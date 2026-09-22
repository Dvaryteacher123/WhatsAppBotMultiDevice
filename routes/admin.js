import { Router } from "express";
import { group } from "../db/groupData.js";
import { member } from "../db/members.js";
import { bot, getBotData } from "../db/botData.js";
import { cmdToText } from "../utils/commandLoader.js";
import mdClient from "../db/client.js";
import passport from "passport";
import { normalizeJID } from "../utils/lid.js";
import messageQueue from "../queue/messageQueue.js";
import {
	pushActivity,
	getLogs,
	getActivity,
	cmdUsage,
} from "../notify/adminEvents.js";
import {
	getCookiesContent,
	saveCookies,
} from "../functions/cookieManager.js";

import {
	startSock,
	getSock,
	getAllSessions,
	stopSession,
	hasSession,
	getSessionStatus,
} from "../connection.js";

const router = Router();

/* ============================================================
   HELPERS
============================================================ */

function cleanPhoneNumber(phoneNumber) {
	return String(phoneNumber || "").replace(/\D/g, "");
}

function makeSessionId(phoneNumber) {
	return `wa_${cleanPhoneNumber(phoneNumber)}`;
}

function getSessionFromRequest(req) {
	return (
		req.body?.sessionId ||
		req.query?.sessionId ||
		req.params?.sessionId ||
		null
	);
}

function getSocket(req, sessionId = null) {
	if (sessionId) {
		return getSock(sessionId);
	}

	return req.app.locals.sock || null;
}

function sessionExists(sessionId) {
	return !!sessionId && hasSession(sessionId);
}

/* ============================================================
   ADMIN AUTH
============================================================ */

function requireAdmin(req, res, next) {
	if (req.session && req.session.isAdmin) {
		return next();
	}

	if (req.path.startsWith("/api/")) {
		return res.status(401).json({
			error: "Unauthorized",
		});
	}

	return res.redirect("/admin/login");
}

/* ============================================================
   PUBLIC STATUS
============================================================ */

router.get("/api/status", (req, res) => {
	try {
		const sessionId =
			req.query.sessionId ||
			"default";

		const sock = getSock(sessionId);

		res.json({
			sessionId,
			connected: !!sock?.user,
			registered: !!sock?.authState?.creds?.registered,
		});
	} catch (err) {
		res.status(500).json({
			error: err.message,
		});
	}
});

/* ============================================================
   PUBLIC PAIRING
   Each phone gets its own session
============================================================ */

router.post("/api/pair", async (req, res) => {
	try {
		const { phoneNumber } = req.body;

		if (!phoneNumber) {
			return res.status(400).json({
				error: "Phone number required.",
			});
		}

		const clean = cleanPhoneNumber(phoneNumber);

		if (clean.length < 7) {
			return res.status(400).json({
				error:
					"Invalid phone number. Include country code and use digits only.",
			});
		}

		const sessionId = makeSessionId(clean);

		let sock = getSock(sessionId);

		/*
		 * If this session already has a connected socket,
		 * don't generate another pairing code.
		 */
		if (sock?.user) {
			return res.status(400).json({
				error:
					"This WhatsApp number is already connected.",
				sessionId,
			});
		}

		/*
		 * If socket doesn't exist, create it.
		 */
		if (!sock) {
			sock = await startSock(
				sessionId,
				"pairing"
			);
		}

		if (!sock) {
			return res.status(503).json({
				error:
					"Unable to create WhatsApp session.",
			});
		}

		/*
		 * If already registered, pairing code is not needed.
		 */
		if (sock.authState?.creds?.registered) {
			return res.status(400).json({
				error:
					"This WhatsApp session is already registered.",
				sessionId,
			});
		}

		const code =
			await sock.requestPairingCode(clean);

		res.json({
			ok: true,
			sessionId,
			phoneNumber: clean,
			code,
		});
	} catch (err) {
		console.error(
			"❌ Public pairing error:",
			err
		);

		res.status(500).json({
			error:
				err.message ||
				"Failed to generate pairing code.",
		});
	}
});

/* ============================================================
   ADMIN ME
============================================================ */

router.get("/api/admin/me", (req, res) => {
	const googleAuthEnabled =
		!!req.app.locals.googleAuthEnabled;

	if (req.session?.isAdmin) {
		return res.json({
			authenticated: true,
			googleAuthEnabled,
		});
	}

	res.status(401).json({
		authenticated: false,
		googleAuthEnabled,
	});
});

/* ============================================================
   ADMIN LOGIN
============================================================ */

router.post("/api/admin/login", (req, res) => {
	const { password } = req.body;

	if (
		password &&
		password === process.env.ADMIN_PASSWORD
	) {
		req.session.isAdmin = true;

		return res.json({
			ok: true,
		});
	}

	res.status(401).json({
		error: "Incorrect password.",
	});
});

/* ============================================================
   ADMIN LOGOUT
============================================================ */

router.post("/api/admin/logout", (req, res) => {
	req.session.destroy(() => {
		res.json({
			ok: true,
		});
	});
});

/* ============================================================
   LEGACY LOGIN
============================================================ */

router.get("/admin/login", (req, res) => {
	if (req.session?.isAdmin) {
		return res.redirect("/admin");
	}

	res.redirect("/admin/#/login");
});

router.post("/admin/login", (req, res) => {
	const { password } = req.body;

	if (
		password &&
		password === process.env.ADMIN_PASSWORD
	) {
		req.session.isAdmin = true;

		return res.redirect("/admin");
	}

	res.render("login", {
		error: "Incorrect password.",
	});
});

router.post("/admin/logout", (req, res) => {
	req.session.destroy(() => {
		res.redirect("/admin/login");
	});
});

/* ============================================================
   GOOGLE OAUTH
============================================================ */

if (
	process.env.GOOGLE_CLIENT_ID &&
	process.env.GOOGLE_CLIENT_SECRET
) {
	router.get(
		"/auth/google",
		passport.authenticate("google", {
			scope: ["profile", "email"],
		})
	);

	router.get(
		"/auth/google/callback",
		passport.authenticate("google", {
			failureRedirect:
				"/admin/#/login?error=google_failed",
			failureMessage: true,
		}),
		(req, res) => {
			const email =
				req.user?.emails?.[0]?.value ||
				"";

			const allowed = (
				process.env.GOOGLE_ALLOWED_EMAILS ||
				""
			)
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);

			if (!allowed.includes(email)) {
				req.logout(() => {});

				return res
					.status(401)
					.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>401 – Not Authorised</title>

<style>
*{
	box-sizing:border-box;
	margin:0;
	padding:0;
}

body{
	background:#080c14;
	color:#f1f5f9;
	font-family:system-ui,sans-serif;
	min-height:100vh;
	display:flex;
	align-items:center;
	justify-content:center;
}

.card{
	background:#0d1420;
	border:1px solid rgba(255,255,255,.07);
	border-radius:16px;
	padding:48px 40px;
	text-align:center;
	max-width:420px;
	width:90%;
}

.code{
	font-size:72px;
	font-weight:700;
	color:#ef4444;
	line-height:1;
}

h1{
	font-size:22px;
	margin:16px 0 8px;
}

p{
	color:#94a3b8;
	font-size:14px;
	line-height:1.6;
}

.email{
	background:#121c2c;
	border:1px solid rgba(239,68,68,.3);
	color:#ef4444;
	border-radius:8px;
	padding:8px 14px;
	display:inline-block;
	margin:14px 0;
	font-size:13px;
	word-break:break-all;
}

a{
	display:inline-block;
	margin-top:24px;
	padding:10px 24px;
	background:#3b82f6;
	color:#fff;
	border-radius:8px;
	text-decoration:none;
	font-size:14px;
}

a:hover{
	background:#2563eb;
}
</style>
</head>

<body>

<div class="card">

<div class="code">401</div>

<h1>Not Authorised</h1>

<p>
This Google account is not allowed to access
the admin panel.
</p>

<div class="email">
${email}
</div>

<p>
Contact the bot owner to get access.
</p>

<a href="/auth/google">
Try a different account
</a>

</div>

</body>
</html>
`);
			}

			req.session.isAdmin = true;

			res.redirect("/admin/");
		}
	);
}

/* ============================================================
   MULTI SESSION LIST
============================================================ */

router.get(
	"/api/admin/sessions",
	requireAdmin,
	(req, res) => {
		try {
			const sessions = getAllSessions();

			const result = sessions.map(
				(session) => {
					const sock =
						session.sock;

					return {
						sessionId:
							session.sessionId,

						connected:
							!!sock?.user,

						registered:
							!!sock?.authState
								?.creds
								?.registered,

						user:
							sock?.user
								? {
										id:
											sock.user.id,
										name:
											sock.user.name ||
											null,
								  }
								: null,
					};
				}
			);

			res.json({
				ok: true,
				sessions: result,
				total: result.length,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   SESSION STATUS
============================================================ */

router.get(
	"/api/admin/sessions/:sessionId",
	requireAdmin,
	(req, res) => {
		try {
			const { sessionId } =
				req.params;

			if (!sessionId) {
				return res.status(400).json({
					error: "sessionId required.",
				});
			}

			const status =
				getSessionStatus(
					sessionId
				);

			res.json({
				ok: true,
				...status,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   CREATE / PAIR SESSION
============================================================ */

router.post(
	"/api/admin/sessions/pair",
	requireAdmin,
	async (req, res) => {
		try {
			const { phoneNumber } =
				req.body;

			if (!phoneNumber) {
				return res.status(400).json({
					error:
						"Phone number is required.",
				});
			}

			const clean =
				cleanPhoneNumber(
					phoneNumber
				);

			if (clean.length < 7) {
				return res.status(400).json({
					error:
						"Invalid phone number.",
				});
			}

			const sessionId =
				makeSessionId(clean);

			let sock =
				getSock(sessionId);

			if (sock?.user) {
				return res.status(400).json({
					error:
						"This WhatsApp number is already connected.",
					sessionId,
				});
			}

			if (!sock) {
				sock =
					await startSock(
						sessionId,
						"admin-pairing"
					);
			}

			if (!sock) {
				return res.status(503).json({
					error:
						"Failed to start WhatsApp session.",
				});
			}

			if (
				sock.authState?.creds
					?.registered
			) {
				return res.status(400).json({
					error:
						"Session is already registered.",
					sessionId,
				});
			}

			const code =
				await sock.requestPairingCode(
					clean
				);

			res.json({
				ok: true,
				sessionId,
				phoneNumber: clean,
				code,
			});
		} catch (err) {
			console.error(
				"❌ Admin pairing error:",
				err
			);

			res.status(500).json({
				error:
					err.message ||
					"Pairing failed.",
			});
		}
	}
);

/* ============================================================
   STOP SESSION
============================================================ */

router.post(
	"/api/admin/sessions/:sessionId/stop",
	requireAdmin,
	async (req, res) => {
		try {
			const { sessionId } =
				req.params;

			if (!sessionExists(sessionId)) {
				return res.status(404).json({
					error:
						"Session not found.",
				});
			}

			await stopSession(sessionId);

			if (
				req.app.locals.socks
			) {
				req.app.locals.socks.delete(
					sessionId
				);
			}

			if (
				req.app.locals.qrs
			) {
				req.app.locals.qrs.delete(
					sessionId
				);
			}

			res.json({
				ok: true,
				sessionId,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   RECONNECT SESSION
============================================================ */

router.post(
	"/api/admin/sessions/:sessionId/reconnect",
	requireAdmin,
	async (req, res) => {
		try {
			const { sessionId } =
				req.params;

			const sock =
				getSock(sessionId);

			if (sock) {
				try {
					await stopSession(
						sessionId
					);
				} catch (_) {}
			}

			const newSock =
				await startSock(
					sessionId,
					"manual-reconnect"
				);

			if (!newSock) {
				return res.status(503).json({
					error:
						"Unable to reconnect session.",
				});
			}

			res.json({
				ok: true,
				sessionId,
				message:
					"Session reconnect started.",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   LOGOUT SESSION
============================================================ */

router.post(
	"/api/admin/sessions/:sessionId/logout",
	requireAdmin,
	async (req, res) => {
		try {
			const { sessionId } =
				req.params;

			const sock =
				getSock(sessionId);

			if (!sock) {
				return res.status(404).json({
					error:
						"Session not found.",
				});
			}

			try {
				await sock.logout(
					"Admin logout"
				);
			} catch (err) {
				console.warn(
					"Logout warning:",
					err.message
				);
			}

			await stopSession(
				sessionId
			);

			req.app.locals.socks?.delete(
				sessionId
			);

			req.app.locals.qrs?.delete(
				sessionId
			);

			res.json({
				ok: true,
				sessionId,
				message:
					"WhatsApp session logged out.",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   API: STATS
============================================================ */

router.get(
	"/api/admin/stats",
	requireAdmin,
	async (req, res) => {
		try {
			const [
				groupCount,
				memberCount,
				botData,
			] = await Promise.all([
				group.countDocuments(),
				member.countDocuments(),
				getBotData(),
			]);

			const sessions =
				getAllSessions();

			res.json({
				uptime:
					Math.floor(
						process.uptime()
					),

				groupCount,

				memberCount,

				sessions:
					sessions.length,

				connectedSessions:
					sessions.filter(
						(s) =>
							!!s.sock?.user
					).length,

				botNumber:
					process.env.BOT_NUMBER
						?.split(",")[0] ||
					"Multi-session",

				disabledGlobally:
					botData
						?.disabledGlobally ||
					[],
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   ANALYTICS
============================================================ */

router.get(
	"/api/admin/analytics",
	requireAdmin,
	async (req, res) => {
		try {
			const [
				groups,
				members,
			] = await Promise.all([
				group
					.find(
						{},
						{
							projection: {
								grpName: 1,
								totalMsgCount: 1,
								isBotOn: 1,
							},
						}
					)
					.toArray(),

				member
					.find({})
					.toArray(),
			]);

			const topGroups =
				[...groups]
					.sort(
						(a, b) =>
							(b.totalMsgCount ||
								0) -
							(a.totalMsgCount ||
								0)
					)
					.slice(0, 10)
					.map((g) => ({
						name: (
							g.grpName ||
							g._id
						).slice(0, 22),

						messages:
							g.totalMsgCount ||
							0,

						active:
							g.isBotOn,
					}));

			const topMembers =
				[...members]
					.sort(
						(a, b) =>
							(b.totalmsg ||
								0) -
							(a.totalmsg ||
								0)
					)
					.slice(0, 10)
					.map((m) => ({
						name: (
							m.username ||
							String(
								m._id
							).split("@")[0]
						).slice(0, 22),

						messages:
							m.totalmsg ||
							0,
					}));

			const typeBreakdown =
				members.reduce(
					(acc, m) => {
						acc.text +=
							m.texttotal ||
							0;

						acc.image +=
							m.imagetotal ||
							0;

						acc.video +=
							m.videototal ||
							0;

						acc.sticker +=
							m.stickertotal ||
							0;

						acc.pdf +=
							m.pdftotal ||
							0;

						return acc;
					},
					{
						text: 0,
						image: 0,
						video: 0,
						sticker: 0,
						pdf: 0,
					}
				);

			const totalMessages =
				Object.values(
					typeBreakdown
				).reduce(
					(a, b) => a + b,
					0
				);

			const activeGroups =
				groups.filter(
					(g) => g.isBotOn
				).length;

			const blockedMembers =
				members.filter(
					(m) => m.isBlock
				).length;

			res.json({
				topGroups,
				topMembers,
				typeBreakdown,
				totalMessages,
				activeGroups,
				blockedMembers,
				totalGroups:
					groups.length,
				totalMembers:
					members.length,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   BOT HEALTH
============================================================ */

router.get(
	"/api/admin/bot/health",
	requireAdmin,
	(req, res) => {
		try {
			const mem =
				process.memoryUsage();

			const sessions =
				getAllSessions();

			res.json({
				uptime:
					Math.floor(
						process.uptime()
					),

				memory: {
					heapUsed:
						mem.heapUsed,
					heapTotal:
						mem.heapTotal,
					rss:
						mem.rss,
					external:
						mem.external,
				},

				connected:
					sessions.some(
						(s) =>
							!!s.sock?.user
					),

				sessions:
					sessions.length,

				connectedSessions:
					sessions.filter(
						(s) =>
							!!s.sock?.user
					).length,

				nodeVersion:
					process.version,

				pid:
					process.pid,

				platform:
					process.platform,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   BROADCAST
   Optional sessionId.
============================================================ */

router.post(
	"/api/admin/broadcast",
	requireAdmin,
	async (req, res) => {
		const {
			message,
			targetJids,
			sessionId,
		} = req.body;

		if (
			!message ||
			!message.trim()
		) {
			return res.status(400).json({
				error:
					"Message is required.",
			});
		}

		const sock =
			getSocket(
				req,
				sessionId
			);

		if (!sock) {
			return res.status(503).json({
				error:
					"Selected WhatsApp session is not connected.",
			});
		}

		try {
			let jids = targetJids;

			if (
				!Array.isArray(jids) ||
				jids.length === 0
			) {
				const activeGroups =
					await group
						.find(
							{ isBotOn: true },
							{
								projection: {
									_id: 1,
								},
							}
						)
						.toArray();

				jids =
					activeGroups.map(
						(g) => g._id
					);
			}

			let sent = 0;
			let failed = 0;

			for (const jid of jids) {
				try {
					await messageQueue.enqueue(
						jid,
						() =>
							sock.sendMessage(
								jid,
								{
									text: message.trim(),
								}
							),
						2
					);

					sent++;
				} catch (_) {
					failed++;
				}
			}

			pushActivity(
				"broadcast_sent",
				{
					sessionId:
						sessionId ||
						sock.sessionId ||
						"default",

					sent,
					failed,
					total: jids.length,

					preview:
						message
							.trim()
							.slice(
								0,
								60
							),
				}
			);

			res.json({
				ok: true,
				sessionId:
					sessionId ||
					sock.sessionId ||
					"default",

				sent,
				failed,
				total: jids.length,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   LEGACY RECONNECT
============================================================ */

router.post(
	"/api/admin/reconnect",
	requireAdmin,
	async (req, res) => {
		try {
			const sessionId =
				req.body?.sessionId ||
				"default";

			const sock =
				getSock(sessionId);

			if (sock) {
				try {
					await stopSession(
						sessionId
					);
				} catch (_) {}
			}

			const newSock =
				await startSock(
					sessionId,
					"manual-reconnect"
				);

			if (!newSock) {
				return res.status(503).json({
					error:
						"Reconnect failed.",
				});
			}

			res.json({
				ok: true,
				sessionId,
				message:
					"Reconnecting…",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   LEGACY RESTART
============================================================ */

router.post(
	"/api/admin/restart",
	requireAdmin,
	(req, res) => {
		res.json({
			ok: true,
			message:
				"Process restarting…",
		});

		setTimeout(
			async () => {
				const {
					spawn,
				} =
					await import(
						"child_process"
					);

				const child =
					spawn(
						process.execPath,
						process.argv.slice(
							1
						),
						{
							cwd:
								process.cwd(),

							env:
								process.env,

							stdio:
								"inherit",

							detached:
								true,
						}
					);

				child.unref();

				process.exit(0);
			},
			600
		);
	}
);

/* ============================================================
   LEGACY LOGOUT BOT
============================================================ */

router.post(
	"/api/admin/logout-bot",
	requireAdmin,
	async (req, res) => {
		try {
			const sessionId =
				req.body?.sessionId ||
				"default";

			const sock =
				getSock(sessionId);

			if (!sock) {
				return res.status(404).json({
					error:
						"Session not found.",
				});
			}

			try {
				await sock.logout(
					"Admin logout"
				);
			} catch (err) {
				console.warn(
					"Logout warning:",
					err.message
				);
			}

			await stopSession(
				sessionId
			);

			req.app.locals.socks?.delete(
				sessionId
			);

			req.app.locals.qrs?.delete(
				sessionId
			);

			res.json({
				ok: true,
				sessionId,
				message:
					"Bot logged out of WhatsApp.",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   ADMIN REQUEST PAIR
   Legacy endpoint, now multi-session.
============================================================ */

router.post(
	"/api/admin/request-pair",
	requireAdmin,
	async (req, res) => {
		try {
			const {
				phoneNumber,
			} = req.body;

			if (!phoneNumber) {
				return res.status(400).json({
					error:
						"Phone number is required.",
				});
			}

			const clean =
				cleanPhoneNumber(
					phoneNumber
				);

			if (clean.length < 7) {
				return res.status(400).json({
					error:
						"Invalid phone number.",
				});
			}

			const sessionId =
				makeSessionId(clean);

			let sock =
				getSock(sessionId);

			if (sock?.user) {
				return res.status(400).json({
					error:
						"This WhatsApp number is already connected.",
					sessionId,
				});
			}

			if (!sock) {
				sock =
					await startSock(
						sessionId,
						"pairing"
					);
			}

			if (!sock) {
				return res.status(503).json({
					error:
						"Bot socket is not ready.",
				});
			}

			if (
				sock.authState?.creds
					?.registered
			) {
				return res.status(400).json({
					error:
						"Session is already registered.",
					sessionId,
				});
			}

			const code =
				await sock.requestPairingCode(
					clean
				);

			res.json({
				ok: true,
				sessionId,
				phoneNumber: clean,
				code,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   CLEAR AUTH
   IMPORTANT:
   Do NOT delete the entire AuthState collection in
   multi-session mode.
============================================================ */

router.post(
	"/api/admin/clear-auth",
	requireAdmin,
	async (req, res) => {
		try {
			const sessionId =
				req.body?.sessionId;

			if (!sessionId) {
				return res.status(400).json({
					error:
						"sessionId is required in multi-session mode.",
				});
			}

			const authCollection =
				mdClient
					.db("MyBotDataDB")
					.collection(
						"AuthState"
					);

			const prefix =
				`${sessionId}::`;

			const result =
				await authCollection.deleteMany(
					{
						_id: {
							$regex:
								"^" +
								prefix.replace(
									/[.*+?^${}()|[\]\\]/g,
									"\\$&"
								),
						},
					}
				);

			try {
				await stopSession(
					sessionId
				);
			} catch (_) {}

			req.app.locals.socks?.delete(
				sessionId
			);

			req.app.locals.qrs?.delete(
				sessionId
			);

			res.json({
				ok: true,
				sessionId,
				deleted:
					result.deletedCount,

				message:
					"Session auth cleared. You can pair this WhatsApp number again.",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   COMMANDS
============================================================ */

router.get(
	"/api/admin/commands",
	requireAdmin,
	async (req, res) => {
		try {
			const [
				cmds,
				botData,
			] = await Promise.all([
				cmdToText(),
				getBotData(),
			]);

			const disabled =
				botData
					?.disabledGlobally ||
				[];

			const annotate = (
				list,
				type
			) =>
				list.map((c) => ({
					...c,
					type,
					disabledGlobally:
						c.cmd.some(
							(k) =>
								disabled.includes(
									k
								)
						),
				}));

			res.json({
				publicCommands:
					annotate(
						cmds.publicCommands,
						"public"
					),

				groupCommands:
					annotate(
						cmds.groupCommands,
						"group"
					),

				adminCommands:
					annotate(
						cmds.adminCommands,
						"admin"
					),

				ownerCommands:
					annotate(
						cmds.ownerCommands,
						"owner"
					),
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   COMMAND TOGGLE
============================================================ */

router.patch(
	"/api/admin/commands/:cmd",
	requireAdmin,
	async (req, res) => {
		const {
			disabled,
			aliases = [],
		} = req.body;

		const primary =
			decodeURIComponent(
				req.params.cmd
			);

		const allKeys = [
			...new Set([
				primary,
				...aliases,
			]),
		];

		try {
			if (disabled) {
				await bot.updateOne(
					{ _id: "bot" },
					{
						$setOnInsert: {
							youtube_session:
								"",
						},

						$addToSet: {
							disabledGlobally:
								{
									$each:
										allKeys,
								},
						},
					},
					{
						upsert: true,
					}
				);
			} else {
				await bot.updateOne(
					{ _id: "bot" },
					{
						$pullAll: {
							disabledGlobally:
								allKeys,
						},
					}
				);
			}

			res.json({
				ok: true,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   GROUPS
============================================================ */

router.get(
	"/api/admin/groups",
	requireAdmin,
	async (req, res) => {
		try {
			const groups =
				await group
					.find(
						{},
						{
							projection: {
								chatHistory: 0,
							},
						}
					)
					.toArray();

			res.json(groups);
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   GROUP UPDATE
============================================================ */

router.patch(
	"/api/admin/groups/:jid",
	requireAdmin,
	async (req, res) => {
		const jid =
			decodeURIComponent(
				req.params.jid
			);

		const allowed = [
			"isBotOn",
			"isChatBotOn",
			"isImgOn",
			"is91Only",
			"isAutoStickerOn",
			"isRankNotifOn",
			"cmdBlocked",
		];

		const update = {};

		for (const key of allowed) {
			if (key in req.body) {
				update[key] =
					req.body[key];
			}
		}

		if (
			!Object.keys(update).length
		) {
			return res.status(400).json({
				error:
					"No valid fields",
			});
		}

		try {
			await group.updateOne(
				{ _id: jid },
				{ $set: update }
			);

			res.json({
				ok: true,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   GROUP MEMBERS
============================================================ */

router.get(
	"/api/admin/groups/:jid/members",
	requireAdmin,
	async (req, res) => {
		const jid =
			decodeURIComponent(
				req.params.jid
			);

		try {
			const grp =
				await group.findOne(
					{ _id: jid },
					{
						projection: {
							members: 1,
						},
					}
				);

			res.json(
				grp?.members || []
			);
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   CHAT HISTORY
============================================================ */

router.get(
	"/api/admin/groups/:jid/chat-history",
	requireAdmin,
	async (req, res) => {
		const jid =
			decodeURIComponent(
				req.params.jid
			);

		const hours = Math.min(
			Math.max(
				parseInt(
					req.query.hours ||
						24
				),
				1
			),
			24
		);

		try {
			const chatLogs =
				mdClient
					.db("MyBotDataDB")
					.collection(
						"ChatLogs"
					);

			const since =
				new Date(
					Date.now() -
						hours *
							60 *
							60 *
							1000
				);

			const messages =
				await chatLogs
					.find({
						groupJid: jid,
						timestamp: {
							$gte: since,
						},
					})
					.sort({
						timestamp: 1,
					})
					.toArray();

			res.json(messages);
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   MEMBERS
============================================================ */

router.get(
	"/api/admin/members",
	requireAdmin,
	async (req, res) => {
		const {
			search = "",
			page = 1,
			limit = 50,
			sort = "totalmsg",
			order = "desc",
		} = req.query;

		const pageNumber =
			Math.max(
				parseInt(page) || 1,
				1
			);

		const limitNumber =
			Math.min(
				Math.max(
					parseInt(limit) ||
						50,
					1
				),
				100
			);

		const skip =
			(pageNumber - 1) *
			limitNumber;

		const query = search
			? {
					$or: [
						{
							_id: {
								$regex:
									search,
								$options:
									"i",
							},
						},

						{
							username: {
								$regex:
									search,
								$options:
									"i",
							},
						},
					],
			  }
			: {};

		const allowedSort = [
			"totalmsg",
			"texttotal",
			"imagetotal",
			"videototal",
			"stickertotal",
			"pdftotal",
			"username",
		];

		const sortField =
			allowedSort.includes(sort)
				? sort
				: "totalmsg";

		const sortDir =
			order === "asc"
				? 1
				: -1;

		try {
			const [
				members,
				total,
			] = await Promise.all([
				member
					.find(query)
					.sort({
						[sortField]:
							sortDir,
					})
					.skip(skip)
					.limit(
						limitNumber
					)
					.toArray(),

				member.countDocuments(
					query
				),
			]);

			res.json({
				members,
				total,
				page: pageNumber,
				limit:
					limitNumber,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   MEMBER ACTION
============================================================ */

router.patch(
	"/api/admin/members/:jid",
	requireAdmin,
	async (req, res) => {
		const jid =
			decodeURIComponent(
				req.params.jid
			);

		const { action } =
			req.body;

		try {
			if (action === "block") {
				await member.updateOne(
					{ _id: jid },
					{
						$set: {
							isBlock: true,
						},
					}
				);

				pushActivity(
					"member_blocked",
					{ jid }
				);
			} else if (
				action === "unblock"
			) {
				await member.updateOne(
					{ _id: jid },
					{
						$set: {
							isBlock: false,
						},
					}
				);

				pushActivity(
					"member_unblocked",
					{ jid }
				);
			} else if (
				action === "resetWarnings"
			) {
				await member.updateOne(
					{ _id: jid },
					{
						$set: {
							warning: [],
						},
					}
				);
			} else if (
				action ===
				"resetMsgCount"
			) {
				await member.updateOne(
					{ _id: jid },
					{
						$set: {
							totalmsg: 0,
							texttotal: 0,
							imagetotal: 0,
							videototal: 0,
							stickertotal: 0,
							pdftotal: 0,
						},
					}
				);
			} else {
				return res.status(400).json({
					error:
						"Unknown action",
				});
			}

			res.json({
				ok: true,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   LOGS
============================================================ */

router.get(
	"/api/admin/logs",
	requireAdmin,
	(req, res) => {
		const {
			limit = 200,
			level = "all",
			since = 0,
		} = req.query;

		res.json({
			logs: getLogs(
				limit,
				level,
				since
			),
		});
	}
);

/* ============================================================
   ACTIVITY
============================================================ */

router.get(
	"/api/admin/activity",
	requireAdmin,
	(_req, res) => {
		res.json({
			activity:
				getActivity(),
		});
	}
);

/* ============================================================
   COMMAND USAGE
============================================================ */

router.get(
	"/api/admin/command-stats",
	requireAdmin,
	(_req, res) => {
		res.json({
			stats:
				Object.fromEntries(
					cmdUsage
				),
		});
	}
);

/* ============================================================
   YOUTUBE COOKIES
============================================================ */

router.get(
	"/api/admin/yt-cookies",
	requireAdmin,
	async (req, res) => {
		try {
			const content =
				await getCookiesContent();

			res.json({
				content:
					content || "",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

router.post(
	"/api/admin/yt-cookies",
	requireAdmin,
	async (req, res) => {
		const { content } =
			req.body;

		if (
			typeof content !==
			"string"
		) {
			return res.status(400).json({
				error:
					"content required",
			});
		}

		try {
			await saveCookies(
				content
			);

			res.json({
				ok: true,
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   DIRECT MESSAGE
============================================================ */

router.post(
	"/api/admin/dm",
	requireAdmin,
	async (req, res) => {
		const {
			jid,
			message,
			sessionId,
		} = req.body;

		if (
			!jid ||
			!message ||
			!message.trim()
		) {
			return res.status(400).json({
				error:
					"jid and message are required.",
			});
		}

		const sock =
			getSocket(
				req,
				sessionId
			);

		if (!sock) {
			return res.status(503).json({
				error:
					"Selected WhatsApp session is not connected.",
			});
		}

		try {
			const normalized =
				await normalizeJID(
					sock,
					jid.trim()
				);

			await messageQueue.enqueue(
				normalized,
				() =>
					sock.sendMessage(
						normalized,
						{
							text:
								message.trim(),
						}
					),
				0
			);

			pushActivity(
				"dm_sent",
				{
					sessionId:
						sessionId ||
						sock.sessionId ||
						"default",

					to: jid,

					preview:
						message
							.trim()
							.slice(
								0,
								60
							),
				}
			);

			res.json({
				ok: true,
				sessionId:
					sessionId ||
					sock.sessionId ||
					"default",
			});
		} catch (err) {
			res.status(500).json({
				error: err.message,
			});
		}
	}
);

/* ============================================================
   EXPORT
============================================================ */

export default router;
