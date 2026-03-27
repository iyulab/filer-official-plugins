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

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: JSON.stringify({
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `hitl:approve:${event.agentId}:${event.requestId}` },
        { text: '❌ Deny', callback_data: `hitl:deny:${event.agentId}:${event.requestId}` },
      ]],
    }),
  };

  try {
    await sendWithTopicRetry(ctx, botToken, chatId, event.channelId || 'default', 'sendMessage', payload);
  } catch (err) {
    ctx.log.error('Failed to send HITL request to Telegram:', err.message);
  }
};
