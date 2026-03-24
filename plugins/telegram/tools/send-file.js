import { createReadStream } from 'fs';
import { basename } from 'path';

export default async function(params, ctx) {
  const token = await ctx.settings.get('telegram.botToken');
  if (!token) throw new Error('Telegram Bot Token not configured.');

  // Resolve chatId: explicit param > channel integration > global default
  let chatId = params.chatId || null;
  if (!chatId) {
    try {
      const session = await ctx.session.getActive();
      if (session) {
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

  const fileName = basename(params.filePath);
  const fileData = await ctx.fs.read(params.filePath);

  // Use FormData for file upload
  const FormData = (await import('node:buffer')).FormData || globalThis.FormData;
  const blob = new Blob([fileData], { type: 'application/octet-stream' });

  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', blob, fileName);
  if (params.caption) formData.append('caption', params.caption);

  const res = await ctx.fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Telegram API error: ${err.description || res.statusText}`);
  }

  const result = await res.json();
  ctx.log.info(`File "${fileName}" sent to ${chatId}`);

  // Track in history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: new Date().toISOString(),
    chat: chatId,
    message: `[File] ${fileName}`,
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('telegram.messageHistory', history);

  return { success: true, messageId: result.result?.message_id };
}
