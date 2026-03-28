/**
 * Telegram Long Polling Service
 * Handles inbound messages from Telegram Bot API via long polling.
 * Routes text messages to sessions and callback queries to HITL endpoints.
 */

const { telegramApi } = require('../lib/telegram-api.js');
const reverseIndex = require('./reverse-channel-index.js');

let pollController = null;
let isRunning = false;

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

  let offset = (await ctx.store.get('telegram.pollOffset')) || 0;

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
        for (const update of data.result) {
          currentOffset = update.update_id + 1;
          try {
            await handleUpdate(ctx, botToken, update);
          } catch (err) {
            ctx.log.error('Error handling update:', err.message);
          }
        }
        await ctx.store.set('telegram.pollOffset', currentOffset);
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
 * Handle an incoming update from Telegram.
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

  ctx.log.info(`Inbound message for channel=${channelId}: "${text.substring(0, 50)}..."`);

  try {
    const hostUrl = process.env.FILER_HOST_URL || 'http://localhost:5100';
    const sessResp = await ctx.fetch(`${hostUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId }),
    }).then(r => r.json());

    const sessionId = sessResp.session_id || sessResp.id;
    if (!sessionId) {
      ctx.log.error('Failed to create session for inbound message');
      return;
    }

    await ctx.fetch(`${hostUrl}/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
  } catch (err) {
    ctx.log.error('Failed to route inbound message:', err.message);
  }
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
    const hostUrl = process.env.FILER_HOST_URL || 'http://localhost:5100';
    await ctx.fetch(`${hostUrl}/api/agents/${mapping.agentId}/hitl/${mapping.requestId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, reason }),
    });

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

module.exports = { start, stop };
