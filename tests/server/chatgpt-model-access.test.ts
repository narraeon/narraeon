import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import {
  chatGptPlanBaseUrl,
  type ChatGptAccount,
} from "../../src/protocol/chatGptAuth.ts";
import type { SaveModelConnectionInput } from "../../src/protocol/modelConnections.ts";
import { v1Protocol, type V1Request } from "../../src/protocol/v1.ts";
import { ChatGptAuth } from "../../src/runtime/model/ChatGptAuth.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { createServer } from "../../src/server/createServer.ts";
import { availableRuntimePort } from "../support/runtimeServer.ts";

const accountId = "opaque-local-account";
const bearer = "the-fixture-subscription-token";
const plan: SaveModelConnectionInput = {
  name: "Local subscription",
  presetId: "chatgpt-plan",
  authMode: "chatgpt",
  provider: "openai_responses",
  baseUrl: chatGptPlanBaseUrl,
  chatGptAccountId: accountId,
  modelId: "test-account-model",
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_000,
};

test("only the direct desktop Runtime can use a saved ChatGPT plan, including after restart", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "narraeon-chatgpt-access-"));
  const configRoot = join(workspace, "config");
  const auth = new ChatGptAuth({
    workspaceDirectory: configRoot,
    localEnabled: true,
  });
  const identity: ChatGptAccount = {
    id: accountId,
    label: "Fixture",
    status: "plan_authorized",
  };
  const accountReads = vi
    .spyOn(auth, "listAccounts")
    .mockImplementation(() => Promise.resolve([{ ...identity }]));
  const listModels = vi
    .spyOn(auth, "listModels")
    .mockResolvedValue([{ id: plan.modelId, displayName: "Fixture model" }]);
  const readToken = vi.spyOn(auth, "getAccessToken").mockResolvedValue(bearer);
  vi.spyOn(auth, "disconnect").mockImplementation(() => {
    identity.status = "signed_out";
    return Promise.resolve({
      account: { ...identity },
      remoteRevocationConfirmed: true,
    });
  });
  const modelFetch = vi.fn<typeof fetch>().mockImplementation(() => {
    const event = {
      type: "response.completed",
      response: {
        id: "resp-plan",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "The local fixture replied." },
            ],
          },
        ],
      },
    };
    return Promise.resolve(
      new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  });

  async function start(
    host: "127.0.0.1" | "0.0.0.0",
    trustedOrigins?: string[],
  ) {
    const runtime = new V1Runtime({
      dataRoot: join(workspace, "data"),
      configRoot,
      chatGptAuth: auth,
      modelFetch,
    });
    await runtime.initialize();
    const port = await availableRuntimePort();
    const server = await createServer({
      runtime,
      port,
      staticRoot: workspace,
      logger: false,
      ...(trustedOrigins === undefined ? {} : { trustedOrigins }),
    });
    await server.listen({ port, host });
    const origin = `http://127.0.0.1:${port}`;
    return {
      close: () => server.close(),
      async rpc(
        request: V1Request,
        headers: Record<string, string> = { origin },
      ) {
        const response = await fetch(`${origin}/api/runtime/v1`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ protocol: v1Protocol, request }),
        });
        const payload: unknown = await response.json();
        expect(JSON.stringify(payload)).not.toContain(bearer);
        return payload;
      },
      origin,
    };
  }

  try {
    await writeFile(join(workspace, "index.html"), "<main>Narraeon</main>");
    const local = await start("127.0.0.1");
    try {
      await expect(
        local.rpc({ type: "model.chatgpt.accounts" }),
      ).resolves.toMatchObject({
        result: [{ id: accountId, status: "plan_authorized" }],
      });
      await expect(
        local.rpc({ type: "model.chatgpt.accounts" }, {}),
      ).resolves.toMatchObject({
        error: { details: { chatGptAuthError: "local_only" } },
      });
      await expect(
        local.rpc(
          { type: "model.chatgpt.accounts" },
          {
            origin: local.origin,
            forwarded: "for=203.0.113.1",
          },
        ),
      ).resolves.toMatchObject({
        error: { details: { chatGptAuthError: "local_only" } },
      });
      await expect(
        local.rpc({
          type: "model.save",
          connection: { ...plan, baseUrl: "https://not-openai.example/v1" },
        }),
      ).resolves.toMatchObject({ error: { code: "invalid_request" } });
      expect(listModels).not.toHaveBeenCalled();
      await expect(
        local.rpc({ type: "model.save", connection: plan }),
      ).resolves.toMatchObject({
        result: {
          chatGptAvailable: true,
          configured: true,
          connections: [
            {
              chatGptAccountId: accountId,
              chatGptAllowFollowups: false,
              hasApiKey: false,
            },
          ],
        },
      });
      const stored = await readFile(
        join(configRoot, "model-connections-v1.json"),
        "utf8",
      );
      expect(stored).not.toMatch(/apiKey|accessToken|refreshToken/u);
      await expect(
        local.rpc({ type: "model.test", connection: plan }),
      ).resolves.toMatchObject({
        result: { outcome: "success" },
      });
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(modelFetch).toHaveBeenCalledTimes(1);
      const [url, init] = modelFetch.mock.calls[0]!;
      expect(url instanceof Request ? url.url : url.toString()).toBe(
        `${chatGptPlanBaseUrl}/responses`,
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        `Bearer ${bearer}`,
      );
    } finally {
      await local.close();
    }
    const readsBeforeRestart = accountReads.mock.calls.length;
    for (const config of [
      { host: "0.0.0.0", trustedOrigins: undefined },
      { host: "127.0.0.1", trustedOrigins: ["https://proxy.example"] },
    ] as const) {
      const remote = await start(config.host, config.trustedOrigins?.slice());
      try {
        await expect(remote.rpc({ type: "model.read" })).resolves.toMatchObject(
          {
            result: {
              configured: false,
              connections: [{ chatGptAccountId: accountId }],
            },
          },
        );
        await expect(
          remote.rpc({ type: "model.test", connection: plan }),
        ).resolves.toMatchObject({
          error: { details: { chatGptAuthError: "local_only" } },
        });
      } finally {
        await remote.close();
      }
    }
    expect(accountReads).toHaveBeenCalledTimes(readsBeforeRestart);
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(modelFetch).toHaveBeenCalledTimes(1);

    const reopened = await start("127.0.0.1");
    try {
      await expect(reopened.rpc({ type: "model.read" })).resolves.toMatchObject(
        {
          result: { configured: true },
        },
      );
      await reopened.rpc({ type: "model.chatgpt.disconnect", accountId });
      await expect(reopened.rpc({ type: "model.read" })).resolves.toMatchObject(
        {
          result: {
            configured: false,
            connections: [{ chatGptAccountId: accountId }],
          },
        },
      );
      await expect(
        reopened.rpc({ type: "model.test", connection: plan }),
      ).resolves.toMatchObject({
        error: { details: { chatGptAuthError: "sign_in_required" } },
      });
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally {
      await reopened.close();
    }
  } finally {
    auth.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
