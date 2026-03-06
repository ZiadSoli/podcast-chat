const axios = require('axios');

async function sendMagicLinkEmail(email, token) {
  const BASE_URL      = process.env.BASE_URL || 'http://localhost:3000';
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_FROM    = process.env.EMAIL_FROM || 'noreply@example.com';

  const link = `${BASE_URL}/auth/verify?token=${token}`;

  if (!RESEND_API_KEY) {
    // Dev mode: print to console instead of sending
    console.log(`\n  ── Magic link for ${email} ──`);
    console.log(`  ${link}\n`);
    return;
  }

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from: EMAIL_FROM,
        to: [email],
        subject: 'Your sign-in link for Podcast Chat',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
            <h2 style="margin:0 0 8px;font-size:20px">Sign in to Podcast Chat</h2>
            <p style="color:#555;margin:0 0 24px">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
            <a href="${link}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500">Sign in</a>
            <p style="color:#888;font-size:13px;margin:24px 0 0">If you didn't request this, you can safely ignore it.</p>
          </div>
        `,
        text: `Sign in to Podcast Chat: ${link}\n\nThis link expires in 15 minutes.`,
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10 second timeout — fail fast instead of hanging
      }
    );
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Resend API error:', detail);
    throw new Error(detail);
  }
}

module.exports = { sendMagicLinkEmail };
