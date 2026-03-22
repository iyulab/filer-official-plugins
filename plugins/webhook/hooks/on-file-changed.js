export default async function(event, ctx) {
  const notify = await ctx.settings.get('webhook.notifyOnFileChange');
  if (!notify) return;

  try {
    await ctx.execute('webhook.webhook_send', {
      event: 'file.changed',
      payload: {
        files: event.files,
        agentId: event.agentId,
      },
    });
  } catch (err) {
    ctx.log.error('Webhook file change notification failed:', err.message);
  }
}
