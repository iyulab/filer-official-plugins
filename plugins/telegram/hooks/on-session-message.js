const { sendWithTopicRetry } = require('../lib/telegram-api');
const { recordOutbound } = require('../lib/message-history');

// The reply to a conversation that came in on Telegram. Filer raises this only for such a conversation, with the reply's
// text in `result` — a chat in the app's own panel, or a run started by a file or a schedule, is never relayed here.
module.exports = async function onSessionMessage(event, ctx) {
  if (!event.channelId) return;
  const botToken = await ctx.settings.get('telegram.botToken');
  const chatId = await ctx.settings.get('telegram.defaultChatId');
  // A relay that cannot be made is a failure, not a quiet no-op: the host reads this hook's outcome as whether the run's
  // reply reached the user (a thrown error = not delivered). Returning here made an unconfigured bot read as delivered.
  if (!botToken) throw new Error('Telegram bot token is not set');
  if (!chatId) throw new Error('Telegram chat id is not set — send /start to the bot');
  let text = typeof event.result === 'string' ? event.result.trim() : '';
  if (!text) throw new Error('The run had no reply text to send');

  const format = (await ctx.settings.get('telegram.messageFormat')) || 'Markdown';

  try {
    if (text.length > 4000) {
      text = text.substring(0, 4000) + '\n\n... [truncated]';
    }

    const payload = {
      chat_id: chatId,
      text,
      parse_mode: format === 'plain' ? undefined : format,
    };

    await sendWithTopicRetry(ctx, botToken, chatId, event.channelId, 'sendMessage', payload);
    await recordOutbound(ctx, { message: text, chatId, channelId: event.channelId });
  } catch (err) {
    ctx.log.error('Failed to relay session message to Telegram:', err.message);
    throw err;
  }
};
