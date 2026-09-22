/**
 * =====================================================
 * DVARY BOT - EVENTS HANDLER
 * Multi-Session Compatible
 * =====================================================
 */

import getConnectionUpdate from "./connectionUpdate.js";
import getCommand from "./messages.js";
import getGroupEvent from "./groupEvent.js";
import getCallEvent from "./callEvents.js";

/**
 * Handle all WhatsApp socket events
 *
 * @param {object} sock - WhatsApp socket
 * @param {function} startSock - Reconnect function
 * @param {object} cache - NodeCache instance
 * @param {string} sessionId - Unique WhatsApp session ID
 */
const events = async (
	sock,
	startSock,
	cache,
	sessionId = "default",
) => {
	// -------------------------------------------------
	// Make sure session ID exists
	// -------------------------------------------------

	sessionId =
		sessionId ||
		sock?.sessionId ||
		"default";

	console.log(
		`📡 Event handler started for session: ${sessionId}`,
	);

	// -------------------------------------------------
	// Process WhatsApp events
	// -------------------------------------------------

	sock.ev.process(async (event) => {
		try {
			// =================================================
			// MESSAGES
			// =================================================

			if (event["messages.upsert"]) {
				const {
					type,
					messages,
				} =
					event[
						"messages.upsert"
					];

				/*
				 * We only process "notify" messages.
				 *
				 * This prevents duplicate processing
				 * of historical / sync messages.
				 */

				if (
					type ===
					"notify"
				) {
					const validMessages =
						messages.filter(
							(msg) =>
								msg &&
								msg.message &&
								msg.key
									?.remoteJid &&
								!msg.key
									.fromMe &&
								Object.keys(
									msg.message,
								)
									.length >
									0,
						);

					// -------------------------------------------------
					// Process messages in this session
					// -------------------------------------------------

					await Promise.all(
						validMessages.map(
							(msg) =>
								getCommand(
									sock,
									msg,
									cache,
									sessionId,
								).catch(
									(error) => {
										console.error(
											`❌ Command processing error [${sessionId}]:`,
											error
												?.message ||
												error,
										);
									},
								),
						),
					);
				}
			}

			// =================================================
			// CONNECTION UPDATE
			// =================================================

			if (
				event[
					"connection.update"
				]
			) {
				await getConnectionUpdate(
					startSock,
					event[
						"connection.update"
					],
					sessionId,
				);
			}

			// =================================================
			// GROUP PARTICIPANTS UPDATE
			// =================================================

			if (
				event[
					"group-participants.update"
				]
			) {
				await getGroupEvent(
					sock,
					event[
						"group-participants.update"
					],
					cache,
				);
			}

			// =================================================
			// CALL EVENTS
			// =================================================

			if (event["call"]) {
				await getCallEvent(
					sock,
					event["call"],
				);
			}
		} catch (error) {
			// -------------------------------------------------
			// Global event error
			// -------------------------------------------------

			console.error(
				`❌ Event processing error [${sessionId}]:`,
				error?.message ||
					error,
			);

			if (error?.stack) {
				console.error(
					error.stack,
				);
			}
		}
	});
};

export default events;
