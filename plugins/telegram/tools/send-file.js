const { resolveTopicId, telegramApi } = require('../lib/telegram-api');

module.exports = async function handler(params, ctx) {
  const botToken = await ctx.settings.get('telegram.botToken');
  if (!botToken) return { success: false, error: 'Bot token not configured' };

  const chatId = params.chatId || await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) return { success: false, error: 'No chat ID configured' };

  const channelId = ctx.channelId;
  const filePath = params.filePath;
  if (!filePath) return { success: false, error: 'filePath is required' };

  try {
    const fileBuffer = await ctx.fs.read(filePath);
    const fileName = filePath.split(/[/\\]/).pop() || 'file';

    const topicId = await resolveTopicId(ctx, botToken, chatId, channelId);

    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', new Blob([fileBuffer]), fileName);
    if (params.caption) formData.append('caption', params.caption);
    if (topicId) formData.append('message_thread_id', String(topicId));

    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description}`);

    // Update message history (persistent store + live viewData)
    const history = (await ctx.store.get('messageHistory')) || [];
    history.unshift({
      direction: 'out',
      message: `[File] ${fileName}`,
      chatId,
      channelId,
      timestamp: Date.now(),
    });
    if (history.length > 100) history.length = 100;
    await ctx.store.set('messageHistory', history);
    ctx.viewData.set('telegram.messageHistory', history);

    return { success: true, fileName };
  } catch (e) {
    return { success: false, error: e.message };
  }
};
