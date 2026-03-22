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
    throw new Error(`Webhook failed (${res.status}): ${text}`);
  }

  return { success: true, statusCode: res.status };
}
