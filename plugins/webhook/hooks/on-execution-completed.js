export default async function(event, ctx) {
  const notify = await ctx.settings.get('webhook.notifyOnAgentComplete');
  if (!notify) return;

  try {
    await ctx.execute('webhook.webhook_send', {
      event: 'agent.execution.completed',
      payload: {
        agentName: event.agentName,
        status: event.status,
        durationMs: event.durationMs,
        tokensUsed: event.tokensUsed,
      },
    });
  } catch (err) {
    ctx.log.error('Webhook notification failed:', err.message);
  }
}
