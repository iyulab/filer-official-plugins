const { sendWithTopicRetry } = require('../lib/telegram-api');

module.exports = async function onAgentHitl(event, ctx) {
  const botToken = await ctx.settings.get('telegram.botToken');
  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!botToken || !chatId) return;

  const text = [
    '⚠️ *Approval Required*',
    '',
    `Action: \`${event.action}\``,
    event.target ? `Target: \`${event.target}\`` : null,
    event.description ? `Description: ${event.description}` : null,
  ].filter(Boolean).join('\n');

  // Telegram callback_data is limited to 64 bytes.
  // Store full IDs in plugin store and use a short key in callback_data.
  const shortKey = Date.now().toString(36);
  await ctx.store.set(`hitl:${shortKey}`, {
    agentId: event.agentId,
    requestId: event.requestId,
  });

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: JSON.stringify({
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `hitl:a:${shortKey}` },
        { text: '❌ Deny', callback_data: `hitl:d:${shortKey}` },
      ]],
    }),
  };

  try {
    await sendWithTopicRetry(ctx, botToken, chatId, event.channelId || 'default', 'sendMessage', payload);
  } catch (err) {
    ctx.log.error('Failed to send HITL request to Telegram:', err.message);
  }
};
