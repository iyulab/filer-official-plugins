const pollingService = require('../services/polling-service');

// The settings the poller reads when it starts. A change to any of them — turning inbound polling on or off, a new bot
// token, another chat — applies now, not at the next start of Filer.
const POLLING_KEYS = new Set(['telegram.enablePolling', 'telegram.botToken', 'telegram.defaultChatId']);

module.exports = async function onPluginSettingsChanged(event, ctx) {
  if (!POLLING_KEYS.has(event?.key)) return;
  try {
    await pollingService.restart(ctx);
  } catch (err) {
    ctx.log.error('Failed to apply the Telegram polling setting:', err.message);
  }
};
