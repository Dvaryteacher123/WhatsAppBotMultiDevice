/**
 * =====================================================
 * DVARY BOT - ADMIN EVENTS
 * =====================================================
 */

const subscribers = new Set();

/**
 * Subscribe to admin events
 */
export const subscribeAdminEvents = (callback) => {
  if (typeof callback !== "function") {
    throw new TypeError(
      "subscribeAdminEvents requires a function"
    );
  }

  subscribers.add(callback);

  console.log(
    `📡 Admin event subscriber added (${subscribers.size})`
  );

  return () => {
    subscribers.delete(callback);

    console.log(
      `📡 Admin event subscriber removed (${subscribers.size})`
    );
  };
};

/**
 * Publish event to all admin subscribers
 */
export const emitAdminEvent = (event) => {
  if (!event) return;

  for (const callback of subscribers) {
    try {
      callback(event);
    } catch (error) {
      console.error(
        "❌ Admin event callback error:",
        error?.message || error
      );
    }
  }
};

/**
 * Get subscriber count
 */
export const getAdminSubscriberCount = () => {
  return subscribers.size;
};

/**
 * Remove all subscribers
 */
export const clearAdminSubscribers = () => {
  subscribers.clear();

  console.log(
    "🧹 All admin event subscribers cleared"
  );
};

export default {
  subscribeAdminEvents,
  emitAdminEvent,
  getAdminSubscriberCount,
  clearAdminSubscribers,
};
