export class HttpIntegrationError extends Error {
  constructor(message, { status = 500, body = null } = {}) {
    super(message);
    this.name = 'HttpIntegrationError';
    this.status = status;
    this.body = body;
  }
}
