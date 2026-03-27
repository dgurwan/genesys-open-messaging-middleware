import crypto from "node:crypto";
import express from "express";
import { loadConfig } from "./config.js";
import { HttpIntegrationError } from "./errors.js";
import { verifyGenesysSignature, verifySinchSignature } from "./signatures.js";
import { GenesysClient } from "./clients/genesysClient.js";
import { SinchClient } from "./clients/sinchClient.js";
import { buildGenesysInboundPayload } from "./mappers/genesysMapper.js";
import {
  buildSinchRequestsFromGenesysMessage,
  parseGenesysOutboundMessage,
  parseSinchCallback,
} from "./mappers/sinchMapper.js";
import { InMemoryIdempotencyStore } from "./idempotencyStore.js";

const config = loadConfig();
const genesysClient = new GenesysClient(config.genesys);
const sinchClient = new SinchClient(config.sinch);
const genesysOutboundIdempotency = new InMemoryIdempotencyStore({
  ttlMs: config.genesys.outboundDedupeTtlSeconds * 1000,
});

const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "2mb",
    verify: captureRawBody,
  }),
);

if (config.security.trustProxy) {
  app.set("trust proxy", true);
}

/**
 * Stores the raw body so webhook signatures can be verified later.
 */
function captureRawBody(req, _res, buf) {
  req.rawBody = buf.toString("utf8");
}

/**
 * Returns a stable request identifier for logging and responses.
 */
function createRequestId(req) {
  return req.header("x-request-id") || crypto.randomUUID();
}

/**
 * Writes one structured info log line.
 */
function logInfo(requestId, message, data = {}) {
  console.log(JSON.stringify({ level: "info", requestId, message, ...data }));
}

/**
 * Writes one structured error log line.
 */
function logError(requestId, message, error, extra = {}) {
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      message,
      error: error?.message,
      status: error?.status,
      details: error?.body,
      ...extra,
    }),
  );
}

/**
 * Forwards one inbound Sinch message to Genesys and retries without the attachment body when needed.
 */
async function sendInboundToGenesys(inbound) {
  const primaryPayload = buildGenesysInboundPayload({
    externalUserId: inbound.externalUserId,
    messageId: inbound.messageId,
    timestamp: inbound.timestamp,
    nickname: inbound.nickname,
    text: inbound.text,
    metadata: inbound.metadata,
    mediaUrl: inbound.mediaUrl,
    includeAttachmentContent: config.genesys.includeAttachmentContent,
  });

  try {
    return await genesysClient.sendInboundMessage(primaryPayload);
  } catch (error) {
    if (
      !(error instanceof HttpIntegrationError) ||
      !inbound.mediaUrl ||
      !config.genesys.includeAttachmentContent
    ) {
      throw error;
    }

    const fallbackPayload = buildGenesysInboundPayload({
      externalUserId: inbound.externalUserId,
      messageId: inbound.messageId,
      timestamp: inbound.timestamp,
      nickname: inbound.nickname,
      text: inbound.text || `[media] ${inbound.mediaUrl}`,
      metadata: {
        ...inbound.metadata,
        genesysAttachmentFallback: true,
      },
      mediaUrl: undefined,
      includeAttachmentContent: false,
    });

    return genesysClient.sendInboundMessage(fallbackPayload);
  }
}

/**
 * Removes the suffix used when one Genesys message is split into multiple Sinch sends.
 */
function normalizeGenesysMessageId(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  return value.replace(/:(text|media|carousel)$/i, "");
}

/**
 * Returns true when the normalized outbound payload still contains something to send.
 */
function hasOutboundContent(outbound) {
  return Boolean(
    outbound?.text ||
      outbound?.structuredMessage ||
      outbound?.directRequest ||
      outbound?.quickReplies?.length ||
      outbound?.carouselCards?.length,
  );
}

/**
 * Sends all Sinch requests produced from one normalized Genesys outbound message.
 */
async function dispatchGenesysOutboundMessage(outbound) {
  const requests = buildSinchRequestsFromGenesysMessage({
    appId: config.sinch.appId,
    genesysMessage: outbound,
  });

  const dispatchedMessages = [];
  for (const request of requests) {
    dispatchedMessages.push(await sinchClient.sendMessage(request));
  }

  return {
    dispatchedMessages,
  };
}

/**
 * Handles the health endpoint.
 */
function handleHealthCheck(_req, res) {
  res.json({
    status: "ok",
    service: config.serviceName,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handles inbound Sinch callbacks and forwards supported messages to Genesys.
 */
async function handleSinchWebhook(req, res) {
  console.log(
    "Step 1 : server.webhook.sinch - Received from Sinch following payload => ",
    JSON.stringify(req.body, null, 4),
  );

  const requestId = createRequestId(req);
  const signatureResult = verifySinchSignature({
    rawBody: req.rawBody || "",
    secret: config.sinch.webhookSecret,
    signature: req.header("x-sinch-webhook-signature"),
    nonce: req.header("x-sinch-webhook-signature-nonce"),
    timestamp: req.header("x-sinch-webhook-signature-timestamp"),
    maxSkewSeconds: config.sinch.signatureMaxSkewSeconds,
  });

  if (!signatureResult.ok) {
    return res.status(401).json({
      requestId,
      error: "Unauthorized",
      details: signatureResult.reason,
    });
  }

  let nestedPayload;
  try {
    nestedPayload = parseSinchCallback(req.body);
    console.log(
      "Step 2 : server.webhook.sinch - Parsed Sinch callback payload => ",
      JSON.stringify(nestedPayload, null, 4),
    );
  } catch (error) {
    logError(requestId, "Failed to parse Sinch callback.", error);
    return res.status(400).json({
      requestId,
      error: "BadRequest",
      details: "Invalid Sinch callback payload.",
    });
  }

  try {
    if (nestedPayload.kind !== "message_inbound") {
      return res.status(200).json({
        requestId,
        status: "ignored",
      });
    }

    if (!nestedPayload.externalUserId) {
      return res.status(400).json({
        requestId,
        error: "BadRequest",
        details: "Sinch callback does not contain an RCS identity.",
      });
    }

    await sendInboundToGenesys(nestedPayload);

    return res.status(200).json({
      requestId,
      status: "accepted",
    });
  } catch (error) {
    logError(requestId, "Failed to process Sinch webhook.", error, {
      callbackKind: nestedPayload?.kind,
      callbackMessageId: nestedPayload?.messageId,
    });

    if (error instanceof HttpIntegrationError) {
      return res.status(502).json({
        requestId,
        error: "IntegrationError",
        details: error.body,
        statusCode: error.status,
      });
    }

    return res.status(500).json({
      requestId,
      error: "InternalServerError",
    });
  }
}

/**
 * Handles outbound Genesys webhooks and forwards them to Sinch.
 */
async function handleGenesysOutboundWebhook(req, res) {
  const requestId = createRequestId(req);
  const signatureValid = verifyGenesysSignature({
    rawBody: req.rawBody || "",
    headerValue: req.header("x-hub-signature-256"),
    secret: config.genesys.outboundWebhookSecret,
  });

  console.log(
    "Step4 : server.webhook.genesys.outbound - Received from Genesys from with body:",
    JSON.stringify(req.body, null, 4),
  );

  if (!signatureValid) {
    return res.status(401).json({
      requestId,
      error: "Unauthorized",
      details: "Invalid Genesys webhook signature.",
    });
  }

  const payloadType = String(req.body?.type || "").toLowerCase();
  const payloadDirection = String(req.body?.direction || "").toLowerCase();

  if (payloadType === "receipt") {
    console.log(
      "Step4 : server.webhook.genesys.outbound - Received a receipt event => ignoring.",
      { requestId, payloadType, payloadDirection },
    );
    return res.status(200).json({
      requestId,
      status: "ignored_receipt",
    });
  }

  if (payloadDirection && payloadDirection !== "outbound") {
    console.log(
      "Step4 : server.webhook.genesys.outbound - Received a non-outbound event => ignoring.",
      { requestId, payloadType, payloadDirection },
    );
    return res.status(200).json({
      requestId,
      status: "ignored_non_outbound",
    });
  }

  const outbound = parseGenesysOutboundMessage(req.body, {
    defaultSinchAppId: config.sinch.appId,
  });

  if (!outbound) {
    return res.status(200).json({
      requestId,
      status: "ignored",
    });
  }

  if (!hasOutboundContent(outbound)) {
    return res.status(200).json({
      requestId,
      status: "ignored_empty_message",
    });
  }

  const dedupeKey = normalizeGenesysMessageId(outbound.id);

  try {
    const execution = dedupeKey
      ? await genesysOutboundIdempotency.run(dedupeKey, async () =>
          dispatchGenesysOutboundMessage(outbound),
        )
      : {
          key: null,
          duplicate: false,
          state: "not_tracked",
          value: await dispatchGenesysOutboundMessage(outbound),
        };

    return res.status(200).json({
      requestId,
      status: execution.duplicate ? "duplicate_ignored" : "accepted",
      dedupeKey: execution.key || undefined,
      dedupeState: execution.duplicate ? execution.state : undefined,
      dispatchedMessages: execution.value.dispatchedMessages,
    });
  } catch (error) {
    logError(requestId, "Failed to process Genesys outbound webhook.", error, {
      dedupeKey,
      outboundMessageId: outbound.id,
    });

    if (error instanceof HttpIntegrationError) {
      return res.status(502).json({
        requestId,
        error: "IntegrationError",
        statusCode: error.status,
        details: error.body,
      });
    }

    return res.status(500).json({
      requestId,
      error: "InternalServerError",
    });
  }
}

/**
 * Handles unexpected Express errors that happen outside the route try/catch blocks.
 */
function handleUnhandledExpressError(err, req, res, _next) {
  const requestId = createRequestId(req);
  logError(requestId, "Unhandled Express error.", err);
  res.status(500).json({ requestId, error: "InternalServerError" });
}

/**
 * Starts the HTTP server.
 */
function start() {
  app.listen(config.port, () => {
    logInfo("startup", `${config.serviceName} listening`, {
      port: config.port,
      genesysOutboundDedupeTtlSeconds: config.genesys.outboundDedupeTtlSeconds,
    });
  });
}

app.get("/health", handleHealthCheck);
app.post("/webhooks/sinch", handleSinchWebhook);
app.post("/webhooks/genesys/outbound", handleGenesysOutboundWebhook);
app.use(handleUnhandledExpressError);

if (process.argv.includes("--check-config")) {
  console.log("Configuration OK");
} else {
  start();
}
