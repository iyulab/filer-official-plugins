export default async function(params, ctx) {
  const token = await ctx.settings.get('telegram.botToken');
  if (!token) throw new Error('Telegram Bot Token not configured. Set it in Settings > Extensions.');

  // Resolve chatId: explicit param > channel integration > global default
  let chatId = params.chatId || null;
  if (!chatId) {
    try {
      const session = await ctx.session.getActive();
      if (session) {
        // session object may carry channelId from the session store
        const channelId = session.channelId;
        if (channelId && channelId !== 'default') {
          const config = await ctx.channels.getIntegrationConfig(channelId, 'telegram');
          if (config?.chatId) chatId = config.chatId;
        }
      }
    } catch { /* fall through to global */ }
  }
  if (!chatId) chatId = await ctx.settings.get('telegram.defaultChatId');
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
