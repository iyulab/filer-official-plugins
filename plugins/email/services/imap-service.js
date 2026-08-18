/**
 * Email IMAP Inbound Listener
 * Connects to an IMAP mailbox via imapflow, auto-idles on INBOX, and routes
 * new mail to a Filer agent run via the CR-1 unified inbound-trigger
 * endpoint — the email-plugin counterpart to telegram/services/polling-service.js.
 */

const { ImapFlow } = require('imapflow');
const { text } = require('node:stream/consumers');
const reverseIndex = require('./reverse-channel-index.js');
const { resolveCursor, isAuthFailure } = require('./imap-cursor.js');
const { findTextPart } = require('./mime-body.js');

let client = null;
let isRunning = false;

/**
 * Start the IMAP listener.
 * @param {object} ctx - PluginContext
 */
async function start(ctx) {
  if (isRunning) return;

  const enabled = await ctx.settings.get('email.enableImapPolling');
  const host = await ctx.settings.get('email.imapHost');
  const user = await ctx.settings.get('email.imapUser');
  const pass = await ctx.settings.get('email.imapPassword');

  if (!enabled || !host || !user || !pass) {
    ctx.log.info('IMAP inbound not started: disabled or credentials incomplete');
    return;
  }

  const port = (await ctx.settings.get('email.imapPort')) || 993;

  await reverseIndex.build(ctx);

  isRunning = true;
  runLoop(ctx, { host, port, user, pass }, 1000);
}

/**
 * Stop the IMAP listener.
 */
function stop() {
  isRunning = false;
  if (client) {
    client.logout().catch(() => {});
    client = null;
  }
}

/**
 * Connect, prime the cursor, drain any backlog, then idle until the
 * connection closes — then reconnect with exponential backoff. Mirrors
 * telegram/services/polling-service.js's pollLoop shape.
 * @param {object} ctx - PluginContext
 * @param {{host:string, port:number, user:string, pass:string}} creds
 * @param {number} backoffMs
 */
async function runLoop(ctx, creds, backoffMs) {
  if (!isRunning) return;

  let cursorPrimed = false;
  const connectedAt = Date.now();

  client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  client.on('error', (err) => {
    ctx.log.warn('IMAP connection error:', err.message);
  });

  client.on('exists', () => {
    // Guard against the connect -> mailboxOpen -> primeCursor window: the
    // server can fire 'exists' before the UID cursor for *this* session has
    // been validated against the mailbox's current UIDVALIDITY, which would
    // otherwise let fetchNewMessages() run against a stale cursor from a
    // previous session — defeating the invariant primeCursor()/
    // resolveCursor() exist to protect.
    if (!isRunning || !cursorPrimed) return;
    fetchNewMessages(ctx).catch((err) => {
      ctx.log.error('Failed to fetch new IMAP messages:', err.message);
    });
  });

  try {
    await client.connect();

    if (!isRunning) {
      // stop() raced this in-flight connect — tear down and do not proceed
      // into mailboxOpen/primeCursor/idle.
      client.logout().catch(() => {});
      return;
    }

    ctx.log.info('IMAP inbound listener connected');

    const mailbox = await client.mailboxOpen('INBOX');
    await primeCursor(ctx, mailbox);
    cursorPrimed = true;
    await fetchNewMessages(ctx); // drain anything that arrived before we connected

    await new Promise((resolve) => client.on('close', resolve));

    if (!isRunning) return;

    // imapflow's own error handling (emitError() -> closeAfter()) routes
    // essentially every real-world disconnect — dropped connections, server
    // throttling, a flaky link during IDLE — through this close path, not
    // the catch block below. Without a delay here, those disconnects
    // reconnect immediately and can hammer the mail server in an unattended
    // 24/7 path. Only reset the backoff to the floor once the connection
    // actually stayed up for a meaningful stretch (1 minute) first, so a
    // healthy long-lived connection's natural reconnect isn't punished
    // forever, but a server actively rejecting/dropping us repeatedly still
    // backs off.
    const stayedUpMs = Date.now() - connectedAt;
    const nextBackoff = stayedUpMs > 60_000 ? 1000 : Math.min(backoffMs * 2, 60_000);
    ctx.log.warn('IMAP connection closed, reconnecting');
    await sleep(nextBackoff);
    return runLoop(ctx, creds, nextBackoff);
  } catch (err) {
    if (isAuthFailure(err)) {
      ctx.log.error('IMAP authentication failed — stopping, check credentials.');
      ctx.toast({ type: 'error', message: 'Email: IMAP login failed. Check your IMAP credentials in Settings.' });
      isRunning = false;
      return;
    }

    if (!isRunning) return;
    ctx.log.warn(`IMAP connection lost, retrying in ${backoffMs}ms:`, err.message);
    await sleep(backoffMs);
    return runLoop(ctx, creds, Math.min(backoffMs * 2, 60_000));
  }
}

/**
 * Resolve and persist the UID cursor to use for this connection.
 * @param {object} ctx - PluginContext
 * @param {{uidValidity:bigint, uidNext:number}} mailbox
 */
async function primeCursor(ctx, mailbox) {
  const stored = await ctx.store.get('email.imapCursor');
  // imapflow's mailboxOpen() reports UIDVALIDITY as a BigInt (verified
  // against the installed package's lib/imap-flow.d.ts and
  // lib/commands/select.js, which parses it via parseBigIntValue()).
  // UIDVALIDITY is a 32-bit unsigned value in practice, well inside
  // Number's safe-integer range, so normalize to Number here — both so
  // it compares correctly against the plain-Number cursor persisted by
  // resolveCursor()/ctx.store (a BigInt !== Number of the same value
  // under strict equality, which would falsely "reset" the cursor on
  // every connect) and so ctx.store.set() below can JSON-serialize it
  // (JSON.stringify throws on a raw BigInt).
  const uidValidity = Number(mailbox.uidValidity);
  const cursor = resolveCursor(stored, uidValidity, mailbox.uidNext);
  if (cursor.reset) {
    ctx.log.warn('IMAP UIDVALIDITY changed — mailbox cursor reset');
  }
  await ctx.store.set('email.imapCursor', { uidValidity: cursor.uidValidity, lastUid: cursor.lastUid });
}

/**
 * Fetch and process every message newer than the stored cursor.
 * @param {object} ctx - PluginContext
 */
async function fetchNewMessages(ctx) {
  const stored = await ctx.store.get('email.imapCursor');
  if (!stored) return;

  let maxUid = stored.lastUid;

  for await (const message of client.fetch(`${stored.lastUid + 1}:*`, { envelope: true, bodyStructure: true }, { uid: true })) {
    if (message.uid <= stored.lastUid) continue; // the ':*' range can re-yield the last known UID

    try {
      await handleMessage(ctx, message);
    } catch (err) {
      ctx.log.error(`Failed to process message uid=${message.uid}:`, err.message);
    }

    if (message.uid > maxUid) maxUid = message.uid;
  }

  if (maxUid > stored.lastUid) {
    await ctx.store.set('email.imapCursor', { uidValidity: stored.uidValidity, lastUid: maxUid });
  }
}

/**
 * Download the best available text body for a message, given its already-
 * fetched bodyStructure. Prefers text/plain, degrades to text/html, and as
 * a last resort downloads the entire raw rfc822 message (undecoded MIME
 * source, headers included) if no text part is found anywhere in the
 * structure. Each degradation is logged so it stays visible instead of
 * silently sending malformed/raw content upstream.
 * @param {object} ctx - PluginContext
 * @param {number} uid
 * @param {object|undefined} structure - message.bodyStructure
 * @returns {Promise<{meta:object, content:import('stream').Readable}>}
 */
async function downloadTextBody(ctx, uid, structure) {
  const found = structure && findTextPart(structure);

  if (!found) {
    ctx.log.warn(`No text/plain or text/html part found for uid=${uid} — downloading raw message source instead`);
    return client.download(uid, undefined, { uid: true });
  }

  if (found.type === 'text/html') {
    ctx.log.warn(`No text/plain part found for uid=${uid} — using text/html part instead (content will include HTML markup)`);
  }

  // A part with no `.part` id is the bodyStructure root itself — i.e. a
  // simple, non-multipart message. imapflow's download() special-cases the
  // string '1' for exactly this case (translating it internally to IMAP's
  // TEXT section) — passing undefined here would silently fall back to
  // downloading the entire raw rfc822 message instead of the decoded body.
  const part = found.node.part || '1';
  return client.download(uid, part, { uid: true });
}

/**
 * Download, resolve the channel, and route one message to the host.
 * @param {object} ctx - PluginContext
 * @param {{uid:number, envelope:object, bodyStructure:object}} message
 */
async function handleMessage(ctx, message) {
  const fromAddress = message.envelope?.from?.[0]?.address;
  const download = await downloadTextBody(ctx, message.uid, message.bodyStructure);
  const body = await text(download.content);

  const channelId = reverseIndex.resolve(fromAddress);

  // Deliberately no sender address / subject here — this line ends up verbatim in
  // ~/.filer/logs/ui-{date}.log and from there in user-shareable support bundles
  // (support-bundle.ts copies log files wholesale, no redaction pass).
  ctx.log.info(`Inbound email routed to channel=${channelId} (uid=${message.uid})`);

  const hostUrl = process.env.FILER_HOST_URL || 'http://localhost:5100';
  const messageId = message.envelope?.messageId || `email-${message.uid}`;

  // CR-1 (Sprint 42): route through the unified /api/triggers/inbound
  // endpoint, same as telegram/services/polling-service.js — falls back to
  // the legacy /api/sessions -> /chat path if the new endpoint 404s.
  try {
    const resp = await ctx.fetch(`${hostUrl}/api/triggers/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_id: channelId,
        source_plugin: 'email',
        message_id: messageId,
        content: body,
      }),
    });

    if (resp.status === 202) {
      return; // Accepted, host will dispatch the agent run.
    }

    if (resp.status === 404) {
      // Two structurally different things return 404 here: a genuinely
      // missing endpoint on a pre-CR-1 host (ASP.NET's default 404, no
      // body shape to speak of) vs. a real routing rejection from a
      // current host's /api/triggers/inbound (Results.NotFound(new
      // {error: "..."}) for "channel not registered" / "no working agent
      // bound to folder" — see TriggerEndpoints.cs). Falling back to the
      // legacy path on a routing rejection would silently create an
      // untagged, non-deduplicated session/chat turn instead of surfacing
      // that the channel/agent isn't actually set up — losing origin
      // tagging, which this project treats as an always-win invariant.
      const responseBody = await resp.text().catch(() => '');
      let routingError;
      try {
        routingError = JSON.parse(responseBody)?.error;
      } catch {
        // not JSON — genuinely missing endpoint, fall through to legacy below
      }

      if (routingError) {
        ctx.log.warn(`Inbound trigger rejected — routing problem, not a legacy-host case: ${routingError}`);
        return;
      }

      ctx.log.warn('Host does not support /api/triggers/inbound — using legacy session path');
      await routeViaLegacySessionPath(ctx, hostUrl, channelId, body);
      return;
    }

    const responseBody = await resp.text().catch(() => '');
    ctx.log.warn(`Inbound trigger rejected (${resp.status}): ${responseBody}`);
  } catch (err) {
    ctx.log.error('Failed to route inbound email:', err.message);
  }
}

/**
 * Legacy fallback: create a session for the channel and send the message
 * content as a chat request. Only used when the host predates /api/triggers/inbound.
 * @param {object} ctx - PluginContext
 * @param {string} hostUrl
 * @param {string} channelId
 * @param {string} content
 */
async function routeViaLegacySessionPath(ctx, hostUrl, channelId, content) {
  const sessResp = await ctx.fetch(`${hostUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: channelId }),
  }).then(r => r.json());

  const sessionId = sessResp.session_id || sessResp.id;
  if (!sessionId) {
    ctx.log.error('Failed to create session for inbound email (legacy path)');
    return;
  }

  await ctx.fetch(`${hostUrl}/api/sessions/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { start, stop };
