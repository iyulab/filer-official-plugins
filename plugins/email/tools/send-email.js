import microsoftAuth from '../services/microsoft-auth.js';

export default async function(params, ctx) {
  const provider = await ctx.settings.get('email.provider') || 'smtp';
  // A Microsoft account sends as itself: the token names the account, which is the From address unless one is set.
  const microsoft = provider === 'microsoft' ? await microsoftAuth.microsoftToken(ctx, 'smtp') : null;
  const fromAddress = (await ctx.settings.get('email.fromAddress')) || microsoft?.user;
  if (!fromAddress) throw new Error('From address not configured. Set it in Connect > Email Integration > Settings.');

  const to = params.to || await ctx.settings.get('email.defaultTo');
  if (!to) throw new Error('No recipient specified and no default configured.');

  let result;
  try {
    if (provider === 'resend') {
      result = await sendViaResend(params, to, fromAddress, ctx);
    } else if (microsoft) {
      const { host, port } = microsoftAuth.MICROSOFT.smtp;
      result = await sendViaSmtp(params, to, fromAddress, ctx, {
        host, port, user: microsoft.user, xoauth2: microsoftAuth.xoauth2(microsoft.user, microsoft.accessToken), provider: 'microsoft',
      });
    } else {
      result = await sendViaSmtp(params, to, fromAddress, ctx);
    }
  } catch (err) {
    // Track failure
    const failStats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
    failStats.failed++;
    await ctx.store.set('stats', failStats);
    ctx.viewData.set('email.stats', failStats);
    throw err;
  }

  // Track history
  const history = (await ctx.store.get('messageHistory')) || [];
  history.unshift({
    timestamp: Date.now(),
    to,
    subject: params.subject,
    status: 'sent',
  });
  if (history.length > 100) history.length = 100;
  await ctx.store.set('messageHistory', history);
  ctx.viewData.set('email.messageHistory', history);

  const stats = (await ctx.store.get('stats')) || { sent: 0, failed: 0 };
  stats.sent++;
  await ctx.store.set('stats', stats);
  ctx.viewData.set('email.stats', stats);

  return result;
}

async function sendViaResend(params, to, from, ctx) {
  const apiKey = await ctx.settings.get('email.resendApiKey');
  if (!apiKey) throw new Error('Resend API key not configured.');

  const res = await ctx.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: params.subject,
      text: params.body,
      html: params.html || undefined,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || res.statusText}`);
  }

  const result = await res.json();
  ctx.log.info(`Email sent via Resend to ${to}, id: ${result.id}`);
  return { success: true, provider: 'resend', id: result.id };
}

/**
 * @param {object} [account] - a signed-in account instead of the SMTP settings: its server, user and XOAUTH2 string
 */
async function sendViaSmtp(params, to, from, ctx, account) {
  const host = account?.host ?? await ctx.settings.get('email.smtpHost');
  const port = account?.port ?? (await ctx.settings.get('email.smtpPort') || 587);
  const user = account?.user ?? await ctx.settings.get('email.smtpUser');
  const password = account ? undefined : await ctx.settings.get('email.smtpPassword');
  const xoauth2 = account?.xoauth2;
  const provider = account?.provider ?? 'smtp';

  if (!host) throw new Error('SMTP host not configured.');

  // Use Node.js net/tls for basic SMTP
  const { createConnection } = await import('net');
  const tls = await import('tls');

  return new Promise((settleOk, settleErr) => {
    // The timeout ends with the send: a timer left running kept the process alive for 30 s after every send.
    let timer;
    const resolve = (value) => { clearTimeout(timer); settleOk(value); };
    const reject = (err) => { clearTimeout(timer); settleErr(err); };
    const socket = createConnection({ host, port }, () => {
      const lines = [];
      let phase = 'greeting';

      socket.on('data', (data) => {
        const response = data.toString();
        lines.push(response);

        switch (phase) {
          case 'greeting':
            socket.write(`EHLO filer\r\n`);
            phase = 'ehlo';
            break;
          case 'ehlo':
            if (response.includes('STARTTLS')) {
              socket.write(`STARTTLS\r\n`);
              phase = 'starttls';
            } else if (xoauth2) {
              // A token is never sent over an unencrypted connection.
              reject(new Error('The mail server did not offer an encrypted connection.'));
              socket.end();
            } else if (user) {
              socket.write(`AUTH LOGIN\r\n`);
              phase = 'auth';
            } else {
              phase = 'mailfrom';
              socket.write(`MAIL FROM:<${from}>\r\n`);
            }
            break;
          case 'starttls': {
            // Upgrade to TLS
            const tlsSocket = tls.connect({ socket, host, servername: host }, () => {
              tlsSocket.write(`EHLO filer\r\n`);
            });
            tlsSocket.on('data', handleTlsData(tlsSocket, { from, to, user, password, xoauth2, provider, params, ctx, resolve, reject }));
            tlsSocket.on('error', reject);
            return;
          }
          case 'auth':
            socket.write(Buffer.from(user).toString('base64') + '\r\n');
            phase = 'auth-user';
            break;
          case 'auth-user':
            socket.write(Buffer.from(password || '').toString('base64') + '\r\n');
            phase = 'auth-pass';
            break;
          case 'auth-pass':
            if (response.startsWith('235')) {
              socket.write(`MAIL FROM:<${from}>\r\n`);
              phase = 'mailfrom';
            } else {
              reject(new Error('SMTP authentication failed'));
              socket.end();
            }
            break;
          case 'mailfrom':
            socket.write(`RCPT TO:<${to}>\r\n`);
            phase = 'rcptto';
            break;
          case 'rcptto':
            socket.write(`DATA\r\n`);
            phase = 'data';
            break;
          case 'data': {
            const body = params.html || params.body;
            const contentType = params.html ? 'text/html' : 'text/plain';
            socket.write(
              `From: ${from}\r\nTo: ${to}\r\nSubject: ${params.subject}\r\n` +
              `Content-Type: ${contentType}; charset=utf-8\r\n` +
              `Date: ${new Date().toUTCString()}\r\n\r\n${body}\r\n.\r\n`
            );
            phase = 'sent';
            break;
          }
          case 'sent':
            socket.write(`QUIT\r\n`);
            ctx.log.info(`Email sent via SMTP to ${to}`);
            resolve({ success: true, provider });
            socket.end();
            break;
        }
      });

      socket.on('error', reject);
    });

    socket.on('error', reject);
    timer = setTimeout(() => { socket.destroy(); reject(new Error('SMTP timeout')); }, 30000);
  });
}

function handleTlsData(socket, opts) {
  let phase = 'ehlo';
  return (data) => {
    const response = data.toString();
    switch (phase) {
      case 'ehlo':
        if (opts.xoauth2) {
          socket.write(`AUTH XOAUTH2 ${opts.xoauth2}\r\n`);
          phase = 'auth-pass';
        } else if (opts.user) {
          socket.write(`AUTH LOGIN\r\n`);
          phase = 'auth';
        } else {
          socket.write(`MAIL FROM:<${opts.from}>\r\n`);
          phase = 'mailfrom';
        }
        break;
      case 'auth':
        socket.write(Buffer.from(opts.user).toString('base64') + '\r\n');
        phase = 'auth-user';
        break;
      case 'auth-user':
        socket.write(Buffer.from(opts.password || '').toString('base64') + '\r\n');
        phase = 'auth-pass';
        break;
      case 'auth-pass':
        if (response.startsWith('235')) {
          socket.write(`MAIL FROM:<${opts.from}>\r\n`);
          phase = 'mailfrom';
        } else {
          opts.reject(new Error('SMTP authentication failed'));
          socket.end();
        }
        break;
      case 'mailfrom':
        socket.write(`RCPT TO:<${opts.to}>\r\n`);
        phase = 'rcptto';
        break;
      case 'rcptto':
        socket.write(`DATA\r\n`);
        phase = 'data';
        break;
      case 'data': {
        const body = opts.params.html || opts.params.body;
        const contentType = opts.params.html ? 'text/html' : 'text/plain';
        socket.write(
          `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.params.subject}\r\n` +
          `Content-Type: ${contentType}; charset=utf-8\r\n` +
          `Date: ${new Date().toUTCString()}\r\n\r\n${body}\r\n.\r\n`
        );
        phase = 'sent';
        break;
      }
      case 'sent':
        socket.write(`QUIT\r\n`);
        opts.ctx.log.info(`Email sent via SMTP to ${opts.to}`);
        opts.resolve({ success: true, provider: opts.provider ?? 'smtp' });
        socket.end();
        break;
    }
  };
}
