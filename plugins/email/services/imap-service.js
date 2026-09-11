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

const CURSOR_KEY = 'email.imapCursor';
// Per-message delivery attempts, `{ [uid]: attempts }`, persisted so a restart does not
// reset the count. Cleared with the cursor on a UIDVALIDITY reset (UIDs are reused then).
const RETRY_KEY = 'email.imapRetry';
// A message that fails delivery this many times is given up on: the cursor moves past it,
// an error names the uid, and the mail stays on the server. Bounds how long one bad
// message can hold every message behind it.
const MAX_DELIVERY_ATTEMPTS = 3;
// Delay before re-running the fetch after a transient failure, by attempt number. Without
// this, nothing re-fires a fetch on a healthy IDLE connection until the next 'exists' —
// hours, if no new mail arrives.
const RETRY_DELAYS_MS = [30_000, 120_000];
let retryTimer = null;

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
  clearRetryTimer();
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

    // A retry timer belongs to the session that scheduled it: the reconnect below re-primes
    // the cursor and drains from it, which re-yields any message still owed, so the timer
    // must not fire into the connect → primeCursor window against a not-yet-validated cursor
    // (the same hazard the 'exists' guard above protects against).
    clearRetryTimer();

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
    clearRetryTimer();
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
  const stored = await ctx.store.get(CURSOR_KEY);
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
    // The retry ledger is keyed by uid, and uids are reused after a UIDVALIDITY change — a
    // stale attempt count would give up on a fresh message early.
    await ctx.store.delete(RETRY_KEY);
  }
  await ctx.store.set(CURSOR_KEY, { uidValidity: cursor.uidValidity, lastUid: cursor.lastUid });
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * Re-run the fetch after a transient delivery failure, once, after a delay that grows with
 * the attempt count. Guarded on `client`: stop() and every disconnect path clear the timer
 * and null/replace the client, so a live timer always belongs to a connected session.
 * @param {object} ctx - PluginContext
 * @param {number} attempts - attempts made so far on the message that deferred the batch
 */
function scheduleRetry(ctx, attempts) {
  clearRetryTimer();
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!client) return;
    scheduleFetch(ctx).catch((err) => {
      ctx.log.error('Failed to retry IMAP delivery:', err.message);
    });
  }, delay);
  retryTimer.unref?.();
}

/**
 * Fetch and process every message newer than the stored cursor.
 *
 * Cursor invariant: every uid <= `lastUid` was either delivered to the host or explicitly
 * given up on after MAX_DELIVERY_ATTEMPTS. So a transient failure on uid X (host unreachable,
 * IMAP download error, 5xx) leaves the cursor at X-1, defers every later message in the batch
 * (they wait behind X rather than being re-downloaded on the retry), records the attempt in
 * the retry ledger and schedules a re-fetch. Before this, `lastUid` advanced past a failed
 * message and that email was never delivered — a silent drop on any blip.
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
  const stored = await ctx.store.get(CURSOR_KEY);
  if (!stored) return;

  const messages = [];
  for await (const message of client.fetch(`${stored.lastUid + 1}:*`, { envelope: true, bodyStructure: true }, { uid: true })) {
    if (message.uid <= stored.lastUid) continue; // the ':*' range can re-yield the last known UID
    messages.push(message);
  }
  // Contiguity of the cursor depends on processing in uid order; the server's yield order
  // is not something to assume.
  messages.sort((a, b) => a.uid - b.uid);

  const retry = (await ctx.store.get(RETRY_KEY)) || {};
  let lastUid = stored.lastUid;
  let deferredAttempts = 0;

  for (const message of messages) {
    try {
      await handleMessage(ctx, message);
      delete retry[message.uid];
    } catch (err) {
      const attempts = (retry[message.uid] || 0) + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        // Give up: the cursor moves past it so the mailbox never wedges; the mail itself stays
        // on the server. Uid only — this line lands in support bundles.
        delete retry[message.uid];
        ctx.log.error(
          `Giving up on inbound email uid=${message.uid} after ${attempts} failed delivery attempts — ` +
            `it stays in the mailbox but will not reach the agent: ${err.message}`
        );
      } else {
        retry[message.uid] = attempts;
        ctx.log.warn(
          `Failed to process message uid=${message.uid} (attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}), will retry: ${err.message}`
        );
        deferredAttempts = attempts;
        break; // everything after this uid waits behind it
      }
    }
    lastUid = message.uid;
  }

  if (lastUid !== stored.lastUid) {
    await ctx.store.set(CURSOR_KEY, { uidValidity: stored.uidValidity, lastUid });
  }
  if (Object.keys(retry).length > 0) {
    await ctx.store.set(RETRY_KEY, retry);
  } else {
    await ctx.store.delete(RETRY_KEY);
  }
  if (deferredAttempts > 0) scheduleRetry(ctx, deferredAttempts);
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
 *
 * Failure contract (fetchNewMessages relies on it): this throws only for a *transient*
 * delivery failure — an IMAP download error, the host unreachable, or the host answering
 * 5xx/429 — so the caller keeps the cursor before this uid and retries. Every deliberate
 * drop (sender not allowlisted, 404 routing rejection, any other 4xx) returns normally so
 * the cursor moves past it: retrying those would re-deliver the same answer.
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
  let resp;
  try {
    resp = await ctx.triggerInbound({
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
  } catch (err) {
    // The host is unreachable (typically: not up yet after a boot, or restarting). Transient
    // by definition — propagate so the cursor does not move past this message.
    throw new Error(`Failed to route inbound email (uid=${message.uid}): ${err.message}`);
  }

  if (resp.status === 202) {
    return; // Accepted, host will dispatch the agent run.
  }

  if (resp.status >= 500 || resp.status === 429) {
    const responseBody = await resp.text().catch(() => '');
    throw new Error(`Inbound trigger failed transiently (${resp.status}) for uid=${message.uid}: ${responseBody}`);
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

  // Any other 4xx is the host rejecting this payload outright — a retry would get the same
  // answer, so log it and let the cursor move on.
  const responseBody = await resp.text().catch(() => '');
  ctx.log.warn(`Inbound trigger rejected (${resp.status}): ${responseBody}`);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// handleMessage / fetchNewMessages / primeCursor exported for unit testing only (HD-91
// follow-through, cycle-647; retry ledger, cycle-899) — start/stop remain the real public API.
// _setClientForTesting injects a fake IMAP client so the calls that read the module-level
// `client` are testable without a real IMAP connection.
module.exports = {
  start,
  stop,
  handleMessage,
  fetchNewMessages,
  primeCursor,
  _setClientForTesting: (fakeClient) => { client = fakeClient; },
  _retryTimerPendingForTesting: () => retryTimer !== null,
};
