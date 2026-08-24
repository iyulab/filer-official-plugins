export default async function(event, ctx) {
  const notify = await ctx.settings.get('webhook.notifyOnAgentComplete');
  if (!notify) return;

  try {
    await ctx.execute('webhook.webhook_send', {
      event: 'agent.execution.completed',
      payload: {
        sessionId: event.sessionId,
        channelId: event.channelId,
        result: event.result,
        durationMs: event.duration,
      },
    });
  } catch (err) {
    ctx.log.error('Webhook notification failed:', err.message);
  }
}
