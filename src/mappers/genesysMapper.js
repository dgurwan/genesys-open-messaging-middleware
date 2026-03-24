import path from 'node:path';
import { sanitizeCustomAttributes } from '../validation.js';

function guessContentType(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

function basenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return path.basename(pathname) || 'attachment';
  } catch {
    return 'attachment';
  }
}

export function buildGenesysInboundPayload({
  externalUserId,
  messageId,
  timestamp,
  nickname,
  text,
  metadata = {},
  mediaUrl,
  includeAttachmentContent = true
}) {
  const customAttributes = sanitizeCustomAttributes(metadata);

  const payload = {
    channel: {
      messageId,
      from: {
        id: externalUserId,
        idType: 'Opaque'
      },
      time: timestamp
    },
    direction: 'Inbound'
  };

  if (nickname) {
    payload.channel.from.nickname = nickname;
  }

  if (Object.keys(customAttributes).length > 0) {
    payload.channel.metadata = {
      customAttributes
    };
  }

  if (text) {
    payload.text = text;
  }

  if (mediaUrl && includeAttachmentContent) {
    payload.content = [
      {
        contentType: 'Attachment',
        attachment: {
          url: mediaUrl,
          contentType: guessContentType(mediaUrl),
          filename: basenameFromUrl(mediaUrl)
        }
      }
    ];
  }

  return payload;
}

export function buildGenesysReceiptPayload({ messageId, status, timestamp, metadata = {} }) {
  return {
    messageId,
    status,
    channel: {
      time: timestamp,
      metadata: {
        customAttributes: sanitizeCustomAttributes(metadata)
      }
    }
  };
}
