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

// ── Collection summary email ──────────────────────────────────────────────────

function stripHtml(raw) {
  return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function fmtDate(datePublished) {
  if (!datePublished) return '';
  return new Date(datePublished * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function buildSummaryHtml(collection, feedsWithEpisodes, period, totalEps) {
  const noEpisodes = totalEps === 0;

  const feedSections = feedsWithEpisodes.map(f => {
    if (!f.episodes.length) return '';
    const rows = f.episodes.map(ep => {
      const desc = stripHtml(ep.description);
      const date = fmtDate(ep.datePublished);
      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;vertical-align:top">
            <a href="${ep.enclosureUrl || '#'}" style="font-weight:600;color:#18181b;text-decoration:none;font-size:14px">${ep.title || 'Untitled'}</a>
            <div style="font-size:12px;color:#6b7280;margin-top:3px">${f.feed_title || ''}${date ? ' · ' + date : ''}</div>
            ${desc ? `<div style="font-size:13px;color:#374151;margin-top:4px">${desc}…</div>` : ''}
          </td>
        </tr>`;
    }).join('');

    return `
      <div style="margin-bottom:28px">
        <h3 style="margin:0 0 10px;font-size:15px;color:#111">${f.feed_title || 'Podcast'}</h3>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          ${rows}
        </table>
      </div>`;
  }).join('');

  const body = noEpisodes
    ? `<p style="color:#6b7280">No new episodes ${period} for this collection.</p>`
    : feedSections;

  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111">
      <h2 style="margin:0 0 4px;font-size:20px">${collection.name}</h2>
      <p style="color:#6b7280;margin:0 0 24px;font-size:13px">Your ${collection.frequency} summary · ${totalEps} new episode${totalEps !== 1 ? 's' : ''} ${period}</p>
      ${body}
      <p style="color:#aaa;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">Podcast Chat · You're receiving this because you set up a collection summary.</p>
    </div>`;
}

function buildSummaryText(collection, feedsWithEpisodes, period, totalEps) {
  const lines = [
    `${collection.name} — ${collection.frequency} summary`,
    `${totalEps} new episode${totalEps !== 1 ? 's' : ''} ${period}`,
    '',
  ];

  if (totalEps === 0) {
    lines.push(`No new episodes ${period}.`);
  } else {
    for (const f of feedsWithEpisodes) {
      if (!f.episodes.length) continue;
      lines.push(`── ${f.feed_title || 'Podcast'} ──`);
      for (const ep of f.episodes) {
        const date = fmtDate(ep.datePublished);
        lines.push(`• ${ep.title || 'Untitled'}${date ? '  (' + date + ')' : ''}`);
        const desc = stripHtml(ep.description);
        if (desc) lines.push(`  ${desc}…`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function sendCollectionSummary(toEmail, collection, feedsWithEpisodes) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_FROM    = process.env.EMAIL_FROM || 'noreply@example.com';

  const period   = collection.frequency === 'daily' ? 'today' : 'this week';
  const totalEps = feedsWithEpisodes.reduce((n, f) => n + f.episodes.length, 0);
  const subject  = `Your ${collection.frequency} ${collection.name} summary`;
  const html     = buildSummaryHtml(collection, feedsWithEpisodes, period, totalEps);
  const text     = buildSummaryText(collection, feedsWithEpisodes, period, totalEps);

  if (!RESEND_API_KEY) {
    console.log(`\n  ── Collection summary for ${toEmail} ──`);
    console.log(text);
    return;
  }

  try {
    await axios.post(
      'https://api.resend.com/emails',
      { from: EMAIL_FROM, to: [toEmail], subject, html, text },
      {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      }
    );
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('[email] Resend error:', detail);
    throw new Error(detail);
  }
}

module.exports = { sendMagicLinkEmail, sendCollectionSummary };
