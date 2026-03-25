import crypto from "node:crypto";
import express from "express";
import { loadConfig } from "./config.js";
import { HttpIntegrationError } from "../errors.js";
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

function normalizeGenesysMessageId(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  return value.replace(/:(text|media)$/i, "");
}

async function dispatchGenesysOutboundMessage(outbound) {
  const requests = buildSinchRequestsFromGenesysMessage({
    appId: config.sinch.appId,
    genesysMessage: outbound,
  });

  const results = [];
  for (const request of requests) {
    results.push(await sinchClient.sendMessage(request));
  }

  return {
    dispatchedMessages: results,
  };
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
    "Step 1 : /webhooks/sinch - Received from Sinch following payload => ",
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

  // format the callback data in a way that is easier to work with for the rest of the app and to abstract away any Sinch-specific details
  let nestedPayload;
  try {
    console.log("Step 2 : /webhooks/sinch - Parsing Sinch callback payload");
    nestedPayload = parseSinchCallback(req.body);
  } catch (error) {
    logError(requestId, "Failed to parse Sinch callback.", error);
    return res.status(400).json({
      requestId,
      error: "BadRequest",
      details: "Invalid Sinch callback payload.",
    });
  }

  try {
    if (nestedPayload.kind === "message_inbound") {
      if (!nestedPayload.externalUserId) {
        return res.status(400).json({
          requestId,
          error: "BadRequest",
          details: "Sinch callback does not contain an RCS identity.",
        });
      }

      // if the message is valid and contains all the necessary information, map it to the Genesys Cloud format and send it to Genesys Cloud as an inbound message
      console.log(
        "Step 3 : sendInboundToGenesys - Push to Genesys Cloud with payload",
      );

      await sendInboundToGenesys(nestedPayload);

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

  const payloadType = String(req.body?.type || "").toLowerCase();
  const payloadDirection = String(req.body?.direction || "").toLowerCase();

  if (payloadType === "receipt") {
    return res.status(200).json({
      requestId,
      status: "ignored_receipt",
    });
  }

  if (payloadDirection && payloadDirection !== "outbound") {
    return res.status(200).json({
      requestId,
      status: "ignored_non_outbound",
    });
  }

  const outbound = parseGenesysOutboundMessage(req.body);
  if (!outbound) {
    return res.status(200).json({
      requestId,
      status: "ignored",
    });
  }

  if (!outbound.text && outbound.quickReplies.length === 0) {
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
      genesysOutboundDedupeTtlSeconds: config.genesys.outboundDedupeTtlSeconds,
    });
  });
}

if (process.argv.includes("--check-config")) {
  console.log("Configuration OK");
} else {
  start();
}
