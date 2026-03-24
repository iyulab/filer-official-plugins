export default async function(event, ctx) {
  const notify = await ctx.settings.get('slack.notifyOnAgentComplete');
  if (!notify) return;

  // Resolve webhookUrl: channel integration > global default
  let webhookUrl = null;
  if (event.channelId && event.channelId !== 'default') {
    try {
      const config = await ctx.channels.getIntegrationConfig(event.channelId, 'slack');
      if (config?.webhookUrl) webhookUrl = config.webhookUrl;
    } catch { /* fall through to global */ }
  }
  if (!webhookUrl) webhookUrl = await ctx.settings.get('slack.webhookUrl');
  if (!webhookUrl) return;

  const status = event.status === 'Completed' ? ':white_check_mark:' : ':x:';
  const text = `${status} Agent execution ${event.status.toLowerCase()}: *${event.agentName || 'Unknown'}* (${event.durationMs ? Math.round(event.durationMs / 1000) + 's' : 'N/A'})`;

  await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(err => ctx.log.error('Slack notification failed:', err.message));
}
