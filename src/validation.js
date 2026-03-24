import crypto from 'node:crypto';

const MAX_CUSTOM_ATTRIBUTES_BYTES = 1900;
const MAX_TEXT_LENGTH = 5000;

function estimateBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isPrimitive(value) {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

export function validateIncomingMessage(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }

  if (!body.externalUserId || typeof body.externalUserId !== 'string' || !body.externalUserId.trim()) {
    errors.push('externalUserId is required and must be a non-empty string.');
  }

  if (body.nickname !== undefined && typeof body.nickname !== 'string') {
    errors.push('nickname must be a string when provided.');
  }

  if (body.messageId !== undefined && typeof body.messageId !== 'string') {
    errors.push('messageId must be a string when provided.');
  }

  if (body.timestamp !== undefined) {
    const date = new Date(body.timestamp);
    if (Number.isNaN(date.getTime())) {
      errors.push('timestamp must be a valid ISO-8601 date string when provided.');
    }
  }

  if (body.text !== undefined && (typeof body.text !== 'string' || !body.text.trim())) {
    errors.push('text must be a non-empty string when provided.');
  }

  if (!body.text && !body.mediaUrl) {
    errors.push('Provide at least one of text or mediaUrl.');
  }

  if (body.text && body.text.length > MAX_TEXT_LENGTH) {
    errors.push(`text must be shorter than ${MAX_TEXT_LENGTH} characters.`);
  }

  if (body.mediaUrl !== undefined) {
    try {
      new URL(body.mediaUrl);
    } catch {
      errors.push('mediaUrl must be a valid absolute URL when provided.');
    }
  }

  if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
    errors.push('metadata must be a JSON object when provided.');
  }

  return errors;
}

export function sanitizeCustomAttributes(input) {
  const cleaned = {};

  for (const [key, value] of Object.entries(input || {})) {
    if (!key || typeof key !== 'string') {
      continue;
    }

    if (value === null || value === undefined) {
      continue;
    }

    if (isPrimitive(value)) {
      cleaned[key] = value;
      continue;
    }

    cleaned[key] = JSON.stringify(value);
  }

  if (estimateBytes(cleaned) <= MAX_CUSTOM_ATTRIBUTES_BYTES) {
    return cleaned;
  }

  const trimmed = {};
  for (const [key, value] of Object.entries(cleaned)) {
    trimmed[key] = value;
    if (estimateBytes(trimmed) > MAX_CUSTOM_ATTRIBUTES_BYTES) {
      delete trimmed[key];
      break;
    }
  }

  trimmed._metadataTruncated = true;
  return trimmed;
}

export function buildManualInboundMessage(body) {
  return {
    externalUserId: body.externalUserId.trim(),
    nickname: body.nickname?.trim() || undefined,
    text: body.text?.trim() || undefined,
    mediaUrl: body.mediaUrl || undefined,
    metadata: sanitizeCustomAttributes(body.metadata || {}),
    messageId: body.messageId?.trim() || crypto.randomUUID(),
    timestamp: body.timestamp || new Date().toISOString()
  };
}
