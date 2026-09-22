// =====================================================
// DVARY BOT - SOCKET REFERENCE
// Multi-Session Socket Manager
// =====================================================

const sockets = new Map();

/**
 * Save / update socket for a session
 */
export const setSock = (sock, sessionId = "default") => {
  if (!sock) return null;

  sockets.set(sessionId, sock);

  // Keep sessionId available on the socket
  sock.sessionId = sessionId;

  console.log(`🔌 Socket registered: ${sessionId}`);

  return sock;
};

/**
 * Get socket for a specific session
 */
export const getSock = (sessionId = "default") => {
  return sockets.get(sessionId) || null;
};

/**
 * Check whether a session has a socket
 */
export const hasSock = (sessionId = "default") => {
  return sockets.has(sessionId);
};

/**
 * Get all active sockets
 */
export const getAllSocks = () => {
  return new Map(sockets);
};

/**
 * Get all session IDs
 */
export const getAllSessionIds = () => {
  return [...sockets.keys()];
};

/**
 * Remove socket from a session
 */
export const removeSock = (sessionId = "default") => {
  const sock = sockets.get(sessionId);

  if (sock) {
    sockets.delete(sessionId);
    console.log(`🗑️ Socket removed: ${sessionId}`);
  }

  return sock || null;
};

/**
 * Clear all sockets
 */
export const clearSocks = () => {
  sockets.clear();
  console.log("🧹 All socket references cleared");
};

/**
 * Number of active sockets
 */
export const getSocketCount = () => {
  return sockets.size;
};

export default {
  setSock,
  getSock,
  hasSock,
  getAllSocks,
  getAllSessionIds,
  removeSock,
  clearSocks,
  getSocketCount,
};
