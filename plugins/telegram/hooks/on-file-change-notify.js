const { sendWithTopicRetry } = require('../lib/telegram-api');

module.exports = async function onFileChangeNotify(event, ctx) {
  const botToken = await ctx.settings.get('telegram.botToken');
  const chatId = await ctx.settings.get('telegram.defaultChatId');
  if (!botToken || !chatId) return;

  const format = (await ctx.settings.get('telegram.messageFormat')) || 'Markdown';

  let text = '';
  if (event.isDigest) {
    text = `🌅 ${event.summary}`;
  } else {
    const folderName = event.folderDisplayName || event.folderPath;
    const lines = [`📁 *${folderName}* — ${event.changes.length} files changed`];
    for (const change of (event.changes || []).slice(0, 10)) {
      const fileName = change.path.split(/[\\/]/).pop();
      const symbol = change.changeType === 'Created' ? '+' : change.changeType === 'Deleted' ? '-' : '~';
      lines.push(`  ${symbol} ${fileName} (${change.changeType.toLowerCase()})`);
    }
    if (event.changes && event.changes.length > 10) {
      lines.push(`  ... and ${event.changes.length - 10} more`);
    }
    text = lines.join('\n');
  }

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: format === 'plain' ? undefined : format,
  };

  try {
    await sendWithTopicRetry(ctx, botToken, chatId, event.channelId || 'default', 'sendMessage', payload);
  } catch (err) {
    ctx.log.error('Failed to send file change notification:', err.message);
  }
};
