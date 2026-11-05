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

// Phones paint a notification picture only from a small JPEG. f_auto comes back as WebP,
// and a WebP is dropped, so the push looks like it has no image. Replace any existing
// Cloudinary transform with one JPEG and a .jpg name.
export function notificationImageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'res.cloudinary.com') return url;
  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  const uploadAt = parts.indexOf('upload');
  if (uploadAt < 0 || parts[uploadAt - 1] !== 'image') return url;
  let rest = parts.slice(uploadAt + 1);
  const first = rest[0] ?? '';
  if (first.includes(',') || /^[a-z]{1,3}_/.test(first)) rest = rest.slice(1);
  if (!rest.length) return null;
  const last = rest.length - 1;
  rest[last] = rest[last]!.replace(/\.[^.]+$/, '.jpg');
  parsed.pathname = `/${[...parts.slice(0, uploadAt + 1), 'f_jpg,q_auto,w_720,c_limit', ...rest].join('/')}`;
  return parsed.toString();
}

function visibleLine(title: string, extra: string | null) {
  if (!extra) return title;
  if (extra.toLowerCase().startsWith(title.toLowerCase())) return extra;
  return `${title}. ${extra}`;
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
  const fallback = input.fallback?.trim() || null;
  return { title, body: visibleLine(title, snippet ?? (imageUrl ? null : fallback)), imageUrl };
}
