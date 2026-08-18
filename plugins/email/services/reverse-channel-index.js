/**
 * In-memory reverse index: lowercased sender address -> channelId.
 * Built from each channel's 'email' integration config (config.matchSender).
 *
 * v1 note: no settings UI exists yet to populate a channel's matchSender, so
 * this index is expected to stay empty in practice and resolve() always
 * falls through to the 'default' channel. The lookup path is still real
 * code (not a stub) so a future channel-integrations UI lights it up
 * without touching this file.
 */

/** @type {Map<string, string>} */
const index = new Map();

/**
 * Pure resolution: given a reverse index and a sender address, return the
 * matching channelId, or 'default' if there is no match.
 * @param {Map<string,string>} idx
 * @param {string|undefined} fromAddress
 * @returns {string}
 */
function resolveFromIndex(idx, fromAddress) {
  if (!fromAddress) return 'default';
  const channelId = idx.get(fromAddress.toLowerCase());
  return channelId || 'default';
}

/**
 * Build the reverse index by scanning all channels' email integration config.
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

  ctx.log.info(`Email reverse channel index built: ${index.size} entries`);
}

/**
 * Resolve an inbound message's sender to a channelId.
 * @param {string|undefined} fromAddress
 * @returns {string}
 */
function resolve(fromAddress) {
  return resolveFromIndex(index, fromAddress);
}

/**
 * Invalidate and rebuild the index.
 * @param {object} ctx - PluginContext
 */
async function invalidate(ctx) {
  await build(ctx);
}

module.exports = { build, resolve, invalidate, resolveFromIndex };
