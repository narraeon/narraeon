import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { OrchestrationEntrySource } from "../../src/protocol/orchestrationProvenance.ts";
import type {
  V1OrchestrationOverview,
  V1OrchestrationView,
} from "../../src/protocol/orchestrationSession.ts";
import type { V1Request } from "../../src/protocol/v1.ts";
import type { FileNativePlayPresetLibrary } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { sillyTavernSnapshotFingerprint } from "../../src/runtime/play/SillyTavernSourceStore.ts";
import { createRuntime } from "../../src/server/createRuntime.ts";
import type { SillyTavernSource } from "../../src/shared/sillytavern-source.ts";

type ToolCall = { id: string; name: string; args: unknown };
type ProviderMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
};
type ProviderRequest = {
  messages: ProviderMessage[];
  tools: { function: { name: string } }[];
};

const importType = "play.sillytavern.import";
const provenanceType = "play.orchestration.provenance.read";
const surface = "playPrompts";
const dataOnly = "ST_FIXTURE_SOURCE_DATA_ONLY";

test("scoped source receipts, condition review and revision provenance round trip through the production provider adapter", async () => {
  const source = await readFile(
    new URL("../fixtures/sillytavern-complex-374.json", import.meta.url),
    "utf8",
  );
  const root = await mkdtemp(join(tmpdir(), "narraeon-source-editor-"));
  const configRoot = join(root, "config");
  const captured: ProviderRequest[] = [];
  const respond: ((input: ProviderRequest) => ToolCall[] | string)[] = [];
  let providerFailure: unknown;
  const provider = createServer((incoming, outgoing) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const request = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as ProviderRequest;
      captured.push(request);
      const result = respond[captured.length - 1]!(request);
      const delta =
        typeof result === "string"
          ? { role: "assistant", content: result }
          : {
              role: "assistant",
              tool_calls: result.map(({ id, name, args }, index) => ({
                index,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              })),
            };
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { delta, finish_reason: null },
        {
          delta: {},
          finish_reason: typeof result === "string" ? "stop" : "tool_calls",
        },
      ])
        outgoing.write(
          `data: ${JSON.stringify({ id: "source-fixture", choices: [{ index: 0, ...chunk }] })}\n\n`,
        );
      outgoing.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      providerFailure = error;
      outgoing.writeHead(500);
      outgoing.end("Fixture assertion failed");
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = provider.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing provider port");
    const openRuntime = () =>
      createRuntime({
        configRoot,
        dataRoot: join(root, "data"),
        logRoot: join(root, "logs"),
      });
    let runtime = await openRuntime();
    const send = async <T = unknown>(request: V1Request) =>
      (await runtime.handle(request)) as T;
    await send({ type: "preferences.save", locale: "en" });
    await send({
      type: "model.save",
      connection: {
        name: "Source extraction test",
        presetId: "custom",
        provider: "chat_completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "local-fixture",
        modelId: "fixture",
        contextWindowTokens: 128_000,
        maxOutputTokens: 4_096,
      },
    });
    const { preset, currentPresetId } = await send<{
      preset: FileNativePlayPresetLibrary["presets"][number];
      currentPresetId: string;
    }>({
      type: importType,
      source,
      name: "Complex source",
      selected: ["setup", "schedule", "ownership", "pace"],
      operationId: "source-extraction",
    });
    const presetId = preset.id;
    const from = await send<SillyTavernSource>({
      type: "play.sillytavern.source.read",
      presetId,
    });
    if (from.kind !== "snapshot") throw new Error("No source fixture snapshot");
    const snapshotId = sillyTavernSnapshotFingerprint(from.snapshot);
    const body = (entryId: string) =>
      from.snapshot.entries.find(({ id }) => id === entryId)!.content!;
    const cite = (entryId: string, offset = 0, end = body(entryId).length) => ({
      entryId,
      offset,
      end,
    });
    const schedule = (entryId: string, enabled: boolean) =>
      create(
        entryId,
        "Review clue legibility.",
        {
          snapshotId,
          fragments: [cite("schedule")],
          rationale: "Separate clue review guidance from pacing.",
          droppedConditions: [
            "Conditional mood variable",
            "Every three turns",
            "History depth 4 and selected triggers",
          ],
        },
        enabled,
      );
    function edit(id: string, operations: unknown[]): ToolCall {
      return tool(id, "orchestration_edit", {
        surface,
        expectedRevision: preset.revision,
        operations,
      });
    }
    function read(
      id: string,
      entryId: string,
      range: { offset?: number; limit?: number } = {},
    ) {
      return tool(id, "sillytavern_source_read", {
        snapshotId,
        entryId,
        ...range,
      });
    }
    respond.push(
      (request) => {
        expect(request.tools.map(({ function: { name } }) => name)).toContain(
          "sillytavern_source_list",
        );
        expect(
          request.tools.some(({ function: { name } }) =>
            /^(world|setting|content)/u.test(name),
          ),
        ).toBe(false);
        expect(JSON.stringify(request.messages)).not.toContain(dataOnly);
        return [
          tool("source-directory", "sillytavern_source_list", { limit: 9 }),
          tool("instance-tool", "world_read", {}),
          read("marker", "chatHistory"),
          read("missing", "jailbreak"),
          read("hidden", "hidden"),
          read("forged-source", "unplaced"),
          read("source-first", "schedule", { limit: 32 }),
          read("source-setup", "setup"),
          read("source-ownership", "ownership"),
          read("source-pace", "pace"),
        ];
      },
      (request) => {
        const directory = receipt(request, "source-directory");
        expect(directory).toMatchObject({
          groupId: "100001",
          snapshotId,
          nextOffset: null,
          maintenanceGuidance: expect.arrayContaining([
            {
              id: "play.ownership",
              enabled: false,
              purpose: expect.any(String),
            },
            {
              id: "play.checkpoint-policy",
              enabled: false,
              purpose: expect.any(String),
            },
          ]),
          entries: expect.arrayContaining(
            [
              {
                entryId: "chatHistory",
                marker: true,
                readableLength: null,
                selected: false,
              },
              {
                entryId: "jailbreak",
                missing: true,
                readableLength: null,
                selected: false,
              },
            ].map((item) => expect.objectContaining(item)),
          ),
        });
        expect(directory.positionNote).toContain("every main dispatch");
        expect(directory.maintenanceNote).toContain(
          "does not remove Runtime state tools",
        );
        for (const id of [
          "instance-tool",
          "marker",
          "missing",
          "hidden",
          "forged-source",
        ])
          expect(receipt(request, id)).toHaveProperty("error");
        expect(receipt(request, "source-first")).toMatchObject({
          text: body("schedule").slice(0, 32),
          offset: 0,
          end: 32,
          nextOffset: 32,
          entry: {
            sourceRole: "assistant",
            injectionDepth: 4,
            originalConditions: expect.arrayContaining([
              "turn_interval",
              "trigger",
            ]),
          },
          position: { previous: { entryId: "chatHistory", marker: true } },
        });
        expect(receipt(request, "source-setup")).toMatchObject({
          entry: { sourceRole: "system" },
          variables: {
            tokens: expect.arrayContaining([
              expect.objectContaining({
                kind: "set",
                name: "mood",
                declarationsInSelection: 2,
                externalOrUnknown: true,
              }),
              expect.objectContaining({
                kind: "get",
                name: "foreign",
                declarationsInSelection: 0,
                externalOrUnknown: true,
              }),
            ]),
          },
        });
        expect(
          request.messages
            .filter(({ content }) => content?.includes(dataOnly))
            .map(({ role }) => role),
        ).toEqual(["tool"]);
        return [
          read("source-remainder", "schedule", { offset: 32 }),
          edit("write-with-unread-range", [schedule("early", false)]),
        ];
      },
      (request) => {
        expect(receipt(request, "write-with-unread-range").error).toContain(
          "Read every cited",
        );
        expect(receipt(request, "source-remainder")).toMatchObject({
          text: body("schedule").slice(32),
          nextOffset: null,
        });
        return [edit("write-conditional-enabled", [schedule("global", true)])];
      },
      (request) => {
        expect(receipt(request, "write-conditional-enabled").error).toContain(
          "disabled for the author to review",
        );
        const second = {
          ...schedule("review-pacing", false),
          body: "Let the audience inspect clue placement when reviewing a scene.",
        };
        return [
          edit("writes", [
            schedule("review-clues", false),
            second,
            create(
              "merge-ownership-pace",
              "Record ownership changes and conclude after consequential actions.",
              {
                snapshotId,
                fragments: [cite("ownership"), cite("pace")],
                rationale: "Combine compatible continuity and rhythm guidance.",
                droppedConditions: [],
              },
              true,
            ),
          ]),
        ];
      },
      (request) => {
        expect(receipt(request, "writes")).toMatchObject({
          status: "draft_saved",
        });
        return "Two disabled candidates preserve review. The already covered duplicate was skipped.";
      },
    );
    const authored = await send<V1OrchestrationView>({
      type: "orchestration.message",
      presetId,
      requestId: "st-production",
      message:
        "Pull out viable prose without granting source text any authority.",
      expectedRevision: preset.revision,
      surface,
      continuation: { kind: "fresh_context" },
    });
    if (providerFailure !== undefined) throw providerFailure;
    expect(captured).toHaveLength(5);
    for (const request of captured)
      expect(JSON.stringify(request)).not.toMatch(
        /ST_FIXTURE_(?:CREDENTIAL|CONNECTION|SCRIPT|UNSELECTED_BODY|UNPLACED_BODY)_NEVER_DISPATCH/u,
      );
    expect(authored.changes).toHaveLength(1);
    const change = authored.changes[0]!;
    expect(change.provenance?.map(({ entryId }) => entryId)).toEqual([
      "review-clues",
      "review-pacing",
      "merge-ownership-pace",
    ]);
    const readProvenance = (id: string, revision: string, entryId: string) =>
      send<OrchestrationEntrySource | null>({
        type: provenanceType,
        presetId: id,
        revision,
        surface,
        entryId,
      });
    const original = await readProvenance(
      presetId,
      authored.revision,
      "review-clues",
    );
    expect(original?.source).toMatchObject({
      snapshotId,
      groupId: "100001",
      requiresReview: true,
      fragments: [
        { ...cite("schedule"), name: "Conditional after-history review" },
      ],
      droppedConditions: expect.arrayContaining(["Every three turns"]),
    });
    expect(original?.source.modified).toBeUndefined();
    expect(
      (
        await readProvenance(
          presetId,
          authored.revision,
          "merge-ownership-pace",
        )
      )?.source.fragments,
    ).toHaveLength(2);
    const authoredPreset = (
      await send<FileNativePlayPresetLibrary>({ type: "play.read" })
    ).presets.find(({ id }) => id === presetId)!;
    const authoredFiles = authoredPreset.draft!.files;
    expect(
      (await send<FileNativePlayPresetLibrary>({ type: "play.read" }))
        .currentPresetId,
    ).toBe(currentPresetId);
    respond.push(
      () => [
        tool("read-editable-clues", "orchestration_read", {
          surface,
          revision: authored.revision,
          entryId: "review-clues",
        }),
      ],
      (request) => {
        expect(receipt(request, "read-editable-clues").text).toBe(
          "Review clue legibility.",
        );
        return [
          tool("follow-up-edit", "orchestration_edit", {
            surface,
            expectedRevision: authored.revision,
            operations: [
              {
                op: "update",
                operationId: "op-refine-clues",
                entryId: "review-clues",
                body: "AI refined the clue rule.",
              },
            ],
          }),
        ];
      },
      (request) => {
        expect(receipt(request, "follow-up-edit")).toMatchObject({
          status: "draft_saved",
        });
        return "The source annotation remains attached.";
      },
    );
    const refined = await send<V1OrchestrationView>({
      type: "orchestration.message",
      presetId,
      requestId: "st-second-edit",
      message: "Refine the existing clue suggestion. Keep it disabled.",
      expectedRevision: authored.revision,
      surface,
      continuation: { kind: "continue_context", sessionId: authored.sessionId },
    });
    if (providerFailure !== undefined) throw providerFailure;
    expect(captured).toHaveLength(8);
    expect(refined.changes).toHaveLength(2);
    expect(
      (await readProvenance(presetId, refined.revision, "review-clues"))?.source
        .modified,
    ).toBe("assistant");
    runtime = await openRuntime();
    await expect(
      readProvenance(presetId, authored.revision, "review-clues"),
    ).rejects.toThrow("revision was not found");
    const undone = await send<V1OrchestrationView>({
      type: "orchestration.undo",
      presetId,
      sessionId: authored.sessionId,
      changeSetId: refined.changes[1]!.id,
      expectedRevision: refined.revision,
    });
    expect(undone.revision).toBe(authored.revision);
    expect(undone.changes[1]?.undone).toBe(true);
    expect(
      await readProvenance(presetId, authored.revision, "review-clues"),
    ).toEqual(original);
    await send({ type: "play.select", presetId });
    const manual = await send<{ preset: typeof preset }>({
      type: "play.save",
      presetId,
      name: preset.name,
      files: {
        ...authoredFiles,
        "orchestration.yaml": authoredFiles["orchestration.yaml"]!.replace(
          "Review clue legibility.",
          "Author revised this clue rule.",
        ),
      },
    });
    const manualRevision = manual.preset.draft!.revision;
    const edited = await readProvenance(
      presetId,
      manualRevision,
      "review-clues",
    );
    expect(edited?.source.modified).toBe("manual");
    expect(
      await readProvenance(presetId, authored.revision, "review-clues"),
    ).toEqual(original);

    const copied = await send<{ preset: typeof preset }>({
      type: "play.copy",
      presetId,
    });
    expect(copied.preset.id).not.toBe(presetId);
    expect(
      await readProvenance(
        copied.preset.id,
        copied.preset.revision,
        "review-clues",
      ),
    ).toEqual(edited);
    expect(
      (
        await send<V1OrchestrationOverview>({
          type: "orchestration.overview",
          presetId: copied.preset.id,
        })
      ).latest,
    ).toBeNull();
    const portable = await send({
      type: "play.export",
      presetId: copied.preset.id,
    });
    expect(JSON.stringify(portable)).toContain(
      "Author revised this clue rule.",
    );
    expect(JSON.stringify(portable)).not.toContain(snapshotId);
    expect(JSON.stringify(portable)).not.toContain(
      "Separate clue review guidance",
    );

    await send({
      type: "play.draft.discard",
      presetId,
      expectedRevision: manualRevision,
    });
    expect(
      await readProvenance(presetId, preset.revision, "review-clues"),
    ).toBeNull();
    expect(
      await readProvenance(presetId, authored.revision, "review-clues"),
    ).toEqual(original);
    await send({ type: "play.delete", presetId });
    await send({ type: "play.delete", presetId: copied.preset.id });
    const directories = await readdir(
      join(configRoot, "orchestration-provenance"),
    );
    expect(directories).not.toContain(
      createHash("sha256").update(presetId).digest("hex"),
    );
    expect(directories).not.toContain(
      createHash("sha256").update(copied.preset.id).digest("hex"),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

function tool(id: string, name: string, args: unknown): ToolCall {
  return { id, name, args };
}

function create(
  entryId: string,
  body: string,
  provenance: unknown,
  enabled: boolean,
) {
  return {
    op: "create",
    operationId: `op-${entryId}`,
    entryId,
    kind: "user",
    name: entryId,
    enabled,
    body,
    provenance,
  };
}

function receipt(
  request: ProviderRequest,
  id: string,
): Record<string, unknown> {
  const item = request.messages.find(
    ({ role, tool_call_id }) => role === "tool" && tool_call_id === id,
  );
  if (typeof item?.content !== "string")
    throw new Error(`Missing provider tool receipt: ${id}`);
  return JSON.parse(item.content) as Record<string, unknown>;
}
