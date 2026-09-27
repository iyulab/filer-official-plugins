const { sendWithTopicRetry } = require('../lib/telegram-api');
const { recordOutbound } = require('../lib/message-history');

module.exports = async function onSessionMessage(event, ctx) {
  if (!event.channelId) return;
  const botToken = await ctx.settings.get('telegram.botToken');
  const chatId = await ctx.settings.get('telegram.defaultChatId');
  // A relay that cannot be made is a failure, not a quiet no-op: the host reads this hook's outcome as whether the run's
  // reply reached the user (a thrown error = not delivered). Returning here made an unconfigured bot read as delivered.
  if (!botToken) throw new Error('Telegram bot token is not set');
  if (!chatId) throw new Error('Telegram chat id is not set — send /start to the bot');

  const format = (await ctx.settings.get('telegram.messageFormat')) || 'Markdown';

  try {
    // A host-triggered working-agent session's transcript is never written to
    // the same file the /history endpoint reads (that write path lives in the
    // chat endpoint, which trigger-driven sessions bypass entirely) — the
    // fetch below would 404 for every one of them. When the event already
    // carries the result text (host-triggered path), use it directly and skip
    // the fetch. A UI-chat-panel session's emission doesn't set `result`, so
    // this falls through to the pre-existing fetch-based lookup unchanged.
    let text = typeof event.result === 'string' ? event.result : null;

    if (!text) {
      // HD-91: ctx.getSessionHistory, not ctx.fetch — this always targets the host's own
      // localhost origin, which ctx.fetch's SSRF deny-list unconditionally blocks.
      const resp = await ctx.getSessionHistory(event.sessionId);
      if (!resp || !Array.isArray(resp)) return;

      const lastAssistant = [...resp].reverse().find(m => m.role === 'assistant');
      if (!lastAssistant?.content) return;

      text = typeof lastAssistant.content === 'string'
        ? lastAssistant.content
        : JSON.stringify(lastAssistant.content);
    }

    if (text.length > 4000) {
      text = text.substring(0, 4000) + '\n\n... [truncated]';
    }

    const payload = {
      chat_id: chatId,
      text,
      parse_mode: format === 'plain' ? undefined : format,
    };

    await sendWithTopicRetry(ctx, botToken, chatId, event.channelId, 'sendMessage', payload);
    await recordOutbound(ctx, { message: text, chatId, channelId: event.channelId });
  } catch (err) {
    ctx.log.error('Failed to relay session message to Telegram:', err.message);
    throw err;
  }
};
