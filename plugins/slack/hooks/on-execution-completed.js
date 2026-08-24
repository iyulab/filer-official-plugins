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

  const duration = event.duration ? `${Math.round(event.duration / 1000)}s` : 'unknown';
  const summary = typeof event.result === 'string' && event.result ? event.result : 'Task completed';
  const text = `:white_check_mark: Agent completed (${duration})\n\n${summary}`;

  await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(err => ctx.log.error('Slack notification failed:', err.message));
}
