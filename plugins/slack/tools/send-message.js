export default async function(params, ctx) {
  // Resolve webhookUrl: channel integration > global default
  let webhookUrl = null;
  try {
    const session = await ctx.session.getActive();
    if (session) {
      const channelId = session.channelId;
      if (channelId && channelId !== 'default') {
        const config = await ctx.channels.getIntegrationConfig(channelId, 'slack');
        if (config?.webhookUrl) webhookUrl = config.webhookUrl;
      }
    }
  } catch { /* fall through to global */ }
  if (!webhookUrl) webhookUrl = await ctx.settings.get('slack.webhookUrl');
  if (!webhookUrl) throw new Error('Slack Webhook URL not configured. Set it in Settings > Extensions.');

  const payload = { text: params.text };
  if (params.channel) payload.channel = params.channel;

  const res = await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();

    // Track failure
    const failStats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
    failStats.failed++;
    await ctx.store.set('stats', failStats);
    ctx.viewData.set('slack.stats', failStats);

    throw new Error(`Slack webhook failed (${res.status}): ${body}`);
  }

  // Track history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: Date.now(),
    channel: params.channel || 'default',
    message: (params.text || '').substring(0, 100),
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('slack.messageHistory', history);

  const stats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
  stats.sent++;
  await ctx.store.set('stats', stats);
  ctx.viewData.set('slack.stats', stats);

  return { success: true, message: `Message sent to Slack` };
}
