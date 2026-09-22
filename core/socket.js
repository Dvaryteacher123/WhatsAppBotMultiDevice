/**
 * ============================================================
 * DVARY BOT - WHATSAPP SOCKET
 * ============================================================
 *
 * Multi-session WhatsApp socket.
 *
 * Kila session ina:
 *   - Socket yake
 *   - Message cache yake
 *   - MongoDB auth state yake
 *   - Credentials zake
 *   - Cleanup yake
 *
 * ============================================================
 */

import NodeCache from "node-cache";

import makeWASocket, {
	makeCacheableSignalKeyStore,
	fetchLatestBaileysVersion,
} from "baileys";

import { useMongoDBAuthState } from "./auth.js";

import P from "pino";

/**
 * ============================================================
 * LOGGER
 * ============================================================
 */

const logger = P({
	level: process.env.LOG_LEVEL || "silent",
});

/**
 * ============================================================
 * SOCKET FACTORY
 * ============================================================
 */

const socket = async (sessionId) => {
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
			"❌ sessionId is required to create WhatsApp socket"
		);
	}

	const safeSessionId =
		String(sessionId).trim();

	if (!safeSessionId) {
		throw new Error(
			"❌ Invalid sessionId"
		);
	}

	console.log(
		"\n=================================================="
	);

	console.log(
		`🚀 Creating WhatsApp socket`
	);

	console.log(
		`🆔 Session: ${safeSessionId}`
	);

	console.log(
		"==================================================\n"
	);

	/**
	 * ========================================================
	 * MESSAGE CACHE
	 * ========================================================
	 *
	 * Cache hii ni ya session hii pekee.
	 */

	const messageCache =
		new NodeCache({
			stdTTL: 120,

			checkperiod: 30,

			maxKeys: 180,

			useClones: false,
		});

	/**
	 * ========================================================
	 * BAILEYS VERSION
	 * ========================================================
	 */

	let version;
	let isLatest;

	try {
		const latest =
			await fetchLatestBaileysVersion();

		version = latest.version;
		isLatest = latest.isLatest;

		console.log(
			`📱 Session ${safeSessionId}`
		);

		console.log(
			`📦 Using WA v${version.join(".")}`
		);

		console.log(
			`📌 Latest version: ${isLatest}`
		);
	} catch (error) {
		console.error(
			`❌ Failed to get Baileys version [${safeSessionId}]:`,
			error?.message || error
		);

		throw error;
	}

	/**
	 * ========================================================
	 * MONGODB AUTH STATE
	 * ========================================================
	 *
	 * Muhimu:
	 *
	 * Session hii itatumia MongoDB auth yake.
	 *
	 * Mfano:
	 *
	 * wa_255718278672
	 * wa_255712345678
	 *
	 * hazitachanganya credentials.
	 */

	let state;
	let saveCreds;
	let cleanup;

	try {
		const auth =
			await useMongoDBAuthState(
				safeSessionId
			);

		state = auth.state;
		saveCreds = auth.saveCreds;
		cleanup = auth.cleanup;

		console.log(
			`✅ MongoDB auth state loaded: ${safeSessionId}`
		);
	} catch (error) {
		console.error(
			`❌ Failed to load MongoDB auth [${safeSessionId}]:`,
			error?.message || error
		);

		throw error;
	}

	/**
	 * ========================================================
	 * AUTH STATUS
	 * ========================================================
	 */

	if (state?.creds?.me) {
		console.log(
			`✅ Authenticated as: ${state.creds.me.id}`
		);
	} else {
		console.log(
			`⚠️ No existing credentials: ${safeSessionId}`
		);

		console.log(
			`📲 Waiting for pairing/QR authentication...`
		);
	}

	/**
	 * ========================================================
	 * START TIME
	 * ========================================================
	 */

	const socketStartTime =
		Date.now();

	/**
	 * ========================================================
	 * CLEANUP CONTROL
	 * ========================================================
	 *
	 * Prevent cleanup() from being called multiple times.
	 */

	let cleanedUp = false;

	const runCleanup = () => {
		if (cleanedUp) {
			return;
		}

		cleanedUp = true;

		try {
			if (typeof cleanup === "function") {
				cleanup();
			}
		} catch (error) {
			console.error(
				`❌ Auth cleanup error [${safeSessionId}]:`,
				error?.message || error
			);
		}

		try {
			messageCache.flushAll();
		} catch (error) {
			console.error(
				`❌ Message cache cleanup error [${safeSessionId}]:`,
				error?.message || error
			);
		}

		console.log(
			`🧹 Socket cleanup completed: ${safeSessionId}`
		);
	};

	/**
	 * ========================================================
	 * GET MESSAGE
	 * ========================================================
	 *
	 * Baileys inaweza kuomba message iliyopita.
	 */

	async function getMessage(key) {
		try {
			if (!key) {
				return undefined;
			}

			const remoteJid =
				key.remoteJid;

			const messageId =
				key.id;

			if (
				!remoteJid ||
				!messageId
			) {
				return undefined;
			}

			const cacheKey =
				`${remoteJid}:${messageId}`;

			if (
				messageCache.has(
					cacheKey
				)
			) {
				return messageCache.get(
					cacheKey
				);
			}

			return undefined;
		} catch (error) {
			logger.error(
				`getMessage error [${safeSessionId}]`,
				error
			);

			return undefined;
		}
	}

	/**
	 * ========================================================
	 * CREATE SOCKET
	 * ========================================================
	 */

	let sock;

	try {
		sock = makeWASocket({
			version,

			logger,

			auth: {
				creds: state.creds,

				keys:
					makeCacheableSignalKeyStore(
						state.keys,
						logger
					),
			},

			/**
			 * Message retry support
			 */
			getMessage,

			/**
			 * Better link previews
			 */
			generateHighQualityLinkPreview:
				true,

			/**
			 * Keep online
			 */
			markOnlineOnConnect:
				true,

			/**
			 * Don't sync complete old history
			 */
			syncFullHistory:
				false,

			shouldSyncHistoryMessage:
				() => false,

			/**
			 * Connection timeout
			 */
			connectTimeoutMs:
				60000,

			/**
			 * Query timeout
			 */
			defaultQueryTimeoutMs:
				90000,

			/**
			 * Keep socket alive
			 */
			keepAliveIntervalMs:
				15000,

			/**
			 * Browser identity
			 */
			browser: [
				"Ubuntu",
				"Chrome",
				"20.0.04",
			],

			/**
			 * Own events
			 */
			emitOwnEvents:
				false,

			/**
			 * Retry delay
			 */
			retryRequestDelayMs:
				250,

			/**
			 * Message retry count
			 */
			maxMsgRetryCount:
				5,

			/**
			 * Upload timeout
			 */
			uploadTimeoutMs:
				60000,

			/**
			 * Don't modify outgoing messages
			 */
			patchMessageBeforeSending:
				(message) => message,
		});
	} catch (error) {
		runCleanup();

		console.error(
			`❌ Failed to create socket [${safeSessionId}]:`,
			error?.message || error
		);

		throw error;
	}

	/**
	 * ========================================================
	 * SESSION DATA
	 * ========================================================
	 */

	sock.sessionId =
		safeSessionId;

	sock.startupTime =
		socketStartTime;

	/**
	 * Store useful internal references.
	 *
	 * Other files can access:
	 *
	 * sock.sessionId
	 * sock.startupTime
	 */

	sock.messageCache =
		messageCache;

	/**
	 * ========================================================
	 * CACHE INCOMING MESSAGES
	 * ========================================================
	 */

	sock.ev.on(
		"messages.upsert",
		(update) => {
			try {
				if (
					!update ||
					!Array.isArray(
						update.messages
					)
				) {
					return;
				}

				for (
					const msg
					of update.messages
				) {
					if (
						!msg?.message
					) {
						continue;
					}

					const remoteJid =
						msg.key?.remoteJid;

					const messageId =
						msg.key?.id;

					if (
						!remoteJid ||
						!messageId
					) {
						continue;
					}

					const cacheKey =
						`${remoteJid}:${messageId}`;

					/**
					 * Check cache size
					 */
					const stats =
						messageCache.getStats();

					if (
						stats.keys >= 180
					) {
						continue;
					}

					messageCache.set(
						cacheKey,
						msg.message
					);
				}
			} catch (error) {
				logger.error(
					`Message cache error [${safeSessionId}]`,
					error
				);
			}
		}
	);

	/**
	 * ========================================================
	 * SAVE CREDENTIALS
	 * ========================================================
	 */

	sock.ev.on(
		"creds.update",
		async () => {
			try {
				await saveCreds();

				console.log(
					`💾 Credentials saved: ${safeSessionId}`
				);
			} catch (error) {
				console.error(
					`❌ Credentials save error [${safeSessionId}]:`,
					error?.message || error
				);
			}
		}
	);

	/**
	 * ========================================================
	 * WEBSOCKET CLOSE
	 * ========================================================
	 */

	if (sock.ws) {
		sock.ws.on(
			"close",
			() => {
				console.log(
					`🔌 WebSocket closed: ${safeSessionId}`
				);

				runCleanup();
			}
		);
	}

	/**
	 * ========================================================
	 * CONNECTION UPDATE
	 * ========================================================
	 *
	 * Hii ni monitoring tu.
	 *
	 * Reconnect logic iko kwenye:
	 *
	 * core/connectionUpdate.js
	 *
	 * Hivyo hatutaki kuanzisha socket mpya hapa
	 * ili kuzuia duplicate sockets.
	 */

	sock.ev.on(
		"connection.update",
		(update) => {
			try {
				if (
					update?.connection
				) {
					console.log(
						`📡 Connection [${safeSessionId}]: ${update.connection}`
					);
				}

				if (
					update?.qr
				) {
					console.log(
						`📲 QR generated [${safeSessionId}]`
					);
				}

				if (
					update?.lastDisconnect
						?.error
				) {
					const error =
						update.lastDisconnect.error;

					console.log(
						`⚠️ Last disconnect [${safeSessionId}]:`,
						error?.message ||
							error
					);

					const errorText =
						String(
							error?.message ||
								error ||
								""
						).toLowerCase();

					/**
					 * Clear message cache when
					 * authentication/session data
					 * looks problematic.
					 */
					if (
						errorText.includes(
							"session"
						) ||
						errorText.includes(
							"prekey"
						)
					) {
						console.log(
							`🧹 Clearing message cache [${safeSessionId}]`
						);

						messageCache.flushAll();
					}
				}
			} catch (error) {
				console.error(
					`❌ Connection monitor error [${safeSessionId}]:`,
					error?.message || error
				);
			}
		}
	);

	/**
	 * ========================================================
	 * FINAL INFO
	 * ========================================================
	 */

	console.log(
		`✅ Socket created successfully: ${safeSessionId}`
	);

	console.log(
		`⏱️ Startup: ${Date.now() - socketStartTime}ms`
	);

	console.log(
		"==================================================\n"
	);

	return sock;
};

/**
 * ============================================================
 * EXPORT
 * ============================================================
 */

export default socket;
