/**
 * Shared Telegram Bot API client and Forum Topic resolution.
 */

async function telegramApiCall(botToken, method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data;
}

/**
 * Text sent with `parse_mode: 'Markdown'` is often free-form, not authored for
 * Telegram's strict legacy Markdown dialect — a stray asterisk (e.g. inside a
 * filename like `*.docx`) or an unclosed backtick is enough for Telegram to
 * reject the whole message with "can't parse entities". Losing the message
 * outright over a formatting quirk is worse than losing formatting, so retry
 * once as plain text on that specific error — the same degrade-and-retry
 * shape `sendWithTopicRetry` already uses for a deleted topic, just one level
 * down, so every caller benefits without duplicating the fallback.
 */
async function telegramApi(botToken, method, params) {
  try {
    return await telegramApiCall(botToken, method, params);
  } catch (e) {
    if (params.parse_mode && /can't parse entities/i.test(e.message)) {
      const { parse_mode, ...plain } = params;
      return await telegramApiCall(botToken, method, plain);
    }
    throw e;
  }
}

/**
 * Resolve the Forum Topic ID for a channel.
 * Returns null for default channel or if topics are not supported.
 * Auto-creates a topic if none exists for the channel.
 */
async function resolveTopicId(ctx, botToken, chatId, channelId) {
  if (!channelId || channelId === 'default') return null;

  const config = await ctx.channels.getIntegrationConfig(channelId, 'telegram');
  if (config?.topicId) return config.topicId;

  try {
    const topicName = channelId.replace(/^ch-/, '').replace(/-/g, ' ');
    const resp = await telegramApi(botToken, 'createForumTopic', {
      chat_id: chatId,
      name: topicName,
    });
    const topicId = resp.result.message_thread_id;
    await ctx.channels.setIntegrationConfig(channelId, 'telegram', { topicId });
    return topicId;
  } catch (e) {
    ctx.log.warn(
      `Failed to create Telegram topic for channel=${channelId}, falling back to default: ${e.message}`
    );
    return null;
  }
}

/**
 * Send a message with topic routing and retry on deleted topic.
 */
async function sendWithTopicRetry(ctx, botToken, chatId, channelId, apiMethod, payload) {
  const topicId = await resolveTopicId(ctx, botToken, chatId, channelId);
  if (topicId) payload.message_thread_id = topicId;

  try {
    return await telegramApi(botToken, apiMethod, payload);
  } catch (e) {
    if (topicId && e.message && e.message.includes('thread not found')) {
      await ctx.channels.setIntegrationConfig(channelId, 'telegram', {});
      delete payload.message_thread_id;
      return await telegramApi(botToken, apiMethod, payload);
    }
    throw e;
  }
}

module.exports = { telegramApi, resolveTopicId, sendWithTopicRetry };
