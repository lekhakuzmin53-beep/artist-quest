// src/lib/mailer.js — отправка писем через Resend API
// Ключ берётся ТОЛЬКО из переменной окружения RESEND_API_KEY (никогда не в коде)
const https = require('https');

const FROM = process.env.MAIL_FROM || 'Artist Quest <onboarding@resend.dev>';

function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return reject(new Error('RESEND_API_KEY не задан в переменных окружения'));
    }

    const payload = JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html,
    });

    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, body });
          } else {
            reject(new Error('Resend ответил ' + res.statusCode + ': ' + body));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Письмо с кодом подтверждения
function sendCodeEmail(to, code, purpose) {
  const title = purpose === 'register' ? 'Подтверждение регистрации' : 'Восстановление пароля';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#1c1208;color:#e8d9a8;border-radius:12px">
      <h2 style="color:#d4a830;margin-top:0">${title}</h2>
      <p>Ваш код подтверждения:</p>
      <div style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#f0c448;background:#251a0a;padding:16px;text-align:center;border-radius:8px;margin:16px 0">${code}</div>
      <p style="color:#8a7040;font-size:13px">Код действует 15 минут. Если вы не запрашивали его — просто проигнорируйте это письмо.</p>
    </div>`;
  return sendEmail(to, `${title} — код ${code}`, html);
}

module.exports = { sendEmail, sendCodeEmail };
