export default async function(params, ctx) {
  const webhookUrl = await ctx.settings.get('slack.webhookUrl');
  if (!webhookUrl) throw new Error('Slack Webhook URL not configured. Set it in Settings > Extensions.');

  const payload = { text: params.text };
  if (params.channel) payload.channel = params.channel;

  const res = await ctx.fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed (${res.status}): ${body}`);
  }

  return { success: true, message: `Message sent to Slack` };
}
