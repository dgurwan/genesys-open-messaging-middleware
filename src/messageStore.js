export class MessageStore {
  config;
  processed = new Map();
  conversationByExternalUser = new Map();
  messagesByExternalUser = new Map();
  sseClientsByExternalUser = new Map();

  constructor(config) {
    this.config = config;
  }

  rememberProcessed(key, ttlMs = 24 * 60 * 60 * 1000) {
    const expiresAt = Date.now() + ttlMs;
    this.processed.set(key, expiresAt);
    this.pruneProcessed();
  }

  hasProcessed(key) {
    this.pruneProcessed();
    const expiresAt = this.processed.get(key);
    return Boolean(expiresAt && expiresAt > Date.now());
  }

  upsertConversation(externalUserId, details = {}) {
    const now = new Date().toISOString();
    const current = this.conversationByExternalUser.get(externalUserId) || {
      externalUserId,
      createdAt: now,
    };

    const merged = {
      ...current,
      ...details,
      externalUserId,
      updatedAt: now,
    };

    this.conversationByExternalUser.set(externalUserId, merged);
    return merged;
  }

  getConversation(externalUserId) {
    return this.conversationByExternalUser.get(externalUserId) || null;
  }

  listConversations() {
    return Array.from(this.conversationByExternalUser.values()).sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    );
  }

  addMessage(externalUserId, message) {
    const current = this.messagesByExternalUser.get(externalUserId) || [];
    current.push(message);

    if (current.length > this.config.maxMessagesPerConversation) {
      current.splice(
        0,
        current.length - this.config.maxMessagesPerConversation,
      );
    }

    this.messagesByExternalUser.set(externalUserId, current);
    this.publishEvent(externalUserId, message);
    return message;
  }

  getMessages(externalUserId) {
    return this.messagesByExternalUser.get(externalUserId) || [];
  }

  createSseClient(externalUserId, res) {
    const set = this.sseClientsByExternalUser.get(externalUserId) || new Set();
    set.add(res);
    this.sseClientsByExternalUser.set(externalUserId, set);
  }

  removeSseClient(externalUserId, res) {
    const set = this.sseClientsByExternalUser.get(externalUserId);
    if (!set) {
      return;
    }

    set.delete(res);
    if (set.size === 0) {
      this.sseClientsByExternalUser.delete(externalUserId);
    }
  }

  publishEvent(externalUserId, payload) {
    const set = this.sseClientsByExternalUser.get(externalUserId);
    if (!set || set.size === 0) {
      return;
    }

    const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        set.delete(res);
      }
    }
  }

  pruneProcessed() {
    const now = Date.now();
    for (const [key, expiresAt] of this.processed.entries()) {
      if (expiresAt <= now) {
        this.processed.delete(key);
      }
    }
  }
}
