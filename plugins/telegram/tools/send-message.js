export default async function(params, ctx) {
  const token = await ctx.settings.get('telegram.botToken');
  if (!token) throw new Error('Telegram Bot Token not configured. Set it in Settings > Extensions.');

  const chatId = params.chatId || await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) throw new Error('No chat ID provided and no default configured.');

  const format = await ctx.settings.get('telegram.messageFormat') || 'Markdown';

  const res = await ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: params.message,
      parse_mode: format === 'plain' ? undefined : format,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Telegram API error: ${err.description || res.statusText}`);
  }

  const result = await res.json();
  const messageId = result.result?.message_id;
  ctx.log.info(`Message sent to ${chatId}, id: ${messageId}`);

  // Track in history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: new Date().toISOString(),
    chat: chatId,
    message: params.message.substring(0, 100),
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('telegram.messageHistory', history);

  return { success: true, messageId };
}
