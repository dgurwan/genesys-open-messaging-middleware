import { Buffer } from "node:buffer";
import { HttpIntegrationError } from "../errors.js";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function replaceEmbeddedStructuredTextMessage(message) {
  if (!isPlainObject(message)) {
    return null;
  }

  const normalizedMessage = normalizeConversationPayload(message);
  const embeddedStructuredMessage = extractStructuredMessageCandidate(
    normalizedMessage?.text_message?.text,
  );

  if (!embeddedStructuredMessage) {
    return normalizedMessage;
  }

  const nextMessage = { ...normalizedMessage };
  delete nextMessage.text_message;

  return {
    ...nextMessage,
    ...embeddedStructuredMessage,
  };
}

function normalizeOutgoingPayload(payload, { defaultAppId } = {}) {
  let candidate = payload;

  if (typeof candidate === "string") {
    const parsed = parseJsonString(candidate);
    if (!parsed) {
      return payload;
    }

    candidate = parsed;
  }

  if (!isPlainObject(candidate)) {
    return payload;
  }

  const normalizedPayload = normalizeConversationPayload(candidate);
  const normalizedMessage = replaceEmbeddedStructuredTextMessage(
    normalizedPayload.message,
  );

  const nextPayload = {
    ...normalizedPayload,
    message: normalizedMessage || normalizedPayload.message,
  };

  if (defaultAppId && !asNonEmptyString(nextPayload.app_id)) {
    nextPayload.app_id = defaultAppId;
  }

  return nextPayload;
}

export class SinchClient {
  config;
  token = null;
  tokenExpiresAt = 0;

  constructor(config) {
    this.config = config;
  }

  async sendMessage(messagePayload) {
    const normalizedPayload = normalizeOutgoingPayload(messagePayload, {
      defaultAppId: this.config.appId,
    });

    console.log(
      "SinchClient => Sending message with payload:",
      JSON.stringify(normalizedPayload),
    );

    return this.request(
      `/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`,
      {
        method: "POST",
        body: normalizedPayload,
      },
    );
  }

  serializeRequestBody(body) {
    if (body === undefined || body === null) {
      return undefined;
    }

    return typeof body === "string" ? body : JSON.stringify(body);
  }

  async request(path, { method = "GET", body } = {}) {
    console.log(
      "SinchClient => mirror enabled ? ",
      this.config.requestMirrorUrl ? "Yes" : "No",
    );

    if (this.config.requestMirrorUrl) {
      console.log(
        "SinchClient => Mirroring request to:",
        this.config.requestMirrorUrl,
        "Method:",
        method,
        "Body:",
        JSON.stringify(body),
      );
      await this.mirrorRequest({ method, body });
    }

    const serializedBody = this.serializeRequestBody(body);
    const token = await this.getAccessToken();
    const response = await fetch(`${this.config.conversationBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: serializedBody,
    });

    const responseBody = await this.readResponseBody(response);

    console.log(
      "SinchClient => Response status:",
      JSON.stringify(response.status),
    );
    console.log("SinchClient => Response body:", JSON.stringify(responseBody));

    if (!response.ok) {
      throw new HttpIntegrationError("Sinch Conversation API request failed.", {
        status: response.status,
        body: responseBody,
      });
    }

    return responseBody;
  }

  async mirrorRequest({ method, body }) {
    try {
      const mirrorResponse = await fetch(this.config.requestMirrorUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: this.serializeRequestBody(body),
      });

      const mirrorResponseBody = await this.readResponseBody(mirrorResponse);
      console.log(
        "SinchClient => Mirror response status:",
        JSON.stringify(mirrorResponse.status),
      );
      console.log(
        "SinchClient => Mirror response body:",
        JSON.stringify(mirrorResponseBody),
      );
    } catch (error) {
      console.warn(
        "SinchClient => Mirror request failed:",
        JSON.stringify({ message: error?.message }),
      );
    }
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) {
      return this.token;
    }

    const basicAuth = Buffer.from(
      `${this.config.keyId}:${this.config.keySecret}`,
    ).toString("base64");
    const response = await fetch(`${this.config.authBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new HttpIntegrationError("Sinch OAuth token request failed.", {
        status: response.status,
        body: responseBody,
      });
    }

    if (!responseBody?.access_token) {
      throw new HttpIntegrationError(
        "Sinch OAuth response does not contain access_token.",
        {
          status: response.status,
          body: responseBody,
        },
      );
    }

    const expiresInSeconds = Number(responseBody.expires_in || 3600);
    this.token = responseBody.access_token;
    this.tokenExpiresAt = now + Math.max(0, expiresInSeconds - 60) * 1000;
    return this.token;
  }

  async readResponseBody(response) {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}
