/**
 * Email IMAP Inbound Listener
 * Connects to an IMAP mailbox via imapflow, auto-idles on INBOX, and routes
 * new mail to a Filer agent run via the CR-1 unified inbound-trigger
 * endpoint — the email-plugin counterpart to telegram/services/polling-service.js.
 */

const { ImapFlow } = require('imapflow');
const { text, buffer } = require('node:stream/consumers');
const reverseIndex = require('./reverse-channel-index.js');
const { resolveCursor, isAuthFailure } = require('./imap-cursor.js');
const { findTextPart, findAttachmentParts, isBlockedAttachmentType, exceedsDownloadSizeCeiling } = require('./mime-body.js');
const { createCoalescingGuard } = require('./coalescing-guard.js');

let client = null;
let isRunning = false;

// Guards fetchNewMessages() against overlap. A rapid burst of 'exists'
// events (and the connect-time drain racing a same-tick 'exists', both
// reachable — 'exists' only waits on `cursorPrimed`, not on any prior fetch
// finishing) would otherwise start a second fetchNewMessages() call that
// reads the same not-yet-updated stored cursor as the first, re-downloading
// and re-processing messages the first call is already handling — the
// host's (source_plugin, message_id) dedup (SC-INBOUND-1) absorbs the
// resulting double-trigger, but the redundant IMAP fetch + HTTP POST still
// happen. See coalescing-guard.js for the re-entrancy semantics.
const scheduleFetch = createCoalescingGuard(fetchNewMessages);

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
    scheduleFetch(ctx).catch((err) => {
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
    await scheduleFetch(ctx); // drain anything that arrived before we connected

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
 *
 * Two passes, deliberately not fused into one loop: imapflow's own `fetch()` JSDoc warns
 * "You can not run any IMAP commands in this loop otherwise you will end up in a deadloop"
 * (`node_modules/imapflow/lib/imap-flow.js`, `fetch()`). `handleMessage()` issues a second
 * command on the same connection (`client.download()`, via `downloadTextBody()`) — the FETCH
 * command can't complete until every yielded message's backpressure `next()` is called, and
 * `next()` here would wait on `handleMessage`, which needs a second command on the very
 * connection FETCH is still holding. That circular wait is a genuine deadlock, not a timeout:
 * nothing ever rejects, so the caller (the coalescing guard's in-flight promise) hangs
 * forever — exactly the drain-fetch hang this fixes
 * (`ISSUE-filer-20260820-imap-post-reconnect-drain-fetch-hangs-silently.md`). Draining the
 * metadata-only fetch fully into `messages` first, then downloading each body afterward,
 * keeps the two IMAP commands strictly sequential on the connection.
 * @param {object} ctx - PluginContext
 */
async function fetchNewMessages(ctx) {
  const stored = await ctx.store.get('email.imapCursor');
  if (!stored) return;

  const messages = [];
  for await (const message of client.fetch(`${stored.lastUid + 1}:*`, { envelope: true, bodyStructure: true }, { uid: true })) {
    if (message.uid <= stored.lastUid) continue; // the ':*' range can re-yield the last known UID
    messages.push(message);
  }

  let maxUid = stored.lastUid;

  for (const message of messages) {
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
 * Download one attachment part's raw bytes, base64-encode it for the JSON
 * trigger payload. Returns null (does not throw) when the part is missing,
 * too large, or a blocked type — findAttachmentParts()'s metadata pass
 * already knows filename/size without downloading, so those checks happen
 * before this is ever called.
 * @param {object} ctx - PluginContext
 * @param {number} uid
 * @param {{filename:string, size:number|undefined, part:string|undefined}} attachment
 * @returns {Promise<{filename:string, content_base64:string}|null>}
 */
async function downloadAttachment(ctx, uid, attachment) {
  if (!attachment.part) return null; // no addressable IMAP part — can't download

  if (isBlockedAttachmentType(attachment.filename)) {
    ctx.log.warn(`Inbound email attachment skipped — blocked file type (uid=${uid}): ${attachment.filename}`);
    return null;
  }

  if (exceedsDownloadSizeCeiling(attachment.size)) {
    ctx.log.warn(`Inbound email attachment skipped — exceeds download size ceiling (uid=${uid}): ${attachment.filename}`);
    return null;
  }

  try {
    const download = await client.download(uid, attachment.part, { uid: true });
    const bytes = await buffer(download.content);
    return { filename: attachment.filename, content_base64: bytes.toString('base64') };
  } catch (err) {
    ctx.log.warn(`Failed to download attachment part=${attachment.part} (uid=${uid}): ${err.message}`);
    return null;
  }
}

/**
 * Download, resolve the channel, and route one message to the host.
 * @param {object} ctx - PluginContext
 * @param {{uid:number, envelope:object, bodyStructure:object}} message
 */
async function handleMessage(ctx, message) {
  const fromAddress = message.envelope?.from?.[0]?.address;
  const channelId = reverseIndex.resolve(fromAddress);

  if (!channelId) {
    // Resolve before downloading: an unmapped, unallowlisted sender is
    // dropped without spending a second IMAP command on its body. Mirrors
    // telegram/services/polling-service.js's own "no channelId -> drop"
    // gate — see ISSUE-filer-20260820-imap-inbound-trigger-no-sender-allowlist.md.
    // Deliberately no sender address here — this line ends up verbatim in
    // ~/.filer/logs/ui-{date}.log and from there in user-shareable support bundles.
    ctx.log.warn(`Inbound email rejected — sender not on the allowlist (uid=${message.uid})`);
    return;
  }

  const download = await downloadTextBody(ctx, message.uid, message.bodyStructure);
  const content = await text(download.content);

  // ISSUE-filer-20260820-email-inbound-attachments-silently-dropped.md.
  // HD-53 step 1: findTextPart() above already skips attachment parts to
  // find the real body; nothing used to look at what it skipped, so an
  // invoice/contract/etc. attachment vanished with no trace anywhere.
  // HD-56 step 2: the actual save now happens host-side (channel.Path is
  // resolved there, not here — see TriggerEndpoints.cs /
  // InboundAttachmentPersister.cs) — this plugin's job is only to resolve
  // and base64-encode the bytes; the host appends the real saved/rejected
  // outcome to the agent's first-turn message, so this plugin no longer
  // builds its own "not saved" mention (it would be wrong for anything the
  // host actually manages to save).
  const attachmentMetas = message.bodyStructure ? findAttachmentParts(message.bodyStructure) : [];
  const resolvedAttachments = (
    await Promise.all(attachmentMetas.map((a) => downloadAttachment(ctx, message.uid, a)))
  ).filter(Boolean);

  // Deliberately no sender address / subject here — this line ends up verbatim in
  // ~/.filer/logs/ui-{date}.log and from there in user-shareable support bundles
  // (support-bundle.ts copies log files wholesale, no redaction pass).
  ctx.log.info(
    `Inbound email routed to channel=${channelId} (uid=${message.uid})` +
      (attachmentMetas.length > 0
        ? ` — ${resolvedAttachments.length}/${attachmentMetas.length} attachment(s) resolved for upload`
        : '')
  );

  const messageId = message.envelope?.messageId || `email-${message.uid}`;

  // CR-1 (Sprint 42): route through the unified /api/triggers/inbound
  // endpoint, same as telegram/services/polling-service.js.
  //
  // HD-91: ctx.triggerInbound, not ctx.fetch — this always targets the host's own
  // localhost origin, which ctx.fetch's SSRF deny-list unconditionally blocks.
  try {
    const resp = await ctx.triggerInbound({
      channelId,
      sourcePlugin: 'email',
      messageId,
      content,
      ...(resolvedAttachments.length > 0
        ? {
            attachments: resolvedAttachments.map(a => ({
              filename: a.filename,
              contentBase64: a.content_base64,
            })),
          }
        : {}),
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

      // A bare 404 with no JSON error body means the host predates CR-1 and doesn't expose
      // /api/triggers/inbound at all. There is no fallback for this — ui/host/ai ship together
      // in this bundled deployment, so a pre-CR-1 host paired with this plugin build isn't a
      // real deployment shape, only a defensive case. Log and drop.
      ctx.log.warn('Host does not support /api/triggers/inbound (pre-CR-1 host) — dropping inbound email');
      return;
    }

    const responseBody = await resp.text().catch(() => '');
    ctx.log.warn(`Inbound trigger rejected (${resp.status}): ${responseBody}`);
  } catch (err) {
    ctx.log.error('Failed to route inbound email:', err.message);
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// handleMessage exported for unit testing only (HD-91 follow-through, cycle-647) — start/stop
// remain the real public API. _setClientForTesting injects a fake IMAP client so handleMessage's
// downloadTextBody/downloadAttachment calls (which read the module-level `client`) are testable
// without a real IMAP connection.
module.exports = {
  start,
  stop,
  handleMessage,
  _setClientForTesting: (fakeClient) => { client = fakeClient; },
};
