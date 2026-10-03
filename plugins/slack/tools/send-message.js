export default async function(params, ctx) {
  // Resolve webhookUrl: channel integration > global default
  let webhookUrl = null;
  // The channel this tool call came from (Telegram's tools read the same field). A session record carries no channel
  // id, so the lookup used to come back empty every time.
  const channelId = ctx.channelId;
  if (channelId && channelId !== 'default') {
    try {
      const config = await ctx.channels.getIntegrationConfig(channelId, 'slack');
      if (config?.webhookUrl) webhookUrl = config.webhookUrl;
    } catch (e) {
      ctx.log.warn(`Channel-scoped Slack webhook lookup failed, falling back to the global webhook: ${e.message}`);
    }
  }
  if (!webhookUrl) webhookUrl = await ctx.settings.get('slack.webhookUrl');
  if (!webhookUrl) throw new Error('Slack Webhook URL not configured. Set it in Connect > Slack Integration > Settings.');

  // A Slack app's incoming webhook always posts to the channel chosen when it was created — Slack ignores a channel
  // in the payload — so the tool takes none, and the history does not claim one.
  const payload = { text: params.text };

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
