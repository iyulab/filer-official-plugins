/**
 * Telegram Long Polling Service
 * Handles inbound messages from Telegram Bot API via long polling.
 * Routes text messages to sessions and callback queries to HITL endpoints.
 */

const { telegramApi } = require('../lib/telegram-api.js');
const reverseIndex = require('./reverse-channel-index.js');

let pollController = null;
let isRunning = false;

const OFFSET_KEY = 'telegram.pollOffset';
// Per-update delivery attempts, `{ [update_id]: attempts }`, persisted so a restart does not
// reset the count. Mirrors email/services/imap-service.js's retry ledger (cycle-899).
const RETRY_KEY = 'telegram.pollRetry';
// An update that fails delivery this many times is given up on: the offset moves past it and
// an error names the update id. Bounds how long one poison update can hold the ones behind it.
const MAX_DELIVERY_ATTEMPTS = 3;
// Pause before the next getUpdates after a transient failure, by attempt number. Without it,
// getUpdates(offset=<failed id>) returns the same update immediately and the three attempts
// burn in milliseconds — while the likeliest cause (the host restarting) takes seconds.
const RETRY_DELAYS_MS = [30_000, 120_000];

/**
 * Start the polling service.
 * @param {object} ctx - PluginContext
 */
async function start(ctx) {
  if (isRunning) return;

  const botToken = await ctx.settings.get('telegram.botToken');
  const defaultChatId = await ctx.settings.get('telegram.defaultChatId');

  if (!botToken || !defaultChatId) {
    ctx.log.info('Polling not started: botToken or defaultChatId not configured');
    return;
  }

  await reverseIndex.build(ctx);

  isRunning = true;
  pollController = new AbortController();

  let offset = (await ctx.store.get(OFFSET_KEY)) || 0;

  ctx.log.info('Telegram polling started');
  pollLoop(ctx, botToken, offset, pollController.signal);
}

/**
 * Stop the polling service.
 */
function stop() {
  if (!isRunning) return;
  isRunning = false;
  pollController?.abort();
  pollController = null;
}

/**
 * Main polling loop.
 * @param {object} ctx - PluginContext
 * @param {string} botToken - Telegram bot token
 * @param {number} offset - Initial poll offset
 * @param {AbortSignal} signal - Abort signal for graceful shutdown
 */
async function pollLoop(ctx, botToken, offset, signal) {
  let currentOffset = offset;
  let backoffMs = 1000;

  while (!signal.aborted) {
    try {
      const data = await telegramApi(botToken, 'getUpdates', {
        offset: currentOffset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      });

      backoffMs = 1000;

      if (data.result && data.result.length > 0) {
        const { offset: nextOffset, deferredAttempts } = await processUpdates(ctx, botToken, data.result, currentOffset);
        currentOffset = nextOffset;
        await ctx.store.set(OFFSET_KEY, currentOffset);
        if (deferredAttempts > 0) {
          await sleep(RETRY_DELAYS_MS[Math.min(deferredAttempts, RETRY_DELAYS_MS.length) - 1], signal);
        }
      }
    } catch (err) {
      if (signal.aborted) break;

      if (err.message?.includes('409')) {
        ctx.log.error('Telegram polling conflict (409) — another instance is polling. Stopping.');
        ctx.toast({ type: 'error', message: 'Telegram: another bot instance detected. Polling stopped.' });
        isRunning = false;
        return;
      }

      ctx.log.warn(`Polling error, retrying in ${backoffMs}ms:`, err.message);
      await sleep(backoffMs, signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

/**
 * Deliver one getUpdates batch and compute the next poll offset.
 *
 * Offset invariant: every update_id < the returned offset was delivered to the host or
 * explicitly given up on after MAX_DELIVERY_ATTEMPTS. So a transient failure on update X
 * (host unreachable, 5xx) stops the batch and returns `offset = X` — the next getUpdates
 * re-delivers X and everything after it — records the attempt in the retry ledger, and reports
 * `deferredAttempts` so the loop pauses before re-polling. Before this, the offset was advanced
 * *before* handleUpdate ran, so a message that arrived while the host was restarting was
 * acknowledged to Telegram and never delivered.
 * @param {object} ctx - PluginContext
 * @param {string} botToken - Telegram bot token
 * @param {Array<{update_id:number}>} updates - one getUpdates result
 * @param {number} offset - the offset this batch was fetched with
 * @returns {Promise<{offset:number, deferredAttempts:number}>}
 */
async function processUpdates(ctx, botToken, updates, offset) {
  // Contiguity depends on processing in update_id order; Telegram's order is not something
  // to assume.
  const sorted = [...updates].sort((a, b) => a.update_id - b.update_id);
  const retry = (await ctx.store.get(RETRY_KEY)) || {};
  let next = offset;
  let deferredAttempts = 0;

  for (const update of sorted) {
    try {
      await handleUpdate(ctx, botToken, update);
      delete retry[update.update_id];
    } catch (err) {
      const attempts = (retry[update.update_id] || 0) + 1;
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        // Give up: the offset moves past it so the poll never wedges. Update id only — this
        // line lands in support bundles.
        delete retry[update.update_id];
        ctx.log.error(
          `Giving up on Telegram update_id=${update.update_id} after ${attempts} failed delivery attempts — ` +
            `it will not reach the agent: ${err.message}`
        );
      } else {
        retry[update.update_id] = attempts;
        ctx.log.warn(
          `Failed to deliver Telegram update_id=${update.update_id} (attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}), will retry: ${err.message}`
        );
        next = update.update_id; // getUpdates(offset=next) re-delivers it and everything after
        deferredAttempts = attempts;
        break;
      }
    }
    next = update.update_id + 1;
  }

  if (Object.keys(retry).length > 0) {
    await ctx.store.set(RETRY_KEY, retry);
  } else {
    await ctx.store.delete(RETRY_KEY);
  }
  return { offset: next, deferredAttempts };
}

/**
 * Handle an incoming update from Telegram.
 *
 * Failure contract (processUpdates relies on it): this throws only for a *transient* delivery
 * failure — the host unreachable, or answering 5xx/429 — so the caller keeps the offset at this
 * update and retries. Every deliberate drop (unmapped chat, 404 routing rejection, any other
 * 4xx) returns normally so the offset moves past it: retrying those would re-deliver the same
 * answer. Mirrors email/services/imap-service.js's handleMessage.
 * @param {object} ctx - PluginContext
 * @param {string} botToken - Telegram bot token
 * @param {object} update - Update object from Telegram API
 */
async function handleUpdate(ctx, botToken, update) {
  if (update.callback_query) {
    await handleCallbackQuery(ctx, botToken, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  const topicId = message.message_thread_id;
  const text = message.text;

  const channelId = reverseIndex.resolve(chatId, topicId);
  if (!channelId) {
    ctx.log.warn(`No channel mapping for chat=${chatId} topic=${topicId}`);
    return;
  }

  // Deliberately no message text here — this line ends up verbatim in
  // ~/.filer/logs/ui-{date}.log and from there in user-shareable support bundles
  // (support-bundle.ts copies log files wholesale, no redaction pass).
  ctx.log.info(`Inbound message routed to channel=${channelId} (${text.length} chars)`);

  // CR-1 (Sprint 42): route through the unified /api/triggers/inbound
  // endpoint so the host can tag the agent run with
  // PipelineEventOrigin.Inbound and flow it through the same trigger
  // model as file events.
  //
  // HD-91: ctx.triggerInbound, not ctx.fetch — this always targets the host's own
  // localhost origin, which ctx.fetch's SSRF deny-list unconditionally blocks.
  const messageId = `telegram-${update.update_id}`;

  let resp;
  try {
    resp = await ctx.triggerInbound({
      channelId,
      sourcePlugin: 'telegram',
      messageId,
      content: text,
    });
  } catch (err) {
    // The host is unreachable (typically: not up yet after a boot, or restarting). Transient
    // by definition — propagate so the offset does not move past this update.
    throw new Error(`Failed to route inbound message (update_id=${update.update_id}): ${err.message}`);
  }

  if (resp.status === 202) {
    return; // Accepted, host will dispatch the agent run.
  }

  if (resp.status >= 500 || resp.status === 429) {
    const responseBody = await resp.text().catch(() => '');
    throw new Error(`Inbound trigger failed transiently (${resp.status}) for update_id=${update.update_id}: ${responseBody}`);
  }

  if (resp.status === 404) {
    // Two structurally different things return 404 here: a genuinely missing endpoint on a
    // pre-CR-1 host (ASP.NET's default 404, no body shape to speak of) vs. a real routing
    // rejection from a current host's /api/triggers/inbound (Results.NotFound(new
    // {error: "..."}) for "channel not registered" / "no working agent bound to folder" — see
    // TriggerEndpoints.cs). Falling back to the legacy path on a routing rejection would
    // silently create an untagged, non-deduplicated session/chat turn instead of surfacing that
    // the channel/agent isn't actually set up — losing origin tagging, which this project
    // treats as an always-win invariant. Mirrors email/services/imap-service.js's own
    // handleMessage, which already made this distinction.
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
    ctx.log.warn('Host does not support /api/triggers/inbound (pre-CR-1 host) — dropping inbound message');
    return;
  }

  // Any other 4xx — 400 (bad request), 409 (agent not active), etc. — is the host rejecting
  // this update outright; a retry would get the same answer, so log it and let the offset
  // move on.
  const body = await resp.text().catch(() => '');
  ctx.log.warn(`Inbound trigger rejected (${resp.status}): ${body}`);
}

/**
 * Handle a callback query from an inline button.
 * Routes HITL-formatted callback data to the host API.
 * @param {object} ctx - PluginContext
 * @param {string} botToken - Telegram bot token
 * @param {object} callbackQuery - Callback query from Telegram API
 */
async function handleCallbackQuery(ctx, botToken, callbackQuery) {
  const data = callbackQuery.data;
  if (!data?.startsWith('hitl:')) return;

  const parts = data.split(':');
  if (parts.length < 3) return;

  // Format: "hitl:a:<shortKey>" or "hitl:d:<shortKey>"
  const [, actionCode, shortKey] = parts;
  const mapping = await ctx.store.get(`hitl:${shortKey}`);
  if (!mapping?.agentId || !mapping?.requestId) {
    ctx.log.warn('HITL callback mapping not found for key:', shortKey);
    return;
  }

  const approved = actionCode === 'a';
  const reason = approved ? 'Approved via Telegram' : 'Denied via Telegram';

  // Clean up stored mapping
  await ctx.store.delete(`hitl:${shortKey}`);

  try {
    // HD-91: ctx.respondToHitl, not ctx.fetch — this always targets the host's own
    // localhost origin, which ctx.fetch's SSRF deny-list unconditionally blocks (every
    // Telegram HITL approve/deny silently failed this call before this fix).
    await ctx.respondToHitl(mapping.agentId, mapping.requestId, approved, reason);

    await telegramApi(botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: approved ? 'Approved ✓' : 'Denied ✗',
    });
  } catch (err) {
    ctx.log.error('Failed to handle HITL callback:', err.message);
    await telegramApi(botToken, 'answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Error processing response',
    }).catch(() => {});
  }
}

/**
 * Sleep helper with abort signal support.
 * @param {number} ms - Milliseconds to sleep
 * @param {AbortSignal} signal - Abort signal for early wake
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
  });
}

// handleUpdate/handleCallbackQuery (HD-91) and processUpdates (cycle-899/900 retry ledger)
// exported for unit testing only — start/stop remain the real public API.
module.exports = { start, stop, handleUpdate, handleCallbackQuery, processUpdates };
