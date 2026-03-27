import {
  asNonEmptyString,
  extractStructuredMessage,
  normalizeDirectSinchRequest,
} from "../utils/sinchPayload.js";

/**
 * Truncates text fields to the maximum size accepted by the downstream channel.
 */
function truncate(value, maxLength) {
  const text = asNonEmptyString(value);
  if (!text) {
    return null;
  }

  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Returns true when the value is a valid absolute HTTP(S) URL.
 */
function isAbsoluteUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reuses the URL validation helper to make the intent explicit.
 */
function looksLikeUrl(value) {
  return isAbsoluteUrl(value);
}

/**
 * Extracts a readable hostname from a URL to build a fallback button title.
 */
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

/**
 * Normalizes a phone number to digits and an optional leading plus sign.
 */
function normalizePhoneNumber(value) {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/[^\d+]/g, "");
  return normalized || null;
}

/**
 * Finds a URL on a choice object regardless of the source field name.
 */
function pickChoiceUrl(choice) {
  return (
    asNonEmptyString(choice?.url) ||
    asNonEmptyString(choice?.uri) ||
    asNonEmptyString(choice?.link) ||
    null
  );
}

/**
 * Builds a safe button title when the source action only contains a URL.
 */
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

/**
 * Converts a Genesys quick reply action into the Sinch choice format.
 */
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

  return {
    text_message: {
      text,
    },
    postback_data:
      asNonEmptyString(choice?.payload) ||
      asNonEmptyString(choice?.postback_data) ||
      text,
  };
}

/**
 * Safely maps a Genesys card action when the action object exists.
 */
function mapGenesysCardActionToChoice(action, index) {
  if (!action || typeof action !== "object") {
    return null;
  }

  return mapQuickReplyChoice(action, index);
}

/**
 * Extracts quick reply definitions from the Genesys content array.
 */
function extractQuickReplies(payload) {
  if (!Array.isArray(payload?.content)) {
    return [];
  }

  return payload.content
    .map((item) => item?.quickReply)
    .filter((item) => item && typeof item === "object");
}

/**
 * Converts one Genesys carousel card into the Sinch carousel card shape.
 */
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

/**
 * Extracts and maps all carousel cards contained in the Genesys payload.
 */
function extractCarouselCards(payload) {
  if (!Array.isArray(payload?.content)) {
    return [];
  }

  const cards = [];

  for (const item of payload.content) {
    if (String(item?.contentType || "").toLowerCase() !== "carousel") {
      continue;
    }

    const rawCards = Array.isArray(item?.carousel?.cards)
      ? item.carousel.cards
      : [];

    for (const rawCard of rawCards) {
      const mapped = mapGenesysCarouselCard(rawCard);
      if (mapped) {
        cards.push(mapped);
      }
    }
  }

  return cards;
}

/**
 * Extracts the plain text portion of a Genesys outbound payload.
 */
function extractGenesysText(payload) {
  return (
    asNonEmptyString(payload?.text) ||
    asNonEmptyString(payload?.message) ||
    (Array.isArray(payload?.content)
      ? payload.content
          .map((item) => asNonEmptyString(item?.text))
          .filter(Boolean)
          .join("\n") || null
      : null)
  );
}

/**
 * Builds the normalized internal object used by the middleware for one Genesys outbound payload.
 */
function buildGenesysOutboundMessage(payload) {
  const rawText = extractGenesysText(payload);
  const structuredMessage = extractStructuredMessage(rawText);

  return {
    kind: "genesys_outbound",
    id:
      asNonEmptyString(payload?.id) ||
      asNonEmptyString(payload?.channel?.messageId),
    customerId:
      asNonEmptyString(payload?.channel?.to?.id) ||
      asNonEmptyString(payload?.to?.id) ||
      asNonEmptyString(payload?.recipient?.id) ||
      null,
    agentId:
      asNonEmptyString(payload?.channel?.from?.id) ||
      asNonEmptyString(payload?.from?.id) ||
      null,
    text: structuredMessage ? null : rawText,
    quickReplies: extractQuickReplies(payload).map(mapQuickReplyChoice),
    carouselCards: extractCarouselCards(payload),
    structuredMessage,
    directRequest: null,
    timestamp:
      asNonEmptyString(payload?.channel?.time) ||
      asNonEmptyString(payload?.time) ||
      new Date().toISOString(),
    raw: payload,
  };
}

/**
 * Normalizes either a direct Sinch request or a Genesys outbound webhook into one internal shape.
 */
export function parseGenesysOutboundMessage(payload, { defaultSinchAppId } = {}) {
  const directRequest = normalizeDirectSinchRequest(payload, {
    defaultAppId: defaultSinchAppId,
  });

  if (directRequest) {
    const parsed = {
      kind: "sinch_direct",
      id: asNonEmptyString(directRequest?.correlation_id),
      customerId: null,
      agentId: null,
      text: null,
      quickReplies: [],
      carouselCards: [],
      structuredMessage: null,
      directRequest,
      timestamp: new Date().toISOString(),
      raw: payload,
    };

    console.log(
      "parseGenesysOutboundMessage : Detected direct Sinch request payload:",
      JSON.stringify({
        correlationId: parsed.id,
        message: parsed.directRequest.message,
      }),
    );

    return parsed;
  }

  const parsed = buildGenesysOutboundMessage(payload);

  console.log(
    "parseGenesysOutboundMessage : Parsed Genesys outbound message:",
    JSON.stringify({
      id: parsed.id,
      customerId: parsed.customerId,
      agentId: parsed.agentId,
      text: parsed.text,
      quickReplies: parsed.quickReplies,
      carouselCards: parsed.carouselCards,
      structuredMessage: parsed.structuredMessage,
      time: parsed.timestamp,
    }),
  );

  return parsed;
}

/**
 * Builds the common Sinch recipient envelope for a customer phone number.
 */
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

/**
 * Translates the normalized outbound message into one or more Sinch API requests.
 */
export function buildSinchRequestsFromGenesysMessage({
  appId,
  genesysMessage,
}) {
  if (genesysMessage.kind === "sinch_direct") {
    return [genesysMessage.directRequest];
  }

  if (!genesysMessage.customerId) {
    throw new Error(
      "Unable to determine end-user RCS identity from Genesys outbound payload.",
    );
  }

  const base = buildRecipient({
    appId,
    customerId: genesysMessage.customerId,
  });
  const correlationBase = genesysMessage.id || `genesys-${Date.now()}`;

  if (genesysMessage.structuredMessage) {
    return [
      {
        ...base,
        correlation_id: correlationBase,
        message: genesysMessage.structuredMessage,
      },
    ];
  }

  if (genesysMessage.carouselCards.length > 0) {
    const requests = [];

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
    return [
      {
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
      },
    ];
  }

  return [
    {
      ...base,
      correlation_id: correlationBase,
      message: {
        text_message: {
          text: genesysMessage.text || "",
        },
      },
    },
  ];
}

/**
 * Flattens a Sinch callback into the internal inbound message shape used by the middleware.
 */
export function parseSinchCallback(payload) {
  if (!payload?.message) {
    return {
      kind: "unsupported",
      raw: payload,
    };
  }

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
