// Email-client-safe HTML (table layout + inline styles — Gmail/Outlook strip <style> and
// don't support fl/grid). Keep a reusable layout so every email (OTP, welcome, notifications)
// shares the DGC look. Banner is hosted on Cloudinary (email clients need a public URL).

// f_auto = best format per client (WebP/AVIF, falls back to JPEG for Outlook), q_auto = smart
// compression, w_1200 = 2× the 600px display width for retina. ~40–56% smaller, same image.
const BANNER_URL =
  'https://res.cloudinary.com/ph82hmab/image/upload/f_auto,q_auto,w_1200/v1782625723/dgc/email/welcome-banner.jpg';
const WEBSITE = 'https://www.davidicgenerationchurch.com';
const PURPLE = '#5B2A86';

export function renderEmailLayout(opts: { preheader: string; contentHtml: string; reason?: string; extraHtml?: string }): string {
  const year = new Date().getFullYear();
  const reason = opts.reason ?? "You received this because a sign-in code was requested for this email address. If that wasn't you, you can safely ignore it.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Davidic Generation Church</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f4f4f7;">${opts.preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #ececf1;">
      <tr><td style="padding:0;">
        <img src="${BANNER_URL}" width="600" alt="Davidic Generation Church" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;">
      </td></tr>
      <tr><td style="height:4px;background-color:${PURPLE};font-size:0;line-height:0;">&nbsp;</td></tr>
      ${opts.extraHtml ?? ''}
      <tr><td style="padding:36px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">${opts.contentHtml}</td></tr>
      <tr><td style="padding:24px 40px 32px 40px;font-family:Arial,Helvetica,sans-serif;border-top:1px solid #eeeeee;">
        <p style="margin:0;color:#9ca3af;font-size:12px;line-height:18px;">
          Davidic Generation Church &middot; <a href="${WEBSITE}" style="color:${PURPLE};text-decoration:none;">davidicgenerationchurch.com</a><br>
          ${reason}
        </p>
        <p style="margin:12px 0 0 0;color:#cbd5e1;font-size:12px;">&copy; ${year} Davidic Generation Church. All rights reserved.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function otpEmail(code: string): { subject: string; html: string; text: string } {
  const contentHtml = `
    <h1 style="margin:0 0 12px 0;color:#1f2937;font-size:22px;font-weight:bold;">Verify your email</h1>
    <p style="margin:0 0 24px 0;color:#4b5563;font-size:15px;line-height:22px;">Use the verification code below to continue signing in to your DGC account.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="padding:4px 0;">
        <div style="display:inline-block;background-color:#f3eefb;border:1px solid #e5d9f7;border-radius:10px;padding:18px 30px;">
          <span style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;letter-spacing:10px;color:${PURPLE};">${code}</span>
        </div>
      </td></tr>
    </table>
    <p style="margin:20px 0 0 0;color:#6b7280;font-size:14px;line-height:20px;text-align:center;">This code expires in <strong>10 minutes</strong>.</p>
    <p style="margin:24px 0 0 0;color:#9ca3af;font-size:13px;line-height:20px;">Didn't request this code? You can safely ignore this email — your account stays secure.</p>`;

  return {
    subject: 'Your DGC verification code',
    html: renderEmailLayout({ preheader: `Your DGC code is ${code} (expires in 10 minutes).`, contentHtml }),
    text: `Your DGC verification code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.\n\n— Davidic Generation Church\ndavidicgenerationchurch.com`,
  };
}

export function resetOtpEmail(code: string): { subject: string; html: string; text: string } {
  const contentHtml = `
    <h1 style="margin:0 0 12px 0;color:#1f2937;font-size:22px;font-weight:bold;">Reset your password</h1>
    <p style="margin:0 0 8px 0;color:#4b5563;font-size:15px;line-height:22px;">We received a request to reset the password on your DGC account.</p>
    <p style="margin:0 0 24px 0;color:#4b5563;font-size:15px;line-height:22px;">Enter the code below in the app to set a new password:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="padding:4px 0;">
        <div style="display:inline-block;background-color:#fef3f2;border:1px solid #fecaca;border-radius:10px;padding:18px 30px;">
          <span style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;letter-spacing:10px;color:#dc2626;">${code}</span>
        </div>
      </td></tr>
    </table>
    <p style="margin:20px 0 0 0;color:#6b7280;font-size:14px;line-height:20px;text-align:center;">This code expires in <strong>10 minutes</strong>.</p>
    <p style="margin:24px 0 0 0;color:#4b5563;font-size:14px;line-height:20px;background-color:#fef9e7;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:6px;">
      <strong>Didn't request a password reset?</strong><br>
      Someone may have entered your email by mistake. Your password has <em>not</em> been changed — you can safely ignore this email. If you're concerned, sign in and change your password.
    </p>`;

  return {
    subject: 'Reset your DGC password',
    html: renderEmailLayout({ preheader: `Your DGC password reset code is ${code} (expires in 10 minutes).`, contentHtml }),
    text: `Your DGC password reset code is ${code}. It expires in 10 minutes.\n\nEnter this code in the app to set a new password.\n\nIf you didn't request this, you can safely ignore this email — your password has not been changed.\n\n— Davidic Generation Church\ndavidicgenerationchurch.com`,
  };
}

// Keep this as a GIF. f_auto would turn it into a still picture and the confetti would stop.
const CONFETTI_URL = 'https://res.cloudinary.com/ph82hmab/image/upload/v1793812481/dgc/email/birthday-confetti.gif';

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function birthdayEmail(name: string, avatarUrl: string | null): { subject: string; html: string; text: string } {
  const safeName = escapeHtml(name);
  const initial = escapeHtml((name.trim().slice(0, 1) || 'F').toUpperCase());
  const photo = avatarUrl && /^https:\/\//i.test(avatarUrl)
    ? `<img src="${escapeHtml(avatarUrl)}" width="96" height="96" alt="${safeName}" style="display:block;width:96px;height:96px;border-radius:48px;border:0;outline:none;object-fit:cover;">`
    : `<div style="width:96px;height:96px;line-height:96px;border-radius:48px;background-color:${PURPLE};color:#ffffff;font-size:40px;font-weight:bold;text-align:center;">${initial}</div>`;
  const contentHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" style="padding:0 0 18px 0;">${photo}</td></tr>
    </table>
    <h1 style="margin:0 0 12px 0;color:#1f2937;font-size:26px;font-weight:bold;text-align:center;">Happy birthday, ${safeName}</h1>
    <p style="margin:0 0 16px 0;color:#4b5563;font-size:16px;line-height:24px;text-align:center;">Today we thank God for your life. May this new year bring you joy, peace, and sweet surprises.</p>
    <p style="margin:0;color:#5B2A86;font-size:16px;line-height:24px;text-align:center;font-weight:bold;">You are loved at Davidic Generation Church.</p>`;
  const text = `Happy birthday, ${name}\n\nToday we thank God for your life. May this new year bring you joy, peace, and sweet surprises.\n\nYou are loved at Davidic Generation Church.\n\n— Davidic Generation Church\ndavidicgenerationchurch.com`;
  return {
    subject: `Happy birthday, ${name}`,
    html: renderEmailLayout({
      preheader: `Happy birthday, ${safeName}. You are loved at DGC.`,
      extraHtml: `<tr><td style="padding:0;background-color:#fff8fb;"><img src="${CONFETTI_URL}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>`,
      contentHtml,
      reason: 'You received this because your birthday is saved on your DGC profile.',
    }),
    text,
  };
}
