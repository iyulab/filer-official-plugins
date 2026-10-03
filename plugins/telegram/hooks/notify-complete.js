const { sendWithTopicRetry } = require('../lib/telegram-api');
const { recordOutbound } = require('../lib/message-history');

// How the run ended: `outcome` is completed / unfulfilled / failed, with Filer's `reason` when it is not completed.
const HEADINGS = {
  completed: '✅ Agent completed',
  unfulfilled: '⚠️ Agent finished without doing everything asked',
  failed: '❌ Agent failed',
};

function body(event) {
  const result = typeof event.result === 'string' && event.result ? event.result : null;
  const reason = typeof event.reason === 'string' && event.reason ? event.reason : null;
  if (event.outcome === 'failed') return reason ?? result ?? 'No reason given';
  if (event.outcome === 'unfulfilled') return [reason, result].filter(Boolean).join('\n\n') || 'No summary available';
  return result ?? 'No summary available';
}

module.exports = async function onAgentComplete(event, ctx) {
  if (!(await ctx.settings.get('telegram.notifyOnAgentComplete'))) return;

  const botToken = await ctx.settings.get('telegram.botToken');
  if (!botToken) return;

  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) return;

  const channelId = event.channelId || 'default';
  const duration = event.duration ? `${(event.duration / 1000).toFixed(1)}s` : 'unknown';
  const text = `${HEADINGS[event.outcome] ?? 'Agent finished'} (${duration})\n\n${body(event)}`;

  const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };

  try {
    await sendWithTopicRetry(ctx, botToken, chatId, channelId, 'sendMessage', payload);
    await recordOutbound(ctx, { message: text, chatId, channelId });
    ctx.toast({ type: 'info', message: 'Agent result sent to Telegram' });
  } catch (e) {
    console.warn('[telegram] notify-complete failed:', e.message);
  }
};
