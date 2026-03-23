export default async function(_params, ctx) {
  const token = await ctx.settings.get('telegram.botToken');
  if (!token) {
    ctx.toast({ type: 'error', message: 'Bot Token is required. Please enter it first.' });
    return;
  }

  try {
    const res = await ctx.fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    if (!res.ok) {
      ctx.toast({ type: 'error', message: `Telegram API error: ${res.status}` });
      return;
    }

    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
      ctx.toast({
        type: 'error',
        message: 'No chats found. Send a message to your bot first, then try again.'
      });
      return;
    }

    // Find unique chat IDs from recent messages
    const chats = new Map();
    for (const update of data.result) {
      const chat = update.message?.chat ?? update.channel_post?.chat;
      if (chat?.id) {
        chats.set(String(chat.id), chat.title ?? chat.first_name ?? String(chat.id));
      }
    }

    if (chats.size === 0) {
      ctx.toast({
        type: 'error',
        message: 'No chats found. Send a message to your bot first, then try again.'
      });
      return;
    }

    // Use the most recent chat
    const [chatId, chatName] = [...chats.entries()].pop();
    await ctx.settings.set('telegram.defaultChatId', chatId);
    ctx.toast({ type: 'success', message: `Chat ID set: ${chatId} (${chatName})` });
    ctx.log.info(`Fetched chat ID: ${chatId} (${chatName})`);
  } catch (err) {
    ctx.toast({ type: 'error', message: `Failed to fetch chats: ${err.message}` });
  }
}
