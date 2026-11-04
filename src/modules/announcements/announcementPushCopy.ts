// What an announcement push shows. A picture rides with the title. With no picture,
// the phone gets the title and the opening of the text.

const SNIPPET = 140;

function snippetOf(body: string | null | undefined): string | null {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= SNIPPET) return text;
  const cut = text.slice(0, SNIPPET);
  const lastSpace = cut.lastIndexOf(' ');
  const short = (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${short}…`;
}

// Phones should not pull the full upload just to paint a notification. Cloudinary
// can hand back a small JPEG. Any other https image is left as the client stored it.
export function notificationImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'res.cloudinary.com') return url;
  const parts = parsed.pathname.split('/');
  const uploadAt = parts.indexOf('upload');
  if (uploadAt < 0 || parts[uploadAt - 1] !== 'image') return url;
  const next = parts[uploadAt + 1] ?? '';
  if (!next || next.includes(',') || /^[a-z]_/.test(next)) return url;
  parts.splice(uploadAt + 1, 0, 'f_jpg,q_auto,w_720,c_limit');
  parsed.pathname = parts.join('/');
  return parsed.toString();
}

export function announcementPushCopy(input: {
  title: string;
  body?: string | null;
  imageUrl?: string | null;
  fallback?: string | null;
}) {
  const title = input.title.trim() || 'Announcement';
  const imageUrl = input.imageUrl ? notificationImageUrl(input.imageUrl) : null;
  const snippet = snippetOf(input.body);
  if (imageUrl) return { title, body: snippet, imageUrl };
  const fallback = input.fallback?.trim() || null;
  return { title, body: snippet ?? fallback, imageUrl: null };
}
