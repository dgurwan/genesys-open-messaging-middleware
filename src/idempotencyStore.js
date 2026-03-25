export class InMemoryIdempotencyStore {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 10 * 60 * 1000;
    this.entries = new Map();
  }

  cleanup(now = Date.now()) {
    for (const [key, entry] of this.entries.entries()) {
      if (!entry?.expiresAt || entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  async run(key, factory) {
    if (!key) {
      const value = await factory();
      return {
        key: null,
        duplicate: false,
        state: "not_tracked",
        value,
      };
    }

    this.cleanup();

    const existing = this.entries.get(key);
    if (existing?.state === "completed") {
      return {
        key,
        duplicate: true,
        state: "completed",
        value: existing.value,
      };
    }

    if (existing?.state === "inflight") {
      try {
        const value = await existing.promise;
        return {
          key,
          duplicate: true,
          state: "inflight",
          value,
        };
      } catch (error) {
        this.entries.delete(key);
        throw error;
      }
    }

    const promise = Promise.resolve().then(factory);
    this.entries.set(key, {
      state: "inflight",
      promise,
      expiresAt: Date.now() + this.ttlMs,
    });

    try {
      const value = await promise;
      this.entries.set(key, {
        state: "completed",
        value,
        expiresAt: Date.now() + this.ttlMs,
      });

      return {
        key,
        duplicate: false,
        state: "created",
        value,
      };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }
}
