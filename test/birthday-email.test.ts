import { describe, expect, it } from 'vitest';
import { birthdayEmail } from '../src/infra/emailTemplate';

describe('birthday email', () => {
  it('includes the name, the photo, and the animated confetti', () => {
    const email = birthdayEmail('Ada', 'https://cdn.example/ada.jpg');
    expect(email.subject).toBe('Happy birthday, Ada');
    expect(email.html).toContain('Happy birthday, Ada');
    expect(email.html).toContain('src="https://cdn.example/ada.jpg"');
    expect(email.html).toContain('/dgc/email/birthday-confetti.gif');
    expect(email.html).not.toContain('f_auto/dgc/email/birthday-confetti.gif');
    expect(email.text).toContain('You are loved at Davidic Generation Church.');
  });

  it('uses an initial when there is no https photo, and escapes the name', () => {
    const email = birthdayEmail('<Ada>', 'http://not-secure.example/a.jpg');
    expect(email.html).toContain('&lt;Ada&gt;');
    expect(email.html).not.toContain('<h1 style="margin:0 0 12px 0;color:#1f2937;font-size:26px;font-weight:bold;text-align:center;">Happy birthday, <Ada>');
    expect(email.html).toContain('>&lt;</div>');
    expect(email.html).not.toContain('http://not-secure.example/a.jpg');
  });
});
