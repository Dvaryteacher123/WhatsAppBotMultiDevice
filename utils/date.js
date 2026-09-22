/**
 * =====================================================
 * DVARY BOT - DATE UTILS
 * =====================================================
 */

/**
 * Get current date using project timezone.
 *
 * Original project timezone:
 * Asia/Kolkata
 */
const getDate = () => {
  const date = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
  });

  return new Date(date);
};

/**
 * Get today's date as YYYY-MM-DD
 */
const getToday = () => {
  const date = getDate();

  const year = date.getFullYear();
  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

/**
 * Get current date object
 */
const getCurrentDate = () => {
  return getDate();
};

/**
 * Default export
 *
 * Keeps compatibility with old code:
 *
 * import getDate from "./utils/date.js";
 */
export default getDate;

/**
 * Named exports
 *
 * Used by index.js and other modules.
 */
export {
  getDate,
  getToday,
  getCurrentDate,
};
