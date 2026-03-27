import dotenv from "dotenv";

dotenv.config();

/**
 * Parses an environment variable into a boolean value.
 */
function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

/**
 * Parses a positive number and falls back to a default when the value is invalid.
 */
function parsePositiveNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Removes trailing slashes from a base URL.
 */
function normalizeUrl(url) {
  return url ? url.replace(/\/+$/, "") : "";
}

/**
 * Derives the Genesys login and API base URLs from the cloud domain.
 */
function deriveGenesysBaseUrls(domain) {
  if (!domain) {
    return null;
  }

  const cleaned = String(domain)
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (!cleaned) {
    return null;
  }

  return {
    loginBaseUrl: `https://login.${cleaned}`,
    apiBaseUrl: `https://api.${cleaned}`,
  };
}

/**
 * Derives the Sinch Conversation API base URL from the configured region.
 */
function deriveSinchBaseUrl(region) {
  if (!region) {
    return "";
  }

  const cleaned = String(region).trim().toLowerCase();
  if (!cleaned) {
    return "";
  }

  return `https://${cleaned}.conversation.api.sinch.com`;
}

/**
 * Reads a required environment variable and throws when it is missing.
 */
function getRequired(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return String(value).trim();
}

/**
 * Loads and validates the full runtime configuration used by the service.
 */
export function loadConfig() {
  const derivedGenesys = deriveGenesysBaseUrls(
    process.env.GENESYS_CLOUD_DOMAIN,
  );
  const genesysLoginBaseUrl = normalizeUrl(
    process.env.GENESYS_CLOUD_LOGIN_BASE_URL || derivedGenesys?.loginBaseUrl,
  );
  const genesysApiBaseUrl = normalizeUrl(
    process.env.GENESYS_CLOUD_API_BASE_URL || derivedGenesys?.apiBaseUrl,
  );
  const sinchBaseUrl = normalizeUrl(
    process.env.SINCH_CONVERSATION_BASE_URL ||
      deriveSinchBaseUrl(process.env.SINCH_REGION),
  );

  const config = {
    port: Number(process.env.PORT || 3000),
    serviceName: "genesys-sinch-rcs-middleware",
    genesys: {
      loginBaseUrl: genesysLoginBaseUrl,
      apiBaseUrl: genesysApiBaseUrl,
      clientId: getRequired("GENESYS_CLOUD_CLIENT_ID"),
      clientSecret: getRequired("GENESYS_CLOUD_CLIENT_SECRET"),
      integrationId: getRequired("GENESYS_OPEN_MESSAGING_INTEGRATION_ID"),
      outboundWebhookSecret: getRequired("GENESYS_OUTBOUND_WEBHOOK_SECRET"),
      prefetchConversationId: parseBoolean(
        process.env.GENESYS_PREFETCH_CONVERSATION_ID,
        false,
      ),
      maxMessageBytes: Number(process.env.GENESYS_MAX_MESSAGE_BYTES || 131072),
      includeAttachmentContent: parseBoolean(
        process.env.GENESYS_INCLUDE_ATTACHMENT_CONTENT,
        true,
      ),
      outboundDedupeTtlSeconds: parsePositiveNumber(
        process.env.GENESYS_OUTBOUND_DEDUPE_TTL_SECONDS,
        600,
      ),
    },
    sinch: {
      authBaseUrl: normalizeUrl(
        process.env.SINCH_AUTH_BASE_URL || "https://auth.sinch.com",
      ),
      conversationBaseUrl: sinchBaseUrl,
      projectId: getRequired("SINCH_PROJECT_ID"),
      appId: getRequired("SINCH_APP_ID"),
      keyId: getRequired("SINCH_KEY_ID"),
      keySecret: getRequired("SINCH_KEY_SECRET"),
      webhookSecret: getRequired("SINCH_WEBHOOK_SECRET"),
      signatureMaxSkewSeconds: Number(
        process.env.SINCH_SIGNATURE_MAX_SKEW_SECONDS || 300,
      ),
      requestMirrorUrl:
        normalizeUrl(process.env.SINCH_REQUEST_MIRROR_URL) || null,
      forceChannel: "RCS",
    },
    storage: {
      maxMessagesPerConversation: Number(
        process.env.MAX_MESSAGES_PER_CONVERSATION || 100,
      ),
    },
    security: {
      trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
    },
  };

  if (!config.genesys.loginBaseUrl) {
    throw new Error(
      "Missing Genesys login URL. Set GENESYS_CLOUD_DOMAIN or GENESYS_CLOUD_LOGIN_BASE_URL.",
    );
  }

  if (!config.genesys.apiBaseUrl) {
    throw new Error(
      "Missing Genesys API URL. Set GENESYS_CLOUD_DOMAIN or GENESYS_CLOUD_API_BASE_URL.",
    );
  }

  if (!config.sinch.conversationBaseUrl) {
    throw new Error(
      "Missing Sinch Conversation API URL. Set SINCH_REGION or SINCH_CONVERSATION_BASE_URL.",
    );
  }

  return config;
}
