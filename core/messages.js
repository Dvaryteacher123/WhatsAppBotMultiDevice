// =====================================================
// DVARY BOT - MESSAGE HANDLER
// Multi-Session Compatible
// =====================================================

import dotenv from "dotenv";
dotenv.config();

import messageQueue from "../queue/messageQueue.js";
import notifyOwner from "../notify/owner.js";
import { escapeHtml } from "../notify/telegram.js";
import { readFileEfficiently } from "../utils/file.js";
import { getGroupMeta, setGroupMeta, checkRateLimit } from "../cache/redisCache.js";

const prefix = process.env.PREFIX || ".";

const moderatos = (process.env.MODERATORS || "")
	.split(",")
	.map((x) => x.trim())
	.filter(Boolean);

import getGroupAdmins from "../utils/groupAdmins.js";
import { extractPhoneNumber, getPNFromLID } from "../utils/lid.js";

import {
	createMembersData,
	getMemberData,
	member,
} from "../db/members.js";

import {
	createGroupData,
	getGroupData,
	group,
} from "../db/groupData.js";

import {
	commandsPublic,
	commandsMembers,
	commandsAdmins,
	commandsOwners,
	commandsReadyPromise,
	commandsLoaded,
} from "../utils/commandLoader.js";

import { getBotData } from "../db/botData.js";
import { saveChatMessage } from "../utils/chatLogger.js";
import { getRankUp } from "../utils/ranks.js";

// =====================================================
// GET NUMBERS FROM SOCKET
// Each WhatsApp session gets its own bot number.
// =====================================================

const getSocketNumbers = (sock) => {
	const numbers = [];

	try {
		const meId = sock?.user?.id;

		if (meId) {
			const cleanMe = String(meId).split(":")[0];

			if (cleanMe) {
				numbers.push(`${cleanMe}@s.whatsapp.net`);
			}
		}

		const lid = sock?.user?.lid;

		if (lid) {
			const cleanLid = String(lid).split(":")[0];

			if (cleanLid) {
				numbers.push(`${cleanLid}@lid`);
			}
		}
	} catch (error) {
		console.error(
			"❌ Error getting socket numbers:",
			error.message,
		);
	}

	return [...new Set(numbers)];
};

// =====================================================
// LEGACY ENV NUMBERS
// Used only as fallback for permission compatibility.
// =====================================================

const getEnvNumbers = () => {
	const myNumbers = [];
	const botNumbers = [];

	try {
		const myRaw = process.env.MY_NUMBER || "";

		myRaw
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean)
			.forEach((number, index) => {
				if (number.includes("@")) {
					myNumbers.push(number);
				} else if (index === 0) {
					myNumbers.push(`${number}@s.whatsapp.net`);
				} else {
					myNumbers.push(`${number}@lid`);
				}
			});
	} catch {}

	try {
		const botRaw = process.env.BOT_NUMBER || "";

		botRaw
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean)
			.forEach((number, index) => {
				if (number.includes("@")) {
					botNumbers.push(number);
				} else if (index === 0) {
					botNumbers.push(`${number}@s.whatsapp.net`);
				} else {
					botNumbers.push(`${number}@lid`);
				}
			});
	} catch {}

	return {
		myNumbers: [...new Set(myNumbers)],
		botNumbers: [...new Set(botNumbers)],
	};
};

// =====================================================
// TAG STICKER CACHE
// =====================================================

let _tagStickerBuffer = null;

const getTagSticker = async () => {
	if (!_tagStickerBuffer) {
		_tagStickerBuffer = await readFileEfficiently(
			"./media/tag.webp",
		);
	}

	return _tagStickerBuffer;
};

// =====================================================
// MESSAGE QUEUE HELPER
// =====================================================

const enqueueMessage = async (
	sessionId,
	to,
	doSend,
	priority = 0,
) => {
	/*
	 * Multi-session queue support.
	 *
	 * New queue format:
	 * enqueue(sessionId, to, doSend, priority)
	 *
	 * If the current queue still uses the old format:
	 * enqueue(to, doSend, priority)
	 *
	 * the fallback keeps old installations working temporarily.
	 */

	try {
		if (
			typeof messageQueue.enqueue !== "function"
		) {
			throw new Error(
				"messageQueue.enqueue is not available",
			);
		}

		// New multi-session queue
		if (messageQueue.multiSession === true) {
			return await messageQueue.enqueue(
				sessionId,
				to,
				doSend,
				priority,
			);
		}

		// If queue exposes session-aware method
		if (
			typeof messageQueue.enqueueSession ===
			"function"
		) {
			return await messageQueue.enqueueSession(
				sessionId,
				to,
				doSend,
				priority,
			);
		}

		// Legacy queue
		return await messageQueue.enqueue(
			to,
			doSend,
			priority,
		);
	} catch (error) {
		console.error(
			"[message queue error]",
			error.message,
		);

		throw error;
	}
};

// =====================================================
// MAIN COMMAND HANDLER
// =====================================================

const getCommand = async (
	sock,
	msg,
	cache,
	sessionId = "default",
) => {
	if (!commandsLoaded) {
		await commandsReadyPromise;
	}

	const startTime = process.hrtime();

	try {
		// -------------------------------------------------
		// SOCKET VALIDATION
		// -------------------------------------------------

		if (!sock || !sock.user) return;
		if (!msg?.message) return;

		const messageKeys = Object.keys(msg.message);

		if (messageKeys.length === 0) return;

		if (
			msg.key?.fromMe &&
			!msg.key?.remoteJid
		) {
			return;
		}

		// -------------------------------------------------
		// SESSION INFORMATION
		// -------------------------------------------------

		sessionId =
			sessionId ||
			sock.sessionId ||
			"default";

		// -------------------------------------------------
		// BOT NUMBERS
		// -------------------------------------------------

		const socketBotNumbers =
			getSocketNumbers(sock);

		const envNumbers =
			getEnvNumbers();

		const botNumber =
			socketBotNumbers.length > 0
				? socketBotNumbers
				: envNumbers.botNumbers;

		/*
		 * Owner numbers remain global for now.
		 * Later we can make owner data per account/user.
		 */
		const myNumber =
			envNumbers.myNumbers;

		// -------------------------------------------------
		// CONTENT TYPES
		// -------------------------------------------------

		const _contentTypes = new Set([
			"conversation",
			"imageMessage",
			"videoMessage",
			"extendedTextMessage",
			"buttonsResponseMessage",
			"templateButtonReplyMessage",
			"listResponseMessage",
			"stickerMessage",
			"documentMessage",
			"audioMessage",
		]);

		// =================================================
		// SEND MESSAGE WITH TYPING
		// =================================================

		const sendMessageWTyping = async (
			to,
			msgObj,
			messageOptions = {},
		) => {
			try {
				if (!to || !msgObj) return;

				if (!sock || !sock.user) {
					console.error(
						`❌ Socket unavailable for session: ${sessionId}`,
					);

					return;
				}

				const mediaTypes = [
					"sticker",
					"image",
					"audio",
					"video",
					"document",
				];

				const messageType =
					Object.keys(msgObj)[0];

				const isGroupChat =
					to.endsWith("@g.us");

				// ------------------------------------------------
				// LOAD MEDIA FROM FILE PATH
				// ------------------------------------------------

				if (
					mediaTypes.includes(messageType)
				) {
					if (
						typeof msgObj[messageType] ===
						"string"
					) {
						try {
							msgObj[messageType] =
								await readFileEfficiently(
									msgObj[messageType],
								);
						} catch (readErr) {
							console.error(
								"❌ Error reading media file:",
								readErr.message,
							);

							throw readErr;
						}
					}
				}

				// ------------------------------------------------
				// ACTUAL SEND
				// ------------------------------------------------

				const doSend = async () => {
					if (!isGroupChat) {
						sock
							.presenceSubscribe(to)
							.catch(() => {});

						await new Promise(
							(resolve) =>
								setTimeout(
									resolve,
									300,
								),
						);

						sock
							.sendPresenceUpdate(
								"composing",
								to,
							)
							.catch(() => {});

						await new Promise(
							(resolve) =>
								setTimeout(
									resolve,
									500,
								),
						);
					}

					try {
						const sendOptions = {
							...messageOptions,
							mediaUploadTimeoutMs:
								isGroupChat
									? 1000 * 60 * 10
									: 1000 * 60 * 5,
						};

						await sock.sendMessage(
							to,
							msgObj,
							sendOptions,
						);
					} catch (err) {
						console.error(
							`❌ Error sending message [${sessionId}]:`,
							err.message,
						);

						throw err;
					} finally {
						if (!isGroupChat) {
							sock
								.sendPresenceUpdate(
									"paused",
									to,
								)
								.catch(() => {});
						}
					}
				};

				// ------------------------------------------------
				// QUEUE MESSAGE
				// ------------------------------------------------

				if (isGroupChat) {
					const priority =
						mediaTypes.includes(
							messageType,
						)
							? 2
							: 1;

					enqueueMessage(
						sessionId,
						to,
						doSend,
						priority,
					).catch((e) =>
						console.error(
							"[queue enqueue error]",
							e.message,
						),
					);

					return;
				}

				await enqueueMessage(
					sessionId,
					to,
					doSend,
					0,
				);

				return;
			} catch (error) {
				console.error(
					"❌ Error in sendMessageWTyping:",
					error.message,
				);

				throw error;
			}
		};

		// =================================================
		// MESSAGE INFORMATION
		// =================================================

		const from =
			msg.key?.remoteJid;

		if (!from) return;

		const content =
			JSON.stringify(msg.message);

		const type =
			messageKeys.find((key) =>
				_contentTypes.has(key),
			) ?? messageKeys[0];

		const m = msg.message || {};

		const bodyMap = {
			conversation:
				m.conversation,

			imageMessage:
				m.imageMessage?.caption,

			videoMessage:
				m.videoMessage?.caption,

			extendedTextMessage:
				m.extendedTextMessage?.text,

			buttonsResponseMessage:
				m.buttonsResponseMessage
					?.selectedDisplayText,

			templateButtonReplyMessage:
				m.templateButtonReplyMessage
					?.selectedDisplayText,

			listResponseMessage:
				m.listResponseMessage
					?.title,
		};

		let body =
			bodyMap[type] ?? "";

		body = String(body).trim();

		const types = [
			"conversation",
			"imageMessage",
			"videoMessage",
			"extendedTextMessage",
			"buttonsResponseMessage",
			"templateButtonReplyMessage",
			"listResponseMessage",
			"stickerMessage",
			"documentMessage",
		];

		const extendedMessageOriginal =
			type === "extendedTextMessage"
				? msg.message
						.extendedTextMessage
						.contextInfo
				: null;

		if (!types.includes(type)) {
			return;
		}

		// =================================================
		// BUTTON / LIST COMMANDS
		// =================================================

		if (
			type === "buttonsResponseMessage"
		) {
			if (
				msg.message
					.buttonsResponseMessage
					.selectedButtonId ===
				"eva"
			) {
				body = body.startsWith(
					prefix,
				)
					? body
					: prefix + body;
			}
		} else if (
			type ===
			"templateButtonReplyMessage"
		) {
			body = body.startsWith(
				prefix,
			)
				? body
				: prefix + body;
		} else if (
			type === "listResponseMessage"
		) {
			if (
				msg.message
					.listResponseMessage
					.singleSelectReply
					.selectedRowId ===
				"eva"
			) {
				body = body.startsWith(
					prefix,
				)
					? body
					: prefix + body;
			}
		}

		// =================================================
		// COMMAND PARSING
		// =================================================

		if (body[1] === " ") {
			body =
				body[0] +
				body.slice(2);
		}

		const isCmd =
			body.startsWith(prefix);

		const evv = body
			.trim()
			.split(/ +/)
			.slice(isCmd ? 1 : 0)
			.join(" ");

		const command = body
			.slice(1)
			.trim()
			.split(/ +/)
			.shift()
			.toLowerCase();

		const args = body
			.trim()
			.split(/ +/)
			.slice(1);

		// =================================================
		// SENDER
		// =================================================

		const isGroup =
			from.endsWith("@g.us");

		const senderJid = isGroup
			? msg.key.participant
			: msg.key.remoteJid;

		if (
			!senderJid ||
			!senderJid.includes("@")
		) {
			return;
		}

		const isOwner =
			myNumber.includes(
				senderJid,
			) ||
			botNumber.includes(
				senderJid,
			);

		const updateId =
			msg.key.fromMe
				? botNumber[0]
				: senderJid;

		const updateName =
			msg.key.fromMe
				? sock.user.name
				: msg.pushName;

		// =================================================
		// MEDIA TYPE
		// =================================================

		const mediaTypeField =
			type === "conversation" ||
			type === "extendedTextMessage"
				? "texttotal"
				: type === "imageMessage"
					? "imagetotal"
					: type === "videoMessage"
						? "videototal"
						: type ===
							  "stickerMessage"
							? "stickertotal"
							: type ===
								  "documentMessage"
								? "pdftotal"
								: null;

		// =================================================
		// MEMBER MESSAGE COUNT
		// =================================================

		if (mediaTypeField) {
			let updatedDoc = null;

			try {
				[updatedDoc] =
					await Promise.all([
						member.findOneAndUpdate(
							{ _id: updateId },
							{
								$inc: {
									totalmsg: 1,
									[mediaTypeField]: 1,
								},
								$set: {
									username:
										updateName,
								},
							},
							{
								returnDocument:
									"after",
							},
						),

						createMembersData(
							updateId,
							updateName,
						),
					]);
			} catch (e) {
				console.error(
					"[member update error]",
					e.message,
				);
			}

			// ------------------------------------------------
			// GROUP MEMBER COUNT
			// ------------------------------------------------

			if (isGroup) {
				setImmediate(
					async () => {
						try {
							const snapId =
								updateId;

							const updated =
								await group.findOneAndUpdate(
									{
										_id: from,
										"members.id":
											updateId,
									},
									{
										$inc: {
											"members.$.count": 1,
											[`members.$.${mediaTypeField}`]:
												1,
										},
										$set: {
											"members.$.name":
												updateName,
										},
									},
									{
										returnDocument:
											"after",
									},
								);

							if (!updated) {
								const newMember =
									{
										id: snapId,
										name:
											updateName,
										count: 1,
										texttotal: 0,
										imagetotal: 0,
										videototal: 0,
										stickertotal: 0,
										pdftotal: 0,
									};

								newMember[
									mediaTypeField
								] = 1;

								await group.updateOne(
									{ _id: from },
									{
										$push: {
											members:
												newMember,
										},
									},
								);
							} else {
								const memberEntry =
									updated.members?.find(
										(m) =>
											m.id ===
											snapId,
									);

								const grpCount =
									memberEntry
										?.count ||
									0;

								const rankUp =
									getRankUp(
										grpCount,
									);

								if (
									rankUp
								) {
									const grpCheck =
										await group.findOne(
											{
												_id: from,
											},
											{
												projection:
													{
														isRankNotifOn:
															1,
													},
											},
										);

									if (
										grpCheck?.isRankNotifOn
									) {
										const text =
											rankUp.congrats
												? `🎉 @${snapId.split("@")[0]} completed *${grpCount.toLocaleString()}* messages in this group! 💎`
												: `🎉 *Rank Up!*\n${rankUp.emoji} *${rankUp.name}*\n@${snapId.split("@")[0]} just hit *${grpCount.toLocaleString()}* messages in this group! 🚀`;

										await sendMessageWTyping(
											from,
											{
												text,
												mentions:
													[
														snapId,
													],
											},
										);
									}
								}
							}

							await group.updateOne(
								{ _id: from },
								{
									$inc: {
										totalMsgCount: 1,
									},
								},
							);
						} catch (e) {
							console.error(
								"[group member update error]",
								e.message,
							);
						}
					},
				);
			}
		}

		// =================================================
		// CHAT LOG
		// =================================================

		const isEvaTrigger =
			body
				.trim()
				.split(" ")[0]
				.toLowerCase() ===
			"eva";

		if (
			isGroup &&
			body &&
			!isCmd &&
			!isEvaTrigger &&
			!msg.key.fromMe &&
			(type === "conversation" ||
				type ===
					"extendedTextMessage")
		) {
			setImmediate(
				async () => {
					try {
						let replyTo =
							null;

						const ctx =
							msg.message
								?.extendedTextMessage
								?.contextInfo;

						if (
							ctx?.quotedMessage
						) {
							const qText =
								ctx.quotedMessage
									.conversation ||
								ctx.quotedMessage
									.extendedTextMessage
									?.text ||
								"";

							const qSender =
								ctx.participant ||
								"";

							let qName =
								"";

							if (
								qSender
							) {
								const qMember =
									await getMemberData(
										qSender,
									).catch(
										() =>
											null,
									);

								qName =
									qMember
										?.username ||
									"";
							}

							replyTo = {
								sender:
									qSender,
								senderName:
									qName,
								text: qText,
							};
						}

						let mentions =
							[];

						const mentionedJids =
							ctx?.mentionedJid ||
							[];

						if (
							mentionedJids.length >
							0
						) {
							mentions =
								await Promise.all(
									mentionedJids.map(
										async (
											jid,
										) => {
											const memberData =
												await getMemberData(
													jid,
												).catch(
													() =>
														null,
												);

											return {
												jid,
												name:
													memberData?.username ||
													jid.split(
														"@",
													)[0],
											};
										},
									),
								);
						}

						await saveChatMessage(
							from,
							senderJid,
							updateName ||
								msg.pushName ||
								"",
							body,
							replyTo,
							mentions,
						);
					} catch (e) {
						console.error(
							"[chatLogger error]",
							e.message,
						);
					}
				},
			);
		}

		// =================================================
		// NON COMMAND STICKER/DOCUMENT
		// =================================================

		if (
			!isCmd &&
			(type === "stickerMessage" ||
				type ===
					"documentMessage")
		) {
			return;
		}

		// =================================================
		// GROUP METADATA
		// =================================================

		let groupMetadata = "";
		let groupData = "";

		if (isGroup) {
			groupMetadata =
				(await getGroupMeta(from)) ||
				cache.get(
					from +
						":groupMetadata",
				);

			if (!groupMetadata) {
				try {
					groupMetadata =
						await Promise.race([
							sock.groupMetadata(
								from,
							),

							new Promise(
								(_, reject) =>
									setTimeout(
										() =>
											reject(
												new Error(
													"Group metadata fetch timeout",
												),
											),
										2000,
									),
							),
						]);

					setGroupMeta(
						from,
						groupMetadata,
					);

					cache.set(
						from +
							":groupMetadata",
						groupMetadata,
						10 * 60,
					);

					createGroupData(
						from,
						groupMetadata,
					).catch((e) =>
						console.error(
							"[createGroupData error]",
							e.message,
						),
					);
				} catch (e) {
					console.error(
						"Group metadata fetch failed:",
						e.message,
					);

					groupMetadata = {
						participants: [],
					};
				}
			}
		}

		// =================================================
		// TAG BOT
		// =================================================

		if (
			msg.message
				.extendedTextMessage
		) {
			const rawMentioned =
				msg.message
					.extendedTextMessage
					.contextInfo
					?.mentionedJid;

			const mentioned =
				Array.isArray(
					rawMentioned,
				)
					? rawMentioned
					: rawMentioned
						? [rawMentioned]
						: [];

			if (
				mentioned.some((jid) =>
					botNumber.includes(
						jid,
					),
				)
			) {
				try {
					const stickerBuffer =
						await getTagSticker();

					sendMessageWTyping(
						from,
						{
							sticker:
								stickerBuffer,
						},
						{
							quoted: msg,
						},
					);
				} catch (err) {
					console.error(
						"Failed to send tag sticker:",
						err.message,
					);
				}
			}
		}

		// =================================================
		// SENDER DATA
		// =================================================

		const senderNumber =
			senderJid.includes(":")
				? senderJid.split(":")[0]
				: senderJid.split("@")[0];

		if (senderJid !== updateId) {
			createMembersData(
				senderJid,
				msg.pushName,
			);
		}

		let senderData = null;
		let groupDataFetched = null;

		try {
			[
				senderData,
				groupDataFetched,
			] = await Promise.all([
				getMemberData(
					senderJid,
				),

				isGroup
					? getGroupData(from)
					: Promise.resolve(""),
			]);
		} catch (e) {
			senderData = null;
			groupDataFetched = null;
		}

		if (isGroup) {
			groupData =
				groupDataFetched;
		}

		// =================================================
		// AUTO STICKER
		// =================================================

		if (
			isGroup &&
			type === "imageMessage" &&
			groupData?.isAutoStickerOn
		) {
			if (
				msg.message.imageMessage
					.caption === ""
			) {
				commandsPublic[
					"sticker"
				](
					sock,
					msg,
					from,
					args,
					{
						senderJid,
						type,
						content,
						isGroup,
						sendMessageWTyping,
						evv,
						sessionId,
					},
				);
			}
		}

		// =================================================
		// BLOCKED MEMBER
		// =================================================

		if (senderData?.isBlock) {
			return;
		}

		// =================================================
		// GROUP ADMINS
		// =================================================

		const groupAdmins =
			isGroup
				? getGroupAdmins(
						groupMetadata.participants,
					)
				: "";

		const isGroupAdmin =
			groupAdmins?.includes(
				senderJid,
			) || false;

		// =================================================
		// CHAT BOT / EVA
		// =================================================

		const isChatBotOn =
			groupData
				? groupData.isChatBotOn
				: false;

		if (
			isGroup &&
			isChatBotOn &&
			(type ===
				"conversation" ||
				type ===
					"extendedTextMessage")
		) {
			let isTaggedBot = false;
			let tagMessage = null;

			if (
				type ===
				"extendedTextMessage"
			) {
				const tagMessageSenderJID =
					msg.message
						?.extendedTextMessage
						?.contextInfo
						?.participant;

				isTaggedBot =
					botNumber.includes(
						tagMessageSenderJID,
					);

				tagMessage =
					msg.message
						?.extendedTextMessage
						?.contextInfo
						?.quotedMessage;
			}

			if (
				body
					.split(" ")[0]
					.toLowerCase() ===
					"eva" ||
				(isTaggedBot &&
					tagMessage &&
					Object.keys(
						tagMessage,
					)[0] ===
						"conversation" &&
					tagMessage?.conversation?.startsWith(
						"_*Eva:*_",
					))
			) {
				commandsPublic[
					"eva"
				](
					sock,
					msg,
					from,
					args,
					{
						sendMessageWTyping,
						command,
						updateName:
							updateName ===
								"" ||
							updateName ==
								null ||
							updateName ===
								undefined
								? senderData?.username
								: updateName,
						updateId,
						senderJid,
						groupMetadata,
						groupAdmins,
						isGroup,
						evv,
						isOwner,
						sessionId,
					},
				);

				notifyOwner(
					sock,
					`🤖 <b>Command Used</b>\n` +
						`━━━━━━━━━━━━━━\n` +
						`📌 <b>Command:</b> <code>chat</code>\n` +
						`👤 <b>User:</b> ${escapeHtml(
							msg.pushName ||
								"",
						)}\n` +
						`📱 <b>ID:</b> <code>${escapeHtml(
							senderJid,
						)}</code>\n` +
						`💬 <b>In:</b> ${escapeHtml(
							groupMetadata.subject ||
								"",
						)}\n` +
						`🆔 <b>Session:</b> <code>${escapeHtml(
							sessionId,
						)}</code>`,
					msg,
				);
			}
		}

		// =================================================
		// NO COMMAND
		// =================================================

		if (!isCmd) return;

		// =================================================
		// MARK AS READ
		// =================================================

		sock
			.readMessages([
				msg.key,
			])
			.catch(() => {});

		// =================================================
		// COMMAND INFO
		// =================================================

		const msgInfoObj = {
			prefix,
			type,
			content,
			evv,
			command,
			isGroup,
			senderJid,
			groupMetadata,
			groupAdmins,
			isGroupAdmin,
			botNumber,
			sendMessageWTyping,
			notifyOwner,
			updateName,
			updateId,
			isOwner,
			startTime,
			extendedMessageOriginal,

			// Multi-session information
			sessionId,
			sock,
		};

		// =================================================
		// DISPLAY PHONE
		// =================================================

		let displayFrom = senderJid;

		try {
			if (
				senderJid.endsWith(
					"@s.whatsapp.net",
				)
			) {
				displayFrom =
					extractPhoneNumber(
						senderJid,
					);
			} else {
				displayFrom =
					extractPhoneNumber(
						(await Promise.resolve(
							getPNFromLID(
								sock,
								senderJid,
							),
						)) ||
							senderJid,
					);
			}
		} catch {
			displayFrom =
				extractPhoneNumber(
					senderJid,
				);
		}

		console.log(
			"[COMMAND]",
			command,
			"[SESSION]",
			sessionId,
			"[FROM]",
			displayFrom,
			"[name]",
			msg.pushName,
			"[IN]",
			isGroup
				? groupMetadata.subject
				: "Directs",
		);

		// =================================================
		// OWNER NOTIFICATION
		// =================================================

		notifyOwner(
			sock,
			`🤖 <b>Command Used</b>\n` +
				`━━━━━━━━━━━━━━\n` +
				`📌 <b>Command:</b> <code>${escapeHtml(
					command,
				)}</code>\n` +
				`👤 <b>User:</b> ${escapeHtml(
					msg.pushName ||
						"",
				)}\n` +
				`📱 <b>ID:</b> <code>${escapeHtml(
					displayFrom,
				)}</code>\n` +
				`💬 <b>In:</b> ${escapeHtml(
					isGroup
						? groupMetadata.subject ||
								"Group"
						: "Direct Message",
				)}\n` +
				`🆔 <b>Session:</b> <code>${escapeHtml(
					sessionId,
				)}</code>`,
			msg,
		);

		// =================================================
		// GLOBAL COMMAND DISABLE
		// =================================================

		if (command !== "") {
			const botData =
				await getBotData();

			const globallyDisabled =
				botData?.disabledGlobally ||
				[];

			if (
				globallyDisabled.includes(
					command,
				)
			) {
				return sendMessageWTyping(
					from,
					{
						text: `🚫 This command is globally disabled.`,
					},
					{
						quoted: msg,
					},
				);
			}
		}

		// =================================================
		// GROUP SETTINGS
		// =================================================

		if (isGroup) {
			const resBotOn =
				groupData
					? await groupData.isBotOn
					: false;

			if (
				resBotOn === false &&
				!(
					command.startsWith(
						"group",
					) ||
					command.startsWith(
						"dev",
					)
				)
			) {
				return sendMessageWTyping(
					from,
					{
						text:
							"```By default, bot is turned off in this group.\nAsk the Owner to activate.\n\nUse ```" +
							prefix +
							"dev",
					},
				);
			}

			const blockCommandsInDB =
				(await groupData?.cmdBlocked) ||
				[];

			if (
				command !== "" &&
				blockCommandsInDB.includes(
					command,
				)
			) {
				return sendMessageWTyping(
					from,
					{
						text: `Command blocked for this group.`,
					},
					{
						quoted: msg,
					},
				);
			}
		}

		// =================================================
		// ADMIN DASHBOARD ACTIVITY
		// =================================================

		const {
			pushActivity,
			cmdUsage,
		} = await import(
			"../notify/adminEvents.js"
		);

		if (
			commandsPublic[command] ||
			commandsMembers[command] ||
			commandsAdmins[command] ||
			commandsOwners[command]
		) {
			cmdUsage.set(
				command,
				(cmdUsage.get(command) || 0) +
					1,
			);

			pushActivity(
				"command_used",
				{
					cmd: command,
					from: senderJid,
					name:
						msg.pushName ||
						senderJid.split(
							"@",
						)[0],
					group: isGroup
						? groupMetadata?.subject ||
							"Group"
						: "DM",

					// Multi-session
					sessionId,
				},
			);
		}

		// =================================================
		// PUBLIC COMMANDS
		// =================================================

		if (
			commandsPublic[command]
		) {
			const t0 =
				Date.now();

			const result =
				await commandsPublic[
					command
				](
					sock,
					msg,
					from,
					args,
					msgInfoObj,
				);

			const t1 =
				Date.now();

			console.log(
				`[PROFILE] Command '${command}' (public) [${sessionId}] took ${
					t1 - t0
				}ms`,
			);

			return result;
		}

		// =================================================
		// MEMBER COMMANDS
		// =================================================

		if (
			commandsMembers[command]
		) {
			const t0 =
				Date.now();

			let result;

			if (
				isGroup ||
				msg.key.fromMe
			) {
				result =
					await commandsMembers[
						command
					](
						sock,
						msg,
						from,
						args,
						msgInfoObj,
					);
			} else {
				result =
					await sendMessageWTyping(
						from,
						{
							text: "```❎ This command is only applicable in Groups!```",
						},
						{
							quoted: msg,
						},
					);
			}

			const t1 =
				Date.now();

			console.log(
				`[PROFILE] Command '${command}' (members) [${sessionId}] took ${
					t1 - t0
				}ms`,
			);

			return result;
		}

		// =================================================
		// ADMIN COMMANDS
		// =================================================

		if (
			commandsAdmins[command]
		) {
			const t0 =
				Date.now();

			let result;

			if (!isGroup) {
				result =
					await sendMessageWTyping(
						from,
						{
							text: "```❎ This command is only applicable in Groups!```",
						},
						{
							quoted: msg,
						},
					);
			} else if (
				isGroupAdmin ||
				moderatos.includes(
					senderNumber,
				) ||
				myNumber.includes(
					senderJid,
				) ||
				botNumber.includes(
					senderJid,
				)
			) {
				result =
					await commandsAdmins[
						command
					](
						sock,
						msg,
						from,
						args,
						msgInfoObj,
					);
			} else {
				result =
					await sendMessageWTyping(
						from,
						{
							text: "```🤭 kya matlab tum admin nhi ho.```",
						},
						{
							quoted: msg,
						},
					);
			}

			const t1 =
				Date.now();

			console.log(
				`[PROFILE] Command '${command}' (admins) [${sessionId}] took ${
					t1 - t0
				}ms`,
			);

			return result;
		}

		// =================================================
		// OWNER COMMANDS
		// =================================================

		if (
			commandsOwners[command]
		) {
			const t0 =
				Date.now();

			let result;

			if (
				moderatos.includes(
					senderNumber,
				) ||
				myNumber.includes(
					senderJid,
				) ||
				botNumber.includes(
					senderJid,
				)
			) {
				result =
					await commandsOwners[
						command
					](
						sock,
						msg,
						from,
						args,
						msgInfoObj,
					);
			} else {
				result =
					await sendMessageWTyping(
						from,
						{
							text: "```🤭 kya matlab tum mere owner nhi ho.```",
						},
						{
							quoted: msg,
						},
					);
			}

			const t1 =
				Date.now();

			console.log(
				`[PROFILE] Command '${command}' (owners) [${sessionId}] took ${
					t1 - t0
				}ms`,
			);

			return result;
		}

		// =================================================
		// UNKNOWN COMMAND / SUGGESTION
		// =================================================

		const allCmds = [
			...Object.keys(
				commandsPublic,
			),
			...Object.keys(
				commandsMembers,
			),
			...Object.keys(
				commandsAdmins,
			),
			...Object.keys(
				commandsOwners,
			),
		];

		const lev = (a, b) => {
			const dp = Array.from(
				{
					length:
						a.length + 1,
				},
				(_, i) =>
					Array.from(
						{
							length:
								b.length + 1,
						},
						(_, j) =>
							i === 0
								? j
								: j === 0
									? i
									: 0,
					),
			);

			for (
				let i = 1;
				i <= a.length;
				i++
			) {
				for (
					let j = 1;
					j <= b.length;
					j++
				) {
					dp[i][j] =
						a[i - 1] ===
						b[j - 1]
							? dp[i - 1][
									j - 1
								]
							: 1 +
								Math.min(
									dp[i - 1][
										j
									],
									dp[i][
										j - 1
									],
									dp[i - 1][
										j - 1
									],
								);
				}
			}

			return dp[a.length][
				b.length
			];
		};

		let best = null;
		let bestDist = Infinity;

		for (const c of allCmds) {
			const d = lev(
				command,
				c,
			);

			if (d < bestDist) {
				bestDist = d;
				best = c;
			}
		}

		const threshold =
			Math.max(
				2,
				Math.floor(
					command.length / 2,
				),
			);

		if (
			best &&
			bestDist <= threshold
		) {
			return sendMessageWTyping(
				from,
				{
					text: `Did you mean *${prefix}${best}*?`,
				},
				{
					quoted: msg,
				},
			);
		}

		return sendMessageWTyping(
			from,
			{
				text:
					"```" +
					(msg.pushName ||
						"User") +
					" !!Use " +
					prefix +
					"help ```",
			},
			{
				quoted: msg,
			},
		);
	} catch (error) {
		// =================================================
		// ERROR HANDLER
		// =================================================

		console.error(
			`❌ Error processing message [${sessionId}]:`,
			error.message,
		);

		console.error(
			"📍 Error stack:",
			error.stack,
		);

		console.error(
			"📝 Message details:",
			JSON.stringify(
				{
					sessionId,
					from:
						msg?.key
							?.remoteJid,
					id: msg?.key?.id,
					fromMe:
						msg?.key?.fromMe,
					messageType:
						Object.keys(
							msg?.message ||
								{},
						)[0],
				},
				null,
				2,
			),
		);

		if (
			sock?.user &&
			msg?.key?.remoteJid
		) {
			setTimeout(
				() => {
					sock
						.sendMessage(
							msg.key
								.remoteJid,
							{
								text: "❌ Sorry, I encountered an error processing your message. Please try again.",
							},
							{
								quoted: msg,
							},
						)
						.catch(
							() => {},
						);
				},
				1000,
			);
		}
	}
};

export default getCommand;
