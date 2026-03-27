/**
 * Returns true only for plain JSON objects.
 */
export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Returns a trimmed string or null when the input is empty.
 */
export function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Parses a JSON string and also supports payloads that were stringified more than once.
 */
export function parseJsonString(value, { maxDepth = 3 } = {}) {
  let text = asNonEmptyString(value);
  if (!text) {
    return null;
  }

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const firstChar = text[0];
    if (firstChar !== "{" && firstChar !== "[" && firstChar !== '"') {
      return depth === 0 ? null : text;
    }

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "string") {
        return parsed;
      }

      text = parsed.trim();
      if (!text) {
        return null;
      }
    } catch {
      return depth === 0 ? null : text;
    }
  }

  return null;
}

const STRUCTURED_MESSAGE_FIELDS = new Set([
  "agent",
  "calendarMessage",
  "calendar_message",
  "cardMessage",
  "card_message",
  "carouselMessage",
  "carousel_message",
  "channelSpecificMessage",
  "channel_specific_message",
  "choiceMessage",
  "choice_message",
  "contactInfoMessage",
  "contact_info_message",
  "explicitChannelMessage",
  "explicit_channel_message",
  "explicitChannelOmniMessage",
  "explicit_channel_omni_message",
  "listMessage",
  "list_message",
  "locationMessage",
  "location_message",
  "mediaMessage",
  "media_message",
  "shareLocationMessage",
  "share_location_message",
  "templateMessage",
  "template_message",
  "textMessage",
  "text_message",
]);

/**
 * Returns true when an object already looks like a Sinch structured message.
 */
export function containsStructuredMessageField(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.keys(value).some((key) => STRUCTURED_MESSAGE_FIELDS.has(key));
}

/**
 * Extracts a structured Sinch message from a raw object, a JSON string or an envelope.
 */
export function extractStructuredMessage(value) {
  let candidate = value;

  if (typeof candidate === "string") {
    candidate = parseJsonString(candidate);
  }

  if (!isPlainObject(candidate)) {
    return null;
  }

  if (containsStructuredMessageField(candidate)) {
    return candidate;
  }

  if (
    isPlainObject(candidate.message) &&
    containsStructuredMessageField(candidate.message)
  ) {
    return candidate.message;
  }

  return null;
}

/**
 * Replaces an embedded JSON string stored in text_message/textMessage with the parsed message object.
 */
export function replaceEmbeddedStructuredTextMessage(message) {
  if (!isPlainObject(message)) {
    return message;
  }

  const embeddedText =
    asNonEmptyString(message?.text_message?.text) ||
    asNonEmptyString(message?.textMessage?.text) ||
    null;

  const embeddedMessage = extractStructuredMessage(embeddedText);
  if (!embeddedMessage) {
    return message;
  }

  const nextMessage = { ...message };
  delete nextMessage.text_message;
  delete nextMessage.textMessage;

  return {
    ...nextMessage,
    ...embeddedMessage,
  };
}

/**
 * Normalizes a direct Sinch request and injects app_id when it is missing.
 */
function normalizeDirectSinchRequest(payload, { defaultAppId } = {}) {
  if (!isPlainObject(payload) || !isPlainObject(payload.recipient)) {
    return null;
  }

  const message = replaceEmbeddedStructuredTextMessage(
    extractStructuredMessage(payload.message) || payload.message,
  );

  if (!containsStructuredMessageField(message)) {
    return null;
  }

  const appId =
    asNonEmptyString(payload.app_id) ||
    asNonEmptyString(payload.appId) ||
    defaultAppId ||
    null;

  if (!appId) {
    return null;
  }

  return {
    ...payload,
    app_id: payload.app_id || appId,
    message,
  };
}

/**
 * Extracts one or more direct Sinch requests from an object, an array or a JSON string.
 */
export function extractDirectSinchRequests(payload, { defaultAppId } = {}) {
  let candidate = payload;

  if (typeof candidate === "string") {
    const parsed = parseJsonString(candidate);
    if (!parsed) {
      return null;
    }

    candidate = parsed;
  }

  const directCandidates = Array.isArray(candidate)
    ? candidate
    : Array.isArray(candidate?.requests)
      ? candidate.requests
      : [candidate];

  if (!Array.isArray(directCandidates) || directCandidates.length === 0) {
    return null;
  }

  const requests = directCandidates.map((request) =>
    normalizeDirectSinchRequest(request, { defaultAppId }),
  );

  return requests.every(Boolean) ? requests : null;
}
