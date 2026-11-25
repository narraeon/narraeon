import { expect, test, vi } from "vitest";

import { fictionGameplay } from "../../src/protocol/gameplay.ts";
import { retargetRequestForRetry } from "../../src/runtime/model/AssistantPrefill.ts";
import {
  FileNativeModelHost,
  type FileNativeModelConnection,
} from "../../src/runtime/model/FileNativeModelAdapters.ts";
import type { ModelHostExchange } from "../../src/runtime/model/ModelHost.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  compileSettingImprovementLegacyCurrentTreeBootstrap,
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
  retargetFrozenCompilation,
  type PromptCompilation,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

interface WireItem {
  text?: string;
  content?: string | WireItem[];
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
}

interface WireRequest {
  system?: WireItem[];
  messages?: WireItem[];
  input?: WireItem[];
  tools?: { input_schema: object }[];
}

function captureHost(
  provider: FileNativeModelConnection["provider"],
  options: Pick<
    FileNativeModelConnection,
    "dialect" | "responsesCacheControl" | "anthropicPromptCacheTtl"
  > = {},
) {
  // A local test transport records the actual encoded body before rejecting it.
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        new Response("Synthetic transport response", { status: 400 }),
      ),
    );
  const host = new FileNativeModelHost(
    {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "synthetic-key",
      modelId: "synthetic-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
      ...options,
    },
    transport,
  );
  return {
    host,
    send: async (request: ModelHostExchange): Promise<WireRequest> => {
      await expect(host.exchange(request)).rejects.toThrow(
        provider === "google_interactions"
          ? "Google Interactions request was rejected"
          : "Synthetic transport response",
      );
      const body = transport.mock.lastCall?.[1]?.body;
      if (typeof body !== "string")
        throw new Error("Missing JSON request body");
      return JSON.parse(body) as WireRequest;
    },
  };
}

function authorBootstrap(
  provider: PromptCompilation["provider"]["protocol"],
  cacheStrategy: PromptCompilation["cache"]["strategy"],
  lastMessageRole: "system" | "user" = "user",
) {
  const playPreset = builtinDefaultPlayPresetBinding("en");
  playPreset.definition.authorPrompts =
    playPreset.definition.authorPrompts!.filter(
      (entry) =>
        entry.kind === "builtin" &&
        ["author.mechanics", "author.target"].includes(entry.builtin),
    );
  playPreset.definition.authorPrompts.push({
    id: "last-author-prompt",
    kind: "user",
    name: "Last author prompt",
    body: "Last stable author prompt.",
    enabled: true,
    messageRole: lastMessageRole,
  });
  return new FileNativePromptCompiler({
    locale: "en",
  }).compileSettingImprovement({
    contentPackageTitle: "Synthetic package",
    gameplay: fictionGameplay,
    playPreset,
    modelBinding: {
      provider,
      modelId: "synthetic-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
      cacheStrategy,
    },
    tools: [],
  });
}

function requestFor(bootstrap: PromptCompilation): ModelHostExchange {
  return {
    bootstrap,
    tools: bootstrap.tools,
    appended: [{ kind: "player", text: "Synthetic author request" }],
    maxOutputTokens: 2_048,
  };
}

test.each([
  ["chat_completions", "en"],
  ["chat_completions", "zh-CN"],
  ["google_interactions", "en"],
  ["google_interactions", "zh-CN"],
] as const)(
  "%s renders the %s initial preload in the wire request and Preview",
  async (provider, locale) => {
    const { host, send } = captureHost(provider);
    const input = createMinimalFileNativePreviewInput({
      ...host.binding(),
      playerInput: "Look around",
      playerInputPlacement: "append",
    });
    const bootstrap = new FileNativePromptCompiler({
      locale,
    }).compilePlayCallChain(
      input,
      builtinDefaultPlayPresetBinding(locale),
    ).bootstrap;
    const request = requestFor(bootstrap);
    const body = await send(request);
    const notice = locale === "zh-CN" ? "Runtime 预载：" : "Runtime preload:";
    expect(JSON.stringify(body)).toContain(notice);
    expect(host.previewRequest(request).body).toEqual(body);
    if (locale === "en") {
      const legacy = structuredClone(bootstrap);
      delete legacy.locale;
      delete legacy.provider.preload?.notice;
      expect(await send(requestFor(legacy))).toEqual(body);
    }

    const nextLocale = locale === "zh-CN" ? "en" : "zh-CN";
    const refreshed = new FileNativePromptCompiler({
      locale: nextLocale,
    }).compilePlayCallChain(
      { ...input, frozenWorldContext: bootstrap },
      builtinDefaultPlayPresetBinding(nextLocale),
    ).bootstrap;
    expect(refreshed.locale).toBe(nextLocale);
    expect(refreshed.provider.preload).toEqual(bootstrap.provider.preload);
    expect(JSON.stringify(await send(requestFor(refreshed)))).toContain(notice);
  },
);

function cacheMarkerCount(value: unknown): number {
  return JSON.stringify(value).match(/"cache_control":/gu)?.length ?? 0;
}

test("Anthropic retry reports the single marked author block in the dispatched request", async () => {
  const { host, send } = captureHost("anthropic_messages");
  const original = authorBootstrap("anthropic_messages", "provider_managed");
  const saved = structuredClone(original);
  const retried = retargetRequestForRetry(requestFor(original), host);

  const body = await send(retried);
  expect(body.messages![0]).toEqual({
    role: "user",
    content: [
      {
        type: "text",
        text: "# Author instruction\n\nLast stable author prompt.",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  expect(body.messages![1]).toEqual({
    role: "user",
    content: "Synthetic author request",
  });
  expect(cacheMarkerCount(body)).toBe(1);
  expect(original).toEqual(saved);
  expect(retried.bootstrap.logicalMessages).toEqual(saved.logicalMessages);
  expect(retried.bootstrap.cache.breakpoints).toEqual(["author_instruction"]);
});

test("Anthropic same-policy retry keeps existing stable markers and excludes the transcript marker from diagnostics", async () => {
  const { host, send } = captureHost("anthropic_messages");
  const original = new FileNativePromptCompiler({
    locale: "en",
  }).compileBootstrap(
    createMinimalFileNativePreviewInput({
      ...host.binding(),
      playerInput: "Look around",
      playerInputPlacement: "append",
    }),
  );
  const turnGuide = "[Runtime turn guide]\n- Synthetic request-only suffix.";
  const request = requestFor(original);
  request.appended.push({
    kind: "runtime_notice",
    notice: "turn_guide",
    text: turnGuide,
  });
  const retried = retargetRequestForRetry(request, host);
  const body = await send(retried);

  expect(body.system).toEqual(original.provider.system);
  expect(body.messages![0]).toEqual(original.provider.messages[0]);
  expect(body.messages![1]!.content?.[0]).toMatchObject({
    text: "Synthetic author request",
    cache_control: { type: "ephemeral" },
  });
  expect(body.messages![2]?.content).toBe(turnGuide);
  expect(cacheMarkerCount(body)).toBe(4);
  expect(retried.bootstrap).toEqual(original);
  expect(retried.bootstrap.cache.breakpoints).toEqual([
    "runtime_system",
    "author_instruction",
    "world_context",
  ]);

  const disabled = retargetFrozenCompilation(original, {
    ...host.binding(),
    cacheStrategy: "provider_managed",
  });
  expect(disabled.cache.breakpoints).toEqual([]);
  expect(cacheMarkerCount(disabled.provider)).toBe(0);
});

test("Anthropic retry counts a stable world preload encoded as a tool result", async () => {
  const { host, send } = captureHost("anthropic_messages");
  const original = new FileNativePromptCompiler({
    locale: "en",
  }).compilePlayCallChain(
    createMinimalFileNativePreviewInput({
      ...host.binding(),
      cacheStrategy: "provider_managed",
      playerInput: "Look around",
      playerInputPlacement: "append",
    }),
    builtinDefaultPlayPresetBinding("en"),
  ).bootstrap;
  const retried = retargetRequestForRetry(requestFor(original), host);
  const body = await send(retried);

  const lastInstruction = original.logicalMessages.findLast(
    ({ role }) => role === "runtime_system" || role === "author_instruction",
  )!;
  const lastSystem = body.system?.at(-1);
  expect(lastSystem?.text).toContain(lastInstruction.markdown);
  expect(lastSystem?.cache_control).toEqual({ type: "ephemeral" });
  expect(body.messages?.[2]?.content?.[0]).toMatchObject({
    type: "tool_result",
    content: original.provider.preload!.markdown,
    cache_control: { type: "ephemeral" },
  });
  expect(cacheMarkerCount(body)).toBe(2);
  expect(retried.bootstrap.cache.breakpoints).toEqual([
    lastInstruction.role,
    "world_context",
  ]);
});

test("Anthropic applies the saved TTL only at its existing content block breakpoints", async () => {
  const standard = captureHost("anthropic_messages");
  const extended = captureHost("anthropic_messages", {
    anthropicPromptCacheTtl: "1h",
  });
  const bootstrap = new FileNativePromptCompiler({
    locale: "en",
  }).compilePlayCallChain(
    createMinimalFileNativePreviewInput({
      ...standard.host.binding(),
      playerInput: "Look around",
      playerInputPlacement: "append",
    }),
    builtinDefaultPlayPresetBinding("en"),
  ).bootstrap;
  const request = requestFor(bootstrap);
  const schema = {
    type: "object",
    properties: { cache_control: { type: "string" } },
  };
  request.tools = [
    {
      name: "lookup",
      description: "Looks up information",
      inputSchema: schema,
    },
  ];
  const nativeTool = {
    type: "tool_use",
    name: "lookup",
    id: "lookup-1",
    input: { cache_control: { type: "ephemeral", ttl: "5m" } },
    vendor_extension: { cache_control: { type: "ephemeral", ttl: "5m" } },
  };
  const signedThinking = {
    type: "thinking",
    thinking: "Inspect the scene",
    signature: "provider-signature",
  };
  const turnGuide = "[Runtime turn guide]\n- Synthetic request-only suffix.";
  request.appended.push(
    {
      kind: "assistant",
      text: "",
      toolCalls: [],
      providerState: {
        protocol: "anthropic_messages",
        content: [signedThinking, nativeTool],
      },
    },
    {
      kind: "runtime_notice",
      notice: "turn_guide",
      text: turnGuide,
    },
  );
  const saved = structuredClone(request);

  const defaultBody = await standard.send(request);
  const extendedBody = await extended.send(request);
  expect(standard.host.previewRequest(request).body).toEqual(defaultBody);
  expect(extended.host.previewRequest(request).body).toEqual(extendedBody);
  expect(JSON.stringify(extended.host.previewRequest(request))).not.toContain(
    "synthetic-key",
  );
  expect(defaultBody.system?.at(-1)?.cache_control).toEqual({
    type: "ephemeral",
  });
  expect(defaultBody.messages?.[2]?.content).toEqual([
    expect.objectContaining({
      type: "tool_result",
      content: bootstrap.provider.preload!.markdown,
      cache_control: { type: "ephemeral" },
    }),
  ]);
  expect(defaultBody.messages?.at(-2)?.content).toEqual([
    signedThinking,
    { ...nativeTool, cache_control: { type: "ephemeral" } },
  ]);
  expect(defaultBody.messages?.at(-1)?.content).toBe(turnGuide);
  expect(defaultBody.tools?.[0]?.input_schema).toEqual(schema);

  const expected = structuredClone(defaultBody);
  const markedBlocks = [
    ...(expected.system ?? []),
    ...(expected.messages ?? []).flatMap(({ content }) =>
      Array.isArray(content) ? content : [],
    ),
  ].filter((block) => block.cache_control !== undefined);
  expect(markedBlocks).toHaveLength(3);
  for (const block of markedBlocks) block.cache_control!.ttl = "1h";
  expect(extendedBody).toEqual(expected);
  expect(request).toEqual(saved);

  const legacy = standard.host.freezeRequest(request);
  delete legacy.modelConfig!.anthropicPromptCacheTtl;
  expect(extended.host.previewRequest(legacy).body).toEqual(defaultBody);
  expect(
    await extended.send(retargetRequestForRetry(legacy, extended.host)),
  ).toEqual(extendedBody);
});

test("Anthropic retry keeps the stable boundary before player text in a legacy User message", async () => {
  const { host, send } = captureHost("anthropic_messages");
  const original = new FileNativePromptCompiler({
    locale: "en",
  }).compileBootstrap(
    createMinimalFileNativePreviewInput({
      ...host.binding(),
      cacheStrategy: "provider_managed",
      playerInput: "Look around",
      playerInputPlacement: "bootstrap",
    }),
  );
  const request = { ...requestFor(original), appended: [] };
  const retried = retargetRequestForRetry(request, host);
  const body = await send(retried);

  expect(body.messages?.[0]?.content?.[0]).toMatchObject({
    text: original.logicalMessages.find(({ role }) => role === "world_context")!
      .markdown,
    cache_control: { type: "ephemeral" },
  });
  expect(body.messages?.[0]?.content?.[1]).toEqual({
    type: "text",
    text: original.logicalMessages.at(-1)!.markdown,
  });
  expect(cacheMarkerCount(body)).toBe(1);
  expect(retried.bootstrap.cache.breakpoints).toEqual(["world_context"]);
});

test.each(["chat_completions", "openai_responses"] as const)(
  "%s proxy retry reports the stable wire marker and clears it when explicit caching is disabled",
  async (provider) => {
    const { host, send } = captureHost(provider, {
      dialect: "cliproxyapi",
      ...(provider === "openai_responses"
        ? { responsesCacheControl: true }
        : {}),
    });
    const original = authorBootstrap(provider, "provider_managed");
    const retried = retargetRequestForRetry(requestFor(original), host);
    const body = await send(retried);
    const messages = (body.messages ?? body.input)!;
    const markerIndex =
      provider === "chat_completions"
        ? original.provider.messages.findLastIndex(
            ({ role }) => role === "system",
          )
        : original.provider.messages.length - 1;
    expect(messages[markerIndex]).toMatchObject({
      role: provider === "chat_completions" ? "system" : "user",
      content: original.provider.messages[markerIndex]!.content,
      cache_control: { type: "ephemeral" },
    });
    expect(cacheMarkerCount(body)).toBe(1);
    expect(retried.modelConfig).not.toHaveProperty("anthropicPromptCacheTtl");
    expect(JSON.stringify(body)).not.toMatch(
      /"anthropicPromptCacheTtl"|"ttl"/u,
    );
    expect(retried.bootstrap.cache.breakpoints).toEqual([
      provider === "chat_completions" ? "runtime_system" : "author_instruction",
    ]);

    const managed = captureHost(provider);
    const disabled = retargetRequestForRetry(retried, managed.host);
    expect(disabled.bootstrap.cache.breakpoints).toEqual([]);
    expect(cacheMarkerCount(await managed.send(disabled))).toBe(0);
  },
);

test.each([
  "anthropic_messages",
  "chat_completions",
  "openai_responses",
] as const)(
  "%s attributes the last marked block in a migrated authoring prefix to Runtime",
  async (provider) => {
    const { host, send } = captureHost(provider, {
      dialect: "cliproxyapi",
      ...(provider === "openai_responses"
        ? { responsesCacheControl: true }
        : {}),
    });
    const original = compileSettingImprovementLegacyCurrentTreeBootstrap(
      authorBootstrap(provider, "provider_managed", "system"),
      "en",
      [],
    );
    const retried = retargetRequestForRetry(requestFor(original), host);
    const body = await send(retried);
    const lastSystem =
      provider === "anthropic_messages"
        ? body.system?.at(-1)
        : (body.messages ?? body.input)?.at(-2);

    expect(lastSystem?.text ?? lastSystem?.content).toContain(
      "Runtime system contract replaces",
    );
    expect(lastSystem?.cache_control).toEqual({ type: "ephemeral" });
    expect(cacheMarkerCount(body)).toBe(1);
    expect(retried.bootstrap.cache.breakpoints).toEqual(["runtime_system"]);
  },
);

test.each(["chat_completions", "openai_responses"] as const)(
  "%s emits no stable markers after retargeting a frozen legacy prefix with inline markers",
  async (provider) => {
    const { host, send } = captureHost(provider, {
      dialect: "cliproxyapi",
      ...(provider === "openai_responses"
        ? { responsesCacheControl: true }
        : {}),
    });
    const original = new FileNativePromptCompiler({
      locale: "en",
    }).compileBootstrap(
      createMinimalFileNativePreviewInput({
        ...host.binding(),
        playerInput: "Look around",
        playerInputPlacement: "append",
      }),
    );
    const explicit = await send(
      retargetRequestForRetry(requestFor(original), host),
    );
    const messages = (explicit.messages ?? explicit.input)!;
    expect(messages[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[1]?.content?.[0]).toMatchObject({
      cache_control: { type: "ephemeral" },
    });
    expect(original.cache.breakpoints).toEqual([
      "author_instruction",
      "world_context",
    ]);

    const managed = captureHost(
      provider,
      provider === "openai_responses"
        ? { dialect: "cliproxyapi", responsesCacheControl: false }
        : {},
    );
    const disabled = retargetRequestForRetry(
      requestFor(original),
      managed.host,
    );
    expect(disabled.bootstrap.cache.breakpoints).toEqual([]);
    expect(cacheMarkerCount(await managed.send(disabled))).toBe(0);
    expect(cacheMarkerCount(disabled.bootstrap.provider)).toBe(0);
  },
);
