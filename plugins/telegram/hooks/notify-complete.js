export default async function(event, ctx) {
  const enabled = await ctx.settings.get('telegram.notifyOnAgentComplete');
  if (!enabled) return;

  const token = await ctx.settings.get('telegram.botToken');
  if (!token) return;

  // Resolve chatId: channel integration > global default
  let chatId = null;
  if (event.channelId && event.channelId !== 'default') {
    try {
      const config = await ctx.channels.getIntegrationConfig(event.channelId, 'telegram');
      if (config?.chatId) chatId = config.chatId;
    } catch { /* fall through to global */ }
  }
  if (!chatId) chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) return;

  const duration = event.duration ? `${Math.round(event.duration / 1000)}s` : 'unknown';
  const summary = event.result?.summary || 'Task completed';
  const message = `🤖 *Agent Complete*\n\nDuration: ${duration}\nResult: ${summary}`;

  try {
    const res = await ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });

    if (res.ok) {
      ctx.toast({ type: 'info', message: 'Agent result sent to Telegram' });
    }
  } catch (err) {
    ctx.log.error('Failed to send agent completion notification:', err.message);
  }
}
