/**
 * =====================================================
 * DVARY BOT - MULTI SESSION CONNECTION MANAGER
 * =====================================================
 */

import NodeCache from "node-cache";
import socket from "./core/socket.js";
import events from "./core/events.js";
import { setSock } from "./core/socketRef.js";

/*
|--------------------------------------------------------------------------
| General cache
|--------------------------------------------------------------------------
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
|   lastConnectionTime
| }
|
*/

const sessions = new Map();

/*
|--------------------------------------------------------------------------
| Limits
|--------------------------------------------------------------------------
*/

const MAX_CONNECTION_ATTEMPTS = 5;
const MIN_CONNECTION_INTERVAL = 10000;

/*
|--------------------------------------------------------------------------
| index.js hook
|--------------------------------------------------------------------------
*/

let _onNewSock = null;

export const onNewSock = (fn) => {
	_onNewSock = fn;
};

/*
|--------------------------------------------------------------------------
| Get session
|--------------------------------------------------------------------------
*/

export const getSession = (sessionId) => {
	return sessions.get(sessionId) || null;
};

/*
|--------------------------------------------------------------------------
| Get socket
|--------------------------------------------------------------------------
*/

export const getSock = (sessionId) => {
	return sessions.get(sessionId)?.sock || null;
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
| Check session exists
|--------------------------------------------------------------------------
*/

export const hasSession = (sessionId) => {
	return sessions.has(sessionId);
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
	try {
		if (!sessionId) {
			throw new Error("sessionId is required");
		}

		/*
		|--------------------------------------------------------------------------
		| Create session record
		|--------------------------------------------------------------------------
		*/

		if (!sessions.has(sessionId)) {
			sessions.set(sessionId, {
				sock: null,
				connectionAttempts: 0,
				lastConnectionTime: 0,
			});
		}

		const session = sessions.get(sessionId);

		/*
		|--------------------------------------------------------------------------
		| Prevent duplicate connection
		|--------------------------------------------------------------------------
		*/

		if (session.sock) {
			console.log(
				`⚠️ Session ${sessionId} already has an active socket`
			);

			return session.sock;
		}

		/*
		|--------------------------------------------------------------------------
		| Connection interval protection
		|--------------------------------------------------------------------------
		*/

		const now = Date.now();

		if (
			now - session.lastConnectionTime <
			MIN_CONNECTION_INTERVAL
		) {
			const wait =
				MIN_CONNECTION_INTERVAL -
				(now - session.lastConnectionTime);

			console.log(
				`⏳ [${sessionId}] Connection too soon. Retrying in ${wait}ms...`
			);

			setTimeout(() => {
				startSock(sessionId, reason).catch((error) => {
					console.error(
						`❌ [${sessionId}] Retry error:`,
						error.message
					);
				});
			}, wait);

			return null;
		}

		/*
		|--------------------------------------------------------------------------
		| Maximum attempts
		|--------------------------------------------------------------------------
		*/

		if (
			session.connectionAttempts >=
			MAX_CONNECTION_ATTEMPTS
		) {
			console.log(
				`❌ [${sessionId}] Maximum connection attempts reached`
			);

			session.connectionAttempts = 0;

			setTimeout(() => {
				const current = sessions.get(sessionId);

				if (current) {
					current.connectionAttempts = 0;
				}
			}, 60000);

			return null;
		}

		/*
		|--------------------------------------------------------------------------
		| Update connection information
		|--------------------------------------------------------------------------
		*/

		session.connectionAttempts++;
		session.lastConnectionTime = now;

		console.log(
			`🔄 [${sessionId}] Starting socket connection ` +
			`(attempt ${session.connectionAttempts}): ${reason}`
		);

		/*
		|--------------------------------------------------------------------------
		| Create WhatsApp socket
		|--------------------------------------------------------------------------
		*/

		const sock = await socket(sessionId);

		if (!sock) {
			console.log(
				`❌ [${sessionId}] Socket creation failed`
			);

			return null;
		}

		/*
		|--------------------------------------------------------------------------
		| Save socket
		|--------------------------------------------------------------------------
		*/

		session.sock = sock;

		/*
		|--------------------------------------------------------------------------
		| Store session ID on socket
		|--------------------------------------------------------------------------
		*/

		sock.sessionId = sessionId;

		/*
		|--------------------------------------------------------------------------
		| Update global reference
		|--------------------------------------------------------------------------
		|
		| Hii bado inahitajika na sehemu za zamani za bot.
		| Baadaye tunaweza kuondoa kabisa global socket.
		|
		*/

		setSock(sock);

		/*
		|--------------------------------------------------------------------------
		| Notify index.js
		|--------------------------------------------------------------------------
		*/

		if (_onNewSock) {
			_onNewSock(sock, sessionId);
		}

		/*
		|--------------------------------------------------------------------------
		| Start events
		|--------------------------------------------------------------------------
		*/

		events(
			sock,

			/*
			|--------------------------------------------------------------------------
			| Reconnect callback
			|--------------------------------------------------------------------------
			*/

			(reconnectReason = "connection closed") => {
				console.log(
					`🔄 [${sessionId}] Reconnecting: ${reconnectReason}`
				);

				const current = sessions.get(sessionId);

				if (current) {
					current.sock = null;
				}

				return startSock(
					sessionId,
					reconnectReason
				);
			},

			cache
		);

		/*
		|--------------------------------------------------------------------------
		| Successful connection
		|--------------------------------------------------------------------------
		*/

		session.connectionAttempts = 0;

		console.log(
			`✅ [${sessionId}] Socket connection established`
		);

		return sock;
	} catch (error) {
		console.error(
			`❌ [${sessionId}] Error starting socket:`,
			error.message
		);

		const session = sessions.get(sessionId);

		if (session) {
			session.sock = null;
		}

		return null;
	}
};

/*
|--------------------------------------------------------------------------
| Stop session
|--------------------------------------------------------------------------
*/

export const stopSession = async (sessionId) => {
	try {
		const session = sessions.get(sessionId);

		if (!session) {
			console.log(
				`⚠️ Session ${sessionId} does not exist`
			);

			return false;
		}

		if (session.sock) {
			try {
				await session.sock.ws?.close();
			} catch (error) {
				console.log(
					`⚠️ [${sessionId}] Socket close warning:`,
					error.message
				);
			}
		}

		session.sock = null;

		console.log(
			`🛑 [${sessionId}] Session stopped`
		);

		return true;
	} catch (error) {
		console.error(
			`❌ [${sessionId}] Stop session error:`,
			error.message
		);

		return false;
	}
};

/*
|--------------------------------------------------------------------------
| Remove session from memory
|--------------------------------------------------------------------------
*/

export const removeSession = async (sessionId) => {
	try {
		await stopSession(sessionId);

		sessions.delete(sessionId);

		console.log(
			`🗑️ [${sessionId}] Session removed from memory`
		);

		return true;
	} catch (error) {
		console.error(
			`❌ [${sessionId}] Remove session error:`,
			error.message
		);

		return false;
	}
};

/*
|--------------------------------------------------------------------------
| Session status
|--------------------------------------------------------------------------
*/

export const getSessionStatus = (sessionId) => {
	const session = sessions.get(sessionId);

	if (!session) {
		return {
			exists: false,
			connected: false,
			sessionId,
		};
	}

	return {
		exists: true,
		connected: !!session.sock,
		sessionId,
		user:
			session.sock?.user ||
			session.sock?.authState?.creds?.me ||
			null,
	};
};

/*
|--------------------------------------------------------------------------
| Start default session
|--------------------------------------------------------------------------
|
| Hii ni kwa compatibility na mfumo wa zamani.
|
*/

export default startSock;
