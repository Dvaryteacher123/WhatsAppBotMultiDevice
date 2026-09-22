import { DisconnectReason } from "baileys";
import { escapeHtml } from "../notify/telegram.js";
import notifyOwner from "../notify/owner.js";

/**
 * =====================================================
 * DVARY BOT - CONNECTION UPDATE
 * Multi-session compatible
 * =====================================================
 */

const getConnectionUpdate = async (
	startSock,
	events,
	sessionId = "default"
) => {
	const update = events;

	const {
		connection,
		lastDisconnect,
		qr,
	} = update;

	// Ignore empty updates
	if (!connection && !qr) return;

	/*
	|--------------------------------------------------------------------------
	| Connection CLOSED
	|--------------------------------------------------------------------------
	*/

	if (connection === "close") {
		const error = lastDisconnect?.error;

		const statusCode =
			error?.output?.statusCode;

		const errorMessage =
			error?.message || "";

		console.log(
			`❌ [${sessionId}] Connection closed. Reason:`,
			statusCode
		);

		console.log(
			`❌ [${sessionId}] Error details:`,
			errorMessage
		);

		/*
		|--------------------------------------------------------------------------
		| Session conflict
		|--------------------------------------------------------------------------
		*/

		const isConflict =
			errorMessage
				.toLowerCase()
				.includes("conflict");

		/*
		|--------------------------------------------------------------------------
		| Real logout
		|--------------------------------------------------------------------------
		*/

		const isTrueLogout =
			statusCode ===
				DisconnectReason.loggedOut &&
			!isConflict;

		if (isTrueLogout) {
			console.log(
				`❌ [${sessionId}] Device logged out`
			);

			notifyOwner(
				null,
				`🚨 <b>Bot Logged Out</b>\n` +
					`━━━━━━━━━━━━━━\n` +
					`🆔 <b>Session:</b> ${escapeHtml(sessionId)}\n` +
					`⚠️ Device was logged out from WhatsApp.\n` +
					`🔑 Manual re-authentication required.`
			);

			/*
			|--------------------------------------------------------------------------
			| IMPORTANT
			|--------------------------------------------------------------------------
			| Do NOT reconnect a real logged-out session.
			|--------------------------------------------------------------------------
			*/

			return;
		}

		/*
		|--------------------------------------------------------------------------
		| Reconnection
		|--------------------------------------------------------------------------
		*/

		const reason = isConflict
			? "Session conflict (another device connected)"
			: `Status ${statusCode}`;

		console.log(
			`🔄 [${sessionId}] Reconnecting... Reason: ${reason}`
		);

		notifyOwner(
			null,
			`🔄 <b>Bot Disconnected</b>\n` +
				`━━━━━━━━━━━━━━\n` +
				`🆔 <b>Session:</b> ${escapeHtml(sessionId)}\n` +
				`📋 <b>Reason:</b> ${escapeHtml(reason)}\n` +
				`⏳ Reconnecting in 5 seconds...`
		);

		setTimeout(() => {
			startSock(
				sessionId,
				"reconnect"
			);
		}, 5000);
	}

	/*
	|--------------------------------------------------------------------------
	| Connecting
	|--------------------------------------------------------------------------
	*/

	else if (connection === "connecting") {
		console.log(
			`🔗 [${sessionId}] Connecting to WhatsApp...`
		);
	}

	/*
	|--------------------------------------------------------------------------
	| Connected
	|--------------------------------------------------------------------------
	*/

	else if (connection === "open") {
		console.log(
			`✅ [${sessionId}] Successfully connected to WhatsApp!`
		);

		console.log(
			`📱 [${sessionId}] Ready to receive and process messages`
		);

		notifyOwner(
			null,
			`✅ <b>Bot Connected</b>\n` +
				`━━━━━━━━━━━━━━\n` +
				`🆔 <b>Session:</b> ${escapeHtml(sessionId)}\n` +
				`📱 Successfully connected to WhatsApp.`
		);
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
		| IMPORTANT
		|--------------------------------------------------------------------------
		| Pairing-code system can use the sessionId here.
		|--------------------------------------------------------------------------
		*/
	}
};

export default getConnectionUpdate;
