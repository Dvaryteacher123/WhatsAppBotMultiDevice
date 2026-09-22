import "dotenv/config";

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import session from "express-session";
import MongoStore from "connect-mongo";
import cors from "cors";
import bodyParser from "body-parser";
import { WebSocketServer } from "ws";

import { startSock, onNewSock, getSock, getAllSessions, stopSession } from "./connection.js";

import adminRouter from "./routes/admin.js";
import messageQueue from "./queue/messageQueue.js";
import { subscribeAdminEvents } from "./events/adminEvents.js";

import {
  scheduleReminders,
  getUpcomingReminders,
} from "./services/reminderScheduler.js";

import {
  getToday,
  getCurrentDate,
} from "./utils/date.js";

import normalizeJID from "./utils/normalizeJID.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =====================================================
   ENV
===================================================== */

const PORT = Number(process.env.PORT || 8000);

const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  console.error(
    "❌ FATAL: SESSION_SECRET environment variable is not set."
  );
  process.exit(1);
}

const MONGODB_KEY = process.env.MONGODB_KEY;

if (!MONGODB_KEY) {
  console.error(
    "❌ FATAL: MONGODB_KEY environment variable is not set."
  );
  process.exit(1);
}

/* =====================================================
   EXPRESS
===================================================== */

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  express.json({
    limit: "10mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

/* =====================================================
   SESSION
===================================================== */

app.use(
  session({
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    store: MongoStore.create({
      mongoUrl: MONGODB_KEY,
      collectionName: "express_sessions",
      ttl: 60 * 60 * 24 * 7,
    }),

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

/* =====================================================
   STATIC FILES
===================================================== */

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =====================================================
   VIEW ENGINE
===================================================== */

app.set(
  "views",
  path.join(__dirname, "views")
);

app.set(
  "view engine",
  "ejs"
);

/* =====================================================
   APP LOCALS
===================================================== */

app.locals.socks = new Map();
app.locals.qrs = new Map();
app.locals.sessions = new Map();

app.locals.getSock = getSock;
app.locals.getSessions = getAllSessions;

app.locals.reconnect = async (sessionId) => {
  return startSock(sessionId, "manual-reconnect");
};

app.locals.stopSession = async (sessionId) => {
  return stopSession(sessionId);
};

/* =====================================================
   ADMIN ROUTER
===================================================== */

app.use("/", adminRouter);

/* =====================================================
   HEALTH
===================================================== */

app.get("/health", async (req, res) => {
  try {
    const sessions = getAllSessions();

    const sessionList = [];

    for (const [sessionId, sessionData] of sessions.entries()) {
      sessionList.push({
        sessionId,
        connected: !!sessionData?.sock?.user,
        starting: !!sessionData?.starting,
        stopped: !!sessionData?.stopped,
        attempts: sessionData?.connectionAttempts || 0,
      });
    }

    res.json({
      success: true,
      status: "online",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      sessions: sessionList,
      sessionCount: sessionList.length,
      connectedCount: sessionList.filter(
        (s) => s.connected
      ).length,
    });
  } catch (error) {
    console.error("❌ Health error:", error);

    res.status(500).json({
      success: false,
      error: error?.message || String(error),
    });
  }
});

/* =====================================================
   ROOT
===================================================== */

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "WhatsApp Bot",
    status: "online",
    version: "multi-session",
    dashboard: "/admin",
  });
});

/* =====================================================
   NEW SOCKET HANDLER
===================================================== */

const handleNewSock = async (sock, sessionId = "default") => {
  try {
    if (!sock) {
      console.error(
        `❌ Cannot register empty socket: ${sessionId}`
      );
      return;
    }

    sessionId =
      sessionId ||
      sock.sessionId ||
      "default";

    console.log(
      `🔌 New WhatsApp socket registered: ${sessionId}`
    );

    /*
     * Store socket locally.
     */
    app.locals.socks.set(
      sessionId,
      sock
    );

    /*
     * Store session metadata.
     */
    app.locals.sessions.set(
      sessionId,
      {
        sessionId,
        sock,
        connected: !!sock.user,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
    );

    /*
     * Listen for connection updates.
     */
    if (sock.ev) {
      sock.ev.on(
        "connection.update",
        (update) => {
          try {
            const {
              connection,
              qr,
              lastDisconnect,
            } = update;

            const current = app.locals.sessions.get(
              sessionId
            );

            if (current) {
              current.updatedAt = new Date();

              if (connection === "open") {
                current.connected = true;
                current.sock = sock;
              }

              if (connection === "close") {
                current.connected = false;
              }
            }

            /*
             * QR CODE
             */
            if (qr) {
              app.locals.qrs.set(
                sessionId,
                qr
              );

              console.log(
                `📱 QR received for session: ${sessionId}`
              );

              broadcastAdmin({
                type: "qr",
                sessionId,
                qr,
              });
            }

            /*
             * CONNECTION OPEN
             */
            if (connection === "open") {
              app.locals.qrs.delete(
                sessionId
              );

              console.log(
                `✅ WhatsApp connected: ${sessionId}`
              );

              broadcastAdmin({
                type: "connection",
                sessionId,
                status: "connected",
              });
            }

            /*
             * CONNECTION CLOSE
             */
            if (connection === "close") {
              console.log(
                `🔴 WhatsApp disconnected: ${sessionId}`
              );

              broadcastAdmin({
                type: "connection",
                sessionId,
                status: "disconnected",
                lastDisconnect,
              });
            }
          } catch (error) {
            console.error(
              `❌ connection.update error [${sessionId}]:`,
              error?.message || error
            );
          }
        }
      );
    }
  } catch (error) {
    console.error(
      `❌ handleNewSock error [${sessionId}]:`,
      error?.message || error
    );
  }
};

/* =====================================================
   REGISTER SOCKET CALLBACK
===================================================== */

onNewSock(handleNewSock);

/* =====================================================
   ADMIN WEBSOCKET CLIENTS
===================================================== */

const adminClients = new Set();

const broadcastAdmin = (data) => {
  const payload = JSON.stringify(data);

  for (const ws of adminClients) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    } catch (error) {
      console.error(
        "❌ Admin WS send error:",
        error?.message || error
      );
    }
  }
};

/* =====================================================
   ADMIN EVENTS
===================================================== */

try {
  subscribeAdminEvents((event) => {
    broadcastAdmin(event);
  });
} catch (error) {
  console.error(
    "❌ Failed to subscribe admin events:",
    error?.message || error
  );
}

/* =====================================================
   HTTP SERVER
===================================================== */

const server = http.createServer(app);

/* =====================================================
   WEBSOCKET SERVER
===================================================== */

const wss = new WebSocketServer({
  server,
  path: "/ws",
});

/* =====================================================
   WEBSOCKET CONNECTION
===================================================== */

wss.on("connection", (ws, req) => {
  console.log("🔌 WebSocket client connected");

  adminClients.add(ws);

  /*
   * Requested session.
   */
  let requestedSession =
    "default";

  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    requestedSession =
      url.searchParams.get("sessionId") ||
      url.searchParams.get("session") ||
      "default";
  } catch {
    requestedSession = "default";
  }

  /*
   * Send initial status.
   */
  const initialSock =
    getSock(requestedSession);

  try {
    ws.send(
      JSON.stringify({
        type: "connection",
        sessionId: requestedSession,
        status: initialSock?.user
          ? "connected"
          : "disconnected",
      })
    );
  } catch {}

  /* ===================================================
     MESSAGE
  =================================================== */

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(
        raw.toString()
      );

      const {
        action,
        message,
        jid,
        sessionId,
        recipients,
      } = data;

      /*
       * Allow changing active session.
       */
      if (sessionId) {
        requestedSession = sessionId;
      }

      /*
       * SEND MESSAGE
       */
      if (action === "send") {
        if (!message) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: "Message is required",
            })
          );

          return;
        }

        const activeSession =
          sessionId ||
          requestedSession ||
          "default";

        const activeSock =
          getSock(activeSession);

        if (!activeSock) {
          ws.send(
            JSON.stringify({
              type: "error",
              sessionId: activeSession,
              error: "Session socket not found",
            })
          );

          return;
        }

        if (!activeSock.user) {
          ws.send(
            JSON.stringify({
              type: "error",
              sessionId: activeSession,
              error: "WhatsApp session is not connected",
            })
          );

          return;
        }

        /*
         * Multiple recipients.
         */
        if (
          Array.isArray(recipients) &&
          recipients.length > 0
        ) {
          const jids =
            recipients
              .map((number) => {
                try {
                  return normalizeJID(
                    String(number)
                  );
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

          await Promise.all(
            jids.map(
              (recipientJid) =>
                messageQueue.enqueue(
                  activeSession,
                  recipientJid,
                  () =>
                    activeSock.sendMessage(
                      recipientJid,
                      {
                        text: message,
                      }
                    ),
                  0
                )
            )
          );

          ws.send(
            JSON.stringify({
              type: "sent",
              sessionId: activeSession,
              count: jids.length,
            })
          );

          return;
        }

        /*
         * Single recipient.
         */
        if (!jid) {
          ws.send(
            JSON.stringify({
              type: "error",
              error: "Recipient JID is required",
            })
          );

          return;
        }

        const recipientJid =
          normalizeJID(String(jid));

        await messageQueue.enqueue(
          activeSession,
          recipientJid,
          () =>
            activeSock.sendMessage(
              recipientJid,
              {
                text: message,
              }
            ),
          0
        );

        ws.send(
          JSON.stringify({
            type: "sent",
            sessionId: activeSession,
            jid: recipientJid,
          })
        );

        return;
      }

      /*
       * GET SESSION STATUS
       */
      if (action === "status") {
        const targetSession =
          sessionId ||
          requestedSession ||
          "default";

        const sock =
          getSock(targetSession);

        ws.send(
          JSON.stringify({
            type: "status",
            sessionId: targetSession,
            connected: !!sock?.user,
            user: sock?.user || null,
          })
        );

        return;
      }

      /*
       * PING
       */
      if (action === "ping") {
        ws.send(
          JSON.stringify({
            type: "pong",
            timestamp: Date.now(),
          })
        );

        return;
      }
    } catch (error) {
      console.error(
        "❌ WebSocket message error:",
        error?.message || error
      );

      try {
        ws.send(
          JSON.stringify({
            type: "error",
            error:
              error?.message ||
              "Invalid WebSocket request",
          })
        );
      } catch {}
    }
  });

  /* ===================================================
     CLOSE
  =================================================== */

  ws.on("close", () => {
    adminClients.delete(ws);

    console.log(
      "🔌 WebSocket client disconnected"
    );
  });

  /* ===================================================
     ERROR
  =================================================== */

  ws.on("error", (error) => {
    console.error(
      "❌ WebSocket error:",
      error?.message || error
    );

    adminClients.delete(ws);
  });
});

/* =====================================================
   API: ALL SESSIONS
===================================================== */

app.get(
  "/api/sessions",
  async (req, res) => {
    try {
      const sessions =
        getAllSessions();

      const result = [];

      for (const [
        sessionId,
        sessionData,
      ] of sessions.entries()) {
        const sock =
          sessionData?.sock ||
          getSock(sessionId);

        result.push({
          sessionId,

          connected:
            !!sock &&
            !!sock.user,

          starting:
            !!sessionData?.starting,

          stopped:
            !!sessionData?.stopped,

          connectionAttempts:
            sessionData?.connectionAttempts ||
            0,

          createdAt:
            sessionData?.createdAt ||
            null,

          updatedAt:
            sessionData?.updatedAt ||
            null,

          user:
            sock?.user ||
            null,
        });
      }

      res.json({
        success: true,
        sessions: result,
        count: result.length,
      });
    } catch (error) {
      console.error(
        "❌ /api/sessions error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =====================================================
   API: SINGLE SESSION
===================================================== */

app.get(
  "/api/sessions/:sessionId",
  async (req, res) => {
    try {
      const sessionId =
        req.params.sessionId;

      const sessions =
        getAllSessions();

      const sessionData =
        sessions.get(sessionId);

      const sock =
        sessionData?.sock ||
        getSock(sessionId);

      if (!sessionData && !sock) {
        return res.status(404).json({
          success: false,
          error: "Session not found",
        });
      }

      res.json({
        success: true,

        session: {
          sessionId,

          connected:
            !!sock &&
            !!sock.user,

          starting:
            !!sessionData?.starting,

          stopped:
            !!sessionData?.stopped,

          connectionAttempts:
            sessionData?.connectionAttempts ||
            0,

          createdAt:
            sessionData?.createdAt ||
            null,

          updatedAt:
            sessionData?.updatedAt ||
            null,

          user:
            sock?.user ||
            null,
        },
      });
    } catch (error) {
      console.error(
        "❌ Single session error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =====================================================
   API: START SESSION
===================================================== */

app.post(
  "/api/sessions/:sessionId/start",
  async (req, res) => {
    try {
      const sessionId =
        req.params.sessionId;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: "sessionId is required",
        });
      }

      const sock =
        await startSock(
          sessionId,
          "api-start"
        );

      res.json({
        success: true,
        sessionId,
        connected: !!sock?.user,
      });
    } catch (error) {
      console.error(
        "❌ Start session error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =====================================================
   API: STOP SESSION
===================================================== */

app.post(
  "/api/sessions/:sessionId/stop",
  async (req, res) => {
    try {
      const sessionId =
        req.params.sessionId;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: "sessionId is required",
        });
      }

      await stopSession(
        sessionId
      );

      app.locals.socks.delete(
        sessionId
      );

      app.locals.qrs.delete(
        sessionId
      );

      app.locals.sessions.delete(
        sessionId
      );

      res.json({
        success: true,
        sessionId,
        message: "Session stopped",
      });
    } catch (error) {
      console.error(
        "❌ Stop session error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =====================================================
   API: QUEUE STATUS
===================================================== */

app.get(
  "/api/queue",
  async (req, res) => {
    try {
      if (
        typeof messageQueue.getSnapshot ===
        "function"
      ) {
        return res.json({
          success: true,
          queue:
            messageQueue.getSnapshot(),
        });
      }

      res.json({
        success: true,
        queue: null,
      });
    } catch (error) {
      console.error(
        "❌ Queue status error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =====================================================
   API: UPCOMING REMINDERS
===================================================== */

app.get(
  "/api/reminders/upcoming",
  async (req, res) => {
    try {
      const reminders =
        await getUpcomingReminders();

      res.json({
        success: true,
        reminders,
      });
    } catch (error) {
      console.error(
        "❌ Reminder error:",
        error
      );

      res.status(500).json({
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }
);

/* =====================================================
   404 API
===================================================== */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "API endpoint not found",
    });
  }
);

/* =====================================================
   ERROR HANDLER
===================================================== */

app.use(
  (error, req, res, next) => {
    console.error(
      "❌ Express error:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(
      error?.status || 500
    ).json({
      success: false,
      error:
        error?.message ||
        "Internal server error",
    });
  }
);

/* =====================================================
   START REMINDER SCHEDULER
===================================================== */

try {
  scheduleReminders();
  console.log(
    "⏰ Reminder scheduler started"
  );
} catch (error) {
  console.error(
    "❌ Reminder scheduler failed:",
    error
  );
}

/* =====================================================
   START SERVER
===================================================== */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "================================================"
    );
    console.log(
      "🚀 WHATSAPP BOT SERVER STARTED"
    );
    console.log(
      "================================================"
    );
    console.log(
      `🌐 Port: ${PORT}`
    );
    console.log(
      `📊 Dashboard: /admin`
    );
    console.log(
      `❤️ Health: /health`
    );
    console.log(
      `🔌 WebSocket: /ws`
    );
    console.log(
      `📱 Multi-session: ENABLED`
    );
    console.log(
      `📦 Queue multi-session: ${
        messageQueue.multiSession
          ? "ENABLED"
          : "DISABLED"
      }`
    );
    console.log(
      "================================================"
    );
    console.log("");
  }
);

/* =====================================================
   PROCESS ERROR HANDLERS
===================================================== */

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "❌ UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "❌ UNHANDLED REJECTION:",
      reason
    );
  }
);

/* =====================================================
   GRACEFUL SHUTDOWN
===================================================== */

let shuttingDown = false;

const gracefulShutdown = async (
  signal
) => {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log("");
  console.log(
    `🛑 Received ${signal}. Shutting down...`
  );

  try {
    /*
     * Stop accepting new HTTP connections.
     */
    await new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  } catch (error) {
    console.error(
      "❌ Server close error:",
      error
    );
  }

  try {
    /*
     * Close WebSocket clients.
     */
    for (const ws of adminClients) {
      try {
        ws.close();
      } catch {}
    }

    adminClients.clear();
  } catch (error) {
    console.error(
      "❌ WebSocket shutdown error:",
      error
    );
  }

  try {
    /*
     * Stop all WhatsApp sessions.
     */
    const sessions =
      getAllSessions();

    for (const [
      sessionId,
    ] of sessions.entries()) {
      try {
        await stopSession(
          sessionId
        );
      } catch (error) {
        console.error(
          `❌ Failed stopping session ${sessionId}:`,
          error?.message ||
            error
        );
      }
    }
  } catch (error) {
    console.error(
      "❌ Session shutdown error:",
      error
    );
  }

  try {
    /*
     * Destroy message queue.
     */
    if (
      typeof messageQueue.destroy ===
      "function"
    ) {
      await messageQueue.destroy();
    }
  } catch (error) {
    console.error(
      "❌ Queue shutdown error:",
      error
    );
  }

  console.log(
    "✅ Shutdown complete"
  );

  process.exit(0);
};

process.on(
  "SIGINT",
  () =>
    gracefulShutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () =>
    gracefulShutdown("SIGTERM")
);
