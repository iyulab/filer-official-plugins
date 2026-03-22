export default async function(params, ctx) {
  const provider = await ctx.settings.get('email.provider') || 'smtp';
  const fromAddress = await ctx.settings.get('email.fromAddress');
  if (!fromAddress) throw new Error('From address not configured. Set it in Settings > Extensions.');

  const to = params.to || await ctx.settings.get('email.defaultTo');
  if (!to) throw new Error('No recipient specified and no default configured.');

  if (provider === 'resend') {
    return await sendViaResend(params, to, fromAddress, ctx);
  } else {
    return await sendViaSmtp(params, to, fromAddress, ctx);
  }
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

async function sendViaSmtp(params, to, from, ctx) {
  const host = await ctx.settings.get('email.smtpHost');
  const port = await ctx.settings.get('email.smtpPort') || 587;
  const user = await ctx.settings.get('email.smtpUser');
  const password = await ctx.settings.get('email.smtpPassword');

  if (!host) throw new Error('SMTP host not configured.');

  // Use Node.js net/tls for basic SMTP
  const { createConnection } = await import('net');
  const tls = await import('tls');

  return new Promise((resolve, reject) => {
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
            } else if (user) {
              socket.write(`AUTH LOGIN\r\n`);
              phase = 'auth';
            } else {
              phase = 'mailfrom';
              socket.write(`MAIL FROM:<${from}>\r\n`);
            }
            break;
          case 'starttls':
            // Upgrade to TLS
            const tlsSocket = tls.connect({ socket, host, servername: host }, () => {
              tlsSocket.write(`EHLO filer\r\n`);
            });
            tlsSocket.on('data', handleTlsData(tlsSocket, { from, to, user, password, params, ctx, resolve, reject }));
            tlsSocket.on('error', reject);
            return;
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
          case 'data':
            const body = params.html || params.body;
            const contentType = params.html ? 'text/html' : 'text/plain';
            socket.write(
              `From: ${from}\r\nTo: ${to}\r\nSubject: ${params.subject}\r\n` +
              `Content-Type: ${contentType}; charset=utf-8\r\n` +
              `Date: ${new Date().toUTCString()}\r\n\r\n${body}\r\n.\r\n`
            );
            phase = 'sent';
            break;
          case 'sent':
            socket.write(`QUIT\r\n`);
            ctx.log.info(`Email sent via SMTP to ${to}`);
            resolve({ success: true, provider: 'smtp' });
            socket.end();
            break;
        }
      });

      socket.on('error', reject);
    });

    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('SMTP timeout')); }, 30000);
  });
}

function handleTlsData(socket, opts) {
  let phase = 'ehlo';
  return (data) => {
    const response = data.toString();
    switch (phase) {
      case 'ehlo':
        if (opts.user) {
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
      case 'data':
        const body = opts.params.html || opts.params.body;
        const contentType = opts.params.html ? 'text/html' : 'text/plain';
        socket.write(
          `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.params.subject}\r\n` +
          `Content-Type: ${contentType}; charset=utf-8\r\n` +
          `Date: ${new Date().toUTCString()}\r\n\r\n${body}\r\n.\r\n`
        );
        phase = 'sent';
        break;
      case 'sent':
        socket.write(`QUIT\r\n`);
        opts.ctx.log.info(`Email sent via SMTP to ${opts.to}`);
        opts.resolve({ success: true, provider: 'smtp' });
        socket.end();
        break;
    }
  };
}
