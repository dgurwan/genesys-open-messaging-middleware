/**
 * Carries HTTP status and response details for downstream integration failures.
 */
export class HttpIntegrationError extends Error {
  /**
   * Builds a typed error that keeps the HTTP response context.
   */
  constructor(message, { status = 500, body = null } = {}) {
    super(message);
    this.name = "HttpIntegrationError";
    this.status = status;
    this.body = body;
  }
}
