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
  if (!webhookUrl) throw new Error('Discord webhook URL not configured.');

  const username = await ctx.settings.get('discord.username') || 'Filer';

  const embed = {
    title: params.title,
    description: params.description || '',
    color: params.color || 3447003,
    fields: params.fields || [],
    timestamp: new Date().toISOString(),
    footer: { text: 'Sent via Filer' },
  };

  const res = await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      embeds: [embed],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook error (${res.status}): ${text}`);
  }

  ctx.log.info('Discord embed sent');
  return { success: true };
}
