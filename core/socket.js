import NodeCache from "node-cache";
import makeWASocket, {
	makeCacheableSignalKeyStore,
	fetchLatestBaileysVersion,
} from "baileys";
import { useMongoDBAuthState } from "./auth.js";
import P from "pino";

const logger = P({ level: "silent" });

// =====================================================
// SOCKET FACTORY
// Kila session inapata socket + cache yake
// =====================================================

const socket = async (sessionId) => {
	if (!sessionId) {
		throw new Error(
			"❌ sessionId is required to create WhatsApp socket"
		);
	}

	const safeSessionId = String(sessionId).trim();

	if (!safeSessionId) {
		throw new Error(
			"❌ Invalid sessionId"
		);
	}

	// ===================================================
	// MESSAGE CACHE YA SESSION HII PEKEE
	// ===================================================

	const messageCache = new NodeCache({
		stdTTL: 120,
		checkperiod: 30,
		maxKeys: 180,
		useClones: false,
	});

	const {
		version,
		isLatest,
	} = await fetchLatestBaileysVersion();

	console.log(
		`📱 Session: ${safeSessionId}`
	);

	console.log(
		`using WA v${version.join(".")}, isLatest: ${isLatest}\n`
	);

	// ===================================================
	// MONGODB AUTH STATE YA SESSION HII
	// ===================================================

	const {
		state,
		saveCreds,
		cleanup,
	} = await useMongoDBAuthState(
		safeSessionId
	);

	console.log(
		`✅ Using MongoDB auth state for session: ${safeSessionId}`
	);

	if (state.creds?.me) {
		console.log(
			`✅ Authenticated as: ${state.creds.me.id}`
		);
	} else {
		console.log(
			`⚠️ No existing credentials for ${safeSessionId}`
		);
	}

	const socketStartTime = Date.now();

	// ===================================================
	// CREATE WHATSAPP SOCKET
	// ===================================================

	const sock = makeWASocket({
		version,

		logger,

		auth: {
			creds: state.creds,

			keys: makeCacheableSignalKeyStore(
				state.keys,
				logger
			),
		},

		generateHighQualityLinkPreview: true,

		getMessage,

		markOnlineOnConnect: true,

		syncFullHistory: false,

		shouldSyncHistoryMessage: () => false,

		connectTimeoutMs: 60000,

		defaultQueryTimeoutMs: 90000,

		keepAliveIntervalMs: 15000,

		browser: [
			"Ubuntu",
			"Chrome",
			"20.0.04",
		],

		emitOwnEvents: false,

		retryRequestDelayMs: 250,

		maxMsgRetryCount: 5,

		uploadTimeoutMs: 60000,

		patchMessageBeforeSending: (msg) => msg,
	});

	// ===================================================
	// GET MESSAGE FROM SESSION CACHE
	// ===================================================

	async function getMessage(key) {
		try {
			const cacheKey =
				`${key.remoteJid}:${key.id}`;

			if (messageCache.has(cacheKey)) {
				return messageCache.get(
					cacheKey
				);
			}

			return undefined;
		} catch (error) {
			logger.error(
				"Error in getMessage function:",
				error
			);

			return undefined;
		}
	}

	// ===================================================
	// MESSAGE CACHE
	// ===================================================

	sock.ev.on(
		"messages.upsert",
		(m) => {
			try {
				for (const msg of m.messages) {
					if (!msg.message) {
						continue;
					}

					const cacheKey =
						`${msg.key.remoteJid}:${msg.key.id}`;

					if (
						messageCache.getStats()
							.keys < 180
					) {
						messageCache.set(
							cacheKey,
							msg.message
						);
					}
				}
			} catch (error) {
				logger.error(
					"Error caching message:",
					error
				);
			}
		}
	);

	// ===================================================
	// SAVE CREDENTIALS
	// ===================================================

	sock.ev.on(
		"creds.update",
		async () => {
			try {
				await saveCreds();

				console.log(
					`💾 Credentials saved to MongoDB: ${safeSessionId}`
				);
			} catch (error) {
				console.error(
					`❌ Error updating credentials for ${safeSessionId}:`,
					error
				);
			}
		}
	);

	// ===================================================
	// SOCKET CLOSED
	// ===================================================

	sock.ws.on(
		"close",
		() => {
			try {
				cleanup();
			} catch (error) {
				console.error(
					`❌ Cleanup error for ${safeSessionId}:`,
					error
				);
			}

			messageCache.flushAll();

			console.log(
				`🧹 Socket cleanup completed: ${safeSessionId}`
			);
		}
	);

	// ===================================================
	// CONNECTION ERRORS
	// ===================================================

	sock.ev.on(
		"connection.update",
		(update) => {
			if (
				update.lastDisconnect?.error
			) {
				const error =
					update.lastDisconnect.error;

				console.log(
					`⚠️ Connection error [${safeSessionId}]:`,
					error.message
				);

				if (
					error.message
						.toLowerCase()
						.includes("session") ||
					error.message
						.toLowerCase()
						.includes("prekey")
				) {
					console.log(
						`🧹 Clearing message cache for ${safeSessionId}`
					);

					messageCache.flushAll();
				}
			}
		}
	);

	// ===================================================
	// SESSION INFORMATION
	// ===================================================

	sock.sessionId = safeSessionId;

	sock.startupTime =
		socketStartTime;

	return sock;
};

export default socket;
