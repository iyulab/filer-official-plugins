// How the run ended: `outcome` is completed / unfulfilled / failed, with Filer's `reason` when it is not completed.
const LOOKS = {
  completed: { subject: 'Filer Agent Task Complete', line: 'Agent task completed.' },
  unfulfilled: { subject: 'Filer Agent Task Not Fully Done', line: 'Agent task finished without doing everything asked.' },
  failed: { subject: 'Filer Agent Task Failed', line: 'Agent task failed.' },
};
const UNKNOWN = { subject: 'Filer Agent Task Finished', line: 'Agent task finished.' };

function details(event) {
  const result = typeof event.result === 'string' && event.result ? event.result : null;
  const reason = typeof event.reason === 'string' && event.reason ? event.reason : null;
  if (event.outcome === 'failed') return `Reason: ${reason ?? result ?? 'No reason given'}`;
  if (event.outcome === 'unfulfilled') {
    return [reason && `Reason: ${reason}`, result && `Result: ${result}`].filter(Boolean).join('\n') || 'Result: Task not fully done';
  }
  return `Result: ${result ?? 'Task completed'}`;
}

export default async function(event, ctx) {
  const enabled = await ctx.settings.get('email.notifyOnAgentComplete');
  if (!enabled) return;

  const fromAddress = await ctx.settings.get('email.fromAddress');
  const toAddress = await ctx.settings.get('email.defaultTo');
  if (!fromAddress || !toAddress) return;

  const duration = event.duration ? `${Math.round(event.duration / 1000)}s` : 'unknown';
  const look = LOOKS[event.outcome] ?? UNKNOWN;

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
          subject: look.subject,
          text: `${look.line}\n\nDuration: ${duration}\n${details(event)}`,
        }),
      });
    }
    // SMTP path uses the tool directly

    ctx.toast({ type: 'info', message: 'Agent result sent via email' });
  } catch (err) {
    ctx.log.error('Failed to send email notification:', err.message);
  }
}
