// How the run ended: `outcome` is completed / unfulfilled / failed, with Filer's `reason` when it is not completed.
const LOOKS = {
  completed: { title: 'Agent Task Complete', color: 3066993 },
  unfulfilled: { title: 'Agent Task Not Fully Done', color: 15105570 },
  failed: { title: 'Agent Task Failed', color: 15158332 },
};
const UNKNOWN = { title: 'Agent Task Finished', color: 9807270 };

function description(event) {
  const result = typeof event.result === 'string' && event.result ? event.result : null;
  const reason = typeof event.reason === 'string' && event.reason ? event.reason : null;
  if (event.outcome === 'failed') return reason ?? result ?? 'No reason given';
  if (event.outcome === 'unfulfilled') return [reason, result].filter(Boolean).join('\n\n') || 'Task not fully done';
  return result ?? 'Task completed';
}

export default async function(event, ctx) {
  const enabled = await ctx.settings.get('discord.notifyOnAgentComplete');
  if (!enabled) return;

  // Resolve webhookUrl: channel integration > global default
  let webhookUrl = null;
  if (event.channelId && event.channelId !== 'default') {
    try {
      const config = await ctx.channels.getIntegrationConfig(event.channelId, 'discord');
      if (config?.webhookUrl) webhookUrl = config.webhookUrl;
    } catch (e) {
      ctx.log.warn(`Channel-scoped Discord webhook lookup failed, falling back to the global webhook: ${e.message}`);
    }
  }
  if (!webhookUrl) webhookUrl = await ctx.settings.get('discord.webhookUrl');
  if (!webhookUrl) return;

  const username = await ctx.settings.get('discord.username') || 'Filer';
  const duration = event.duration ? `${Math.round(event.duration / 1000)}s` : 'unknown';
  const look = LOOKS[event.outcome] ?? UNKNOWN;

  try {
    await ctx.fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        embeds: [{
          title: look.title,
          description: description(event),
          color: look.color,
          fields: [
            { name: 'Duration', value: duration, inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Filer Agent' },
        }],
      }),
    });
    ctx.toast({ type: 'info', message: 'Agent result sent to Discord' });
  } catch (err) {
    ctx.log.error('Failed to send Discord notification:', err.message);
  }
}
