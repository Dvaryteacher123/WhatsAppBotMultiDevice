import { DisconnectReason } from "baileys";
import { escapeHtml } from "../notify/telegram.js";
import notifyOwner from "../notify/owner.js";

/**
 * =====================================================
 * DVARY BOT - CONNECTION UPDATE
 * Multi-session compatible
 * =====================================================
 *
 * Handles:
 * - connecting
 * - open
 * - close
 * - reconnect
 * - logout
 * - session conflict
 *
 * Each WhatsApp session is handled independently.
 * =====================================================
 */

// Prevent multiple reconnect timers for the same session
const reconnectTimers = new Map();

// Prevent reconnect while a reconnect is already running
const reconnectingSessions = new Set();

/**
 * -----------------------------------------------------
 * Get safe session ID
 * -----------------------------------------------------
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

/**
 * -----------------------------------------------------
 * Clear reconnect timer
 * -----------------------------------------------------
 */
const clearReconnectTimer = (sessionId) => {
	const timer = reconnectTimers.get(sessionId);

	if (timer) {
		clearTimeout(timer);
		reconnectTimers.delete(sessionId);
	}
};

/**
 * -----------------------------------------------------
 * Schedule reconnect
 * -----------------------------------------------------
 */
const scheduleReconnect = (
	startSock,
	sessionId,
	delay = 5000
) => {
	sessionId = normalizeSessionId(sessionId);

	/*
	|--------------------------------------------------------------------------
	| Don't create duplicate reconnect timers
	|--------------------------------------------------------------------------
	*/

	if (reconnectTimers.has(sessionId)) {
		console.log(
			`⏳ [${sessionId}] Reconnect already scheduled`
		);

		return;
	}

	/*
	|--------------------------------------------------------------------------
	| Don't reconnect same session twice
	|--------------------------------------------------------------------------
	*/

	if (reconnectingSessions.has(sessionId)) {
		console.log(
			`⏳ [${sessionId}] Reconnect already in progress`
		);

		return;
	}

	console.log(
		`⏳ [${sessionId}] Reconnecting in ${delay / 1000} seconds...`
	);

	const timer = setTimeout(async () => {
		reconnectTimers.delete(sessionId);
		reconnectingSessions.add(sessionId);

		try {
			console.log(
				`🔄 [${sessionId}] Starting reconnect...`
			);

			await startSock(
				sessionId,
				"reconnect"
			);

			console.log(
				`✅ [${sessionId}] Reconnect started successfully`
			);
		} catch (error) {
			console.error(
				`❌ [${sessionId}] Reconnect failed:`,
				error?.message || error
			);

			/*
			|--------------------------------------------------------------------------
			| Retry again
			|--------------------------------------------------------------------------
			*/

			reconnectingSessions.delete(sessionId);

			scheduleReconnect(
				startSock,
				sessionId,
				10000
			);

			return;
		}

		reconnectingSessions.delete(sessionId);
	}, delay);

	reconnectTimers.set(
		sessionId,
		timer
	);
};

/**
 * =====================================================
 * MAIN CONNECTION UPDATE
 * =====================================================
 */
const getConnectionUpdate = async (
	startSock,
	events,
	sessionId = "default"
) => {
	sessionId = normalizeSessionId(sessionId);

	const update = events || {};

	const {
		connection,
		lastDisconnect,
		qr,
	} = update;

	/*
	|--------------------------------------------------------------------------
	| Ignore empty update
	|--------------------------------------------------------------------------
	*/

	if (!connection && !qr) {
		return;
	}

	/*
	|--------------------------------------------------------------------------
	| QR CODE
	|--------------------------------------------------------------------------
	*/

	if (qr) {
		console.log(
			`📱 [${sessionId}] QR Code received`
		);

		/*
		|--------------------------------------------------------------------------
		| Pairing code system
		|--------------------------------------------------------------------------
		|
		| QR itself is not stored globally.
		| The socket/session that generated it owns it.
		|
		*/

		console.log(
			`🔑 [${sessionId}] Waiting for authentication...`
		);
	}

	/*
	|--------------------------------------------------------------------------
	| CONNECTING
	|--------------------------------------------------------------------------
	*/

	if (connection === "connecting") {
		console.log(
			`🔗 [${sessionId}] Connecting to WhatsApp...`
		);

		return;
	}

	/*
	|--------------------------------------------------------------------------
	| CONNECTED
	|--------------------------------------------------------------------------
	*/

	if (connection === "open") {
		/*
		|--------------------------------------------------------------------------
		| Cancel any old reconnect timer
		|--------------------------------------------------------------------------
		*/

		clearReconnectTimer(sessionId);

		reconnectingSessions.delete(
			sessionId
		);

		console.log(
			`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
		);

		console.log(
			`✅ [${sessionId}] Successfully connected to WhatsApp!`
		);

		console.log(
			`📱 [${sessionId}] Ready to receive messages`
		);

		console.log(
			`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
		);

		/*
		|--------------------------------------------------------------------------
		| Notify owner
		|--------------------------------------------------------------------------
		*/

		try {
			await notifyOwner(
				null,
				`✅ <b>Bot Connected</b>\n` +
					`━━━━━━━━━━━━━━\n` +
					`🆔 <b>Session:</b> ${escapeHtml(sessionId)}\n` +
					`📱 Successfully connected to WhatsApp.\n` +
					`🟢 Status: Online`
			);
		} catch (error) {
			console.error(
				`⚠️ [${sessionId}] Failed to send Telegram notification:`,
				error?.message || error
			);
		}

		return;
	}

	/*
	|--------------------------------------------------------------------------
	| CONNECTION CLOSED
	|--------------------------------------------------------------------------
	*/

	if (connection === "close") {
		const error =
			lastDisconnect?.error;

		const statusCode =
			error?.output?.statusCode ??
			error?.statusCode ??
			null;

		const errorMessage =
			error?.message ||
			error?.toString?.() ||
			"Unknown connection error";

		console.log(
			`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
		);

		console.log(
			`❌ [${sessionId}] Connection closed`
		);

		console.log(
			`📋 [${sessionId}] Status: ${statusCode ?? "unknown"}`
		);

		console.log(
			`📋 [${sessionId}] Error: ${errorMessage}`
		);

		console.log(
			`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
		);

		/*
		|--------------------------------------------------------------------------
		| SESSION CONFLICT
		|--------------------------------------------------------------------------
		*/

		const lowerError =
			errorMessage.toLowerCase();

		const isConflict =
			lowerError.includes(
				"conflict"
			) ||
			lowerError.includes(
				"replaced"
			) ||
			lowerError.includes(
				"logged out"
			) &&
			statusCode !==
				DisconnectReason.loggedOut;

		/*
		|--------------------------------------------------------------------------
		| TRUE LOGOUT
		|--------------------------------------------------------------------------
		|
		| WhatsApp explicitly logged the device out.
		|
		*/

		const isTrueLogout =
			statusCode ===
				DisconnectReason.loggedOut &&
			!isConflict;

		if (isTrueLogout) {
			clearReconnectTimer(
				sessionId
			);

			reconnectingSessions.delete(
				sessionId
			);

			console.log(
				`🚫 [${sessionId}] WhatsApp session logged out`
			);

			try {
				await notifyOwner(
					null,
					`🚨 <b>Bot Logged Out</b>\n` +
						`━━━━━━━━━━━━━━\n` +
						`🆔 <b>Session:</b> ${escapeHtml(sessionId)}\n` +
						`⚠️ WhatsApp device was logged out.\n` +
						`🔑 Manual re-authentication required.\n` +
						`🛑 Automatic reconnect disabled.`
				);
			} catch (notifyError) {
				console.error(
					`⚠️ [${sessionId}] Logout notification failed:`,
					notifyError?.message ||
						notifyError
				);
			}

			return;
		}

		/*
		|--------------------------------------------------------------------------
		| RECONNECT
		|--------------------------------------------------------------------------
		*/

		let reason;

		if (isConflict) {
			reason =
				"Session conflict / another device connected";
		} else if (
			statusCode ===
			DisconnectReason.connectionClosed
		) {
			reason =
				"WhatsApp connection closed";
		} else if (
			statusCode ===
			DisconnectReason.connectionLost
		) {
			reason =
				"WhatsApp connection lost";
		} else if (
			statusCode ===
			DisconnectReason.timedOut
		) {
			reason =
				"Connection timed out";
		} else if (
			statusCode ===
			DisconnectReason.restartRequired
		) {
			reason =
				"WhatsApp requested restart";
		} else if (
			statusCode ===
			DisconnectReason.multideviceMismatch
		) {
			reason =
				"Multi-device mismatch";
		} else {
			reason =
				`Connection closed (${statusCode ?? "unknown"})`;
		}

		console.log(
			`🔄 [${sessionId}] ${reason}`
		);

		/*
		|--------------------------------------------------------------------------
		| Telegram notification
		|--------------------------------------------------------------------------
		*/

		try {
			await notifyOwner(
				null,
				`🔄 <b>Bot Disconnected</b>\n` +
					`━━━━━━━━━━━━━━\n` +
					`🆔 <b>Session:</b> ${escapeHtml(sessionId)}\n` +
					`📋 <b>Reason:</b> ${escapeHtml(reason)}\n` +
					`⏳ Reconnecting in 5 seconds...`
			);
		} catch (notifyError) {
			console.error(
				`⚠️ [${sessionId}] Disconnect notification failed:`,
				notifyError?.message ||
					notifyError
			);
		}

		/*
		|--------------------------------------------------------------------------
		| Schedule reconnect
		|--------------------------------------------------------------------------
		*/

		scheduleReconnect(
			startSock,
			sessionId,
			5000
		);

		return;
	}
};

/**
 =====================================================
 * CLEANUP HELPERS
 * =====================================================
 */

/**
 * Cancel reconnect for one session
 */
export const cancelReconnect = (
	sessionId = "default"
) => {
	sessionId =
		normalizeSessionId(sessionId);

	clearReconnectTimer(
		sessionId
	);

	reconnectingSessions.delete(
		sessionId
	);

	console.log(
		`🛑 [${sessionId}] Reconnect cancelled`
	);
};

/**
 * Check whether session has reconnect pending
 */
export const isReconnectScheduled = (
	sessionId = "default"
) => {
	sessionId =
		normalizeSessionId(sessionId);

	return reconnectTimers.has(
		sessionId
	);
};

/**
 * Get reconnecting sessions
 */
export const getReconnectingSessions = () => {
	return [
		...reconnectingSessions
	];
};

/**
 * Cancel all reconnect timers
 */
export const cancelAllReconnects = () => {
	for (const [
		sessionId,
		timer,
	] of reconnectTimers.entries()) {
		clearTimeout(timer);

		console.log(
			`🛑 [${sessionId}] Reconnect cancelled`
		);
	}

	reconnectTimers.clear();
	reconnectingSessions.clear();
};

/**
 * Default export
 */
export default getConnectionUpdate;
