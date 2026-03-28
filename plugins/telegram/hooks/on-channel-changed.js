const reverseIndex = require('../services/reverse-channel-index');

module.exports = async function onChannelChanged(event, ctx) {
  // Rebuild the reverse channel index when channels change
  try {
    await reverseIndex.invalidate(ctx);
  } catch (err) {
    ctx.log.error('Failed to rebuild reverse channel index:', err.message);
  }
};
