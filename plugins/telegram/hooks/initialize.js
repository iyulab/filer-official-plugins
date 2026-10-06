const pollingService = require('../services/polling-service');

module.exports = async function(event, ctx) {
  // Load message history into viewData on startup
  const history = (await ctx.store.get('messageHistory')) || [];
  ctx.viewData.set('telegram.messageHistory', history);

  const stats = {
    sentToday: history.filter(h => {
      const d = new Date(h.timestamp);
      const today = new Date();
      return d.toDateString() === today.toDateString();
    }).length,
    failed: history.filter(h => h.status === 'failed').length,
  };
  ctx.viewData.set('stats', stats);

  // Start polling — the service reads the switch itself, and on-settings-changed.js applies later changes
  try {
    await pollingService.start(ctx);
  } catch (err) {
    ctx.log.error('Failed to start Telegram polling:', err.message);
  }

  ctx.log.info('Telegram plugin initialized');
};
