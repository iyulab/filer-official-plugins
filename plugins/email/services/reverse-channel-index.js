/**
 * In-memory reverse index: lowercased sender address -> channelId.
 * Built from each channel's 'email' integration config (config.matchSender).
 *
 * v1 note: no settings UI exists yet to populate a channel's matchSender, so
 * this index is expected to stay empty in practice — a mapped sender always
 * wins over the allowlist below when one does exist. The lookup path is
 * still real code (not a stub) so a future channel-integrations UI lights
 * it up without touching this file.
 *
 * Sender allowlist (email.senderAllowlist, global setting): unlike Telegram's
 * polling-service.js (a chatId the user themselves messages from, so a
 * "default chat" is a natural, safe default), email has no equivalent
 * built-in identity — anyone on the internet can address the configured
 * mailbox. Routing every unmapped sender to 'default' unconditionally
 * (v1's original behavior) is exactly the exposure
 * ISSUE-filer-20260820-imap-inbound-trigger-no-sender-allowlist.md flags.
 * Secure-by-default: an unset/empty allowlist means no unmapped sender is
 * ever routed, mirroring polling-service.js's own "no channelId -> drop the
 * message" gate rather than inventing a different failure mode for email.
 */

/** @type {Map<string, string>} */
const index = new Map();

/** @type {Set<string>} */
let allowlist = new Set();

/**
 * Parse the raw comma-separated setting value into a lowercased Set. Blank
 * entries (extra commas, surrounding whitespace) are dropped rather than
 * kept as accidental "match everything" wildcards.
 * @param {string|undefined} raw
 * @returns {Set<string>}
 */
function parseAllowlist(raw) {
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Does this allowlist admit the given (already-lowercased) sender address?
 * An entry starting with '@' matches the whole domain (`@example.com`
 * admits anyone@example.com); any other entry must match the full address
 * exactly.
 * @param {Set<string>} list
 * @param {string} lowerAddress
 * @returns {boolean}
 */
function isAllowed(list, lowerAddress) {
  if (list.has(lowerAddress)) return true;
  const at = lowerAddress.lastIndexOf('@');
  if (at === -1) return false;
  return list.has(`@${lowerAddress.slice(at + 1)}`);
}

/**
 * Pure resolution: given a reverse index, a sender allowlist, and a sender
 * address, return the matching channelId — a per-channel mapping wins
 * outright, otherwise an allowlisted sender falls back to 'default', and an
 * unmapped, unallowlisted (or missing) sender is rejected with `null`.
 * @param {Map<string,string>} idx
 * @param {Set<string>} list
 * @param {string|undefined} fromAddress
 * @returns {string|null}
 */
function resolveFromIndex(idx, list, fromAddress) {
  if (!fromAddress) return null;
  const lower = fromAddress.toLowerCase();
  const mapped = idx.get(lower);
  if (mapped) return mapped;
  return isAllowed(list, lower) ? 'default' : null;
}

/**
 * Build the reverse index and sender allowlist.
 * @param {object} ctx - PluginContext
 */
async function build(ctx) {
  index.clear();

  const hostUrl = process.env.FILER_HOST_URL || 'http://localhost:5100';
  const channelList = await ctx.fetch(`${hostUrl}/api/channels`).then(r => r.json()).catch(() => []);

  for (const channel of channelList) {
    const config = await ctx.channels.getIntegrationConfig(channel.channelId, 'email');
    if (config?.matchSender) {
      index.set(String(config.matchSender).toLowerCase(), channel.channelId);
    }
  }

  allowlist = parseAllowlist(await ctx.settings.get('email.senderAllowlist'));

  ctx.log.info(`Email reverse channel index built: ${index.size} entries, ${allowlist.size} allowlisted sender(s)`);
}

/**
 * Resolve an inbound message's sender to a channelId, or null to reject it.
 * @param {string|undefined} fromAddress
 * @returns {string|null}
 */
function resolve(fromAddress) {
  return resolveFromIndex(index, allowlist, fromAddress);
}

/**
 * Invalidate and rebuild the index.
 * @param {object} ctx - PluginContext
 */
async function invalidate(ctx) {
  await build(ctx);
}

module.exports = { build, resolve, invalidate, resolveFromIndex, isAllowed, parseAllowlist };
