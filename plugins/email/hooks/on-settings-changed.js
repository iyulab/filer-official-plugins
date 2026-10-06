const imapService = require('../services/imap-service.js');
const reverseIndex = require('../services/reverse-channel-index.js');

// What the listener reads when it starts — a change applies now, not at the next start of Filer.
const LISTENER_KEYS = new Set([
  'email.enableImapPolling',
  'email.imapHost',
  'email.imapPort',
  'email.imapUser',
  'email.imapPassword',
]);
// Read when the reverse index is built: who may write to a folder.
const INDEX_KEYS = new Set(['email.senderAllowlist']);

module.exports = async function onPluginSettingsChanged(event, ctx) {
  const key = event?.key;
  try {
    if (LISTENER_KEYS.has(key)) await imapService.restart(ctx);
    else if (INDEX_KEYS.has(key)) await reverseIndex.invalidate(ctx);
  } catch (err) {
    ctx.log.error('Failed to apply the email inbound setting:', err.message);
  }
};
