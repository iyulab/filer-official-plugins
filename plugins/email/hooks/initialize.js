const imapService = require('../services/imap-service.js');

module.exports = async function onAppReady(event, ctx) {
  try {
    await imapService.start(ctx);
  } catch (err) {
    ctx.log.error('Failed to start IMAP inbound listener:', err.message);
  }
};
