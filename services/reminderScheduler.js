/**
 * =====================================================
 * DVARY BOT - REMINDER SCHEDULER
 * =====================================================
 */

const reminders = new Map();

let schedulerStarted = false;
let schedulerTimer = null;

/**
 * Generate reminder ID
 */
const createReminderId = () => {
  return `rem_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

/**
 * Add reminder
 */
export const addReminder = ({
  sessionId = "default",
  jid,
  message,
  remindAt,
}) => {
  if (!jid) {
    throw new Error("jid is required");
  }

  if (!message) {
    throw new Error("message is required");
  }

  const date = new Date(remindAt);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid remindAt date");
  }

  const id = createReminderId();

  const reminder = {
    id,
    sessionId,
    jid,
    message,
    remindAt: date.toISOString(),
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  reminders.set(id, reminder);

  return reminder;
};

/**
 * Remove reminder
 */
export const removeReminder = (id) => {
  if (!id) return false;

  return reminders.delete(id);
};

/**
 * Get one reminder
 */
export const getReminder = (id) => {
  return reminders.get(id) || null;
};

/**
 * Get all reminders
 */
export const getAllReminders = () => {
  return [...reminders.values()];
};

/**
 * Get upcoming reminders
 */
export const getUpcomingReminders = async () => {
  const now = Date.now();

  return [...reminders.values()]
    .filter((reminder) => {
      if (reminder.status !== "pending") {
        return false;
      }

      return (
        new Date(reminder.remindAt).getTime() >=
        now
      );
    })
    .sort(
      (a, b) =>
        new Date(a.remindAt).getTime() -
        new Date(b.remindAt).getTime()
    );
};

/**
 * Process reminders
 */
const processReminders = async () => {
  const now = Date.now();

  for (const reminder of reminders.values()) {
    try {
      if (reminder.status !== "pending") {
        continue;
      }

      const remindTime =
        new Date(
          reminder.remindAt
        ).getTime();

      if (
        Number.isNaN(remindTime) ||
        remindTime > now
      ) {
        continue;
      }

      /*
       * Mark as processed.
       *
       * Actual WhatsApp sending can be connected
       * here later through the session/socket system.
       */
      reminder.status = "processed";

      reminder.processedAt =
        new Date().toISOString();

      reminders.set(
        reminder.id,
        reminder
      );

      console.log(
        `⏰ Reminder processed: ${reminder.id}`
      );
    } catch (error) {
      console.error(
        `❌ Reminder processing error [${reminder.id}]:`,
        error?.message || error
      );

      reminder.status = "error";
      reminder.error =
        error?.message ||
        String(error);

      reminders.set(
        reminder.id,
        reminder
      );
    }
  }
};

/**
 * Start scheduler
 */
export const scheduleReminders = () => {
  if (schedulerStarted) {
    return;
  }

  schedulerStarted = true;

  schedulerTimer = setInterval(
    () => {
      processReminders().catch(
        (error) => {
          console.error(
            "❌ Reminder scheduler error:",
            error?.message || error
          );
        }
      );
    },
    30 * 1000
  );

  /*
   * Do not keep Node alive only because
   * of this timer.
   */
  if (
    schedulerTimer &&
    typeof schedulerTimer.unref ===
      "function"
  ) {
    schedulerTimer.unref();
  }

  console.log(
    "⏰ Reminder scheduler initialized"
  );
};

/**
 * Stop scheduler
 */
export const stopReminderScheduler = () => {
  if (schedulerTimer) {
    clearInterval(
      schedulerTimer
    );

    schedulerTimer = null;
  }

  schedulerStarted = false;

  console.log(
    "🛑 Reminder scheduler stopped"
  );
};

/**
 * Scheduler status
 */
export const isReminderSchedulerRunning =
  () => {
    return schedulerStarted;
  };

/**
 * Clear all reminders
 */
export const clearReminders = () => {
  reminders.clear();

  console.log(
    "🧹 All reminders cleared"
  );
};

export default {
  addReminder,
  removeReminder,
  getReminder,
  getAllReminders,
  getUpcomingReminders,
  scheduleReminders,
  stopReminderScheduler,
  isReminderSchedulerRunning,
  clearReminders,
};
