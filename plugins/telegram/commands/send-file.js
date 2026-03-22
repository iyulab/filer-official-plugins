export default async function(args, ctx) {
  const files = args?.files || [];
  if (files.length === 0) {
    ctx.toast({ type: 'error', message: 'No files selected' });
    return;
  }

  const token = await ctx.settings.get('telegram.botToken');
  if (!token) {
    ctx.toast({ type: 'error', message: 'Telegram Bot Token not configured. Set it in Settings > Extensions.' });
    return;
  }

  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) {
    ctx.toast({ type: 'error', message: 'Default Chat ID not configured. Set it in Settings > Extensions.' });
    return;
  }

  let sent = 0;
  for (const filePath of files) {
    try {
      await ctx.execute('telegram.send_telegram_file', { filePath, chatId });
      sent++;
    } catch (err) {
      ctx.log.error(`Failed to send ${filePath}:`, err.message);
    }
  }

  ctx.toast({
    type: sent > 0 ? 'success' : 'error',
    message: sent > 0 ? `Sent ${sent} file(s) to Telegram` : 'Failed to send files',
  });
}
