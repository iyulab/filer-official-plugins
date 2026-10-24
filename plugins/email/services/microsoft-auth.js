/**
 * Signing in with a Microsoft account (Microsoft 365 / Outlook.com) instead of a password: Exchange Online refuses passwords for
 * IMAP and is turning them off for SMTP. Filer signs the person in (Connect › Email › Sign in with Microsoft) and hands this
 * plugin a short-lived access token for the mailbox scope it declared; the plugin never sees the refresh token.
 */

const MICROSOFT = {
  imap: { host: 'outlook.office365.com', port: 993, scope: 'https://outlook.office.com/IMAP.AccessAsUser.All' },
  smtp: { host: 'smtp.office365.com', port: 587, scope: 'https://outlook.office.com/SMTP.Send' },
};

/** The error code Filer gives when the account must sign in again (or nobody has signed in). */
const SIGN_IN_NEEDED = 'microsoft_sign_in_needed';

/**
 * The signed-in account and an access token for one mailbox protocol.
 * @param {object} ctx - PluginContext
 * @param {'imap'|'smtp'} protocol
 * @returns {Promise<{user: string, accessToken: string}>}
 */
async function microsoftToken(ctx, protocol) {
  if (!ctx.auth?.getToken) {
    throw Object.assign(new Error('Signing in with Microsoft needs a newer version of Filer.'), { code: SIGN_IN_NEEDED });
  }
  const { accessToken, account } = await ctx.auth.getToken('microsoft', [MICROSOFT[protocol].scope]);
  return { user: account, accessToken };
}

/**
 * The SASL XOAUTH2 initial response IMAP and SMTP take: `user=<account>^Aauth=Bearer <token>^A^A`, base64.
 * @param {string} user
 * @param {string} accessToken
 */
function xoauth2(user, accessToken) {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
}

/** True when the error means the person has to sign in again — retrying will not help. */
function needsSignIn(err) {
  return err?.code === SIGN_IN_NEEDED;
}

module.exports = { MICROSOFT, SIGN_IN_NEEDED, microsoftToken, xoauth2, needsSignIn };
