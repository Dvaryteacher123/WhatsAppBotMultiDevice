import { BufferJSON, initAuthCreds, proto } from "baileys";
import mdClient from "../db/client.js";

const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFER_SIZE = 500;

/**
 * Multi-session MongoDB Auth State
 *
 * Kila WhatsApp user anapata namespace yake:
 *
 * userId::creds
 * userId::session-...
 * userId::pre-key-...
 * userId::sender-key-...
 */
const useMongoDBAuthState = async (sessionId) => {
	if (!sessionId) {
		throw new Error("sessionId is required for MongoDB auth state");
	}

	const safeSessionId = String(sessionId).trim();

	if (!safeSessionId) {
		throw new Error("Invalid sessionId");
	}

	const collection = mdClient
		.db("MyBotDataDB")
		.collection("AuthState");

	// Prefix ya kutenganisha session moja na nyingine
	const prefix = `${safeSessionId}::`;

	// In-memory buffer
	const buffer = new Map();

	let flushTimer = null;
	let flushing = false;

	const CRITICAL_PREFIXES = [
		"creds",
		"session",
		"pre-key",
		"sender-key",
	];

	const isCritical = (key) => {
		return CRITICAL_PREFIXES.some((p) => key.startsWith(p));
	};

	const mongoKey = (key) => {
		return `${prefix}${key}`;
	};

	// =====================================================
	// READ
	// =====================================================

	const readData = async (key) => {
		const doc = await collection.findOne({
			_id: mongoKey(key),
		});

		if (!doc?.value) {
			return null;
		}

		return JSON.parse(
			doc.value,
			BufferJSON.reviver
		);
	};

	// =====================================================
	// CRITICAL WRITE
	// =====================================================

	const writeCriticalBulk = async (ops) => {
		if (!ops.length) return;

		await collection.bulkWrite(
			ops,
			{
				ordered: false,
			}
		);
	};

	// =====================================================
	// BUFFER WRITE
	// =====================================================

	const bufferWrite = (key, value) => {
		buffer.set(key, value);

		if (buffer.size >= MAX_BUFFER_SIZE) {
			flushBuffer().catch((error) => {
				console.error(
					"❌ MongoDB auth buffer flush error:",
					error.message
				);
			});
		}
	};

	// =====================================================
	// FLUSH BUFFER
	// =====================================================

	const flushBuffer = async () => {
		if (!buffer.size || flushing) {
			return;
		}

		flushing = true;

		try {
			const entries = Array.from(buffer.entries());

			const ops = entries.map(([key, value]) => {
				const id = mongoKey(key);

				// null = delete key
				if (value == null) {
					return {
						deleteOne: {
							filter: {
								_id: id,
							},
						},
					};
				}

				return {
					updateOne: {
						filter: {
							_id: id,
						},
						update: {
							$set: {
								value: JSON.stringify(
									value,
									BufferJSON.replacer
								),

								sessionId: safeSessionId,

								updatedAt: new Date(),
							},
						},
						upsert: true,
					},
				};
			});

			await collection.bulkWrite(
				ops,
				{
					ordered: false,
				}
			);

			// Clear only after successful MongoDB write
			for (const [key] of entries) {
				if (
					buffer.has(key) &&
					buffer.get(key) ===
						entries.find(
							([entryKey]) =>
								entryKey === key
						)?.[1]
				) {
					buffer.delete(key);
				}
			}
		} finally {
			flushing = false;
		}
	};

	// =====================================================
	// BACKGROUND FLUSH
	// =====================================================

	flushTimer = setInterval(() => {
		flushBuffer().catch((error) => {
			console.error(
				"❌ Background MongoDB flush error:",
				error.message
			);
		});
	}, FLUSH_INTERVAL_MS);

	// =====================================================
	// CREDS
	// =====================================================

	const creds =
		(await readData("creds")) ||
		initAuthCreds();

	// =====================================================
	// AUTH STATE
	// =====================================================

	return {
		state: {
			creds,

			keys: {
				// ==========================================
				// GET KEYS
				// ==========================================

				get: async (type, ids) => {
					const rawKeys = ids.map(
						(id) => `${type}-${id}`
					);

					const mongoIds = rawKeys.map(
						(key) => mongoKey(key)
					);

					const docs = await collection
						.find({
							_id: {
								$in: mongoIds,
							},
						})
						.toArray();

					const byKey = {};

					for (const doc of docs) {
						if (!doc?.value) {
							continue;
						}

						const rawKey =
							doc._id.startsWith(prefix)
								? doc._id.slice(prefix.length)
								: doc._id;

						byKey[rawKey] =
							JSON.parse(
								doc.value,
								BufferJSON.reviver
							);
					}

					const data = {};

					for (const id of ids) {
						const rawKey =
							`${type}-${id}`;

						let value =
							byKey[rawKey] ?? null;

						if (
							type ===
								"app-state-sync-key" &&
							value
						) {
							value =
								proto.Message
									.AppStateSyncKeyData
									.fromObject(
										value
									);
						}

						data[id] = value;
					}

					return data;
				},

				// ==========================================
				// SET KEYS
				// ==========================================

				set: async (data) => {
					const criticalOps = [];

					for (const category in data) {
						for (const id in data[category]) {
							const value =
								data[category][id];

							const key =
								`${category}-${id}`;

							const idWithPrefix =
								mongoKey(key);

							// =================================
							// DELETE
							// =================================

							if (value == null) {
								const operation = {
									deleteOne: {
										filter: {
											_id:
												idWithPrefix,
										},
									},
								};

								if (
									isCritical(key)
								) {
									criticalOps.push(
										operation
									);
								} else {
									buffer.set(
										key,
										null
									);
								}

								continue;
							}

							// =================================
							// CRITICAL
							// =================================

							if (isCritical(key)) {
								criticalOps.push({
									updateOne: {
										filter: {
											_id:
												idWithPrefix,
										},

										update: {
											$set: {
												value:
													JSON.stringify(
														value,
														BufferJSON.replacer
													),

												sessionId:
													safeSessionId,

												updatedAt:
													new Date(),
											},
										},

										upsert: true,
									},
								});
							}

							// =================================
							// NON CRITICAL
							// =================================

							else {
								bufferWrite(
									key,
									value
								);
							}
						}
					}

					await writeCriticalBulk(
						criticalOps
					);
				},
			},
		},

		// =================================================
		// SAVE CREDS
		// =================================================

		saveCreds: async () => {
			await collection.updateOne(
				{
					_id: mongoKey("creds"),
				},

				{
					$set: {
						value: JSON.stringify(
							creds,
							BufferJSON.replacer
						),

						sessionId:
							safeSessionId,

						updatedAt:
							new Date(),
					},
				},

				{
					upsert: true,
				}
			);
		},

		// =================================================
		// CLEANUP
		// =================================================

		cleanup: () => {
			if (flushTimer) {
				clearInterval(flushTimer);
				flushTimer = null;
			}

			flushBuffer().catch((error) => {
				console.error(
					"❌ Auth cleanup flush error:",
					error.message
				);
			});

			buffer.clear();

			console.log(
				`🧹 Auth state cleanup completed for ${safeSessionId}`
			);
		},
	};
};

// =====================================================
// CLEAR ONE SESSION
// =====================================================

const clearMongoDBAuthState = async (
	sessionId = null
) => {
	try {
		const collection = mdClient
			.db("MyBotDataDB")
			.collection("AuthState");

		if (!sessionId) {
			const result =
				await collection.deleteMany({});

			console.log(
				`🗑️ Cleared ${result.deletedCount} auth state documents`
			);

			return result.deletedCount;
		}

		const prefix =
			`${String(sessionId).trim()}::`;

		const result =
			await collection.deleteMany({
				_id: {
					$regex: `^${prefix.replace(
						/[.*+?^${}()|[\]\\]/g,
						"\\$&"
					)}`,
				},
			});

		console.log(
			`🗑️ Cleared ${result.deletedCount} documents for session ${sessionId}`
		);

		return result.deletedCount;
	} catch (error) {
		console.error(
			"❌ Error clearing MongoDB auth state:",
			error
		);

		return 0;
	}
};

// =====================================================
// STATS
// =====================================================

const getAuthStateStats = async () => {
	try {
		const collection = mdClient
			.db("MyBotDataDB")
			.collection("AuthState");

		const count =
			await collection.countDocuments();

		const sessions =
			await collection.distinct(
				"sessionId"
			);

		return {
			total: count,

			sessions:
				sessions.filter(Boolean),

			sessionCount:
				sessions.filter(Boolean).length,
		};
	} catch (error) {
		console.error(
			"❌ Error getting auth state stats:",
			error
		);

		return {
			total: 0,
			sessions: [],
			sessionCount: 0,
		};
	}
};

export {
	useMongoDBAuthState,
	clearMongoDBAuthState,
	getAuthStateStats,
};
