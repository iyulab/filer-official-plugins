/**
 * Records a message the bot sent in the plugin's history (persistent store + live view), newest first, 100 kept.
 * Every outbound path calls it after Telegram accepted the message — the send tools, and the hooks that relay a
 * reply, announce a finished run, report file changes or ask for an approval — so the history shows everything the
 * bot said, not only what an agent sent with a tool.
 */
async function recordOutbound(ctx, { message, chatId, channelId }) {
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    direction: 'out',
    message: String(message).substring(0, 100),
    chatId,
    channelId,
    timestamp: Date.now(),
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('telegram.messageHistory', history);
}

module.exports = { recordOutbound };
