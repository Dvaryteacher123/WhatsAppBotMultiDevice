/**
 * ============================================================
 * DVARY BOT - MAIN INDEX
 * Multi-Session Compatible
 * ============================================================
 */

import startSock, {
	onNewSock,
	getSock,
	getAllSessions,
	stopSession,
} from "./connection.js";

import { startReminderScheduler } from "./utils/reminderScheduler.js";
import getDate from "./utils/date.js";
import { normalizeJID } from "./utils/lid.js";

import adminRouter from "./routes/admin.js";
import messageQueue from "./queue/messageQueue.js";

import {
	pushLog,
	subscribe as subscribeAdminEvents,
	getLogs,
	getActivity,
} from "./notify/adminEvents.js";

/*
|--------------------------------------------------------------------------
| Console interceptor
|--------------------------------------------------------------------------
*/

const _log = console.log.bind(console);
const _info = console.info.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);

const _SESSION_SPAM = [
	"Closing session:",
	"Removing old closed session:",
];

/*
|--------------------------------------------------------------------------
| Suppress startup Mongo credential noise
|--------------------------------------------------------------------------
*/

let _startupTime = Date.now();

function _suppressStartupNoise(msg) {
	if (
		msg === "💾 Credentials saved to MongoDB" &&
		Date.now() - _startupTime < 10000
	) {
		return true;
	}

	return false;
}

console.log = (...a) => {
	const s = String(a[0]);

	if (_suppressStartupNoise(s)) {
		return;
	}

	_log(...a);
	pushLog("info", ...a);
};

console.info = (...a) => {
	if (
		_SESSION_SPAM.some((s) =>
			String(a[0]).startsWith(s)
		)
	) {
		return;
	}

	_info(...a);
	pushLog("info", ...a);
};

console.warn = (...a) => {
	_warn(...a);
	pushLog("warn", ...a);
};

console.error = (...a) => {
	_error(...a);
	pushLog("error", ...a);
};

/*
|--------------------------------------------------------------------------
| Express
|--------------------------------------------------------------------------
*/

import cors from "cors";
import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import bodyParser from "body-parser";

import {
	WebSocketServer,
	WebSocket,
} from "ws";

import path from "path";
import {
	fileURLToPath,
} from "url";

import passport from "passport";
import {
	Strategy as GoogleStrategy,
} from "passport-google-oauth20";

/*
|--------------------------------------------------------------------------
| __dirname
|--------------------------------------------------------------------------
*/

const __filename =
	fileURLToPath(import.meta.url);

const __dirname =
	path.dirname(__filename);

/*
|--------------------------------------------------------------------------
| Express app
|--------------------------------------------------------------------------
*/

const app = express();

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/

app.use(
	cors({
		credentials: true,
		optionsSuccessStatus: 200,
	})
);

/*
|--------------------------------------------------------------------------
| SESSION SECRET
|--------------------------------------------------------------------------
*/

if (!process.env.SESSION_SECRET) {
	console.error(
		"FATAL: SESSION_SECRET environment variable is not set. Cannot run application securely."
	);

	process.exit(1);
}

/*
|--------------------------------------------------------------------------
| Express Session
|--------------------------------------------------------------------------
*/

app.use(
	session({
		secret: process.env.SESSION_SECRET,

		resave: false,

		saveUninitialized: false,

		store: MongoStore.create({
			mongoUrl:
				process.env.MONGODB_KEY,

			ttl: 8 * 60 * 60,
		}),

		cookie: {
			secure: false,
			httpOnly: true,
			maxAge:
				8 * 60 * 60 * 1000,
		},
	})
);

/*
|--------------------------------------------------------------------------
| Passport / Google OAuth
|--------------------------------------------------------------------------
*/

const baseUrl = (
	process.env.HOST_URL ||
	"http://localhost:8000"
).replace(/\/$/, "");

const googleAuthEnabled = !!(
	process.env.GOOGLE_CLIENT_ID &&
	process.env.GOOGLE_CLIENT_SECRET
);

if (googleAuthEnabled) {
	passport.use(
		new GoogleStrategy(
			{
				clientID:
					process.env.GOOGLE_CLIENT_ID,

				clientSecret:
					process.env.GOOGLE_CLIENT_SECRET,

				callbackURL:
					`${baseUrl}/auth/google/callback`,
			},

			(
				_accessToken,
				_refreshToken,
				profile,
				done
			) => {
				done(null, profile);
			}
		)
	);
} else {
	console.log(
		"Google OAuth disabled — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set."
	);
}

passport.serializeUser(
	(user, done) => done(null, user)
);

passport.deserializeUser(
	(user, done) => done(null, user)
);

app.use(
	passport.initialize()
);

app.use(
	passport.session()
);

app.locals.googleAuthEnabled =
	googleAuthEnabled;

/*
|--------------------------------------------------------------------------
| Body parser
|--------------------------------------------------------------------------
*/

app.use(
	bodyParser.json({
		limit: "10mb",
	})
);

app.use(
	express.urlencoded({
		extended: true,
		limit: "10mb",
	})
);

/*
|--------------------------------------------------------------------------
| Static files
|--------------------------------------------------------------------------
*/

app.use(
	express.static(
		path.join(
			__dirname,
			"public"
		),
		{
			maxAge: "1d",
			etag: false,
		}
	)
);

/*
|--------------------------------------------------------------------------
| React dashboard
|--------------------------------------------------------------------------
*/

app.use(
	"/admin",
	express.static(
		path.join(
			__dirname,
			"public",
			"app"
		),
		{
			maxAge: "1d",
			etag: false,
		}
	)
);

/*
|--------------------------------------------------------------------------
| EJS
|--------------------------------------------------------------------------
*/

app.set(
	"views",
	path.join(
		__dirname,
		"./public"
	)
);

app.set(
	"view engine",
	"ejs"
);

/*
|--------------------------------------------------------------------------
| PORT
|--------------------------------------------------------------------------
*/

const port =
	process.env.PORT || 8000;

/*
|--------------------------------------------------------------------------
| Home
|--------------------------------------------------------------------------
*/

app.get("/", (_req, res) => {
	res.render("index");
});

/*
|--------------------------------------------------------------------------
| Admin routes
|--------------------------------------------------------------------------
*/

app.use(
	"/",
	adminRouter
);

/*
|--------------------------------------------------------------------------
| React SPA catch-all
|--------------------------------------------------------------------------
*/

const reactIndex =
	path.join(
		__dirname,
		"public",
		"app",
		"index.html"
	);

app.get(
	"/admin",
	(_req, res) => {
		res.sendFile(
			reactIndex
		);
	}
);

app.get(
	"/admin/*",
	(req, res, next) => {
		if (
			req.path.startsWith(
				"/api/"
			)
		) {
			return next();
		}

		res.sendFile(
			reactIndex
		);
	}
);

/*
|--------------------------------------------------------------------------
| HTTP server
|--------------------------------------------------------------------------
*/

const server =
	app.listen(
		port,
		() => {
			const mem =
				Math.round(
					process.memoryUsage()
						.heapUsed /
						1024 /
						1024
				);

			_log(
				`\n${"═".repeat(50)}`
			);

			_log(
				`  Dvary Bot  ·  ${getDate()}`
			);

			_log(
				`  Port: ${port}  ·  Heap: ${mem}MB`
			);

			_log(
				`${"═".repeat(50)}\n`
			);

			startServer();
		}
	);

/*
|--------------------------------------------------------------------------
| Web server error
|--------------------------------------------------------------------------
*/

app.on(
	"error",
	(error) => {
		console.error(
			"Web-server error:",
			error.message
		);
	}
);

/*
|--------------------------------------------------------------------------
| WebSocket server
|--------------------------------------------------------------------------
*/

const wss =
	new WebSocketServer({
		server,

		maxPayload:
			10 * 1024 * 1024,

		perMessageDeflate:
			true,
	});

/*
|--------------------------------------------------------------------------
| Multi-session state
|--------------------------------------------------------------------------
*/

if (!app.locals.socks) {
	app.locals.socks =
		new Map();
}

if (!app.locals.qrs) {
	app.locals.qrs =
		new Map();
}

/*
|--------------------------------------------------------------------------
| Broadcast
|--------------------------------------------------------------------------
*/

function broadcast(payload) {
	const msg =
		JSON.stringify(
			payload
		);

	wss.clients.forEach(
		(client) => {
			if (
				client.readyState ===
				WebSocket.OPEN
			) {
				client.send(msg);
			}
		}
	);
}

/*
|--------------------------------------------------------------------------
| New socket handler
|--------------------------------------------------------------------------
*/

function handleNewSock(
	sock,
	sessionId = "default"
) {
	/*
	|--------------------------------------------------------------------------
	| Save socket
	|--------------------------------------------------------------------------
	*/

	app.locals.socks.set(
		sessionId,
		sock
	);

	/*
	|--------------------------------------------------------------------------
	| Backward compatibility
	|--------------------------------------------------------------------------
	*/

	if (
		sessionId ===
		"default"
	) {
		app.locals.sock =
			sock;
	}

	console.log(
		`📡 Live socket registered: ${sessionId}`
	);

	/*
	|--------------------------------------------------------------------------
	| Connection updates
	|--------------------------------------------------------------------------
	*/

	sock.ev.on(
		"connection.update",
		(update) => {
			const {
				qr,
				isOnline,
				connection,
			} = update;

			/*
			|--------------------------------------------------------------------------
			| QR
			|--------------------------------------------------------------------------
			*/

			if (qr) {
				console.log(
					`📱 [${sessionId}] QR received`
				);

				app.locals.qrs.set(
					sessionId,
					{
						qr,
						createdAt:
							Date.now(),
					}
				);

				broadcast({
					type: "qr",
					sessionId,
					qr,
				});
			}

			/*
			|--------------------------------------------------------------------------
			| Connected
			|--------------------------------------------------------------------------
			*/

			if (
				isOnline ||
				connection ===
					"open"
			) {
				console.log(
					`✅ [${sessionId}] WhatsApp connected`
				);

				app.locals.qrs.delete(
					sessionId
				);

				broadcast({
					type: "status",
					sessionId,
					status: "connected",
				});
			}

			/*
			|--------------------------------------------------------------------------
			| Disconnected
			|--------------------------------------------------------------------------
			*/

			if (
				connection ===
				"close"
			) {
				console.log(
					`🔴 [${sessionId}] WhatsApp disconnected`
				);

				broadcast({
					type: "status",
					sessionId,
					status: "disconnected",
				});
			}
		}
	);
}

/*
|--------------------------------------------------------------------------
| Register socket hook
|--------------------------------------------------------------------------
|
| connection.js will call this every time a socket is created.
|--------------------------------------------------------------------------
*/

onNewSock(
	handleNewSock
);

/*
|--------------------------------------------------------------------------
| Admin events → WebSocket
|--------------------------------------------------------------------------
*/

subscribeAdminEvents(
	(event) => {
		broadcast(event);
	}
);

/*
|--------------------------------------------------------------------------
| Reconnect helper
|--------------------------------------------------------------------------
*/

app.locals.reconnect = (
	sessionId = "default"
) => {
	return startSock(
		sessionId,
		"manual-reconnect"
	);
};

/*
|--------------------------------------------------------------------------
| Get socket for session
|--------------------------------------------------------------------------
*/

app.locals.getSock = (
	sessionId = "default"
) => {
	return getSock(
		sessionId
	);
};

/*
|--------------------------------------------------------------------------
| Get all sessions
|--------------------------------------------------------------------------
*/

app.locals.getSessions = () => {
	return getAllSessions();
};

/*
|--------------------------------------------------------------------------
| WebSocket connection
|--------------------------------------------------------------------------
*/

wss.on(
	"connection",
	(ws) => {
		/*
		|--------------------------------------------------------------------------
		| Default session
		|--------------------------------------------------------------------------
		*/

		const sessionId =
			"default";

		const sock =
			getSock(
				sessionId
			);

		/*
		|--------------------------------------------------------------------------
		| Current status
		|--------------------------------------------------------------------------
		*/

		if (
			sock?.user
		) {
			ws.send(
				JSON.stringify({
					type:
						"status",

					sessionId,

					status:
						"connected",
				})
			);
		} else {
			const qrData =
				app.locals.qrs.get(
					sessionId
				);

			if (
				qrData
			) {
				ws.send(
					JSON.stringify({
						type:
							"qr",

						sessionId,

						qr:
							qrData.qr,
					})
				);
			}
		}

		/*
		|--------------------------------------------------------------------------
		| Logs
		|--------------------------------------------------------------------------
		*/

		ws.send(
			JSON.stringify({
				type:
					"log_snapshot",

				logs:
					getLogs(100),
			})
		);

		/*
		|--------------------------------------------------------------------------
		| Activity
		|--------------------------------------------------------------------------
		*/

		ws.send(
			JSON.stringify({
				type:
					"activity_snapshot",

				activity:
					getActivity(),
			})
		);

		/*
		|--------------------------------------------------------------------------
		| Heartbeat
		|--------------------------------------------------------------------------
		*/

		const heartbeat =
			setInterval(
				() => {
					if (
						ws.readyState ===
						WebSocket.OPEN
					) {
						ws.ping();
					}
				},
				30000
			);

		ws.on(
			"pong",
			() => {}
		);

		/*
		|--------------------------------------------------------------------------
		| WebSocket messages
		|--------------------------------------------------------------------------
		*/

		ws.on(
			"message",
			async (raw) => {
				try {
					const data =
						JSON.parse(
							raw
						);

					const {
						to,
						message,
						sessionId:
							requestedSession =
								"default",
					} = data;

					if (
						!to ||
						!message
					) {
						ws.send(
							JSON.stringify({
								type:
									"error",

								error:
									"Invalid request",
							})
						);

						return;
					}

					if (
						message.length >
						4096
					) {
						ws.send(
							JSON.stringify({
								type:
									"error",

								error:
									"Message too long",
							})
						);

						return;
					}

					/*
					|--------------------------------------------------------------------------
					| Find requested session
					|--------------------------------------------------------------------------
					*/

					const activeSock =
						getSock(
							requestedSession
						);

					if (
						!activeSock
					) {
						ws.send(
							JSON.stringify({
								type:
									"error",

								error:
									`Session ${requestedSession} is not connected`,
							})
						);

						return;
					}

					/*
					|--------------------------------------------------------------------------
					| Normalize JID
					|--------------------------------------------------------------------------
					*/

					const jid =
						await normalizeJID(
							activeSock,
							to
						);

					/*
					|--------------------------------------------------------------------------
					| Queue message
					|--------------------------------------------------------------------------
					*/

					await messageQueue.enqueue(
						jid,
						() =>
							activeSock.sendMessage(
								jid,
								{
									text:
										message,
								}
							),
						0
					);

					console.log(
						`[${requestedSession}] Message sent to ${to}: ${message}`
					);

					ws.send(
						JSON.stringify({
							type:
								"success",

							success:
								"Message sent",

							sessionId:
								requestedSession,
						})
					);
				} catch (err) {
					console.error(
						"Error handling WebSocket message:",
						err
					);

					ws.send(
						JSON.stringify({
							type:
								"error",

							error:
								"Failed to send message",
						})
					);
				}
			}
		);

		/*
		|--------------------------------------------------------------------------
		| Close
		|--------------------------------------------------------------------------
		*/

		ws.on(
			"close",
			() => {
				clearInterval(
					heartbeat
				);
			}
		);

		/*
		|--------------------------------------------------------------------------
		| Error
		|--------------------------------------------------------------------------
		*/

		ws.on(
			"error",
			(err) => {
				console.error(
					"WebSocket error:",
					err
				);

				clearInterval(
					heartbeat
				);
			}
		);
	}
);

/*
|--------------------------------------------------------------------------
| Start server / bot
|--------------------------------------------------------------------------
*/

async function startServer() {
	try {
		/*
		|--------------------------------------------------------------------------
		| Start default session
		|--------------------------------------------------------------------------
		|
		| Compatibility with the existing bot.
		|
		*/

		await startSock(
			"default",
			"start"
		);

		/*
		|--------------------------------------------------------------------------
		| Reminder scheduler
		|--------------------------------------------------------------------------
		*/

		startReminderScheduler();

		console.log(
			"🚀 Dvary Bot server started"
		);
	} catch (error) {
		console.error(
			"❌ Error starting bot:",
			error
		);
	}
}

/*
|--------------------------------------------------------------------------
| Send message API
|--------------------------------------------------------------------------
*/

app.post(
	"/send",
	async (req, res) => {
		const {
			to,
			message,
			sessionId =
				"default",
		} = req.body;

		if (
			!to ||
			!message
		) {
			return res
				.status(400)
				.send({
					message:
						"Invalid request",
				});
		}

		try {
			/*
			|--------------------------------------------------------------------------
			| Get session socket
			|--------------------------------------------------------------------------
			*/

			const sock =
				getSock(
					sessionId
				);

			if (!sock) {
				return res
					.status(503)
					.send({
						message:
							`Session ${sessionId} is not connected`,
					});
			}

			/*
			|--------------------------------------------------------------------------
			| Multiple recipients
			|--------------------------------------------------------------------------
			*/

			if (
				Array.isArray(
					to
				)
			) {
				const jids =
					await Promise.all(
						to.map(
							(recipient) =>
								normalizeJID(
									sock,
									recipient
								)
						)
					);

				await Promise.all(
					jids.map(
						(jid) =>
							messageQueue.enqueue(
								jid,
								() =>
									sock.sendMessage(
										jid,
										{
											text:
												message,
										}
									),
								0
							)
					)
				);

				console.log(
					`[${sessionId}] Message queued for multiple recipients`
				);

				return res.send({
					message:
						"Messages queued",

					sessionId,
				});
			}

			/*
			|--------------------------------------------------------------------------
			| Single recipient
			|--------------------------------------------------------------------------
			*/

			const recipientJid =
				await normalizeJID(
					sock,
					to
				);

			await messageQueue.enqueue(
				recipientJid,
				() =>
					sock.sendMessage(
						recipientJid,
						{
							text:
								message,
						}
					),
				0
			);

			console.log(
				`[${sessionId}] Message queued for: ${to}`
			);

			return res.send({
				message:
					"Message queued",

				sessionId,
			});
		} catch (error) {
			console.error(
				"Error sending message:",
				error
			);

			return res
				.status(500)
				.send({
					message:
						"Failed to send message",
				});
		}
	}
);

/*
|--------------------------------------------------------------------------
| Session status API
|--------------------------------------------------------------------------
*/

app.get(
	"/api/sessions",
	(_req, res) => {
		try {
			const sessions =
				getAllSessions();

			const result =
				[];

			for (
				const [
					sessionId,
					sessionData,
				] of sessions
			) {
				result.push({
					sessionId,

					connected:
						!!sessionData.sock,

					user:
						sessionData
							.sock
							?.user ||
						null,

					connectionAttempts:
						sessionData
							.connectionAttempts,
				});
			}

			res.json({
				success:
					true,

				sessions:
					result,
			});
		} catch (error) {
			console.error(
				"Error getting sessions:",
				error
			);

			res
				.status(500)
				.json({
					success:
						false,

					error:
						"Failed to get sessions",
				});
		}
	}
);

/*
|--------------------------------------------------------------------------
| Session stop API
|--------------------------------------------------------------------------
*/

app.post(
	"/api/sessions/:sessionId/stop",
	async (req, res) => {
		try {
			const {
				sessionId,
			} = req.params;

			const stopped =
				await stopSession(
					sessionId
				);

			if (!stopped) {
				return res
					.status(404)
					.json({
						success:
							false,

						error:
							"Session not found",
					});
			}

			res.json({
				success:
					true,

				sessionId,
			});
		} catch (error) {
			console.error(
				"Error stopping session:",
				error
			);

			res
				.status(500)
				.json({
					success:
						false,

					error:
						"Failed to stop session",
				});
		}
	}
);

/*
|--------------------------------------------------------------------------
| Unhandled rejection
|--------------------------------------------------------------------------
*/

process.on(
	"unhandledRejection",
	(reason, p) => {
		console.error(
			"Unhandled Rejection at:",
			p,
			"reason:",
			reason
		);
	}
);

/*
|--------------------------------------------------------------------------
| Uncaught exception
|--------------------------------------------------------------------------
*/

process.on(
	"uncaughtException",
	(err) => {
		console.error(
			"Uncaught Exception:",
			err
		);

		gracefulShutdown(
			"UNCAUGHT_EXCEPTION"
		);
	}
);

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

async function gracefulShutdown(
	signal
) {
	console.log(
		`\n🔄 Received ${signal}. Starting graceful shutdown...`
	);

	try {
		/*
		|--------------------------------------------------------------------------
		| Close all WhatsApp sessions
		|--------------------------------------------------------------------------
		*/

		const sessions =
			getAllSessions();

		console.log(
			`🔌 Closing ${sessions.size} WhatsApp sessions...`
		);

		for (
			const [
				sessionId,
			] of sessions
		) {
			try {
				await stopSession(
					sessionId
				);
			} catch (error) {
				console.error(
					`Error stopping ${sessionId}:`,
					error.message
				);
			}
		}
	} catch (error) {
		console.error(
			"Error closing WhatsApp sessions:",
			error.message
		);
	}

	/*
	|--------------------------------------------------------------------------
	| Close HTTP server
	|--------------------------------------------------------------------------
	*/

	server.close(
		() => {
			console.log(
				"✅ HTTP server closed"
			);

			/*
			|--------------------------------------------------------------------------
			| Close WebSockets
			|--------------------------------------------------------------------------
			*/

			wss.clients.forEach(
				(client) =>
					client.close()
			);

			console.log(
				"✅ Graceful shutdown completed"
			);

			process.exit(0);
		}
	);

	/*
	|--------------------------------------------------------------------------
	| Force shutdown
	|--------------------------------------------------------------------------
	*/

	setTimeout(
		() => {
			console.error(
				"❌ Forced shutdown due to timeout"
			);

			process.exit(1);
		},
		10000
	);
}

/*
|--------------------------------------------------------------------------
| Signals
|--------------------------------------------------------------------------
*/

process.on(
	"SIGTERM",
	() =>
		gracefulShutdown(
			"SIGTERM"
		)
);

process.on(
	"SIGINT",
	() =>
		gracefulShutdown(
			"SIGINT"
		)
);
