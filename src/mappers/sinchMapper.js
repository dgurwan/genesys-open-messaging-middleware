function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstArray(...candidates) {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      return candidate;
    }
  }
  return [];
}

function mapQuickReplyChoice(choice, index) {
  const text =
    asNonEmptyString(choice?.title) ||
    asNonEmptyString(choice?.text) ||
    asNonEmptyString(choice?.label) ||
    `Choice ${index + 1}`;
  const url =
    asNonEmptyString(choice?.url) ||
    asNonEmptyString(choice?.uri) ||
    asNonEmptyString(choice?.link);

  if (url) {
    return {
      url_message: {
        title: text,
        url,
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

function extractQuickReplies(payload) {
  /* structure examples to consider:
  {
    "text_message": {
    "text": "Confirm"
    }
  }*/

  if (Array.isArray(payload?.content)) {
    const nested = [];
    for (const item of payload.content) {
      if (item.quickReply && item.quickReply.text) {
        nested.push(item.quickReply);
        // nested.push({ text_message: { text: item.quickReply.text } });
      }

      /*  const nested = firstArray(
        item?.quickReply,
        item?.quickReplies,
        item?.quick_replies,
        item?.choices,
        item?.buttons,
        item?.actions,
      ); */
    }

    console.log(
      "extractQuickReplies : Extracted quick replies from nested content:",
      JSON.stringify(nested),
    );
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

export function parseGenesysOutboundMessage(payload) {
  if (payload && payload.type == "receipt") {
    return;
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

  const text =
    asNonEmptyString(payload?.text) ||
    asNonEmptyString(payload?.message) ||
    (Array.isArray(payload?.content)
      ? payload.content
          .map((item) => asNonEmptyString(item?.text))
          .filter(Boolean)
          .join("\n") || null
      : null);

  const quickReplies = extractQuickReplies(payload).map(mapQuickReplyChoice);

  const time =
    asNonEmptyString(payload?.channel?.time) ||
    asNonEmptyString(payload?.time) ||
    new Date().toISOString();

  console.log(
    "parseGenesysOutboundMessage : Parsed Genesys outbound message:",
    JSON.stringify({ id, customerId, agentId, text, quickReplies, time }),
  );

  return {
    id,
    customerId,
    agentId,
    text,
    quickReplies,
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
  const customerId = genesysMessage.customerId;
  if (!customerId) {
    throw new Error(
      "Unable to determine end-user RCS identity from Genesys outbound payload.",
    );
  }

  const base = buildRecipient({ appId, customerId });
  const correlationBase = genesysMessage.id || `genesys-${Date.now()}`;
  const requests = [];

  if (genesysMessage.quickReplies.length > 0) {
    requests.push({
      ...base,
      correlation_id: correlationBase,
      message: {
        choice_message: {
          text_message: {
            text: genesysMessage.text || "Please choose an option.",
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
    } else if (contactMessage.media_message?.url) {
      inboundType = "media";
      mediaUrl = contactMessage.media_message.url;
      text = `[media] ${mediaUrl}`;
    } else if (contactMessage.location_message?.coordinates) {
      inboundType = "location";
      const location = contactMessage.location_message;
      text = `Location: ${location.coordinates.latitude}, ${location.coordinates.longitude}${location.title ? ` (${location.title})` : ""}`;
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

  if (payload?.message_delivery_report) {
    const report = payload.message_delivery_report;
    return {
      kind: "message_delivery",
      status: asNonEmptyString(report.status),
      genesysMessageId: asNonEmptyString(payload.correlation_id) || null,
      sinchMessageId: asNonEmptyString(report.message_id),
      externalUserId: asNonEmptyString(report.channel_identity?.identity),
      timestamp:
        asNonEmptyString(payload.event_time) ||
        asNonEmptyString(payload.accepted_time) ||
        new Date().toISOString(),
      metadata: {
        sinchConversationId:
          asNonEmptyString(report.conversation_id) || undefined,
        sinchContactId: asNonEmptyString(report.contact_id) || undefined,
        failureCode: report.reason?.code || undefined,
        failureDescription: report.reason?.description || undefined,
      },
      raw: payload,
    };
  }

  return {
    kind: "unsupported",
    raw: payload,
  };
}
