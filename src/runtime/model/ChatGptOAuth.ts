import { timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

import {
  chatGptPlanBaseUrl,
  type ChatGptAuthErrorCode,
} from "../../protocol/chatGptAuth.ts";
import { isRecord } from "./ProviderValues.ts";

const issuer = "https://auth.openai.com";
const tokenEndpoint = issuer + "/api/accounts/oauth/token";
const discoveryEndpoint = issuer + "/.well-known/openid-configuration";
const jwksEndpoint = issuer + "/.well-known/jwks.json";
const modelsEndpoint = chatGptPlanBaseUrl + "/models";
const planScope = "chatgpt.tokens.use.direct";
const maxResponseBytes = 1024 * 1024;
const requestTimeoutMs = 10_000;

export const chatGptResource = chatGptPlanBaseUrl;
export const chatGptAuthorize = issuer + "/api/accounts/authorize";
export const chatGptDynamicClient = "dynamic_agent_client";
export const chatGptScopes =
  "openid profile email offline_access resource.invoke " + planScope;

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  scopes: string[];
  expiresAt: number;
  earliestRefreshAt?: number;
}

const terminalRefreshErrors = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export class ChatGptAuthError extends Error {
  readonly code: ChatGptAuthErrorCode;

  constructor(code: ChatGptAuthErrorCode) {
    super(`ChatGPT authorization: ${code}`);
    this.name = "ChatGptAuthError";
    this.code = code;
  }
}

export class ChatGptCodeGrantRejected extends ChatGptAuthError {
  constructor() {
    super("authorization_failed");
    this.name = "ChatGptCodeGrantRejected";
  }
}

export class ChatGptOAuth {
  readonly #fetch: typeof fetch;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(fetchImplementation: typeof fetch) {
    this.#fetch = fetchImplementation;
    this.#jwks = createRemoteJWKSet(new URL(jwksEndpoint), {
      cooldownDuration: 5_000,
      [customFetch]: (url, options) =>
        this.#fetch(url, { ...options, redirect: "error" }),
    });
  }

  async exchangeCode(input: {
    code: string;
    clientId: string;
    verifier: string;
    redirectUri: string;
    nonce: string;
  }): Promise<{ subject: string; email?: string; tokens: ChatGptTokens }> {
    const tokens = await this.#exchange({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    });
    if (tokens.idToken === undefined)
      throw new ChatGptAuthError("invalid_response");
    const identity = await this.#verifyIdentity(
      tokens.idToken,
      input.clientId,
      input.nonce,
    );
    return { ...identity, tokens };
  }

  async refresh(
    clientId: string,
    subject: string,
    current: ChatGptTokens,
  ): Promise<ChatGptTokens> {
    if (current.refreshToken === undefined)
      throw new ChatGptAuthError("reauthorization_required");
    const updated = await this.#exchange({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: current.refreshToken,
    });
    if (updated.refreshToken === undefined)
      throw new ChatGptAuthError("invalid_response");
    if (updated.idToken !== undefined) {
      const verified = await this.#verifyIdentity(updated.idToken, clientId);
      if (verified.subject !== subject)
        throw new ChatGptAuthError("invalid_response");
    } else if (current.idToken !== undefined) {
      updated.idToken = current.idToken;
    }
    return updated;
  }

  async revoke(clientId: string, refreshToken: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const discovery = await this.#request(discoveryEndpoint);
        if (discovery.status >= 500) {
          await discard(discovery);
          throw new ChatGptAuthError("service_unavailable");
        }
        if (!discovery.ok) {
          await discard(discovery);
          return false;
        }
        const metadata = await readObject(discovery);
        const revocationEndpoint = checkedRevocationEndpoint(metadata);
        if (revocationEndpoint === undefined) return false;
        const response = await this.#request(revocationEndpoint, {
          method: "POST",
          body: new URLSearchParams({
            token: refreshToken,
            token_type_hint: "refresh_token",
            client_id: clientId,
          }),
        });
        await discard(response);
        if (response.status < 500) return response.status === 200;
      } catch {
        // Clear the local session even when the upstream cannot confirm it.
      }
      if (attempt === 0) await delay(250);
    }
    return false;
  }

  async listModels(
    accessToken: string,
  ): Promise<{ id: string; displayName: string }[]> {
    const response = await this.#request(modelsEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const body = await readObject(response).catch(() => undefined);
      const error = body?.error;
      const challenge = response.headers.get("www-authenticate");
      if (
        response.status === 401 &&
        ((isRecord(error) &&
          (error.code === "invalid_token" || error.code === "token_revoked")) ||
          (challenge !== null &&
            /\bBearer\b[^,]*\berror\s*=\s*"?invalid_token"?\b/iu.test(
              challenge,
            )))
      )
        throw new ChatGptAuthError("reauthorization_required");
      throw new ChatGptAuthError("catalog_unavailable");
    }
    const catalog = await readObject(response);
    if (!Array.isArray(catalog.models))
      throw new ChatGptAuthError("invalid_response");
    const models: { id: string; displayName: string }[] = [];
    const seen = new Set<string>();
    for (const model of catalog.models) {
      if (
        !isRecord(model) ||
        model.visibility !== "list" ||
        !safeIdentityText(model.slug, 512) ||
        !safeIdentityText(model.display_name, 512) ||
        seen.has(model.slug)
      )
        continue;
      seen.add(model.slug);
      models.push({ id: model.slug, displayName: model.display_name });
    }
    return models;
  }

  async #exchange(form: Record<string, string>): Promise<ChatGptTokens> {
    const response = await this.#request(tokenEndpoint, {
      method: "POST",
      body: new URLSearchParams({ ...form, resource: chatGptResource }),
    });
    const payload = await readObject(response).catch(() => undefined);
    if (!response.ok) {
      if (
        form.grant_type === "authorization_code" &&
        payload?.error === "invalid_grant"
      )
        throw new ChatGptCodeGrantRejected();
      if (
        form.grant_type === "refresh_token" &&
        typeof payload?.error === "string" &&
        terminalRefreshErrors.has(payload.error)
      )
        throw new ChatGptAuthError("reauthorization_required");
      throw new ChatGptAuthError(
        response.status >= 500 || response.status === 429
          ? "service_unavailable"
          : "authorization_failed",
      );
    }
    return parseTokenResponse(payload);
  }

  async #verifyIdentity(
    token: string,
    clientId: string,
    nonce?: string,
  ): Promise<{ subject: string; email?: string }> {
    try {
      const { payload } = await jwtVerify(token, this.#jwks, {
        issuer,
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "iat", "exp"],
        clockTolerance: 5,
      });
      if (
        !safeIdentityText(payload.sub, 512) ||
        typeof payload.iat !== "number" ||
        payload.iat > Date.now() / 1000 + 5 ||
        (nonce !== undefined && !matchesSecret(payload.nonce, nonce)) ||
        ((payload.azp !== undefined ||
          (Array.isArray(payload.aud) && payload.aud.length > 1)) &&
          payload.azp !== clientId)
      )
        throw new ChatGptAuthError("invalid_response");
      const email =
        payload.email_verified === true && safeIdentityText(payload.email, 320)
          ? payload.email
          : undefined;
      return {
        subject: payload.sub,
        ...(email === undefined ? {} : { email }),
      };
    } catch {
      throw new ChatGptAuthError("invalid_response");
    }
  }

  async #request(url: string, input: RequestInit = {}): Promise<Response> {
    try {
      return await this.#fetch(url, {
        ...input,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new ChatGptAuthError("service_unavailable");
    }
  }
}

function checkedRevocationEndpoint(
  metadata: Record<string, unknown>,
): string | undefined {
  if (
    metadata.issuer !== issuer ||
    typeof metadata.revocation_endpoint !== "string"
  )
    return;
  try {
    const endpoint = new URL(metadata.revocation_endpoint);
    if (
      endpoint.origin === issuer &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === ""
    )
      return endpoint.href;
  } catch {
    return;
  }
}

function parseTokenResponse(value: unknown): ChatGptTokens {
  if (
    !isRecord(value) ||
    !isToken(value.access_token) ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 86_400 ||
    typeof value.scope !== "string" ||
    value.scope.length > 4096 ||
    (value.refresh_token !== undefined && !isToken(value.refresh_token)) ||
    (value.id_token !== undefined && !isToken(value.id_token))
  )
    throw new ChatGptAuthError("invalid_response");
  const earliest = value.earliest_refresh_at;
  return {
    accessToken: value.access_token,
    ...(value.refresh_token === undefined
      ? {}
      : { refreshToken: value.refresh_token }),
    ...(value.id_token === undefined ? {} : { idToken: value.id_token }),
    scopes: value.scope.trim().split(/\s+/u).filter(Boolean),
    expiresAt: Date.now() + value.expires_in * 1000,
    ...(typeof earliest === "number" &&
    Number.isSafeInteger(earliest) &&
    earliest > 0 &&
    earliest < 10_000_000_000
      ? { earliestRefreshAt: earliest * 1000 }
      : {}),
  };
}

async function readObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ChatGptAuthError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array))
        throw new ChatGptAuthError("invalid_response");
      size += bytes.byteLength;
      if (size > maxResponseBytes)
        throw new ChatGptAuthError("invalid_response");
      chunks.push(bytes);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(value)) throw new ChatGptAuthError("invalid_response");
    return value;
  } catch {
    void reader.cancel().catch(() => undefined);
    throw new ChatGptAuthError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function hasChatGptPlanGrant(tokens: ChatGptTokens): boolean {
  return tokens.scopes.includes(planScope);
}

export function isIssuedClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== chatGptDynamicClient &&
    /^[A-Za-z0-9._-]{1,256}$/u.test(value)
  );
}

export function safeIdentityText(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

export function isToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32_768 &&
    /^[!-~]+$/u.test(value)
  );
}

export function matchesSecret(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const bytes = Buffer.from(value);
  const target = Buffer.from(expected);
  return bytes.length === target.length && timingSafeEqual(bytes, target);
}
