import { Buffer } from "node:buffer";
import { HttpIntegrationError } from "../errors.js";

export class GenesysClient {
  config;
  token = null;
  tokenExpiresAt = 0;

  constructor(config) {
    this.config = config;
  }

  async sendInboundMessage(messagePayload) {
    const query = this.config.prefetchConversationId
      ? "?prefetchConversationId=true"
      : "";

    console.log(
      "GenesysClient => Sending inbound message with payload:",
      JSON.stringify(messagePayload),
    );

    return this.request(
      `/api/v2/conversations/messages/${encodeURIComponent(this.config.integrationId)}/inbound/open/message${query}`,
      {
        method: "POST",
        body: messagePayload,
      },
    );
  }

  async sendInboundReceipt(receiptPayload) {
    return this.request(
      `/api/v2/conversations/messages/${encodeURIComponent(this.config.integrationId)}/inbound/open/receipt`,
      {
        method: "POST",
        body: receiptPayload,
      },
    );
  }

  async request(path, { method = "GET", body } = {}) {
    console.log(
      "Step 4 : GenesysClient.request - Making API request to Genesys Cloud with path:",
      path,
    );
    console.log("Step 4 : GenesysClient.request - Request method:", method);
    console.log(
      "Step 4 : GenesysClient.request - Request body:",
      JSON.stringify(body),
    );

    const token = await this.getAccessToken();
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new HttpIntegrationError("Genesys Cloud request failed.", {
        status: response.status,
        body: responseBody,
      });
    }

    console.log(
      "GenesysClient => Response status:",
      JSON.stringify(response.status),
    );
    console.log(
      "GenesysClient => Response body:",
      JSON.stringify(responseBody),
    );

    return responseBody;
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) {
      return this.token;
    }

    const basicAuth = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
    const response = await fetch(`${this.config.loginBaseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new HttpIntegrationError("Genesys OAuth token request failed.", {
        status: response.status,
        body: responseBody,
      });
    }

    if (!responseBody?.access_token) {
      throw new HttpIntegrationError(
        "Genesys OAuth response does not contain access_token.",
        {
          status: response.status,
          body: responseBody,
        },
      );
    }

    const expiresInSeconds = Number(responseBody.expires_in || 3600);
    this.token = responseBody.access_token;
    this.tokenExpiresAt = now + Math.max(0, expiresInSeconds - 60) * 1000;
    return this.token;
  }

  async readResponseBody(response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}
