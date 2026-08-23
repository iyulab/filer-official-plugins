const { sendWithTopicRetry } = require('../lib/telegram-api');

module.exports = async function onSessionMessage(event, ctx) {
  const botToken = await ctx.settings.get('telegram.botToken');
  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!botToken || !chatId) return;
  if (!event.channelId) return;

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
      const hostUrl = process.env.FILER_HOST_URL || 'http://localhost:5100';
      const resp = await ctx.fetch(`${hostUrl}/api/sessions/${event.sessionId}/history`).then(r => r.json());
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
  } catch (err) {
    ctx.log.error('Failed to relay session message to Telegram:', err.message);
  }
};
