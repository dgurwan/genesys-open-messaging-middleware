import { Buffer } from "node:buffer";
import { HttpIntegrationError } from "../errors.js";

export class SinchClient {
  config;
  token = null;
  tokenExpiresAt = 0;

  constructor(config) {
    this.config = config;
  }

  async sendMessage(messagePayload) {
    console.log(
      "SinchClient => Sending message with payload:",
      JSON.stringify(messagePayload),
    );

    return this.request(
      `/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`,
      {
        method: "POST",
        body: messagePayload,
      },
    );
  }

  async request(path, { method = "GET", body } = {}) {
    console.log(
      "SinchClient => mirror enabled ? ",
      this.config.requestMirrorUrl ? "Yes" : "No",
    );

    if (this.config.requestMirrorUrl) {
      console.log(
        "SinchClient => Mirroring request to:",
        this.config.requestMirrorUrl,
        "Method:",
        method,
        "Body:",
        JSON.stringify(body),
      );
      await this.mirrorRequest({ method, body });
    }

    const token = await this.getAccessToken();
    const response = await fetch(`${this.config.conversationBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const responseBody = await this.readResponseBody(response);

    console.log(
      "SinchClient => Response status:",
      JSON.stringify(response.status),
    );
    console.log("SinchClient => Response body:", JSON.stringify(responseBody));

    if (!response.ok) {
      throw new HttpIntegrationError("Sinch Conversation API request failed.", {
        status: response.status,
        body: responseBody,
      });
    }

    return responseBody;
  }

  async mirrorRequest({ method, body }) {
    try {
      const mirrorResponse = await fetch(this.config.requestMirrorUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const mirrorResponseBody = await this.readResponseBody(mirrorResponse);
      console.log(
        "SinchClient => Mirror response status:",
        JSON.stringify(mirrorResponse.status),
      );
      console.log(
        "SinchClient => Mirror response body:",
        JSON.stringify(mirrorResponseBody),
      );
    } catch (error) {
      console.warn(
        "SinchClient => Mirror request failed:",
        JSON.stringify({ message: error?.message }),
      );
    }
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt) {
      return this.token;
    }

    const basicAuth = Buffer.from(
      `${this.config.keyId}:${this.config.keySecret}`,
    ).toString("base64");
    const response = await fetch(`${this.config.authBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    const responseBody = await this.readResponseBody(response);
    if (!response.ok) {
      throw new HttpIntegrationError("Sinch OAuth token request failed.", {
        status: response.status,
        body: responseBody,
      });
    }

    if (!responseBody?.access_token) {
      throw new HttpIntegrationError(
        "Sinch OAuth response does not contain access_token.",
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
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }
}
