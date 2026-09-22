/**
 * =====================================================
 * DVARY BOT - JID NORMALIZER
 * =====================================================
 */

/**
 * Normalize WhatsApp JID
 *
 * Examples:
 * 255718278672
 * +255718278672
 * 255718278672@s.whatsapp.net
 * 120363xxxxx@g.us
 *
 * @param {string|number} input
 * @returns {string}
 */
const normalizeJID = (input) => {
  if (
    input === undefined ||
    input === null
  ) {
    throw new Error(
      "WhatsApp JID is required"
    );
  }

  let value = String(input).trim();

  if (!value) {
    throw new Error(
      "WhatsApp JID cannot be empty"
    );
  }

  /*
   * Remove whitespace.
   */
  value = value.replace(/\s+/g, "");

  /*
   * Already a WhatsApp JID.
   */
  if (value.includes("@")) {
    const [user, server] =
      value.split("@");

    if (!user || !server) {
      throw new Error(
        `Invalid WhatsApp JID: ${value}`
      );
    }

    return `${user}@${server}`;
  }

  /*
   * Remove leading +.
   */
  value = value.replace(/^\+/, "");

  /*
   * Keep digits only.
   */
  value = value.replace(/\D/g, "");

  if (!value) {
    throw new Error(
      `Invalid WhatsApp number: ${input}`
    );
  }

  /*
   * WhatsApp individual number JID.
   */
  return `${value}@s.whatsapp.net`;
};

export default normalizeJID;

export {
  normalizeJID,
};
