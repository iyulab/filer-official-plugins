const reverseIndex = require('../services/reverse-channel-index.js');

module.exports = async function onChannelChanged(event, ctx) {
  try {
    await reverseIndex.invalidate(ctx);
  } catch (err) {
    ctx.log.error('Failed to rebuild email reverse channel index:', err.message);
  }
};
