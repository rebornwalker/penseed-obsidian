import { App, requestUrl } from "obsidian";

const REFRESH_TOKEN_KEY = "penseed-refresh-token";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  status?: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: number;
  email?: string;
}

interface JwtPayload {
  sub?: string;
  exp?: number;
  [key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload {
  try {
    const base64 = token.split(".")[1];
    return JSON.parse(atob(base64)) as JwtPayload;
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Handles the device-authorization sign-in flow and silent token renewal.
 * Only the long-lived refresh token is persisted (in Obsidian SecretStorage);
 * the short-lived access token is cached in memory and renewed on demand.
 */
export class PenseedAuthManager {
  private cachedAccessToken: string | null = null;
  private cachedAccessExp: number | null = null;

  constructor(private app: App, private apiUrl: string) {}

  isConnected(): boolean {
    return !!this.app.secretStorage.getSecret(REFRESH_TOKEN_KEY);
  }

  getEmail(): string | null {
    const refreshToken = this.app.secretStorage.getSecret(REFRESH_TOKEN_KEY);
    if (!refreshToken) return null;
    return decodeJwtPayload(refreshToken).sub ?? null;
  }

  async connect(): Promise<string> {
    const codeResp = await this.requestDeviceCode();
    window.open(codeResp.verification_uri, "_blank");

    const deadline = Date.now() + codeResp.expires_in * 1000;
    const intervalMs = Math.max(codeResp.interval, 2) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const tokenResp = await this.requestDeviceToken(codeResp.device_code);

      if (tokenResp.access_token && tokenResp.refresh_token) {
        this.app.secretStorage.setSecret(
          REFRESH_TOKEN_KEY,
          tokenResp.refresh_token
        );
        this.cachedAccessToken = tokenResp.access_token;
        this.cachedAccessExp =
          decodeJwtPayload(tokenResp.access_token).exp ?? null;
        return tokenResp.email ?? this.getEmail() ?? "";
      }
    }

    throw new Error("Sign-in timed out. Please try again.");
  }

  async disconnect(): Promise<void> {
    // SecretStorage has no remove API in this Obsidian version; clearing the
    // value to an empty string is treated as "not connected" by isConnected().
    this.app.secretStorage.setSecret(REFRESH_TOKEN_KEY, "");
    this.cachedAccessToken = null;
    this.cachedAccessExp = null;
  }

  async getAccessToken(): Promise<string | null> {
    if (this.cachedAccessToken && this.cachedAccessExp) {
      const now = Math.floor(Date.now() / 1000);
      if (this.cachedAccessExp - now > 60) {
        return this.cachedAccessToken;
      }
    }

    const refreshToken = this.app.secretStorage.getSecret(REFRESH_TOKEN_KEY);
    if (!refreshToken) return null;

    const accessToken = await this.requestRefresh(refreshToken);
    if (accessToken) {
      this.cachedAccessToken = accessToken;
      this.cachedAccessExp = decodeJwtPayload(accessToken).exp ?? null;
      return accessToken;
    }
    return null;
  }

  private baseUrl(): string {
    return this.apiUrl.replace(/\/+$/, "");
  }

  private async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/api/auth/device/code`,
      method: "POST",
      throw: false,
    });
    if (response.status >= 200 && response.status < 300) {
      return response.json as DeviceCodeResponse;
    }
    throw new Error("Unable to start sign-in. Please try again.");
  }

  private async requestDeviceToken(
    deviceCode: string
  ): Promise<DeviceTokenResponse> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/api/auth/device/token`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      contentType: "application/json",
      body: JSON.stringify({ device_code: deviceCode }),
      throw: false,
    });
    if (response.status >= 200 && response.status < 300) {
      return response.json as DeviceTokenResponse;
    }
    throw new Error("Device authorization failed. Please try again.");
  }

  private async requestRefresh(refreshToken: string): Promise<string | null> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/api/auth/refresh`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      contentType: "application/json",
      body: JSON.stringify({ refresh_token: refreshToken }),
      throw: false,
    });
    if (response.status >= 200 && response.status < 300) {
      const data = response.json as { access_token?: string };
      return data.access_token ?? null;
    }
    return null;
  }
}
