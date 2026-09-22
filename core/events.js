/**
 * =====================================================
 * DVARY BOT - EVENTS
 * Multi-session compatible
 * =====================================================
 */

import getConnectionUpdate from "./connectionUpdate.js";
import getCommand from "./messages.js";
import getGroupEvent from "./groupEvent.js";
import getCallEvent from "./callEvents.js";

const events = async (sock, startSock, cache) => {
	/*
	|--------------------------------------------------------------------------
	| Get session ID from socket
	|--------------------------------------------------------------------------
	*/

	const sessionId = sock?.sessionId || "default";

	console.log(
		`📡 Registering events for session: ${sessionId}`
	);

	/*
	|--------------------------------------------------------------------------
	| Process WhatsApp events
	|--------------------------------------------------------------------------
	*/

	sock.ev.process(async (event) => {
		try {
			/*
			|--------------------------------------------------------------------------
			| Messages
			|--------------------------------------------------------------------------
			*/

			if (event["messages.upsert"]) {
				const { type, messages } =
					event["messages.upsert"];

				if (type === "notify") {
					const validMessages = messages.filter(
						(msg) =>
							msg &&
							msg.message &&
							msg.key?.remoteJid &&
							!msg.key.fromMe &&
							Object.keys(msg.message).length > 0
					);

					await Promise.all(
						validMessages.map((msg) =>
							getCommand(
								sock,
								msg,
								cache
							).catch((err) => {
								console.error(
									`❌ [${sessionId}] Error processing message:`,
									err
								);

								console.error(
									`Message key [${sessionId}]:`,
									msg.key
								);
							})
						)
					);
				}
			}

			/*
			|--------------------------------------------------------------------------
			| Connection update
			|--------------------------------------------------------------------------
			*/

			if (event["connection.update"]) {
				await getConnectionUpdate(
					startSock,
					event["connection.update"],
					sessionId
				);
			}

			/*
			|--------------------------------------------------------------------------
			| Group participants
			|--------------------------------------------------------------------------
			*/

			if (event["group-participants.update"]) {
				await getGroupEvent(
					sock,
					event["group-participants.update"],
					cache
				);
			}

			/*
			|--------------------------------------------------------------------------
			| Calls
			|--------------------------------------------------------------------------
			*/

			if (event["call"]) {
				await getCallEvent(
					sock,
					event["call"]
				);
			}
		} catch (err) {
			console.error(
				`❌ [${sessionId}] Error processing event:`,
				err
			);

			console.error(
				`Event type [${sessionId}]:`,
				Object.keys(event)
			);
		}
	});
};

export default events;
