export default async function(params, ctx) {
  const url = await ctx.settings.get('webhook.url');
  if (!url) throw new Error('Webhook URL not configured. Set it in Settings > Extensions.');

  const body = JSON.stringify({
    event: params.event,
    timestamp: new Date().toISOString(),
    payload: params.payload || {},
  });

  const headers = { 'Content-Type': 'application/json' };

  // Add HMAC signature if secret is configured
  const secret = await ctx.settings.get('webhook.secret');
  if (secret) {
    const { createHmac } = await import('crypto');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  const res = await ctx.fetch(url, { method: 'POST', headers, body });

  if (!res.ok) {
    const text = await res.text();

    // Track failure
    const failStats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
    failStats.failed++;
    await ctx.store.set('stats', failStats);
    ctx.viewData.set('webhook.stats', failStats);

    throw new Error(`Webhook failed (${res.status}): ${text}`);
  }

  const statusCode = res.status;

  // Track history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: Date.now(),
    url,
    statusCode,
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('webhook.messageHistory', history);

  const stats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
  stats.sent++;
  await ctx.store.set('stats', stats);
  ctx.viewData.set('webhook.stats', stats);

  return { success: true, statusCode };
}
