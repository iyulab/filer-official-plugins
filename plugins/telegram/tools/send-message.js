const { sendWithTopicRetry } = require('../lib/telegram-api');

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

    // Update message history (persistent store + live viewData)
    const history = (await ctx.store.get('messageHistory')) || [];
    history.unshift({
      direction: 'out',
      message: params.message.substring(0, 100),
      chatId,
      channelId,
      timestamp: Date.now(),
    });
    if (history.length > 100) history.length = 100;
    await ctx.store.set('messageHistory', history);
    ctx.viewData.set('telegram.messageHistory', history);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};
