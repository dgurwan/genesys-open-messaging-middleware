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
      "Extracted quick replies from nested content:",
      JSON.stringify(nested),
    );
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function extractCards(payload) {
  const cards = firstArray(
    payload?.cards,
    payload?.carousel,
    payload?.template?.cards,
    payload?.content?.filter?.(
      (item) =>
        item?.title || item?.description || item?.mediaUrl || item?.imageUrl,
    ) || [],
  );

  return cards
    .map((card) => ({
      title: asNonEmptyString(card?.title) || "",
      description:
        asNonEmptyString(card?.description) ||
        asNonEmptyString(card?.subtitle) ||
        "",
      mediaUrl:
        asNonEmptyString(card?.mediaUrl) ||
        asNonEmptyString(card?.imageUrl) ||
        asNonEmptyString(card?.image?.url),
      quickReplies: firstArray(
        card?.quickReplies,
        card?.buttons,
        card?.choices,
      ),
    }))
    .filter((card) => card.title || card.description || card.mediaUrl);
}

function looksLikeMediaUrl(url) {
  return /(\.jpg|\.jpeg|\.png|\.gif|\.webp|\.pdf|\.mp4|\.mov|\.mp3|\.wav|\.ogg)(\?|#|$)/i.test(
    String(url || ""),
  );
}

function extractAttachments(payload) {
  const attachments = [];

  const arrays = [
    payload?.content,
    payload?.attachments,
    payload?.attachment ? [payload.attachment] : [],
  ];

  for (const array of arrays) {
    if (!Array.isArray(array)) {
      continue;
    }

    for (const item of array) {
      const attachment = item?.attachment || item;
      const url =
        asNonEmptyString(attachment?.url) ||
        asNonEmptyString(attachment?.mediaUrl) ||
        asNonEmptyString(item?.url);
      const declaredAttachment =
        Boolean(item?.attachment) ||
        String(item?.contentType || "").toLowerCase() === "attachment";
      if (!url || (!declaredAttachment && !looksLikeMediaUrl(url))) {
        continue;
      }

      attachments.push({
        url,
        contentType:
          asNonEmptyString(attachment?.contentType) ||
          asNonEmptyString(item?.contentType) ||
          undefined,
        filename: asNonEmptyString(attachment?.filename) || undefined,
      });
    }
  }

  return attachments;
}

export function parseGenesysOutboundMessage(payload) {
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

  console.log("Extracted quick replies:", JSON.stringify(quickReplies));

  const cards = extractCards(payload).map((card) => ({
    title: card.title,
    description: card.description,
    media_message: card.mediaUrl ? { url: card.mediaUrl } : undefined,
    choices: card.quickReplies.map(mapQuickReplyChoice),
  }));
  const attachments = extractAttachments(payload);
  const time =
    asNonEmptyString(payload?.channel?.time) ||
    asNonEmptyString(payload?.time) ||
    new Date().toISOString();

  return {
    id,
    customerId,
    agentId,
    text,
    quickReplies,
    cards,
    attachments,
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

  if (genesysMessage.cards.length > 1) {
    requests.push({
      ...base,
      correlation_id: correlationBase,
      message: {
        carousel_message: {
          cards: genesysMessage.cards.slice(0, 10),
        },
      },
    });
    return requests;
  }

  if (genesysMessage.cards.length === 1) {
    const [card] = genesysMessage.cards;
    requests.push({
      ...base,
      correlation_id: correlationBase,
      message: {
        card_message: {
          title: card.title,
          description: card.description,
          ...(card.media_message ? { media_message: card.media_message } : {}),
          ...(card.choices?.length
            ? { choices: card.choices.slice(0, 4) }
            : {}),
        },
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
            text: genesysMessage.text || "Please choose an option.",
          },
          choices: genesysMessage.quickReplies.slice(0, 13),
        },
      },
    });
    return requests;
  }

  if (genesysMessage.attachments.length > 0 && !genesysMessage.text) {
    const [attachment] = genesysMessage.attachments;
    requests.push({
      ...base,
      correlation_id: correlationBase,
      message: {
        media_message: {
          url: attachment.url,
        },
      },
    });
    return requests;
  }

  if (genesysMessage.attachments.length > 0 && genesysMessage.text) {
    requests.push({
      ...base,
      correlation_id: `${correlationBase}:text`,
      message: {
        text_message: {
          text: genesysMessage.text,
        },
      },
    });

    const [attachment] = genesysMessage.attachments;
    requests.push({
      ...base,
      correlation_id: `${correlationBase}:media`,
      message: {
        media_message: {
          url: attachment.url,
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
