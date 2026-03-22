export default async function(params, ctx) {
  const webhookUrl = params.webhookUrl || await ctx.settings.get('discord.webhookUrl');
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
