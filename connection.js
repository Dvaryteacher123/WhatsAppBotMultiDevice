 /**
 * =====================================================
 * DVARY BOT - MULTI SESSION CONNECTION MANAGER
 * =====================================================
 *
 * Supports:
 * - Multiple WhatsApp sessions
 * - Separate socket per session
 * - Separate reconnect handling
 * - Pairing-code sessions
 * - MongoDB auth sessions
 * - Backward compatibility
 * =====================================================
 */

import NodeCache from "node-cache";
import socket from "./core/socket.js";
import events from "./core/events.js";
import {
	setSock,
	getSock as getSocketRef,
	removeSock,
} from "./core/socketRef.js";

/*
|--------------------------------------------------------------------------
| General cache
|--------------------------------------------------------------------------
|
| This cache contains general bot data.
| Authentication is NOT stored here.
| Authentication belongs to MongoDB auth state.
|
*/

const cache = new NodeCache({
	stdTTL: 300,
	checkperiod: 60,
	useClones: false,
	maxKeys: 300,
	deleteOnExpire: true,
});

/*
|--------------------------------------------------------------------------
| Active sessions
|--------------------------------------------------------------------------
|
| sessionId => {
|   sock,
|   connectionAttempts,
|   lastConnectionTime,
|   starting,
|   stopped,
|   createdAt,
|   updatedAt
| }
|
*/

const sessions = new Map();

/*
|--------------------------------------------------------------------------
| Connection limits
|--------------------------------------------------------------------------
*/

const MAX_CONNECTION_ATTEMPTS = 5;

/*
|--------------------------------------------------------------------------
| Minimum connection interval
|--------------------------------------------------------------------------
|
| Prevents accidental duplicate sockets.
|
*/

const MIN_CONNECTION_INTERVAL = 10000;

/*
|--------------------------------------------------------------------------
| Reset attempts after
|--------------------------------------------------------------------------
*/

const ATTEMPT_RESET_TIME = 60000;

/*
|--------------------------------------------------------------------------
| index.js hook
|--------------------------------------------------------------------------
*/

let _onNewSock = null;

/**
 * Register callback used by index.js
 */
export const onNewSock = (fn) => {
	if (typeof fn !== "function") {
		_onNewSock = null;
		return;
	}

	_onNewSock = fn;
};

/*
|--------------------------------------------------------------------------
| Normalize session ID
|--------------------------------------------------------------------------
*/

const normalizeSessionId = (sessionId) => {
	if (
		typeof sessionId !== "string" ||
		!sessionId.trim()
	) {
		return "default";
	}

	return sessionId.trim();
};

/*
|--------------------------------------------------------------------------
| Create session record
|--------------------------------------------------------------------------
*/

const createSession = (sessionId) => {
	sessionId = normalizeSessionId(sessionId);

	if (!sessions.has(sessionId)) {
		sessions.set(sessionId, {
			sock: null,
			connectionAttempts: 0,
			lastConnectionTime: 0,
			starting: false,
			stopped: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	}

	return sessions.get(sessionId);
};

/*
|--------------------------------------------------------------------------
| Get session
|--------------------------------------------------------------------------
*/

export const getSession = (sessionId = "default") => {
	sessionId = normalizeSessionId(sessionId);

	return sessions.get(sessionId) || null;
};

/*
|--------------------------------------------------------------------------
| Get socket
|--------------------------------------------------------------------------
*/

export const getSock = (sessionId = "default") => {
	sessionId = normalizeSessionId(sessionId);

	return (
		sessions.get(sessionId)?.sock ||
		getSocketRef(sessionId) ||
		null
	);
};

/*
|--------------------------------------------------------------------------
| Get all sessions
|--------------------------------------------------------------------------
*/

export const getAllSessions = () => {
	return sessions;
};

/*
|--------------------------------------------------------------------------
| Get session IDs
|--------------------------------------------------------------------------
*/

export const getSessionIds = () => {
	return [...sessions.keys()];
};

/*
|--------------------------------------------------------------------------
| Check session exists
|--------------------------------------------------------------------------
*/

export const hasSession = (sessionId = "default") => {
	sessionId = normalizeSessionId(sessionId);

	return sessions.has(sessionId);
};

/*
|--------------------------------------------------------------------------
| Check session connected
|--------------------------------------------------------------------------
*/

export const isConnected = (sessionId = "default") => {
	sessionId = normalizeSessionId(sessionId);

	const session = sessions.get(sessionId);

	return !!(
		session?.sock &&
		session.sock.user
	);
};

/*
|--------------------------------------------------------------------------
| Start socket
|--------------------------------------------------------------------------
*/

export const startSock = async (
	sessionId = "default",
	reason = "initial"
) => {
	sessionId = normalizeSessionId(sessionId);

	let session;

	try {
		/*
		|--------------------------------------------------------------------------
		| Create session
		|--------------------------------------------------------------------------
		*/

		session = createSession(sessionId);

		session.updatedAt = Date.now();
		session.stopped = false;

		/*
		|--------------------------------------------------------------------------
		| Already connecting
		|--------------------------------------------------------------------------
		*/

		if (session.starting) {
			console.log(
				`⏳ [${sessionId}] Socket is already starting...`
			);

			return session.sock || null;
		}

		/*
		|--------------------------------------------------------------------------
		| Already connected
		|--------------------------------------------------------------------------
		*/

		if (
			session.sock &&
			session.sock.user
		) {
			console.log(
				`⚠️ [${sessionId}] Session already connected`
			);

			return session.sock;
		}

		/*
		|--------------------------------------------------------------------------
		| Connection interval protection
		|--------------------------------------------------------------------------
		*/

		const now = Date.now();

		const elapsed =
			now - session.lastConnectionTime;

		if (
			session.lastConnectionTime > 0 &&
			elapsed < MIN_CONNECTION_INTERVAL
		) {
			const wait =
				MIN_CONNECTION_INTERVAL -
				elapsed;

			console.log(
				`⏳ [${sessionId}] Connection requested too soon.`
			);

			console.log(
				`⏳ [${sessionId}] Waiting ${Math.ceil(
					wait / 1000
				)} seconds...`
			);

			setTimeout(() => {
				startSock(
					sessionId,
					`${reason} delayed`
				).catch((error) => {
					console.error(
						`❌ [${sessionId}] Delayed start error:`,
						error?.message || error
					);
				});
			}, wait);

			return null;
		}

		/*
		|--------------------------------------------------------------------------
		| Reset old attempts
		|--------------------------------------------------------------------------
		*/

		if (
			session.lastConnectionTime > 0 &&
			elapsed >= ATTEMPT_RESET_TIME
		) {
			session.connectionAttempts = 0;
		}

		/*
		|--------------------------------------------------------------------------
		| Maximum connection attempts
		|--------------------------------------------------------------------------
		*/

		if (
			session.connectionAttempts >=
			MAX_CONNECTION_ATTEMPTS
		) {
			console.log(
				`❌ [${sessionId}] Maximum connection attempts reached`
			);

			console.log(
				`⏸️ [${sessionId}] Waiting before trying again...`
			);

			session.connectionAttempts = 0;

			setTimeout(() => {
				const current =
					sessions.get(sessionId);

				if (!current) {
					return;
				}

				current.connectionAttempts = 0;
				current.lastConnectionTime = 0;

				console.log(
					`🔓 [${sessionId}] Connection retry limit reset`
				);
			}, ATTEMPT_RESET_TIME);

			return null;
		}

		/*
		|--------------------------------------------------------------------------
		| Mark as starting
		|--------------------------------------------------------------------------
		*/

		session.starting = true;
		session.connectionAttempts++;
		session.lastConnectionTime = Date.now();
		session.updatedAt = Date.now();

		console.log(
			`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
		);

		console.log(
			`🔄 [${sessionId}] Starting WhatsApp socket`
		);

		console.log(
			`📋 Reason: ${reason}`
		);

		console.log(
			`🔢 Attempt: ${session.connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}`
		);

		console.log(
			`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
		);

		/*
		|--------------------------------------------------------------------------
		| Create socket
		|--------------------------------------------------------------------------
		*/

		const sock = await socket(
			sessionId
		);

		/*
		|--------------------------------------------------------------------------
		| Socket creation failed
		|--------------------------------------------------------------------------
		*/

		if (!sock) {
			session.starting = false;
			session.sock = null;
			session.updatedAt = Date.now();

			console.log(
				`❌ [${sessionId}] Socket creation failed`
			);

			return null;
		}

		/*
		|--------------------------------------------------------------------------
		| Attach session ID
		|--------------------------------------------------------------------------
		*/

		sock.sessionId = sessionId;

		/*
		|--------------------------------------------------------------------------
		| Save socket
		|--------------------------------------------------------------------------
		*/

		session.sock = sock;
		session.starting = false;
		session.updatedAt = Date.now();

		/*
		|--------------------------------------------------------------------------
		| IMPORTANT
		|--------------------------------------------------------------------------
		| Store socket using session ID.
		|--------------------------------------------------------------------------
		*/

		setSock(
			sock,
			sessionId
		);

		/*
		|--------------------------------------------------------------------------
		| Notify index.js
		|--------------------------------------------------------------------------
		*/

		if (_onNewSock) {
			try {
				await _onNewSock(
					sock,
					sessionId
				);
			} catch (hookError) {
				console.error(
					`⚠️ [${sessionId}] onNewSock hook error:`,
					hookError?.message ||
						hookError
				);
			}
		}

		/*
		|--------------------------------------------------------------------------
		| Start event handlers
		|--------------------------------------------------------------------------
		|
		| IMPORTANT:
		| events.js now handles connection.update itself.
		|
		| Therefore we DO NOT pass a reconnect callback here.
		|
		*/

		await events(
			sock,
			startSock,
			cache,
			sessionId
		);

		/*
		|--------------------------------------------------------------------------
		| Reset attempts
		|--------------------------------------------------------------------------
		|
		| Socket creation succeeded.
		| connectionUpdate.js will handle actual
		| WhatsApp connection state.
		|
		*/

		session.connectionAttempts = 0;
		session.updatedAt = Date.now();

		console.log(
			`✅ [${sessionId}] Socket initialized successfully`
		);

		return sock;
	} catch (error) {
		console.error(
			`❌ [${sessionId}] Error starting socket:`,
			error?.message || error
		);

		if (error?.stack) {
			console.error(
				error.stack
			);
		}

		/*
		|--------------------------------------------------------------------------
		| Cleanup failed socket
		|--------------------------------------------------------------------------
		*/

		const current =
			sessions.get(sessionId);

		if (current) {
			current.sock = null;
			current.starting = false;
			current.updatedAt = Date.now();
		}

		try {
			removeSock(
				sessionId
			);
		} catch {
			// Ignore socket reference cleanup errors
		}

		return null;
	}
};

/*
|--------------------------------------------------------------------------
| Stop session
|--------------------------------------------------------------------------
*/

export const stopSession = async (
	sessionId = "default"
) => {
	sessionId = normalizeSessionId(sessionId);

	try {
		const session =
			sessions.get(sessionId);

		if (!session) {
			console.log(
				`⚠️ [${sessionId}] Session does not exist`
			);

			return false;
		}

		/*
		|--------------------------------------------------------------------------
		| Mark stopped
		|--------------------------------------------------------------------------
		*/

		session.stopped = true;
		session.starting = false;

		/*
		|--------------------------------------------------------------------------
		| Close socket
		|--------------------------------------------------------------------------
		*/

		if (session.sock) {
			try {
				if (
					session.sock.ws &&
					typeof session.sock.ws.close ===
						"function"
				) {
					session.sock.ws.close();
				}
			} catch (error) {
				console.log(
					`⚠️ [${sessionId}] Socket close warning:`,
					error?.message || error
				);
			}
		}

		/*
		|--------------------------------------------------------------------------
		| Remove socket reference
		|--------------------------------------------------------------------------
		*/

		session.sock = null;
		session.updatedAt = Date.now();

		try {
			removeSock(
				sessionId
			);
		} catch {
			// Ignore cleanup errors
		}

		console.log(
			`🛑 [${sessionId}] Session stopped`
		);

		return true;
	} catch (error) {
		console.error(
			`❌ [${sessionId}] Stop session error:`,
			error?.message || error
		);

		return false;
	}
};

/*
|--------------------------------------------------------------------------
| Remove session from memory
|--------------------------------------------------------------------------
*/

export const removeSession = async (
	sessionId = "default"
) => {
	sessionId = normalizeSessionId(sessionId);

	try {
		await stopSession(
			sessionId
		);

		sessions.delete(
			sessionId
		);

		try {
			removeSock(
				sessionId
			);
		} catch {
			// Ignore
		}

		console.log(
			`🗑️ [${sessionId}] Session removed from memory`
		);

		return true;
	} catch (error) {
		console.error(
			`❌ [${sessionId}] Remove session error:`,
			error?.message || error
		);

		return false;
	}
};

/*
|--------------------------------------------------------------------------
| Restart session
|--------------------------------------------------------------------------
*/

export const restartSession = async (
	sessionId = "default",
	reason = "manual restart"
) => {
	sessionId = normalizeSessionId(sessionId);

	console.log(
		`🔄 [${sessionId}] Restart requested`
	);

	await stopSession(
		sessionId
	);

	/*
	|--------------------------------------------------------------------------
	| Reset retry state
	|--------------------------------------------------------------------------
	*/

	const session =
		sessions.get(sessionId);

	if (session) {
		session.connectionAttempts = 0;
		session.lastConnectionTime = 0;
		session.stopped = false;
		session.starting = false;
	}

	return startSock(
		sessionId,
		reason
	);
};

/*
|--------------------------------------------------------------------------
| Get session status
|--------------------------------------------------------------------------
*/

export const getSessionStatus = (
	sessionId = "default"
) => {
	sessionId = normalizeSessionId(sessionId);

	const session =
		sessions.get(sessionId);

	if (!session) {
		return {
			exists: false,
			connected: false,
			starting: false,
			sessionId,
			user: null,
		};
	}

	const sock =
		session.sock;

	return {
		exists: true,

		connected: !!(
			sock &&
			sock.user
		),

		starting:
			!!session.starting,

		stopped:
			!!session.stopped,

		sessionId,

		connectionAttempts:
			session.connectionAttempts,

		lastConnectionTime:
			session.lastConnectionTime,

		createdAt:
			session.createdAt,

		updatedAt:
			session.updatedAt,

		user:
			sock?.user ||
			sock?.authState?.creds?.me ||
			null,
	};
};

/*
|--------------------------------------------------------------------------
| Get all session statuses
|--------------------------------------------------------------------------
*/

export const getAllSessionStatuses = () => {
	const result = {};

	for (
		const sessionId of sessions.keys()
	) {
		result[sessionId] =
			getSessionStatus(
				sessionId
			);
	}

	return result;
};

/*
|--------------------------------------------------------------------------
| Get active session count
|--------------------------------------------------------------------------
*/

export const getActiveSessionCount = () => {
	let count = 0;

	for (
		const session of sessions.values()
	) {
		if (
			session.sock &&
			session.sock.user
		) {
			count++;
		}
	}

	return count;
};

/*
|--------------------------------------------------------------------------
| Get total session count
|--------------------------------------------------------------------------
*/

export const getSessionCount = () => {
	return sessions.size;
};

/*
|--------------------------------------------------------------------------
| Shutdown all sessions
|--------------------------------------------------------------------------
*/

export const stopAllSessions = async () => {
	console.log(
		`🛑 Stopping all WhatsApp sessions...`
	);

	const sessionIds = [
		...sessions.keys(),
	];

	await Promise.all(
		sessionIds.map(
			(sessionId) =>
				stopSession(
					sessionId
				)
		)
	);

	console.log(
		`✅ All WhatsApp sessions stopped`
	);
};

/*
|--------------------------------------------------------------------------
| Default export
|--------------------------------------------------------------------------
*/

export default startSock;
