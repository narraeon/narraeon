import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatGptAuth } from "../../src/runtime/model/ChatGptAuth.ts";

const issuer = "https://auth.openai.com";
const tokenEndpoint = issuer + "/api/accounts/oauth/token";
const jwksEndpoint = issuer + "/.well-known/jwks.json";
const discoveryEndpoint = issuer + "/.well-known/openid-configuration";
const revokeEndpoint = issuer + "/api/accounts/oauth/revoke";
const modelsEndpoint = "https://api.openai.com/v1/models";
const resource = "https://api.openai.com/v1";
const fullScopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const identityScopes = "openid profile email offline_access";
const client = "oaiapp_test_one";
const sameEmailClient = "oaiapp_test_two";
const email = "test@example.invalid";
const subject = "verified-subject";
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const synthesizedPrivateKeys: SigningKey[] = [];
let signingJwk: JWK;
const created: { auth: ChatGptAuth; directory: string }[] = [];

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const untrusted = await generateKeyPair("RS256");
  signingJwk = { ...(await exportJWK(keys.publicKey)), kid: "local-signing" };
  synthesizedPrivateKeys.push(keys.privateKey, untrusted.privateKey);
});

afterEach(async () => {
  for (const { auth } of created) auth.close();
  await Promise.all(
    created
      .splice(0)
      .map(({ directory }) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local ChatGPT authorization", () => {
  it("registers against the documented endpoints and exposes only the account catalog and safe fields", async () => {
    const provider = await fixture();
    const start = await provider.start();
    expect(new URL(start.authorization).origin).toBe(issuer);
    expect(new URL(start.authorization).pathname).toBe(
      "/api/accounts/authorize",
    );
    const params = new URL(start.authorization).searchParams;
    expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
    expect(Object.fromEntries(params)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Narraeon",
      code_challenge_method: "S256",
      response_type: "code",
      resource,
      scope: fullScopes,
    });
    expect(start.callback.hostname).toBe("127.0.0.1");
    expect(start.callback.pathname).toBe("/auth/callback");
    expect(provider.auth.signInStatus(start.attemptId)).toEqual({
      status: "pending",
    });
    const callback = await provider.complete(start, { scope: identityScopes });
    expect(callback.status).toBe(200);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await callback.text()).not.toContain("fixture-code");

    const account = provider.auth.signInStatus(start.attemptId).account!;
    expect(provider.auth.signInStatus(start.attemptId)).toEqual({
      status: "completed",
      account: {
        id: account.id,
        label: email + " · 1",
        email,
        status: "plan_authorized",
      },
    });
    const calls = provider.forms.filter(({ url }) => url === tokenEndpoint);
    expect(calls).toHaveLength(1);
    const form = calls[0]?.form;
    const verifier = form?.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Object.fromEntries(form ?? [])).toEqual({
      grant_type: "authorization_code",
      client_id: client,
      code: "fixture-code",
      code_verifier: verifier,
      redirect_uri: start.callback.href,
      resource,
    });
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      new URL(start.authorization).searchParams.get("code_challenge"),
    );

    expect(await provider.auth.listModels(account.id)).toEqual([
      { id: "model-z", displayName: "Model Z" },
      { id: "model-a", displayName: "Model A" },
    ]);
    expect(provider.catalogCredentials).toEqual(["Bearer fixture-access"]);

    const protectedFile = provider.file;
    const mode = (await stat(protectedFile)).mode;
    if (process.platform !== "win32") expect(mode & 0o777).toBe(0o600);
    const disk = await readFile(protectedFile, "utf8");
    expect(disk).toContain("fixture-refresh");
    expect(disk).toContain(client);
    expect(disk).toContain(subject);
    const publicData = JSON.stringify(await provider.auth.listAccounts());
    for (const privateValue of [
      "fixture-access",
      "fixture-refresh",
      client,
      subject,
    ])
      expect(publicData).not.toContain(privateValue);
  });

  it("binds to one matching state and permits a valid denial without exchanging the code", async () => {
    const provider = await fixture();
    const start = await provider.start();
    await expect(provider.auth.startSignIn()).rejects.toMatchObject({
      code: "busy",
    });
    const spoof = new URL(start.callback);
    spoof.search = new URLSearchParams({
      state: "wrong",
      code: "fixture-code",
      client_id: client,
    }).toString();
    expect((await fetch(spoof)).status).toBe(400);
    const duplicate = new URL(start.callback);
    duplicate.searchParams.append("state", "wrong");
    duplicate.searchParams.append("state", start.state);
    expect((await fetch(duplicate)).status).toBe(400);
    expect(provider.auth.signInStatus(start.attemptId)).toEqual({
      status: "pending",
    });
    const rejected = await provider.complete(start, {
      error: "access_denied",
      error_description: "fixture-secret-reason",
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.text()).not.toContain("fixture-secret-reason");
    expect(provider.auth.signInStatus(start.attemptId)).toEqual({
      status: "denied",
    });
    expect(await provider.auth.listAccounts()).toEqual([]);
    expect(provider.forms).toEqual([]);
  });

  it.each(["signature", "issuer", "audience", "nonce", "expiry"] as const)(
    "rejects an ID token with invalid %s without saving any credentials",
    async (invalid) => {
      const provider = await fixture();
      const start = await provider.start();
      const signer = signatureKey(invalid === "signature");
      provider.tokenResponse = async () =>
        tokenPayload(
          await new SignJWT({
            sub: subject,
            email,
            email_verified: true,
            nonce: invalid === "nonce" ? "wrong-nonce" : start.nonce,
          })
            .setProtectedHeader({ alg: "RS256", kid: "local-signing" })
            .setIssuer(invalid === "issuer" ? "https://wrong.invalid" : issuer)
            .setAudience(invalid === "audience" ? "another_client" : client)
            .setIssuedAt()
            .setExpirationTime(invalid === "expiry" ? "1 minute ago" : "5m")
            .sign(signer),
        );
      expect((await provider.complete(start)).status).toBe(400);
      expect(provider.auth.signInStatus(start.attemptId)).toEqual({
        status: "failed",
        error: "invalid_response",
      });
      expect(await provider.auth.listAccounts()).toEqual([]);
      expect(await readFile(provider.file, "utf8")).not.toContain(
        "fixture-access",
      );
    },
  );

  it("retries a rejected code through fresh authorization with the issued client", async () => {
    const provider = await fixture();
    const start = await provider.start();
    provider.tokenResponse = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    expect((await provider.complete(start)).status).toBe(400);
    expect(provider.auth.signInStatus(start.attemptId)).toEqual({
      status: "failed",
      error: "authorization_failed",
    });
    expect(await provider.auth.listAccounts()).toEqual([]);

    const retry = await provider.start();
    const params = new URL(retry.authorization).searchParams;
    expect(params.get("client_id")).toBe(client);
    expect(params.get("agent_name_hint")).toBeNull();
    expect(params.get("id_token_hint")).toBeNull();
    expect(retry.state).not.toBe(start.state);
    expect(retry.nonce).not.toBe(start.nonce);
    provider.tokenResponse = undefined;
    expect(
      (
        await provider.complete(retry, {
          code: "new-code",
          client_id: undefined,
        })
      ).status,
    ).toBe(200);
    expect(provider.forms.map(({ form }) => form.get("code"))).toEqual([
      "fixture-code",
      "new-code",
    ]);
  });

  it("separates identity-only sign-in from explicit plan consent and rejects another subject on reopening", async () => {
    const provider = await fixture();
    const start = await provider.start();
    provider.tokenResponse = async () =>
      tokenPayload(await mintToken(start), { scope: identityScopes });
    await provider.complete(start, { scope: fullScopes });
    const account = provider.auth.signInStatus(start.attemptId).account!;
    expect(account.status).toBe("signed_in");
    await expect(provider.auth.listModels(account.id)).rejects.toMatchObject({
      code: "plan_permission_required",
    });
    expect(provider.catalogCredentials).toEqual([]);

    provider.restart();
    expect(await provider.auth.listAccounts()).toEqual([account]);
    const retry = await provider.start({
      accountId: account.id,
      requestPlanConsent: true,
    });
    const browser = new URL(retry.authorization);
    expect(browser.searchParams.get("client_id")).toBe(client);
    expect(browser.searchParams.get("id_token_hint")).not.toBeNull();
    expect(browser.searchParams.get("prompt")).toBe("consent");
    expect(browser.searchParams.get("agent_name_hint")).toBeNull();
    expect(retry.state).not.toBe(start.state);
    expect(retry.nonce).not.toBe(start.nonce);
    expect(browser.searchParams.get("ext_agent_host_id")).toBe(
      new URL(start.authorization).searchParams.get("ext_agent_host_id"),
    );

    provider.tokenResponse = async () =>
      tokenPayload(await mintToken(retry, { subject: "wrong-account" }));
    expect(
      (await provider.complete(retry, { client_id: undefined })).status,
    ).toBe(400);
    expect(provider.auth.signInStatus(retry.attemptId)).toEqual({
      status: "failed",
      error: "authorization_failed",
    });
    expect(await provider.auth.listAccounts()).toEqual([account]);

    const correct = await provider.start({
      accountId: account.id,
      requestPlanConsent: true,
    });
    provider.tokenResponse = async () => tokenPayload(await mintToken(correct));
    await provider.complete(correct, { client_id: undefined });
    expect(await provider.auth.listAccounts()).toEqual([
      { ...account, status: "plan_authorized" },
    ]);
  });

  it("rejects a missing issued client on first registration and a swapped issued client on returning sign-in", async () => {
    const provider = await fixture();
    const first = await provider.start();
    expect(
      (await provider.complete(first, { client_id: undefined })).status,
    ).toBe(400);
    expect(provider.forms).toEqual([]);
    const start = await provider.start();
    await provider.complete(start);
    const account = provider.auth.signInStatus(start.attemptId).account!;
    const returning = await provider.start({ accountId: account.id });
    expect(
      (await provider.complete(returning, { client_id: sameEmailClient }))
        .status,
    ).toBe(400);
    expect(provider.forms).toHaveLength(1);
    expect(await provider.auth.listAccounts()).toEqual([account]);
  });

  it("keeps same-email registrations separate and revokes only the selected workspace", async () => {
    const provider = await fixture();
    const first = await provider.start();
    await provider.complete(first);
    const a = provider.auth.signInStatus(first.attemptId).account!;
    const second = await provider.start();
    provider.tokenResponse = async () =>
      tokenPayload(await mintToken(second, { clientId: sameEmailClient }), {
        access_token: "second-access",
        refresh_token: "second-refresh",
      });
    await provider.complete(second, { client_id: sameEmailClient });
    const b = provider.auth.signInStatus(second.attemptId).account!;
    expect(b.id).not.toBe(a.id);
    expect(b.label).not.toBe(a.label);
    expect(b.email).toBe(a.email);
    await provider.auth.listModels(a.id);
    await provider.auth.listModels(b.id);
    expect(provider.catalogCredentials).toEqual([
      "Bearer fixture-access",
      "Bearer second-access",
    ]);

    expect(await provider.auth.disconnect(a.id)).toEqual({
      account: { ...a, status: "signed_out" },
      remoteRevocationConfirmed: true,
    });
    const revocation = provider.forms.at(-1);
    expect(revocation?.url).toBe(revokeEndpoint);
    expect(Object.fromEntries(revocation?.form ?? [])).toEqual({
      client_id: client,
      token_type_hint: "refresh_token",
      token: "fixture-refresh",
    });
    await expect(provider.auth.getAccessToken(a.id)).rejects.toMatchObject({
      code: "sign_in_required",
    });
    expect(await provider.auth.getAccessToken(b.id)).toBe("second-access");
    expect(await readFile(provider.file, "utf8")).not.toContain(
      "fixture-refresh",
    );

    const third = await provider.start({ accountId: a.id });
    const returning = new URL(third.authorization);
    expect(returning.searchParams.get("client_id")).toBe(client);
    expect(returning.searchParams.get("id_token_hint")).toBeNull();
    await provider.complete(third, { error: "access_denied" });
  });

  it("deduplicates concurrent renewals, preserves rotation on abort and rejects stale invalidation", async () => {
    const provider = await fixture();
    const start = await provider.start();
    provider.tokenResponse = async () =>
      tokenPayload(await mintToken(start), { expires_in: 15 });
    await provider.complete(start);
    const account = provider.auth.signInStatus(start.attemptId).account!;
    const began = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    provider.tokenResponse = async () => {
      began.resolve();
      await resume.promise;
      return tokenPayload(undefined, {
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
      });
    };

    const cancellation = new AbortController();
    const token = provider.auth.getAccessToken(account.id, cancellation.signal);
    const read = provider.auth.getAccessToken(account.id);
    await began.promise;
    const manual = provider.auth.refresh(account.id);
    const canceled = expect(token).rejects.toMatchObject({
      name: "AbortError",
    });
    cancellation.abort();
    await canceled;
    resume.resolve();
    expect(await read).toBe("rotated-access");
    expect(await manual).toEqual(account);
    expect(
      provider.forms.filter(
        ({ form }) => form.get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);
    expect(Object.fromEntries(provider.forms.at(-1)?.form ?? [])).toEqual({
      grant_type: "refresh_token",
      client_id: client,
      refresh_token: "fixture-refresh",
      resource,
    });
    await provider.auth.invalidateAccessToken(account.id, "fixture-access");
    provider.restart();
    expect(await provider.auth.getAccessToken(account.id)).toBe(
      "rotated-access",
    );
    const disk = await readFile(provider.file, "utf8");
    expect(disk).toContain("rotated-refresh");
    expect(disk).not.toContain("fixture-refresh");
  });

  it("preserves grants on transient refresh trouble and clears only when credential loss is confirmed", async () => {
    const provider = await fixture();
    const start = await provider.start();
    await provider.complete(start);
    const account = provider.auth.signInStatus(start.attemptId).account!;
    provider.tokenResponse = () =>
      Response.json(
        {
          error: "temporarily_unavailable",
          error_description: "fixture-access",
        },
        { status: 503 },
      );
    await expect(provider.auth.refresh(account.id)).rejects.toMatchObject({
      code: "service_unavailable",
      message: "ChatGPT authorization: service_unavailable",
    });
    expect(await provider.auth.getAccessToken(account.id)).toBe(
      "fixture-access",
    );
    provider.tokenResponse = () =>
      Response.json({ error: "invalid_grant" }, { status: 400 });
    await expect(provider.auth.refresh(account.id)).rejects.toMatchObject({
      code: "reauthorization_required",
    });
    expect(await provider.auth.listAccounts()).toEqual([
      { ...account, status: "reauthorization_required" },
    ]);
    const disk = await readFile(provider.file, "utf8");
    expect(disk).not.toContain("fixture-refresh");
    expect(disk).not.toContain("fixture-access");
    expect(disk).toContain(client);
  });

  it("reports unconfirmed remote revocation while still clearing local tokens", async () => {
    const provider = await fixture();
    const start = await provider.start();
    await provider.complete(start);
    const account = provider.auth.signInStatus(start.attemptId).account!;
    provider.revocationResponse = () => new Response(null, { status: 503 });

    expect(await provider.auth.disconnect(account.id)).toEqual({
      account: { ...account, status: "signed_out" },
      remoteRevocationConfirmed: false,
    });
    expect(
      provider.forms.filter(({ url }) => url === revokeEndpoint),
    ).toHaveLength(2);
    expect(await readFile(provider.file, "utf8")).not.toContain(
      "fixture-refresh",
    );
  });

  it("rejects nonlocal callers and refuses a shared or symlinked credential file", async () => {
    const provider = await fixture(false);
    await expect(provider.auth.startSignIn()).rejects.toMatchObject({
      code: "local_only",
    });
    await expect(provider.auth.listAccounts()).rejects.toMatchObject({
      code: "local_only",
    });
    expect(provider.browser).toHaveLength(0);
    expect(provider.fetch).not.toHaveBeenCalled();
    await expect(stat(provider.file)).rejects.toMatchObject({ code: "ENOENT" });

    if (process.platform === "win32") return;
    provider.restart();
    const start = await provider.start();
    await provider.complete(start);
    await chmod(provider.file, 0o644);
    await expect(provider.auth.listAccounts()).rejects.toMatchObject({
      code: "service_unavailable",
    });
    const separateFile = provider.file + ".elsewhere";
    await rm(provider.file);
    await symlink(separateFile, provider.file);
    await expect(provider.auth.listAccounts()).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });
});

interface StartedSignIn {
  attemptId: string;
  authorization: string;
  callback: URL;
  state: string;
  nonce: string;
}

async function fixture(localEnabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "narraeon-chatgpt-auth-"));
  const file = join(directory, "chatgpt-auth-v1.json");
  const forms: { url: string; form: URLSearchParams }[] = [];
  const browser: string[] = [];
  const catalogCredentials: (string | null)[] = [];
  let currentSignIn: StartedSignIn | undefined;
  const fetchStub = vi.fn<typeof fetch>(
    async (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(init?.redirect).toBe("error");
      if (init?.body instanceof URLSearchParams)
        forms.push({ url, form: init.body });
      if (url === tokenEndpoint) {
        if (provider.tokenResponse !== undefined)
          return provider.tokenResponse();
        if (currentSignIn === undefined)
          throw new Error("Expected a fixture sign-in");
        return tokenPayload(await mintToken(currentSignIn));
      }
      if (url === discoveryEndpoint)
        return Response.json({ issuer, revocation_endpoint: revokeEndpoint });
      if (url === revokeEndpoint) return provider.revocationResponse();
      if (url === jwksEndpoint) return Response.json({ keys: [signingJwk] });
      if (url === modelsEndpoint) {
        catalogCredentials.push(
          new Headers(init?.headers).get("authorization"),
        );
        return Response.json({
          models: [
            { visibility: "list", slug: "model-z", display_name: "Model Z" },
            { visibility: "hidden", slug: "hidden", display_name: "Hidden" },
            { visibility: "list", slug: "model-a", display_name: "Model A" },
            { visibility: "list", slug: "model-a", display_name: "Duplicate" },
          ],
        });
      }
      throw new Error("The fixture received an unexpected network destination");
    },
  );
  const create = (enabled: boolean) =>
    new ChatGptAuth({
      workspaceDirectory: directory,
      localEnabled: enabled,
      fetch: fetchStub,
      openBrowser: (url) => {
        browser.push(url);
        return Promise.resolve();
      },
    });
  const tracked = { auth: create(localEnabled), directory };
  created.push(tracked);
  const provider = {
    get auth() {
      return tracked.auth;
    },
    file,
    forms,
    browser,
    catalogCredentials,
    fetch: fetchStub,
    tokenResponse: undefined as
      (() => Response | Promise<Response>) | undefined,
    revocationResponse: (): Response => new Response(null, { status: 200 }),
    restart() {
      tracked.auth.close();
      tracked.auth = create(true);
    },
    async start(
      input?: Parameters<ChatGptAuth["startSignIn"]>[0],
    ): Promise<StartedSignIn> {
      const { attemptId } = await tracked.auth.startSignIn(input);
      const authorization = browser.at(-1)!;
      const params = new URL(authorization).searchParams;
      return {
        attemptId,
        authorization,
        callback: new URL(params.get("redirect_uri")!),
        state: params.get("state")!,
        nonce: params.get("nonce")!,
      };
    },
    async complete(
      start: StartedSignIn,
      params: Record<string, string | undefined> = {},
    ): Promise<Response> {
      currentSignIn = start;
      const callback = new URL(start.callback);
      for (const [name, value] of Object.entries({
        code: "fixture-code",
        state: start.state,
        client_id: client,
        ...params,
      }))
        if (value !== undefined) callback.searchParams.set(name, value);
      return fetch(callback);
    },
  };
  return provider;
}

function signatureKey(untrusted: boolean): SigningKey {
  const key = synthesizedPrivateKeys[untrusted ? 1 : 0];
  if (key === undefined) throw new Error("No fixture signing key");
  return key;
}

function mintToken(
  start: StartedSignIn,
  options: { clientId?: string; subject?: string } = {},
): Promise<string> {
  return new SignJWT({
    sub: options.subject ?? subject,
    email,
    email_verified: true,
    nonce: start.nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: "local-signing" })
    .setIssuer(issuer)
    .setAudience(options.clientId ?? client)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signatureKey(false));
}

function tokenPayload(
  idToken: string | undefined,
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: fullScopes,
    ...overrides,
  });
}
