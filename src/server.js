import crypto from "node:crypto";
import express from "express";
import { loadConfig } from "./config.js";
import { HttpIntegrationError } from "./errors.js";
import { verifyGenesysSignature, verifySinchSignature } from "./signatures.js";
import {
  buildManualInboundMessage,
  validateIncomingMessage,
} from "./validation.js";
import { GenesysClient } from "./clients/genesysClient.js";
import { SinchClient } from "./clients/sinchClient.js";
import {
  buildGenesysInboundPayload,
  buildGenesysReceiptPayload,
} from "./mappers/genesysMapper.js";
import {
  buildSinchRequestsFromGenesysMessage,
  parseGenesysOutboundMessage,
  parseSinchCallback,
} from "./mappers/sinchMapper.js";

const config = loadConfig();
const genesysClient = new GenesysClient(config.genesys);
const sinchClient = new SinchClient(config.sinch);

const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

if (config.security.trustProxy) {
  app.set("trust proxy", true);
}

function logInfo(requestId, message, data = {}) {
  console.log(JSON.stringify({ level: "info", requestId, message, ...data }));
}

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

function serializeMessage(direction, source, payload) {
  return {
    id: payload.messageId || payload.id || crypto.randomUUID(),
    direction,
    source,
    timestamp: payload.timestamp || new Date().toISOString(),
    text: payload.text || null,
    mediaUrl: payload.mediaUrl || null,
    metadata: payload.metadata || {},
    raw: payload.raw || undefined,
  };
}

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

  console.log(
    "sendInboundToGenesys : Push to Genesys Cloud with payload:",
    JSON.stringify(primaryPayload, null, 2),
  );

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

function buildSinchDedupeKey({ callback, fallbackNonce }) {
  if (callback.kind === "message_delivery") {
    return [
      "sinch",
      "message_delivery",
      callback.sinchMessageId || callback.messageId || "unknown",
      callback.status || "unknown",
      callback.timestamp || "no-timestamp",
    ].join(":");
  }

  return [
    "sinch",
    callback.kind || "unknown",
    callback.messageId ||
      callback.sinchMessageId ||
      fallbackNonce ||
      crypto.randomUUID(),
  ].join(":");
}

function normalizeGenesysMessageId(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  return value.replace(/:(text|media)$/i, "");
}

function mapSinchDeliveryStatusToGenesys(status) {
  if (!status) {
    return "Delivered";
  }

  const normalized = String(status).toUpperCase();

  if (normalized === "FAILED") {
    return "Failed";
  }

  // READ, DELIVERED, SENT, etc. -> Delivered côté Genesys
  return "Delivered";
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: config.serviceName,
    timestamp: new Date().toISOString(),
  });
});

app.post("/webhooks/sinch", async (req, res) => {
  console.log(
    "Received from Sinch at /webhooks/sinch with body:",
    JSON.stringify(req.body, null, 4),
  );

  const requestId = req.header("x-request-id") || crypto.randomUUID();

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

  let callback;
  try {
    callback = parseSinchCallback(req.body);
  } catch (error) {
    logError(requestId, "Failed to parse Sinch callback.", error);
    return res.status(400).json({
      requestId,
      error: "BadRequest",
      details: "Invalid Sinch callback payload.",
    });
  }

  try {
    if (callback.kind === "message_inbound") {
      if (!callback.externalUserId) {
        return res.status(400).json({
          requestId,
          error: "BadRequest",
          details: "Sinch callback does not contain an RCS identity.",
        });
      }

      console.log("Received inbound message from Sinch:", {
        externalUserId: callback.externalUserId,
        messageId: callback.messageId,
        text: callback.text,
        mediaUrl: callback.mediaUrl,
        metadata: callback.metadata,
      });

      await sendInboundToGenesys(callback);

      return res.status(200).json({
        requestId,
        status: "accepted",
      });
    }

    return res.status(200).json({
      requestId,
      status: "ignored",
    });
  } catch (error) {
    logError(requestId, "Failed to process Sinch webhook.", error, {
      callbackKind: callback.kind,
      dedupeKey,
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
});

app.post("/webhooks/genesys/outbound", async (req, res) => {
  const requestId = req.header("x-request-id") || crypto.randomUUID();
  const signatureValid = verifyGenesysSignature({
    rawBody: req.rawBody || "",
    headerValue: req.header("x-hub-signature-256"),
    secret: config.genesys.outboundWebhookSecret,
  });

  console.log(
    "Received from Genesys from /webhooks/genesys/outbound with body:",
    JSON.stringify(req.body, null, 4),
  );

  if (!signatureValid) {
    return res.status(401).json({
      requestId,
      error: "Unauthorized",
      details: "Invalid Genesys webhook signature.",
    });
  }

  const outbound = parseGenesysOutboundMessage(req.body);

  try {
    const requests = buildSinchRequestsFromGenesysMessage({
      appId: config.sinch.appId,
      genesysMessage: outbound,
    });

    const results = [];
    for (const request of requests) {
      results.push(await sinchClient.sendMessage(request));
    }

    return res.status(200).json({
      requestId,
      status: "accepted",
      dispatchedMessages: results,
    });
  } catch (error) {
    logError(requestId, "Failed to process Genesys outbound webhook.", error);
    if (error instanceof HttpIntegrationError) {
      return res.status(502).json({
        requestId,
        error: "IntegrationError",
        statusCode: error.status,
        details: error.body,
      });
    }

    return res.status(500).json({ requestId, error: "InternalServerError" });
  }
});

app.use((err, req, res, _next) => {
  const requestId = req.header("x-request-id") || crypto.randomUUID();
  logError(requestId, "Unhandled Express error.", err);
  res.status(500).json({ requestId, error: "InternalServerError" });
});

function start() {
  app.listen(config.port, () => {
    logInfo("startup", `${config.serviceName} listening`, {
      port: config.port,
    });
  });
}

if (process.argv.includes("--check-config")) {
  console.log("Configuration OK");
} else {
  start();
}
