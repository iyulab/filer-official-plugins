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
  const summary = typeof event.result === 'string' && event.result ? event.result : 'Task completed';

  try {
    await ctx.fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        embeds: [{
          title: 'Agent Task Complete',
          description: summary,
          color: 3066993,
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
