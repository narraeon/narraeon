import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveAppPaths } from "../../src/runtime/config/appPaths.ts";
import {
  applyPlayPresetStructuredEditor,
  builtinDefaultPlayPresetBinding,
  toPlayPresetStructuredEditor,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  RuntimeServerPool,
  availableRuntimePort,
} from "../../tests/support/runtimeServer.ts";
import { semanticCases, withSemanticFixture } from "./semantic-cases.mjs";

const protocols = ["openai_responses", "chat_completions"];
const previewProviders = ["anthropic_messages", "google_interactions"];

export async function evaluateSemantic(args) {
  const [destination, model, ...options] = args;
  if (!destination || !model) {
    throw new Error(
      "Usage: node scripts/evaluate-orchestration-editor/run.mjs --semantic NEW_OUTPUT_DIRECTORY MODEL_ID [--repo=RUNTIME_ROOT] [--cases=ID,ID] [--fixtures-only]",
    );
  }
  const output = resolve(destination);
  const selected = options.find((option) => option.startsWith("--cases="));
  const caseIds = selected?.slice("--cases=".length).split(",");
  const cases = caseIds
    ? semanticCases.filter(({ id }) => caseIds.includes(id))
    : semanticCases;
  assert(
    cases.length > 0 && (!caseIds || caseIds.length === cases.length),
    "Invalid case selection",
  );
  const rootPath = options.find((option) => option.startsWith("--repo="));
  if (rootPath) process.chdir(rootPath.slice("--repo=".length));
  const fixturesOnly = options.includes("--fixtures-only");

  const config = resolveAppPaths(process.env).configRoot;
  const library = JSON.parse(
    await readFile(join(config, "model-connections-v1.json"), "utf8"),
  );
  const profiles = protocols.map((protocol) => {
    const connection = library.connections.find(
      (entry) => entry.modelId === model && entry.provider === protocol,
    );
    assert(
      connection,
      "Missing configured connection: " + model + " / " + protocol,
    );
    return connection;
  });
  const sanitize = (value) =>
    profiles.reduce(
      (text, { apiKey, baseUrl }) =>
        [apiKey, baseUrl]
          .filter(Boolean)
          .reduce(
            (next, secret) => next.replaceAll(secret, "[redacted]"),
            text,
          ),
      value,
    );
  await mkdir(output, { mode: 0o700 });
  const save = (name, value) =>
    writeFile(
      join(output, name),
      sanitize(JSON.stringify(value, null, 2)) + "\n",
      { mode: 0o600 },
    );
  const sha256 = (data) => createHash("sha256").update(data).digest("hex");
  await save("design.json", {
    model,
    profiles: profiles.map(
      ({
        provider,
        dialect,
        reasoningEffort,
        contextWindowTokens,
        maxOutputTokens,
        modelPrompt,
      }) => ({
        provider,
        dialect,
        reasoningEffort,
        contextWindowTokens,
        maxOutputTokens,
        modelPromptHash: sha256(modelPrompt ?? ""),
      }),
    ),
    cases,
    rubricHash: sha256(
      await readFile(new URL("./semantic-rubric.md", import.meta.url)),
    ),
    systemSourceHash: sha256(
      await readFile("src/runtime/orchestration/EditorSystem.ts"),
    ),
    fixturesOnly,
  });
  const results = await Promise.allSettled(profiles.map(evaluate));
  for (const result of results)
    if (result.status === "rejected")
      throw new Error(sanitize(String(result.reason)));

  async function evaluate(profile) {
    const root = await mkdtemp(join(tmpdir(), "narraeon-375-editor-"));
    const pool = new RuntimeServerPool();
    try {
      await mkdir(join(root, "config"), { mode: 0o700 });
      await writeFile(
        join(root, "config", "model-connections-v1.json"),
        JSON.stringify({
          schemaVersion: library.schemaVersion,
          activeConnectionId: profile.id,
          connections: [profile],
        }),
        { mode: 0o600 },
      );
      const port = await availableRuntimePort();
      await pool.start(root, port);
      async function request(payload) {
        const response = await fetch(
          "http://127.0.0.1:" + port + "/api/runtime/v1",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              protocol: "narraeon.runtime/v1",
              request: payload,
            }),
            signal: AbortSignal.timeout(300_000),
          },
        );
        const envelope = await response.json();
        if (!response.ok) {
          throw new Error(
            sanitize(
              JSON.stringify({
                type: payload.type,
                status: response.status,
                error: envelope.error,
              }),
            ),
          );
        }
        return envelope.result;
      }
      const previewConnections = new Map();
      for (const provider of previewProviders) {
        const name = "Offline preview " + provider;
        const connections = await request({
          type: "model.save",
          connection: {
            presetId: "custom",
            name,
            provider,
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "offline-preview-fixture",
            modelId: "offline-preview-fixture",
            contextWindowTokens: 32768,
            maxOutputTokens: 4096,
          },
        });
        previewConnections.set(
          provider,
          connections.connections.find((connection) => connection.name === name)
            .id,
        );
      }
      const rows = [];
      for (const question of cases) {
        rows.push(await runCase(question));
        console.log(profile.provider, question.id, rows.at(-1).runStatus);
        await save("raw-" + profile.provider + ".json", rows);
      }

      async function runCase(question) {
        const row = { id: question.id, protocol: profile.provider, model };
        const started = Date.now();
        try {
          await request({ type: "preferences.save", locale: question.locale });
          const base = builtinDefaultPlayPresetBinding(question.locale);
          const files = question.fixture
            ? applyPlayPresetStructuredEditor(
                base.files,
                withSemanticFixture(
                  toPlayPresetStructuredEditor(base.definition),
                  question,
                ),
              )
            : base.files;
          const { preset } = await request({
            type: "play.create",
            name:
              question.locale === "en"
                ? "Orchestration fixture"
                : "编排方案样本",
            files,
          });
          await request({ type: "play.select", presetId: preset.id });
          const preview = (revision, options) =>
            request({
              type: "play.orchestration.preview",
              presetId: preset.id,
              revision,
              gameplay: question.gameplay,
              surface: "play",
              ...options,
            });
          const targetPreview = async (revision) => {
            await request({
              type: "model.select",
              connectionId: previewConnections.get(question.target),
            });
            try {
              return (await preview(revision)).selected;
            } finally {
              await request({ type: "model.select", connectionId: profile.id });
            }
          };
          let message = question.question;
          await request({ type: "model.select", connectionId: profile.id });
          row.beforeRevision = preset.revision;
          if (question.target) {
            const target = await targetPreview(preset.revision);
            assert.equal(target.protocol.status, question.beforeStatus);
            row.before = target;
            const summary = JSON.stringify({
              revision: target.revision,
              gameplay: target.gameplay,
              protocol: target.protocol,
              messageOrder: target.messageOrder,
              messages: target.messages.filter((item) =>
                item.entryIds.some(
                  (id) =>
                    question.inspect.includes(id) ||
                    target.protocol.conflictingIds.includes(id),
                ),
              ),
            });
            message +=
              (question.locale === "en"
                ? "\n\nTarget connection preview: "
                : "\n\n目标连接的工作台预览：") + summary;
          }
          if (question.authorTarget) {
            row.reference = {
              play: (await preview(preset.revision)).selected,
              author: (
                await preview(preset.revision, {
                  surface: "author",
                  authorTarget: question.authorTarget,
                })
              ).selected,
            };
            assert(
              row.reference.author.entries
                .find(({ builtin }) => builtin === "author.play-reference")
                ?.markdown?.includes(question.body),
            );
          }
          row.question = message;
          if (fixturesOnly) return { ...row, runStatus: "fixture-ready" };
          const payload = {
            type: "orchestration.message",
            presetId: preset.id,
            requestId: randomUUID(),
            expectedRevision: preset.revision,
            surface: "playPrompts",
            ...(question.target ? { focusedEntryId: question.inspect[0] } : {}),
            message,
            continuation: { kind: "fresh_context" },
          };
          let view = await request(payload);
          const deadline = Date.now() + 300_000;
          while (view.runStatus === "running" && Date.now() < deadline) {
            await delay(1000);
            view = await request({
              type: "orchestration.session.read",
              presetId: preset.id,
              sessionId: view.sessionId,
            });
          }
          if (view.runStatus === "running") {
            view = await request({
              type: "orchestration.cancel",
              presetId: preset.id,
              sessionId: view.sessionId,
            });
          }
          const exchanges = view.turns.flatMap((turn) => turn.exchanges);
          row.runStatus = view.runStatus;
          row.failure = view.lastFailure;
          row.finalText = exchanges.at(-1)?.text ?? "";
          row.usage = view.usage;
          row.changes = view.changes;
          row.dispatches = exchanges.map(
            ({ text, status, failure, retries, usage, toolCalls }) => ({
              text,
              status,
              failure,
              retries,
              usage,
              toolCalls,
            }),
          );
          const current = await request({ type: "play.read" });
          const saved = current.presets.find(({ id }) => id === preset.id);
          row.appliedUnchanged =
            current.currentPresetId === preset.id &&
            saved.revision === preset.revision;
          row.draftRevision = saved.draft?.revision ?? null;
          if (saved.draft && question.target) {
            row.after = {
              editor: (await preview(saved.draft.revision)).selected,
              target: await targetPreview(saved.draft.revision),
            };
          }
        } catch (error) {
          row.runStatus ??= "harness-error";
          row.harnessError = sanitize(String(error));
        }
        row.elapsedMs = Date.now() - started;
        return row;
      }
    } finally {
      await pool.stopAll();
      await rm(root, { recursive: true, force: true });
    }
  }
}
