export default async function(_params, ctx) {
  const token = await ctx.settings.get('telegram.botToken');
  if (!token) {
    ctx.toast({ type: 'error', message: 'Bot Token is required. Please enter it first.' });
    return;
  }

  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!chatId) {
    ctx.toast({ type: 'error', message: 'Chat ID is required. Use "Fetch Chat ID" first.' });
    return;
  }

  try {
    const res = await ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '👋 Hello from Filer! Your Telegram integration is working.',
        parse_mode: 'Markdown',
      }),
    });

    const data = await res.json();
    if (data.ok) {
      ctx.toast({ type: 'success', message: 'Test message sent successfully!' });
      ctx.log.info('Test message sent to chat', chatId);
    } else {
      ctx.toast({ type: 'error', message: `Telegram error: ${data.description}` });
    }
  } catch (err) {
    ctx.toast({ type: 'error', message: `Failed to send test message: ${err.message}` });
  }
}
