import { optimizeImage, thumbUrl } from '../../utils/cloudinaryUrl';

// Announcement pictures leave the server as a phone-sized image plus a small preview.
// The file in Cloudinary stays the original. Old posts are rewritten on the way out,
// so a slow phone does not download the camera original while scrolling.

type Attachment = { url: string; type: string };

export function presentAnnouncement<T extends { mediaUrl: string | null; type: string; attachments?: Attachment[] }>(
  message: T,
) {
  const attachments = message.attachments?.map((item) => {
    const url = item.type === 'IMAGE' ? optimizeImage(item.url) : item.url;
    return { ...item, url, thumbUrl: thumbUrl(url, item.type) };
  });
  const mediaUrl = message.type === 'IMAGE' && message.mediaUrl ? optimizeImage(message.mediaUrl) : message.mediaUrl;
  return {
    ...message,
    mediaUrl,
    thumbUrl: thumbUrl(mediaUrl, message.type),
    ...(attachments ? { attachments } : {}),
  };
}
