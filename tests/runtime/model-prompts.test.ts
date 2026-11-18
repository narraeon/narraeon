import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import type {
  CopyModelConnectionResult,
  ModelConnectionLibraryView,
  SaveModelConnectionInput,
} from "../../src/protocol/modelConnections.ts";
import type {
  ContentTreeFile,
  V1AuthoringRequestPreview,
  V1PlayCallChainView,
  V1PlayContextReadingView,
  V1Request,
  V1SettingImprovementView,
  V1WorldRevisionOverview,
  V1WorldRevisionView,
} from "../../src/protocol/v1.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import type { FileNativePlayPresetView } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  FileNativePromptCompiler,
  type PromptPreview,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { firstPartyActionChoicesPresetFilesForLocale } from "../../src/shared/first-party-action-choices.ts";
import type { OrderedPlayPrompt } from "../../src/shared/ordered-play-prompts.ts";

const promptA = "MODEL-A-ONLY\n  second line\n";
const promptB = "MODEL-B-ONLY\n  replacement line\n";
const playMarker = "PLAY-MODEL-PLACEMENT-MARKER";
const authorMarker = "AUTHOR-MODEL-PLACEMENT-MARKER";
const model = {
  provider: "chat_completions",
  modelId: "same-model-id",
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_000,
} as const;
const connection: SaveModelConnectionInput = {
  ...model,
  presetId: "custom",
  name: "Connection A",
  baseUrl: "https://provider.invalid/v1",
  apiKey: "test-key",
  modelPrompt: promptA,
};

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("play uses the selected connection in preset order, freezing the tool loop, followup, retry and history", async () => {
  const { request, reconnect } = await setup();
  const { a, b } = await twoConnections(request);
  const { preset } = await request<{ preset: FileNativePlayPresetView }>({
    type: "play.create",
    name: "Test play order",
    files: firstPartyActionChoicesPresetFilesForLocale("en"),
  });
  const playPrompts = preset.structure!.playPrompts!;
  expect(playPrompts.slice(0, 2).map(({ id }) => id)).toEqual([
    "play.mechanics",
    "play.model-prompt",
  ]);
  const moved = placeModelPrompt(playPrompts, "play", playMarker, "user");
  const { preset: saved } = await savePlayPrompts(request, preset, moved);
  const { files } = await request<{ files: ContentTreeFile[] }>({
    type: "play.export",
    presetId: saved.id,
  });
  expect(JSON.stringify(files)).not.toMatch(/MODEL-[AB]-ONLY|Connection [AB]/u);
  const { preset: imported } = await request<{
    preset: FileNativePlayPresetView;
  }>({
    type: "play.import",
    name: "Portable order",
    files,
  });
  expect(imported.structure?.playPrompts).toEqual(moved);
  await request({ type: "play.select", presetId: imported.id });

  const { packageId, worldId } = await createWorld(request);
  const preview = () =>
    request<PromptPreview>({
      type: "prompt.preview",
      packageId,
      playerInput: "I look around.",
      model,
    });
  expectPlacement(await preview(), "Connection A", promptA, playMarker);

  const sent: ProviderRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, options) => {
      const payload = readProviderRequest(options?.body);
      sent.push(payload);
      if (sent.length === 1) {
        await request({ type: "model.select", connectionId: b });
        return toolResponse("context_read", { ref: "@current-situation" });
      }
      if (sent.length === 4) return response("Unfinished.", "length");
      return response("The innkeeper nods.");
    }),
  );

  const first = await request<V1PlayCallChainView>({
    type: "play.chain.start",
    worldId,
    chainId: "model-prompt-context",
    exchangeId: "profile-a",
    playerText: "I look around.",
  });
  expect(first.status).toBe("ready");
  expect(first.events.map(({ kind }) => kind)).toContain("followup");
  expect(sent).toHaveLength(3);
  for (const payload of sent) {
    expectWirePlacement(payload, promptA, promptB, playMarker, "user");
  }
  expectPlacement(await preview(), "Connection B", promptB, playMarker);

  const second = await request<V1PlayCallChainView>({
    type: "play.chain.append",
    worldId,
    chainId: "model-prompt-context",
    exchangeId: "profile-b",
    playerText: "I ask about the letter.",
  });
  expect(second).toMatchObject({ status: "interrupted", canRetry: true });
  expectWirePlacement(sent[3]!, promptB, promptA, playMarker, "user");
  expect(
    sent[0]!.messages.findIndex(({ content }) => content?.includes(promptA)),
  ).toBe(
    sent[3]!.messages.findIndex(({ content }) => content?.includes(promptB)),
  );
  await request({ type: "model.select", connectionId: a });
  const resumed = await request<V1PlayCallChainView>({
    type: "play.chain.append",
    worldId,
    chainId: "model-prompt-context",
    exchangeId: "retry-profile-b",
    playerText: "",
  });
  expect(resumed.status).toBe("ready");
  expect(sent).toHaveLength(6);
  expect(sent[4]!.messages).toEqual(sent[3]!.messages);
  expectWirePlacement(sent[5]!, promptB, promptA, playMarker, "user");

  const coldRequest = await reconnect();
  const history = await coldRequest<V1PlayContextReadingView>({
    type: "world.play-context.read",
    worldId,
  });
  expect(
    history.currentContext?.promptHistory?.map(({ bootstrap }) =>
      bootstrap.logicalMessages.flatMap(({ blocks }) =>
        blocks.filter(({ source }) => source.startsWith("model-connection:")),
      ),
    ),
  ).toEqual([
    [{ source: "model-connection:Connection A", markdown: promptA }],
    [{ source: "model-connection:Connection B", markdown: promptB }],
  ]);

  const disabled = moved.map((entry) =>
    entry.kind === "builtin" && entry.builtin === "play.model-prompt"
      ? { ...entry, enabled: false }
      : entry,
  );
  const { preset: off } = await savePlayPrompts(request, imported, disabled);
  expectNoModelPrompt(await preview());
  await savePlayPrompts(request, off, moved);
  for (const modelPrompt of [" \n\t ", ""]) {
    await request({
      type: "model.save",
      connection: { ...connection, connectionId: a, modelPrompt },
    });
    expectNoModelPrompt(await preview());
  }
});

test("setting improvement and world revision use independent author placement without repeating the future play reference", async () => {
  const { request, reconnect } = await setup();
  const { a, b } = await twoConnections(request);
  const { preset } = await request<{ preset: FileNativePlayPresetView }>({
    type: "play.create",
    name: "Test author order",
  });
  const authorPrompts = preset.structure!.authorPrompts!;
  expect(authorPrompts.slice(0, 2).map(({ id }) => id)).toEqual([
    "author.mechanics",
    "author.model-prompt",
  ]);
  const authorOrder = placeModelPrompt(
    authorPrompts,
    "author",
    authorMarker,
    "assistant",
  );
  await request({
    type: "play.save",
    presetId: preset.id,
    name: preset.name,
    files: preset.files,
    structure: { ...preset.structure, authorPrompts: authorOrder },
  });
  await request({ type: "play.select", presetId: preset.id });
  const { packageId, worldId } = await createWorld(request);
  const sent: ProviderRequest[] = [];
  const playPreviews = vi.spyOn(FileNativePromptCompiler.prototype, "preview");
  const newNote = {
    ref: "check-note",
    title: "Check note",
    summary: "A note created during a write check.",
    aliases: [],
    body: "status: active\n",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, options) => {
      sent.push(readProviderRequest(options?.body));
      if (sent.length === 1) {
        await request({ type: "model.select", connectionId: b });
        return toolResponse("setting_create", {
          ...newNote,
          path: "world/check.yaml",
        });
      }
      if (sent.length === 3) {
        await request({ type: "model.select", connectionId: a });
        return toolResponse("world_revision_create", {
          ...newNote,
          path: "state/check.yaml",
        });
      }
      return response("The proposed details are clear.");
    }),
  );

  const setting = await request<V1SettingImprovementView>({
    type: "setting-improvement.message",
    packageId,
    requestId: "setting-a",
    message: "Discuss the starting location.",
    continuation: { kind: "fresh_context" },
  });
  expect(setting.runStatus).toBe("ready");
  expect(setting.turns[0]?.exchanges[0]?.toolCalls[0]?.result?.isError).toBe(
    false,
  );
  for (const payload of sent) {
    expectWirePlacement(payload, promptA, promptB, authorMarker, "assistant");
  }
  expectModelPrompt(
    playPreviews.mock.calls.at(-1)?.[0].modelPrompt,
    "Connection A",
    promptA,
  );

  const revision = await request<V1WorldRevisionView>({
    type: "world.revision.message",
    worldId,
    requestId: "revision-b",
    message: "Discuss the working world.",
    continuation: { kind: "fresh_context" },
  });
  expect(revision.runStatus).toBe("ready");
  expect(revision.turns[0]?.exchanges[0]?.toolCalls[0]?.result?.isError).toBe(
    false,
  );
  expect(sent).toHaveLength(4);
  for (const payload of sent.slice(2)) {
    expectWirePlacement(payload, promptB, promptA, authorMarker, "assistant");
  }
  expectModelPrompt(
    playPreviews.mock.calls.at(-1)?.[0].modelPrompt,
    "Connection B",
    promptB,
  );

  const overview = await request<V1WorldRevisionOverview>({
    type: "world.revision.overview",
    worldId,
  });
  await request({
    type: "world.revision.apply",
    worldId,
    epochId: revision.epochId,
    expectedRevision: overview.epoch!.revision,
  });
  expectModelPrompt(
    playPreviews.mock.calls.at(-1)?.[0].modelPrompt,
    "Connection A",
    promptA,
  );

  const coldRequest = await reconnect();
  const settingPreview = await coldRequest<V1AuthoringRequestPreview>({
    type: "setting-improvement.request.preview",
    packageId,
    sessionId: setting.sessionId,
    requestId: "setting-a",
  });
  const revisionPreview = await coldRequest<V1AuthoringRequestPreview>({
    type: "world.revision.request.preview",
    worldId,
    sessionId: revision.sessionId,
    requestId: "revision-b",
  });
  expectPlacement(settingPreview, "Connection A", promptA, authorMarker);
  expectPlacement(revisionPreview, "Connection B", promptB, authorMarker);
});

type Request = <T>(input: V1Request) => Promise<T>;
interface ProviderRequest {
  model: string;
  messages: { role: string; content: string | null }[];
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "narraeon-model-prompts-"));
  roots.push(root);
  const reconnect = async (): Promise<Request> => {
    const runtime = new V1Runtime({
      dataRoot: join(root, "data"),
      configRoot: join(root, "config"),
    });
    await runtime.initialize();
    return async <T>(input: V1Request) =>
      (await runtime.handle(input)).result as T;
  };
  return { request: await reconnect(), reconnect };
}

async function twoConnections(request: Request) {
  const initial = await request<ModelConnectionLibraryView>({
    type: "model.save",
    connection,
  });
  const a = initial.activeConnectionId!;
  const copy = await request<CopyModelConnectionResult>({
    type: "model.copy",
    connectionId: a,
    name: "Connection B",
  });
  const b = copy.copiedConnectionId;
  expect(copy.library.connections.find(({ id }) => id === b)?.modelPrompt).toBe(
    promptA,
  );
  const edited = await request<ModelConnectionLibraryView>({
    type: "model.save",
    connection: {
      ...connection,
      connectionId: b,
      name: "Connection B",
      modelPrompt: promptB,
    },
  });
  expect(edited.connections.find(({ id }) => id === a)?.modelPrompt).toBe(
    promptA,
  );
  await request({ type: "model.select", connectionId: a });
  return { a, b };
}

async function createWorld(request: Request) {
  const { localId: packageId } = await request<{ localId: string }>({
    type: "content.create-sample",
    locale: "en",
  });
  const created = await request<{ world: { worldId: string } }>({
    type: "world.create",
    operationId: "create-model-prompt-world",
    packageId,
    model,
  });
  return { packageId, worldId: created.world.worldId };
}

function placeModelPrompt(
  entries: OrderedPlayPrompt[],
  surface: "play" | "author",
  marker: string,
  messageRole: "user" | "assistant",
): OrderedPlayPrompt[] {
  const id = surface + ".model-prompt";
  const next = entries.filter((entry) => entry.id !== id);
  next.splice(
    4,
    0,
    { kind: "builtin", id, builtin: id, enabled: true, messageRole },
    {
      kind: "user",
      id: surface + ".marker",
      name: "Placement marker",
      body: marker,
      enabled: true,
    },
  );
  return next;
}

async function savePlayPrompts(
  request: Request,
  preset: FileNativePlayPresetView,
  playPrompts: OrderedPlayPrompt[],
) {
  await request({
    type: "play.save",
    presetId: preset.id,
    name: preset.name,
    files: preset.files,
    structure: { ...preset.structure, playPrompts },
  });
  return request<{ preset: FileNativePlayPresetView }>({
    type: "play.select",
    presetId: preset.id,
  });
}

function expectPlacement(
  { compilation }: Pick<V1AuthoringRequestPreview, "compilation">,
  name: string,
  markdown: string,
  marker: string,
) {
  const messages = compilation.logicalMessages;
  const index = messages.findIndex((message) => message.markdown === markdown);
  expect(messages[index]?.blocks).toEqual([
    { source: "model-connection:" + name, markdown },
  ]);
  expect(messages[index + 1]?.markdown).toBe(marker);
}

function expectModelPrompt(
  modelPrompt: unknown,
  connectionName: string,
  markdown: string,
) {
  expect(modelPrompt).toEqual({ connectionName, markdown });
}

function expectNoModelPrompt({ compilation }: PromptPreview) {
  expect(
    compilation.logicalMessages
      .flatMap(({ blocks }) => blocks)
      .some(({ source }) => source.startsWith("model-connection:")),
  ).toBe(false);
  expect(JSON.stringify(compilation.provider)).not.toMatch(/MODEL-[AB]-ONLY/u);
}

function expectWirePlacement(
  payload: ProviderRequest,
  expected: string,
  other: string,
  marker: string,
  role: string,
) {
  expect(payload.model).toBe(model.modelId);
  const bodies = payload.messages
    .map(({ content }) => content ?? "")
    .join("\n");
  const index = payload.messages.findIndex(({ content }) =>
    content?.includes(expected),
  );
  expect(payload.messages[index]?.role).toBe(role);
  expect(payload.messages[index + 1]?.content).toContain(marker);
  expect(bodies.split(expected)).toHaveLength(2);
  expect(bodies).not.toContain(other);
}

function readProviderRequest(body: unknown): ProviderRequest {
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(body) as ProviderRequest;
}

function toolResponse(name: string, args: object) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "read-for-test",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function response(content: string, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: finishReason,
        },
      ],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}
