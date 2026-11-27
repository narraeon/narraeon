import { createHash, randomBytes, randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import openBrowser from "open";

import type {
  ChatGptAccount,
  ChatGptAuthErrorCode,
  ChatGptDisconnectResult,
  ChatGptModel,
  ChatGptSignInResult,
} from "../../protocol/chatGptAuth.ts";
import {
  ChatGptCredentialStore,
  maxChatGptAccounts,
  type ChatGptCredentialDocument,
  type StoredChatGptAccount,
} from "./ChatGptCredentialStore.ts";
import {
  ChatGptAuthError,
  ChatGptCodeGrantRejected,
  ChatGptOAuth,
  chatGptAuthorize,
  chatGptDynamicClient,
  chatGptResource,
  chatGptScopes,
  hasChatGptPlanGrant,
  isIssuedClientId,
  isToken,
  matchesSecret,
} from "./ChatGptOAuth.ts";

export { ChatGptAuthError } from "./ChatGptOAuth.ts";

const loopbackAddress = "127.0.0.1";
const callbackPath = "/auth/callback";
const signInLifetimeMs = 5 * 60_000;
const keepSignInResults = 8;
const renewBeforeExpiryMs = 60_000;

interface PendingSignIn {
  id: string;
  selected?: StoredChatGptAccount;
  retryClientId?: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: URL;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  consuming: boolean;
}

export class ChatGptAuth {
  readonly #store: ChatGptCredentialStore;
  readonly #oauth: ChatGptOAuth;
  readonly #localEnabled: boolean;
  readonly #openBrowser: (url: string) => Promise<unknown>;
  readonly #signInResults = new Map<string, ChatGptSignInResult>();
  readonly #renewals = new Map<string, Promise<StoredChatGptAccount>>();
  #pending: PendingSignIn | undefined;
  #retryRegistration: { clientId: string; expiresAt: number } | undefined;
  #closed = false;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(input: {
    workspaceDirectory: string;
    localEnabled: boolean;
    fetch?: typeof fetch;
    openBrowser?: (url: string) => Promise<unknown>;
  }) {
    this.#store = new ChatGptCredentialStore(input.workspaceDirectory);
    this.#localEnabled = input.localEnabled;
    this.#oauth = new ChatGptOAuth(input.fetch ?? fetch);
    this.#openBrowser = input.openBrowser ?? openBrowser;
  }

  async listAccounts(): Promise<ChatGptAccount[]> {
    this.#assertLocal();
    await this.#mutationTail;
    const document = await this.#store.read();
    return document?.accounts.map(accountView) ?? [];
  }

  async startSignIn(
    input: { accountId?: string; requestPlanConsent?: boolean } = {},
  ): Promise<{ attemptId: string }> {
    this.#assertLocal();
    const start = await this.#mutate(async () => {
      if (this.#pending !== undefined) throw new ChatGptAuthError("busy");
      const document = await this.#prepareDocument();
      const selected =
        input.accountId === undefined
          ? undefined
          : findAccount(document, input.accountId);
      if (
        selected === undefined &&
        document.accounts.length >= maxChatGptAccounts
      )
        throw new ChatGptAuthError("busy");
      if (input.requestPlanConsent && selected === undefined)
        throw new ChatGptAuthError("account_not_found");

      const server = createServer(
        { headersTimeout: 15_000, requestTimeout: 15_000 },
        (request, response) => {
          void this.#handleCallback(server, request, response).catch(() =>
            replyToBrowser(response, 500, "failed"),
          );
        },
      );
      const port = await bindLoopback(server);
      if (this.#closed) {
        server.close();
        throw new ChatGptAuthError("local_only");
      }
      const retry = this.#retryRegistration;
      const retryClientId =
        selected === undefined &&
        retry !== undefined &&
        retry.expiresAt > Date.now()
          ? retry.clientId
          : undefined;
      this.#retryRegistration = undefined;
      const id = randomUUID();
      const attempt: PendingSignIn = {
        id,
        ...(selected === undefined ? {} : { selected }),
        ...(retryClientId === undefined ? {} : { retryClientId }),
        state: randomBytes(32).toString("base64url"),
        nonce: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
        redirectUri: new URL(
          `http://${loopbackAddress}:${port}${callbackPath}`,
        ),
        server,
        timer: setTimeout(
          () => this.#finishAttempt(id, expiredSignIn()),
          signInLifetimeMs,
        ),
        consuming: false,
      };
      attempt.timer.unref();
      server.on("error", () =>
        this.#finishAttempt(id, failedSignIn("service_unavailable")),
      );
      this.#pending = attempt;
      this.#signInResults.set(id, { status: "pending" });
      if (this.#signInResults.size > keepSignInResults) {
        const oldest = this.#signInResults.keys().next().value;
        if (oldest !== undefined) this.#signInResults.delete(oldest);
      }
      return {
        attemptId: id,
        url: authorizationUrl(
          attempt,
          document.hostId,
          input.requestPlanConsent,
        ),
      };
    });
    try {
      await this.#openBrowser(start.url);
    } catch {
      this.#finishAttempt(
        start.attemptId,
        failedSignIn("authorization_failed"),
      );
      throw new ChatGptAuthError("authorization_failed");
    }
    return { attemptId: start.attemptId };
  }

  signInStatus(attemptId: string): ChatGptSignInResult {
    this.#assertLocal();
    const result = this.#signInResults.get(attemptId);
    return result === undefined ? expiredSignIn() : structuredClone(result);
  }

  async refresh(accountId: string): Promise<ChatGptAccount> {
    this.#assertLocal();
    return accountView(await this.#renew(accountId, true));
  }

  async listModels(accountId: string): Promise<ChatGptModel[]> {
    const accessToken = await this.getAccessToken(accountId);
    try {
      return await this.#oauth.listModels(accessToken);
    } catch (error) {
      if (
        error instanceof ChatGptAuthError &&
        error.code === "reauthorization_required"
      )
        await this.invalidateAccessToken(accountId, accessToken);
      throw error;
    }
  }

  async getAccessToken(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.#assertLocal();
    signal?.throwIfAborted();
    return waitUntilAborted(this.#accessToken(accountId, signal), signal);
  }

  disconnect(accountId: string): Promise<ChatGptDisconnectResult> {
    this.#assertLocal();
    return this.#mutate(async () => {
      const document = await this.#store.read();
      const account = findAccount(document, accountId);
      const pending = this.#pending;
      if (pending?.selected?.id === accountId)
        this.#finishAttempt(pending.id, expiredSignIn());
      const refreshToken = account.tokens?.refreshToken;
      const confirmed =
        refreshToken === undefined
          ? account.tokens === undefined &&
            !account.needsReauthorization &&
            !account.revocationUnconfirmed
          : await this.#oauth.revoke(account.clientId, refreshToken);
      delete account.tokens;
      delete account.needsReauthorization;
      if (confirmed) delete account.revocationUnconfirmed;
      else account.revocationUnconfirmed = true;
      if (document !== undefined) await this.#store.write(document);
      return {
        account: accountView(account),
        remoteRevocationConfirmed: confirmed,
      };
    });
  }

  invalidateAccessToken(accountId: string, accessToken: string): Promise<void> {
    this.#assertLocal();
    return this.#mutate(async () => {
      const document = await this.#store.read();
      const account = document?.accounts.find(({ id }) => id === accountId);
      if (
        document === undefined ||
        account?.tokens?.accessToken !== accessToken
      )
        return;
      await this.#markReauthorization(document, account);
    });
  }

  close(): void {
    this.#closed = true;
    const pending = this.#pending;
    if (pending !== undefined) this.#finishAttempt(pending.id, expiredSignIn());
    this.#signInResults.clear();
    this.#retryRegistration = undefined;
  }

  #assertLocal(): void {
    if (!this.#localEnabled || this.#closed)
      throw new ChatGptAuthError("local_only");
  }

  async #prepareDocument(): Promise<ChatGptCredentialDocument> {
    const saved = await this.#store.read();
    if (saved !== undefined) return saved;
    const created: ChatGptCredentialDocument = {
      version: 1,
      hostId: `urn:uuid:${randomUUID()}`,
      accounts: [],
    };
    await this.#store.write(created);
    return created;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(() => {
      this.#assertLocal();
      return operation();
    });
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #accessToken(accountId: string, signal?: AbortSignal): Promise<string> {
    await this.#mutationTail;
    this.#assertLocal();
    signal?.throwIfAborted();
    const document = await this.#store.read();
    signal?.throwIfAborted();
    const account = findAccount(document, accountId);
    const tokens = planTokens(account);
    if (tokens.expiresAt > Date.now() + renewBeforeExpiryMs)
      return tokens.accessToken;
    const updated = planTokens(await this.#renew(accountId, false));
    if (updated.expiresAt <= Date.now())
      throw new ChatGptAuthError("service_unavailable");
    return updated.accessToken;
  }

  #renew(accountId: string, force: boolean): Promise<StoredChatGptAccount> {
    const ongoing = this.#renewals.get(accountId);
    if (ongoing !== undefined) return ongoing;
    const job = this.#mutate(async () => {
      const document = await this.#store.read();
      if (document === undefined)
        throw new ChatGptAuthError("account_not_found");
      const account = findAccount(document, accountId);
      const current = force ? signedInTokens(account) : planTokens(account);
      const now = Date.now();
      if (!force && current.expiresAt > now + renewBeforeExpiryMs)
        return account;
      if (
        current.earliestRefreshAt !== undefined &&
        now < current.earliestRefreshAt
      ) {
        if (current.expiresAt <= now)
          throw new ChatGptAuthError("service_unavailable");
        return account;
      }
      if (current.refreshToken === undefined) {
        if (!force && current.expiresAt > now) return account;
        if (current.expiresAt <= now)
          await this.#markReauthorization(document, account);
        throw new ChatGptAuthError("reauthorization_required");
      }
      try {
        account.tokens = await this.#oauth.refresh(
          account.clientId,
          account.subject,
          current,
        );
      } catch (error) {
        if (
          error instanceof ChatGptAuthError &&
          error.code === "reauthorization_required"
        )
          await this.#markReauthorization(document, account);
        throw error;
      }
      await this.#store.write(document);
      return account;
    }).finally(() => this.#renewals.delete(accountId));
    this.#renewals.set(accountId, job);
    return job;
  }

  async #markReauthorization(
    document: ChatGptCredentialDocument,
    account: StoredChatGptAccount,
  ): Promise<void> {
    delete account.tokens;
    account.needsReauthorization = true;
    await this.#store.write(document);
  }

  async #handleCallback(
    server: Server,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const attempt = this.#pending;
    if (attempt?.server !== server) {
      replyToBrowser(response, 410, "failed");
      return;
    }
    const params = callbackParams(request, attempt.redirectUri);
    if (
      params === undefined ||
      !matchesSecret(params.get("state"), attempt.state)
    ) {
      replyToBrowser(response, 400, "failed");
      return;
    }
    if (attempt.consuming) {
      replyToBrowser(response, 409, "failed");
      return;
    }
    attempt.consuming = true;
    let result: ChatGptSignInResult;
    if (params.has("error")) {
      result =
        params.get("error") === "access_denied"
          ? { status: "denied" }
          : failedSignIn("authorization_failed");
    } else {
      try {
        const account = await this.#completeSignIn(attempt, params);
        result = { status: "completed", account };
      } catch (error) {
        result = failedSignIn(
          error instanceof ChatGptAuthError
            ? error.code
            : "authorization_failed",
        );
      }
    }
    this.#finishAttempt(attempt.id, result);
    replyToBrowser(
      response,
      result.status === "completed" || result.status === "denied" ? 200 : 400,
      result.status === "completed"
        ? "completed"
        : result.status === "denied"
          ? "denied"
          : "failed",
    );
  }

  async #completeSignIn(
    attempt: PendingSignIn,
    params: URLSearchParams,
  ): Promise<ChatGptAccount> {
    const code = params.get("code");
    const selected = attempt.selected;
    const expectedClient = selected?.clientId ?? attempt.retryClientId;
    const returnedClient = params.get("client_id");
    const clientId = expectedClient ?? returnedClient;
    if (
      !isToken(code) ||
      !isIssuedClientId(clientId) ||
      (expectedClient !== undefined &&
        returnedClient !== null &&
        returnedClient !== expectedClient)
    )
      throw new ChatGptAuthError("authorization_failed");

    return this.#mutate(async () => {
      if (this.#pending !== attempt)
        throw new ChatGptAuthError("authorization_expired");
      const document = await this.#prepareDocument();
      const exchanged = await this.#oauth
        .exchangeCode({
          code,
          clientId,
          verifier: attempt.verifier,
          redirectUri: attempt.redirectUri.href,
          nonce: attempt.nonce,
        })
        .catch((error: unknown) => {
          if (
            error instanceof ChatGptCodeGrantRejected &&
            selected === undefined &&
            this.#pending === attempt
          )
            this.#retryRegistration = {
              clientId,
              expiresAt: Date.now() + signInLifetimeMs,
            };
          throw error;
        });
      if (this.#pending !== attempt)
        throw new ChatGptAuthError("authorization_expired");
      const existing = document.accounts.find(
        (account) => account.clientId === clientId,
      );
      if (
        (existing !== undefined && existing.subject !== exchanged.subject) ||
        (selected !== undefined && existing?.id !== selected.id)
      )
        throw new ChatGptAuthError("authorization_failed");
      const email = exchanged.email;
      const account: StoredChatGptAccount = {
        id: existing?.id ?? randomUUID(),
        clientId,
        subject: exchanged.subject,
        ...(email === undefined ? {} : { email }),
        label:
          existing?.label ??
          `${email ?? "ChatGPT"} · ${document.accounts.length + 1}`,
        tokens: exchanged.tokens,
      };
      const index =
        existing === undefined ? -1 : document.accounts.indexOf(existing);
      if (index < 0) document.accounts.push(account);
      else document.accounts[index] = account;
      clearTimeout(attempt.timer);
      await this.#store.write(document);
      return accountView(account);
    });
  }

  #finishAttempt(attemptId: string, result: ChatGptSignInResult): void {
    const pending = this.#pending;
    if (pending?.id !== attemptId) return;
    this.#pending = undefined;
    clearTimeout(pending.timer);
    pending.server.close();
    this.#signInResults.set(attemptId, result);
  }
}

function accountView(account: StoredChatGptAccount): ChatGptAccount {
  let status: ChatGptAccount["status"] = "signed_out";
  const tokens = account.tokens;
  if (account.needsReauthorization) status = "reauthorization_required";
  else if (tokens !== undefined)
    status = hasChatGptPlanGrant(tokens) ? "plan_authorized" : "signed_in";
  return {
    id: account.id,
    label: account.label,
    ...(account.email === undefined ? {} : { email: account.email }),
    status,
  };
}

function findAccount(
  document: ChatGptCredentialDocument | undefined,
  accountId: string,
): StoredChatGptAccount {
  const account = document?.accounts.find(({ id }) => id === accountId);
  if (account === undefined) throw new ChatGptAuthError("account_not_found");
  return account;
}

function signedInTokens(account: StoredChatGptAccount) {
  if (account.needsReauthorization)
    throw new ChatGptAuthError("reauthorization_required");
  if (account.tokens === undefined)
    throw new ChatGptAuthError("sign_in_required");
  return account.tokens;
}

function planTokens(account: StoredChatGptAccount) {
  const tokens = signedInTokens(account);
  if (!hasChatGptPlanGrant(tokens))
    throw new ChatGptAuthError("plan_permission_required");
  return tokens;
}

function authorizationUrl(
  attempt: PendingSignIn,
  hostId: string,
  requestPlanConsent = false,
): string {
  const params = new URLSearchParams({
    client_id:
      attempt.selected?.clientId ??
      attempt.retryClientId ??
      chatGptDynamicClient,
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: attempt.redirectUri.href,
    scope: chatGptScopes,
    resource: chatGptResource,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(attempt.verifier)
      .digest("base64url"),
  });
  if (attempt.selected === undefined && attempt.retryClientId === undefined)
    params.set("agent_name_hint", "Narraeon");
  const previousIdToken = attempt.selected?.tokens?.idToken;
  if (previousIdToken !== undefined)
    params.set("id_token_hint", previousIdToken);
  if (requestPlanConsent) params.set("prompt", "consent");
  return `${chatGptAuthorize}?${params.toString()}`;
}

function callbackParams(
  request: IncomingMessage,
  redirectUri: URL,
): URLSearchParams | undefined {
  if (
    request.method !== "GET" ||
    request.headers.host !== redirectUri.host ||
    request.headersDistinct.host?.length !== 1 ||
    !request.url?.startsWith(callbackPath)
  )
    return;
  const url = URL.parse(request.url, redirectUri.href);
  if (
    url?.origin !== redirectUri.origin ||
    url.pathname !== callbackPath ||
    url.hash !== ""
  )
    return;
  const params = url.searchParams;
  for (const field of ["state", "code", "error", "client_id", "iss"]) {
    if (params.getAll(field).length > 1) return;
  }
  if (
    params.has("iss") &&
    params.get("iss") !== new URL(chatGptAuthorize).origin
  )
    return;
  return params;
}

function bindLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new ChatGptAuthError("service_unavailable"));
    server.once("error", onError);
    server.listen({ host: loopbackAddress, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        onError();
        return;
      }
      resolve(address.port);
    });
  });
}

function replyToBrowser(
  response: ServerResponse,
  status: number,
  outcome: "completed" | "denied" | "failed",
): void {
  if (response.writableEnded) return;
  const text = {
    completed: [
      "Signed in. You can return to Narraeon.",
      "登录成功，可以返回 Narraeon。",
    ],
    denied: [
      "Authorization was canceled. You can return to Narraeon.",
      "已取消授权，可以返回 Narraeon。",
    ],
    failed: [
      "Sign-in could not be completed. Return to Narraeon to try again.",
      "未能完成登录，请返回 Narraeon 重试。",
    ],
  }[outcome];
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  });
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Narraeon</title><p>${text[0]}</p><p lang="zh-CN">${text[1]}</p></html>`,
  );
}

function failedSignIn(error: ChatGptAuthErrorCode): ChatGptSignInResult {
  return { status: "failed", error };
}

function expiredSignIn(): ChatGptSignInResult {
  return { status: "expired", error: "authorization_expired" };
}

async function waitUntilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return operation;
  let listener: ReturnType<typeof addAbortListener> | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    listener = addAbortListener(signal, () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new DOMException("Aborted", "AbortError"),
      );
    });
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    listener?.[Symbol.dispose]();
  }
}
