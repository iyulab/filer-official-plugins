/**
 * In-memory reverse index: "chatId:topicId" → channelId.
 * Built from channel integration configs at startup.
 */

/** @type {Map<string, string>} */
const index = new Map();
let defaultChatId = null;

/**
 * Build the reverse index by scanning all channels.
 * @param {object} ctx - PluginContext
 */
async function build(ctx) {
  index.clear();
  defaultChatId = (await ctx.settings.get('telegram.defaultChatId')) || null;

  // List all channels via host API. HD-91: ctx.listChannels, not ctx.fetch — this always
  // targets the host's own localhost origin, which ctx.fetch's SSRF deny-list unconditionally
  // blocks (this call was silently returning [] on every real run before this fix).
  const channelList = await ctx.listChannels().catch(() => []);

  for (const channel of channelList) {
    const config = await ctx.channels.getIntegrationConfig(channel.channelId, 'telegram');
    if (config?.topicId) {
      const key = `${defaultChatId}:${config.topicId}`;
      index.set(key, channel.channelId);
    }
  }

  ctx.log.info(`Reverse channel index built: ${index.size} entries`);
}

/**
 * Resolve a Telegram message to a channelId.
 * @param {number|string} chatId
 * @param {number|string|undefined} topicId
 * @returns {string|null}
 */
function resolve(chatId, topicId) {
  if (topicId) {
    const key = `${chatId}:${topicId}`;
    const channelId = index.get(key);
    if (channelId) return channelId;
  }

  // Default channel if chatId matches
  if (String(chatId) === String(defaultChatId)) {
    return 'default';
  }

  return null;
}

/**
 * Invalidate and rebuild the index.
 * @param {object} ctx - PluginContext
 */
async function invalidate(ctx) {
  await build(ctx);
}

module.exports = { build, resolve, invalidate };
