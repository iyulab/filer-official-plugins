// How the run ended: `outcome` is completed / unfulfilled / failed, with Filer's `reason` when it is not completed.
const HEADINGS = {
  completed: ':white_check_mark: Agent completed',
  unfulfilled: ':warning: Agent finished without doing everything asked',
  failed: ':x: Agent failed',
};

function body(event) {
  const result = typeof event.result === 'string' && event.result ? event.result : null;
  const reason = typeof event.reason === 'string' && event.reason ? event.reason : null;
  if (event.outcome === 'failed') return reason ?? result ?? 'No reason given';
  if (event.outcome === 'unfulfilled') return [reason, result].filter(Boolean).join('\n\n') || 'Task not fully done';
  return result ?? 'Task completed';
}

export default async function(event, ctx) {
  const notify = await ctx.settings.get('slack.notifyOnAgentComplete');
  if (!notify) return;

  // Resolve webhookUrl: channel integration > global default
  let webhookUrl = null;
  if (event.channelId && event.channelId !== 'default') {
    try {
      const config = await ctx.channels.getIntegrationConfig(event.channelId, 'slack');
      if (config?.webhookUrl) webhookUrl = config.webhookUrl;
    } catch (e) {
      ctx.log.warn(`Channel-scoped Slack webhook lookup failed, falling back to the global webhook: ${e.message}`);
    }
  }
  if (!webhookUrl) webhookUrl = await ctx.settings.get('slack.webhookUrl');
  if (!webhookUrl) return;

  const duration = event.duration ? `${Math.round(event.duration / 1000)}s` : 'unknown';
  const text = `${HEADINGS[event.outcome] ?? 'Agent finished'} (${duration})\n\n${body(event)}`;

  await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(err => ctx.log.error('Slack notification failed:', err.message));
}
