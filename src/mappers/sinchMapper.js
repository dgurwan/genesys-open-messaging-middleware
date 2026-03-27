function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncate(value, maxLength) {
  const text = asNonEmptyString(value);
  if (!text) {
    return null;
  }

  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function isAbsoluteUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeUrl(value) {
  return isAbsoluteUrl(value);
}

function hostnameFromUrl(value) {
  if (!isAbsoluteUrl(value)) {
    return null;
  }

  try {
    return new URL(value).hostname.replace(/^www\./i, "") || null;
  } catch {
    return null;
  }
}

function normalizePhoneNumber(value) {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/[^\d+]/g, "");
  return normalized || null;
}

function pickChoiceUrl(choice) {
  return (
    asNonEmptyString(choice?.url) ||
    asNonEmptyString(choice?.uri) ||
    asNonEmptyString(choice?.link) ||
    null
  );
}

function deriveUrlChoiceTitle(choice, index) {
  const explicitTitle =
    asNonEmptyString(choice?.title) ||
    asNonEmptyString(choice?.label) ||
    asNonEmptyString(choice?.text);

  if (explicitTitle && !looksLikeUrl(explicitTitle)) {
    return explicitTitle;
  }

  return hostnameFromUrl(pickChoiceUrl(choice)) || `Open link ${index + 1}`;
}

function mapQuickReplyChoice(choice, index) {
  const url = pickChoiceUrl(choice);

  if (url) {
    return {
      url_message: {
        title: truncate(deriveUrlChoiceTitle(choice, index), 25),
        url,
      },
    };
  }

  const text =
    truncate(
      asNonEmptyString(choice?.title) ||
        asNonEmptyString(choice?.text) ||
        asNonEmptyString(choice?.label) ||
        `Choice ${index + 1}`,
      25,
    ) || `Choice ${index + 1}`;

  const phoneNumber =
    normalizePhoneNumber(choice?.phoneNumber) ||
    normalizePhoneNumber(choice?.phone_number) ||
    normalizePhoneNumber(choice?.phone);

  if (phoneNumber) {
    return {
      call_message: {
        title: text,
        phone_number: phoneNumber,
      },
    };
  }

  const postback =
    asNonEmptyString(choice?.payload) ||
    asNonEmptyString(choice?.postback_data) ||
    text;

  return {
    text_message: {
      text,
    },
    postback_data: postback,
  };
}

function mapGenesysCardActionToChoice(action, index) {
  if (!action || typeof action !== "object") {
    return null;
  }

  return mapQuickReplyChoice(action, index);
}

function extractQuickReplies(payload) {
  if (Array.isArray(payload?.content)) {
    const nested = [];

    for (const item of payload.content) {
      if (item?.quickReply && typeof item.quickReply === "object") {
        nested.push(item.quickReply);
      }
    }

    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function mapGenesysCarouselCard(card) {
  if (!card || typeof card !== "object") {
    return null;
  }

  const mapped = {};

  const title = truncate(card?.title || card?.name, 200);
  if (title) {
    mapped.title = title;
  }

  const description = truncate(card?.description || card?.text, 2000);
  if (description) {
    mapped.description = description;
  }

  const mediaUrl =
    asNonEmptyString(card?.image) ||
    asNonEmptyString(card?.imageUrl) ||
    asNonEmptyString(card?.mediaUrl) ||
    asNonEmptyString(card?.media?.url) ||
    null;

  if (mediaUrl && isAbsoluteUrl(mediaUrl)) {
    mapped.media_message = {
      url: mediaUrl,
    };
  }

  const rawActions = Array.isArray(card?.actions)
    ? card.actions
    : Array.isArray(card?.buttons)
      ? card.buttons
      : [];

  const choices = rawActions
    .map(mapGenesysCardActionToChoice)
    .filter(Boolean)
    .slice(0, 4);

  if (choices.length > 0) {
    mapped.choices = choices;
  }

  return Object.keys(mapped).length > 0 ? mapped : null;
}

function extractCarouselCards(payload) {
  if (!Array.isArray(payload?.content)) {
    return [];
  }

  const cards = [];

  for (const item of payload.content) {
    if (String(item?.contentType || "").toLowerCase() !== "carousel") {
      continue;
    }

    const rawCards = Array.isArray(item?.carousel?.cards) ? item.carousel.cards : [];
    for (const rawCard of rawCards) {
      const mapped = mapGenesysCarouselCard(rawCard);
      if (mapped) {
        cards.push(mapped);
      }
    }
  }

  return cards;
}

function parseJsonString(value) {
  const text = asNonEmptyString(value);
  if (!text) {
    return null;
  }

  const firstChar = text[0];
  if (firstChar !== "{" && firstChar !== "[") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeCardHeight(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return (
      {
        0: "UNSPECIFIED_HEIGHT",
        1: "SHORT",
        2: "MEDIUM",
        3: "TALL",
      }[value] || value
    );
  }

  const text = asNonEmptyString(value);
  if (!text) {
    return value;
  }

  const normalized = text.toUpperCase();
  const enumMap = {
    UNSPECIFIED: "UNSPECIFIED_HEIGHT",
    UNSPECIFIED_HEIGHT: "UNSPECIFIED_HEIGHT",
    SHORT: "SHORT",
    MEDIUM: "MEDIUM",
    TALL: "TALL",
  };

  return enumMap[normalized] || value;
}

const CAMEL_TO_SNAKE_KEY_MAP = {
  appId: "app_id",
  callbackUrl: "callback_url",
  calendarMessage: "calendar_message",
  cardMessage: "card_message",
  carouselMessage: "carousel_message",
  channelIdentities: "channel_identities",
  channelPriorityOrder: "channel_priority_order",
  channelSpecificMessage: "channel_specific_message",
  choiceMessage: "choice_message",
  contactId: "contact_id",
  contactInfoMessage: "contact_info_message",
  correlationId: "correlation_id",
  eventDescription: "event_description",
  eventEnd: "event_end",
  eventStart: "event_start",
  eventTitle: "event_title",
  explicitChannelMessage: "explicit_channel_message",
  explicitChannelOmniMessage: "explicit_channel_omni_message",
  fallbackUrl: "fallback_url",
  filenameOverride: "filename_override",
  identifiedBy: "identified_by",
  listMessage: "list_message",
  locationMessage: "location_message",
  mediaMessage: "media_message",
  messageProperties: "message_properties",
  messageType: "message_type",
  phoneNumber: "phone_number",
  postbackData: "postback_data",
  shareLocationMessage: "share_location_message",
  templateMessage: "template_message",
  textMessage: "text_message",
  thumbnailUrl: "thumbnail_url",
  urlMessage: "url_message",
  callMessage: "call_message",
};

function normalizeConversationKey(key) {
  return CAMEL_TO_SNAKE_KEY_MAP[key] || key;
}

function normalizeConversationPayload(value, { parentKey } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeConversationPayload(item, { parentKey }),
    );
  }

  if (!isPlainObject(value)) {
    if (parentKey === "height") {
      return normalizeCardHeight(value);
    }

    return value;
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeConversationKey(rawKey);
    normalized[key] = normalizeConversationPayload(rawValue, { parentKey: key });
  }

  return normalized;
}

const STRUCTURED_MESSAGE_FIELDS = new Set([
  "agent",
  "calendar_message",
  "card_message",
  "carousel_message",
  "channel_specific_message",
  "choice_message",
  "contact_info_message",
  "explicit_channel_message",
  "explicit_channel_omni_message",
  "list_message",
  "location_message",
  "media_message",
  "share_location_message",
  "template_message",
  "text_message",
]);

function containsStructuredMessageField(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.keys(value).some((key) => STRUCTURED_MESSAGE_FIELDS.has(key));
}

function extractStructuredMessageCandidate(value) {
  let candidate = value;

  if (typeof candidate === "string") {
    candidate = parseJsonString(candidate);
  }

  if (!isPlainObject(candidate)) {
    return null;
  }

  const normalizedCandidate = normalizeConversationPayload(candidate);

  if (containsStructuredMessageField(normalizedCandidate)) {
    return normalizedCandidate;
  }

  if (
    isPlainObject(normalizedCandidate.message) &&
    containsStructuredMessageField(normalizedCandidate.message)
  ) {
    return normalizedCandidate.message;
  }

  return null;
}

function normalizeDirectRequestMessage(message) {
  const normalizedMessage = normalizeConversationPayload(message);
  if (!isPlainObject(normalizedMessage)) {
    return null;
  }

  const embeddedStructuredMessage = extractStructuredMessageCandidate(
    normalizedMessage?.text_message?.text,
  );

  if (embeddedStructuredMessage) {
    return embeddedStructuredMessage;
  }

  return normalizedMessage;
}

function normalizeDirectSinchRequest(payload, { defaultAppId } = {}) {
  if (!isPlainObject(payload)) {
    return null;
  }

  const normalizedPayload = normalizeConversationPayload(payload);
  if (!isPlainObject(normalizedPayload.recipient)) {
    return null;
  }

  const normalizedMessage = normalizeDirectRequestMessage(normalizedPayload.message);
  if (!normalizedMessage || !containsStructuredMessageField(normalizedMessage)) {
    return null;
  }

  const appId = asNonEmptyString(normalizedPayload.app_id) || defaultAppId || null;
  if (!appId) {
    return null;
  }

  return {
    ...normalizedPayload,
    app_id: appId,
    message: normalizedMessage,
  };
}

export function extractDirectSinchRequests(
  payload,
  { defaultAppId } = {},
) {
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

export function parseGenesysOutboundMessage(payload, { defaultSinchAppId } = {}) {
  const directRequests = extractDirectSinchRequests(payload, {
    defaultAppId: defaultSinchAppId,
  });

  if (directRequests) {
    const directCorrelationId =
      directRequests
        .map((request) => asNonEmptyString(request?.correlation_id))
        .find(Boolean) || null;

    console.log(
      "parseGenesysOutboundMessage : Detected direct Sinch request payload:",
      JSON.stringify({
        correlationId: directCorrelationId,
        requestCount: directRequests.length,
      }),
    );

    return {
      kind: "sinch_direct",
      id: directCorrelationId,
      customerId: null,
      agentId: null,
      text: null,
      quickReplies: [],
      carouselCards: [],
      structuredMessage: null,
      timestamp: new Date().toISOString(),
      directRequests,
      raw: payload,
    };
  }

  const id =
    asNonEmptyString(payload?.id) ||
    asNonEmptyString(payload?.channel?.messageId);
  const customerId =
    asNonEmptyString(payload?.channel?.to?.id) ||
    asNonEmptyString(payload?.to?.id) ||
    asNonEmptyString(payload?.recipient?.id) ||
    null;

  const agentId =
    asNonEmptyString(payload?.channel?.from?.id) ||
    asNonEmptyString(payload?.from?.id) ||
    null;

  const rawText =
    asNonEmptyString(payload?.text) ||
    asNonEmptyString(payload?.message) ||
    (Array.isArray(payload?.content)
      ? payload.content
          .map((item) => asNonEmptyString(item?.text))
          .filter(Boolean)
          .join("\n") || null
      : null);

  const structuredMessage = extractStructuredMessageCandidate(rawText);
  const text = structuredMessage ? null : rawText;

  const quickReplies = extractQuickReplies(payload).map(mapQuickReplyChoice);
  const carouselCards = extractCarouselCards(payload);

  const time =
    asNonEmptyString(payload?.channel?.time) ||
    asNonEmptyString(payload?.time) ||
    new Date().toISOString();

  console.log(
    "parseGenesysOutboundMessage : Parsed Genesys outbound message:",
    JSON.stringify({
      id,
      customerId,
      agentId,
      text,
      quickReplies,
      carouselCards,
      structuredMessage,
      time,
    }),
  );

  return {
    kind: "genesys_outbound",
    id,
    customerId,
    agentId,
    text,
    quickReplies,
    carouselCards,
    structuredMessage,
    timestamp: time,
    raw: payload,
  };
}

function buildRecipient({ appId, customerId }) {
  return {
    app_id: appId,
    recipient: {
      identified_by: {
        channel_identities: [
          {
            channel: "RCS",
            identity: customerId,
          },
        ],
      },
    },
  };
}

export function buildSinchRequestsFromGenesysMessage({
  appId,
  genesysMessage,
}) {
  if (genesysMessage.kind === "sinch_direct") {
    return genesysMessage.directRequests;
  }

  const customerId = genesysMessage.customerId;
  if (!customerId) {
    throw new Error(
      "Unable to determine end-user RCS identity from Genesys outbound payload.",
    );
  }

  const base = buildRecipient({ appId, customerId });
  const correlationBase = genesysMessage.id || `genesys-${Date.now()}`;
  const requests = [];

  if (genesysMessage.structuredMessage) {
    requests.push({
      ...base,
      correlation_id: correlationBase,
      message: genesysMessage.structuredMessage,
    });
    return requests;
  }

  if (genesysMessage.carouselCards.length > 0) {
    if (genesysMessage.text) {
      requests.push({
        ...base,
        correlation_id: `${correlationBase}:text`,
        message: {
          text_message: {
            text: genesysMessage.text,
          },
        },
      });
    }

    const carouselMessage = {
      cards: genesysMessage.carouselCards.slice(0, 10),
    };

    if (genesysMessage.quickReplies.length > 0) {
      carouselMessage.choices = genesysMessage.quickReplies.slice(0, 3);
    }

    requests.push({
      ...base,
      correlation_id: `${correlationBase}:carousel`,
      message: {
        carousel_message: carouselMessage,
      },
    });

    return requests;
  }

  if (genesysMessage.quickReplies.length > 0) {
    requests.push({
      ...base,
      correlation_id: correlationBase,
      message: {
        choice_message: {
          text_message: {
            text: genesysMessage.text || "Fais le bon choix ! 😉",
          },
          choices: genesysMessage.quickReplies.slice(0, 13),
        },
      },
    });
    return requests;
  }

  requests.push({
    ...base,
    correlation_id: correlationBase,
    message: {
      text_message: {
        text: genesysMessage.text || "",
      },
    },
  });

  return requests;
}

export function parseSinchCallback(payload) {
  if (payload?.message) {
    const message = payload.message;
    const contactMessage = message.contact_message || {};

    let inboundType = "unsupported";
    let text = null;
    let mediaUrl = null;
    let choiceMessageId = null;

    if (contactMessage.text_message?.text) {
      inboundType = "text";
      text = contactMessage.text_message.text;
    } else if (contactMessage.choice_response_message?.postback_data) {
      inboundType = "quick_reply";
      text = contactMessage.choice_response_message.postback_data;
      choiceMessageId =
        contactMessage.choice_response_message.message_id || null;
    }

    return {
      kind: "message_inbound",
      externalUserId: asNonEmptyString(message.channel_identity?.identity),
      messageId: asNonEmptyString(message.id),
      timestamp:
        asNonEmptyString(message.accept_time) ||
        asNonEmptyString(payload.event_time) ||
        new Date().toISOString(),
      nickname: asNonEmptyString(message.sender_id) || null,
      text,
      mediaUrl,
      inboundType,
      metadata: {
        sourceChannel: "RCS",
        sinchConversationId:
          asNonEmptyString(message.conversation_id) || undefined,
        sinchContactId: asNonEmptyString(message.contact_id) || undefined,
        sinchAppId: asNonEmptyString(payload.app_id) || undefined,
        sinchMessageMetadata: payload.message_metadata || undefined,
        sinchCorrelationId: payload.correlation_id || undefined,
        choiceMessageId: choiceMessageId || undefined,
      },
      raw: payload,
    };
  }

  return {
    kind: "unsupported",
    raw: payload,
  };
}
