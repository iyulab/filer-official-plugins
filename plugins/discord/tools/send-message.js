export default async function(params, ctx) {
  const webhookUrl = params.webhookUrl || await ctx.settings.get('discord.webhookUrl');
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
    throw new Error(`Discord webhook error (${res.status}): ${text}`);
  }

  ctx.log.info('Discord message sent');
  return { success: true };
}
