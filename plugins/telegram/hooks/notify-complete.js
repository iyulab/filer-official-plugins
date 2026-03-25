const { sendWithTopicRetry } = require('../lib/telegram-api');

module.exports = async function onAgentComplete(event, ctx) {
  if (!(await ctx.settings.get('telegram.notifyOnAgentComplete'))) return;

  const botToken = await ctx.settings.get('telegram.botToken');
  if (!botToken) return;

  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) return;

  const channelId = event.channelId || 'default';
  const duration = event.result?.durationMs
    ? `${(event.result.durationMs / 1000).toFixed(1)}s`
    : 'unknown';
  const summary = event.result?.summary || 'No summary available';
  const text = `✅ Agent completed (${duration})\n\n${summary}`;

  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };

  try {
    await sendWithTopicRetry(ctx, botToken, chatId, channelId, 'sendMessage', payload);
    ctx.toast({ type: 'info', message: 'Agent result sent to Telegram' });
  } catch (e) {
    console.warn('[telegram] notify-complete failed:', e.message);
  }
};
