export default async function(event, ctx) {
  const enabled = await ctx.settings.get('email.notifyOnAgentComplete');
  if (!enabled) return;

  const fromAddress = await ctx.settings.get('email.fromAddress');
  const toAddress = await ctx.settings.get('email.defaultTo');
  if (!fromAddress || !toAddress) return;

  const duration = event.duration ? `${Math.round(event.duration / 1000)}s` : 'unknown';
  const summary = event.result?.summary || 'Task completed';

  try {
    const provider = await ctx.settings.get('email.provider') || 'smtp';

    if (provider === 'resend') {
      const apiKey = await ctx.settings.get('email.resendApiKey');
      if (!apiKey) return;

      await ctx.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [toAddress],
          subject: 'Filer Agent Task Complete',
          text: `Agent task completed.\n\nDuration: ${duration}\nResult: ${summary}`,
        }),
      });
    }
    // SMTP path uses the tool directly

    ctx.toast({ type: 'info', message: 'Agent result sent via email' });
  } catch (err) {
    ctx.log.error('Failed to send email notification:', err.message);
  }
}
