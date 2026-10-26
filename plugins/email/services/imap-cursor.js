/**
 * Pure UID/UIDVALIDITY cursor logic for the email IMAP listener, and
 * classification of imapflow's authentication-failure error shape.
 * Kept dependency-free and side-effect-free so it is unit-testable without
 * a live IMAP connection.
 */

/**
 * Resolve which UID cursor to use next.
 *
 * IMAP's UIDVALIDITY changes if the mailbox was recreated or its UIDs were
 * reused by the server — a stored cursor from before that point is no
 * longer meaningful and must be reset, not silently reused (would either
 * reprocess old mail or skip new mail depending on UID overlap).
 *
 * @param {{uidValidity:number,lastUid:number,account?:string}|null|undefined} stored - previously persisted cursor, if any
 * @param {number} mailboxUidValidity - current mailbox UIDVALIDITY (from mailboxOpen())
 * @param {number} mailboxUidNext - current mailbox UIDNEXT (from mailboxOpen())
 * @param {string} [account] - the mailbox's account. UIDs and UIDVALIDITY belong to one mailbox: two accounts on the same
 *   server can report the same UIDVALIDITY, so a cursor saved for another account must not be reused (it would skip every
 *   message whose UID is below the other mailbox's last one). A cursor saved before accounts were recorded has none and is
 *   taken as this account's.
 * @returns {{uidValidity:number, lastUid:number, reset:boolean, account?:string}}
 */
function resolveCursor(stored, mailboxUidValidity, mailboxUidNext, account) {
  const sameAccount = !stored || stored.account === undefined || account === undefined || stored.account === account;
  const owner = account === undefined ? {} : { account };
  if (!stored || stored.uidValidity !== mailboxUidValidity || !sameAccount) {
    return { uidValidity: mailboxUidValidity, lastUid: mailboxUidNext - 1, ...owner, reset: Boolean(stored) };
  }
  return { uidValidity: stored.uidValidity, lastUid: stored.lastUid, ...owner, reset: false };
}

/**
 * Whether an error from imapflow represents an authentication failure
 * (bad credentials) as opposed to a transient network/connection error.
 * imapflow's AuthenticationFailure error class sets `authenticationFailed: true`.
 * @param {Error|undefined|null} err
 * @returns {boolean}
 */
function isAuthFailure(err) {
  return Boolean(err && err.authenticationFailed === true);
}

module.exports = { resolveCursor, isAuthFailure };
