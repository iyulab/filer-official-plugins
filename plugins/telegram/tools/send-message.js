const { sendWithTopicRetry } = require('../lib/telegram-api');
const { recordOutbound } = require('../lib/message-history');

module.exports = async function handler(params, ctx) {
  const botToken = await ctx.settings.get('telegram.botToken');
  if (!botToken) return { success: false, error: 'Bot token not configured' };

  const chatId = params.chatId || await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) return { success: false, error: 'No chat ID configured' };

  const format = (await ctx.settings.get('telegram.messageFormat')) || 'Markdown';
  const channelId = ctx.channelId;

  const payload = { chat_id: chatId, text: params.message, parse_mode: format };

  try {
    await sendWithTopicRetry(ctx, botToken, chatId, channelId, 'sendMessage', payload);
    await recordOutbound(ctx, { message: params.message, chatId, channelId });

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};
