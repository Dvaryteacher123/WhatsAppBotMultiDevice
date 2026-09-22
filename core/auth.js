/**
 * ============================================================
 * DVARY BOT - MONGODB AUTH STATE
 * ============================================================
 *
 * Multi-session authentication storage for Baileys.
 *
 * Kila WhatsApp session ina namespace yake:
 *
 *   sessionId::creds
 *   sessionId::pre-key-...
 *   sessionId::session-...
 *   sessionId::sender-key-...
 *   sessionId::app-state-sync-key-...
 *
 * ============================================================
 */

import {
	BufferJSON,
	initAuthCreds,
	proto,
} from "baileys";

import mdClient from "../db/client.js";

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const FLUSH_INTERVAL_MS = 5000;

const MAX_BUFFER_SIZE = 500;

const DB_NAME = "MyBotDataDB";

const COLLECTION_NAME = "AuthState";

/**
 * ============================================================
 * MONGODB AUTH STATE
 * ============================================================
 */

const useMongoDBAuthState = async (
	sessionId
) => {
	/**
	 * --------------------------------------------------------
	 * Validate session ID
	 * --------------------------------------------------------
	 */

	if (
		sessionId === undefined ||
		sessionId === null
	) {
		throw new Error(
			"sessionId is required for MongoDB auth state"
		);
	}

	const safeSessionId =
		String(sessionId).trim();

	if (!safeSessionId) {
		throw new Error(
			"Invalid sessionId"
		);
	}

	/**
	 * --------------------------------------------------------
	 * MongoDB collection
	 * --------------------------------------------------------
	 */

	const collection = mdClient
		.db(DB_NAME)
		.collection(COLLECTION_NAME);

	/**
	 * --------------------------------------------------------
	 * Namespace
	 * --------------------------------------------------------
	 *
	 * Example:
	 *
	 * wa_255718278672::
	 */

	const prefix =
		`${safeSessionId}::`;

	/**
	 * --------------------------------------------------------
	 * In-memory write buffer
	 * --------------------------------------------------------
	 */

	const buffer = new Map();

	let flushTimer = null;

	let flushing = false;

	let cleanupStarted = false;

	/**
	 * ========================================================
	 * CRITICAL KEY TYPES
	 * ========================================================
	 *
	 * Credentials and important session keys are written
	 * directly to MongoDB.
	 */

	const CRITICAL_PREFIXES = [
		"creds",
		"session",
		"pre-key",
		"sender-key",
	];

	/**
	 * Check whether a key is critical.
	 */

	const isCritical = (key) => {
		return CRITICAL_PREFIXES.some(
			(item) =>
				key === item ||
				key.startsWith(
					`${item}-`
				)
		);
	};

	/**
	 * Add session namespace.
	 */

	const mongoKey = (key) => {
		return `${prefix}${key}`;
	};

	/**
	 * ========================================================
	 * READ ONE KEY
	 * ========================================================
	 */

	const readData = async (key) => {
		try {
			const doc =
				await collection.findOne({
					_id: mongoKey(key),
				});

			if (
				!doc ||
				doc.value === undefined ||
				doc.value === null
			) {
				return null;
			}

			return JSON.parse(
				doc.value,
				BufferJSON.reviver
			);
		} catch (error) {
			console.error(
				`❌ MongoDB auth read error [${safeSessionId}] [${key}]:`,
				error?.message || error
			);

			return null;
		}
	};

	/**
	 * ========================================================
	 * WRITE CRITICAL OPERATIONS
	 * ========================================================
	 */

	const writeCriticalBulk =
		async (operations) => {
			if (
				!operations ||
				operations.length === 0
			) {
				return;
			}

			await collection.bulkWrite(
				operations,
				{
					ordered: false,
				}
			);
		};

	/**
	 * ========================================================
	 * ADD TO BUFFER
	 * ========================================================
	 */

	const bufferWrite = (
		key,
		value
	) => {
		if (cleanupStarted) {
			return;
		}

		buffer.set(
			key,
			value
		);

		/**
		 * Flush when buffer gets large.
		 */
		if (
			buffer.size >=
			MAX_BUFFER_SIZE
		) {
			void flushBuffer().catch(
				(error) => {
					console.error(
						`❌ MongoDB auth buffer flush error [${safeSessionId}]:`,
						error?.message ||
							error
					);
				}
			);
		}
	};

	/**
	 * ========================================================
	 * FLUSH BUFFER
	 * ========================================================
	 *
	 * Important:
	 *
	 * Tunachukua snapshot ya buffer.
	 *
	 * Baada ya MongoDB kufanikiwa:
	 * tunafuta tu entries ambazo bado zina
	 * value ile ile.
	 *
	 * Kama entry imebadilishwa wakati wa write,
	 * value mpya inabaki kwenye buffer.
	 */

	const flushBuffer = async () => {
		if (
			buffer.size === 0 ||
			flushing
		) {
			return;
		}

		flushing = true;

		try {
			const entries = [
				...buffer.entries(),
			];

			const operations =
				entries.map(
					([key, value]) => {
						const id =
							mongoKey(key);

						/**
						 * NULL = DELETE
						 */

						if (
							value === null ||
							value === undefined
						) {
							return {
								deleteOne: {
									filter: {
										_id: id,
									},
								},
							};
						}

						/**
						 * WRITE
						 */

						return {
							updateOne: {
								filter: {
									_id: id,
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
						};
					}
				);

			/**
			 * Write to MongoDB
			 */

			await collection.bulkWrite(
				operations,
				{
					ordered: false,
				}
			);

			/**
			 * Remove only entries that have
			 * not changed during the write.
			 */

			for (
				const [
					key,
					value,
				] of entries
			) {
				if (
					buffer.get(key) ===
					value
				) {
					buffer.delete(key);
				}
			}
		} catch (error) {
			console.error(
				`❌ MongoDB auth flush error [${safeSessionId}]:`,
				error?.message ||
					error
			);

			throw error;
		} finally {
			flushing = false;
		}
	};

	/**
	 * ========================================================
	 * BACKGROUND FLUSH
	 * ========================================================
	 */

	flushTimer =
		setInterval(() => {
			void flushBuffer().catch(
				(error) => {
					console.error(
						`❌ Background auth flush error [${safeSessionId}]:`,
						error?.message ||
							error
					);
				}
			);
		}, FLUSH_INTERVAL_MS);

	/**
	 * Do not keep Node process alive
	 * only because of this timer.
	 */

	if (
		flushTimer &&
		typeof flushTimer.unref ===
			"function"
	) {
		flushTimer.unref();
	}

	/**
	 * ========================================================
	 * LOAD CREDENTIALS
	 * ========================================================
	 */

	const existingCreds =
		await readData("creds");

	const creds =
		existingCreds ||
		initAuthCreds();

	if (existingCreds) {
		console.log(
			`🔐 Existing credentials loaded: ${safeSessionId}`
		);
	} else {
		console.log(
			`🆕 New authentication state: ${safeSessionId}`
		);
	}

	/**
	 * ========================================================
	 * AUTH STATE
	 * ========================================================
	 */

	const state = {
		creds,

		keys: {
			/**
			 * =================================================
			 * GET KEYS
			 * =================================================
			 */

			get: async (
				type,
				ids
			) => {
				if (
					!Array.isArray(ids) ||
					ids.length === 0
				) {
					return {};
				}

				/**
				 * Convert:
				 *
				 * type + id
				 *
				 * into:
				 *
				 * type-id
				 */

				const rawKeys =
					ids.map(
						(id) =>
							`${type}-${id}`
					);

				const mongoIds =
					rawKeys.map(
						(key) =>
							mongoKey(key)
					);

				let docs = [];

				try {
					docs =
						await collection
							.find({
								_id: {
									$in:
										mongoIds,
								},
							})
							.toArray();
				} catch (error) {
					console.error(
						`❌ MongoDB auth key read error [${safeSessionId}]:`,
						error?.message ||
							error
					);

					docs = [];
				}

				/**
				 * Map MongoDB docs
				 */

				const byKey = {};

				for (
					const doc of docs
				) {
					if (
						!doc ||
						doc.value ===
							undefined ||
						doc.value === null
					) {
						continue;
					}

					const rawKey =
						doc._id.startsWith(
							prefix
						)
							? doc._id.slice(
									prefix.length
								)
							: doc._id;

					try {
						byKey[rawKey] =
							JSON.parse(
								doc.value,
								BufferJSON.reviver
							);
					} catch (error) {
						console.error(
							`❌ Failed to parse auth key [${safeSessionId}] [${rawKey}]:`,
							error?.message ||
								error
						);
					}
				}

				/**
				 * Build result in Baileys format.
				 */

				const data = {};

				for (
					const id of ids
				) {
					const rawKey =
						`${type}-${id}`;

					let value =
						byKey[
							rawKey
						] ??
						null;

					/**
					 * Baileys requires AppStateSyncKeyData
					 * to be converted from object.
					 */

					if (
						type ===
							"app-state-sync-key" &&
						value
					) {
						try {
							value =
								proto.Message
									.AppStateSyncKeyData
									.fromObject(
										value
									);
						} catch (error) {
							console.error(
								`❌ AppState key conversion error [${safeSessionId}]:`,
								error?.message ||
									error
							);

							value =
								null;
						}
					}

					data[id] =
						value;
				}

				return data;
			},

			/**
			 * =================================================
			 * SET KEYS
			 * =================================================
			 */

			set: async (
				data
			) => {
				if (
					!data ||
					typeof data !==
						"object"
				) {
					return;
				}

				const criticalOps = [];

				for (
					const category in data
				) {
					if (
						!Object.prototype.hasOwnProperty.call(
							data,
							category
						)
					) {
						continue;
					}

					const categoryData =
						data[
							category
						];

					if (
						!categoryData ||
						typeof categoryData !==
							"object"
					) {
						continue;
					}

					for (
						const id in categoryData
					) {
						if (
							!Object.prototype.hasOwnProperty.call(
								categoryData,
								id
							)
						) {
							continue;
						}

						const value =
							categoryData[
								id
							];

						const key =
							`${category}-${id}`;

						const idWithPrefix =
							mongoKey(key);

						/**
						 * =================================
						 * DELETE
						 * =================================
						 */

						if (
							value ===
								null ||
							value ===
								undefined
						) {
							const operation =
								{
									deleteOne: {
										filter: {
											_id:
												idWithPrefix,
										},
									},
								};

							if (
								isCritical(
									key
								)
							) {
								criticalOps.push(
									operation
								);
							} else {
								bufferWrite(
									key,
									null
								);
							}

							continue;
						}

						/**
						 * =================================
						 * CRITICAL KEY
						 * =================================
						 *
						 * Direct MongoDB write.
						 */

						if (
							isCritical(
								key
							)
						) {
							criticalOps.push(
								{
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

										upsert:
											true,
									},
								}
							);
						}

						/**
						 * =================================
						 * NON-CRITICAL KEY
						 * =================================
						 */

						else {
							bufferWrite(
								key,
								value
							);
						}
					}
				}

				/**
				 * Write critical keys now.
				 */

				await writeCriticalBulk(
					criticalOps
				);
			},
		},
	};

	/**
	 * ========================================================
	 * SAVE CREDENTIALS
	 * ========================================================
	 */

	const saveCreds =
		async () => {
			try {
				await collection.updateOne(
					{
						_id:
							mongoKey(
								"creds"
							),
					},

					{
						$set: {
							value:
								JSON.stringify(
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
						upsert:
							true,
					}
				);
			} catch (error) {
				console.error(
					`❌ Failed to save credentials [${safeSessionId}]:`,
					error?.message ||
						error
				);

				throw error;
			}
		};

	/**
	 * ========================================================
	 * CLEANUP
	 * ========================================================
	 *
	 * Important:
	 *
	 * Hatu-clear buffer kabla flush haijaisha.
	 */

	const cleanup =
		async () => {
			if (
				cleanupStarted
			) {
				return;
			}

			cleanupStarted = true;

			console.log(
				`🧹 Starting auth cleanup: ${safeSessionId}`
			);

			/**
			 * Stop timer first.
			 */

			if (
				flushTimer
			) {
				clearInterval(
					flushTimer
				);

				flushTimer =
					null;
			}

			/**
			 * Try to flush remaining data.
			 */

			try {
				await flushBuffer();
			} catch (error) {
				console.error(
					`❌ Final auth flush failed [${safeSessionId}]:`,
					error?.message ||
						error
				);
			}

			/**
			 * Only clear after flush attempt.
			 */

			buffer.clear();

			console.log(
				`✅ Auth state cleanup completed: ${safeSessionId}`
			);
		};

	/**
	 * ========================================================
	 * RETURN
	 * ========================================================
	 */

	return {
		state,

		saveCreds,

		cleanup,
	};
};

/**
 * ============================================================
 * CLEAR ONE SESSION
 * ============================================================
 */

const clearMongoDBAuthState =
	async (
		sessionId = null
	) => {
		try {
			const collection =
				mdClient
					.db(DB_NAME)
					.collection(
						COLLECTION_NAME
					);

			/**
			 * ------------------------------------------------
			 * CLEAR EVERYTHING
			 * ------------------------------------------------
			 */

			if (
				sessionId ===
					null ||
				sessionId ===
					undefined ||
				String(
					sessionId
				).trim() === ""
			) {
				const result =
					await collection.deleteMany(
						{}
					);

				console.log(
					`🗑️ Cleared ${result.deletedCount} auth state documents`
				);

				return result.deletedCount;
			}

			/**
			 * ------------------------------------------------
			 * CLEAR ONE SESSION
			 * ------------------------------------------------
			 */

			const safeSessionId =
				String(
					sessionId
				).trim();

			const prefix =
				`${safeSessionId}::`;

			/**
			 * Escape regex safely.
			 */

			const escapedPrefix =
				prefix.replace(
					/[.*+?^${}()|[\]\\]/g,
					"\\$&"
				);

			const result =
				await collection.deleteMany(
					{
						_id: {
							$regex:
								`^${escapedPrefix}`,
						},
					}
				);

			console.log(
				`🗑️ Cleared ${result.deletedCount} auth documents for session ${safeSessionId}`
			);

			return result.deletedCount;
		} catch (error) {
			console.error(
				"❌ Error clearing MongoDB auth state:",
				error?.message ||
					error
			);

			return 0;
		}
	};

/**
 * ============================================================
 * GET AUTH STATE STATS
 * ============================================================
 */

const getAuthStateStats =
	async () => {
		try {
			const collection =
				mdClient
					.db(DB_NAME)
					.collection(
						COLLECTION_NAME
					);

			const total =
				await collection.countDocuments();

			const sessions =
				await collection.distinct(
					"sessionId"
				);

			const validSessions =
				sessions.filter(
					(Boolean)
				);

			return {
				total,

				sessions:
					validSessions,

				sessionCount:
					validSessions.length,
			};
		} catch (error) {
			console.error(
				"❌ Error getting auth state stats:",
				error?.message ||
					error
			);

			return {
				total: 0,

				sessions: [],

				sessionCount: 0,
			};
		}
	};

/**
 * ============================================================
 * EXPORTS
 * ============================================================
 */

export {
	useMongoDBAuthState,
	clearMongoDBAuthState,
	getAuthStateStats,
};
