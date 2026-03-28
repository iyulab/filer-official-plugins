export default async function(params, ctx) {
  // Resolve webhookUrl: explicit param > channel integration > global default
  let webhookUrl = params.webhookUrl || null;
  if (!webhookUrl) {
    try {
      const session = await ctx.session.getActive();
      if (session) {
        const channelId = session.channelId;
        if (channelId && channelId !== 'default') {
          const config = await ctx.channels.getIntegrationConfig(channelId, 'discord');
          if (config?.webhookUrl) webhookUrl = config.webhookUrl;
        }
      }
    } catch { /* fall through to global */ }
  }
  if (!webhookUrl) webhookUrl = await ctx.settings.get('discord.webhookUrl');
  if (!webhookUrl) throw new Error('Discord webhook URL not configured. Set it in Settings > Extensions.');

  const username = await ctx.settings.get('discord.username') || 'Filer';

  const res = await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: params.content,
      username,
    }),
  });

  if (!res.ok) {
    const text = await res.text();

    // Track failure
    const failStats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
    failStats.failed++;
    await ctx.store.set('stats', failStats);
    ctx.viewData.set('discord.stats', failStats);

    throw new Error(`Discord webhook error (${res.status}): ${text}`);
  }

  // Track history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: Date.now(),
    server: params.server || 'default',
    message: (params.content || '').substring(0, 100),
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('discord.messageHistory', history);

  const stats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
  stats.sent++;
  await ctx.store.set('stats', stats);
  ctx.viewData.set('discord.stats', stats);

  ctx.log.info('Discord message sent');
  return { success: true };
}
