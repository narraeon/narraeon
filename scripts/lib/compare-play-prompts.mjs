import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";

const source = fileURLToPath(new URL("../..", import.meta.url));
const defaultLocale = "zh-CN";
const load = (root, path) =>
  import(pathToFileURL(join(root, "src", path)).href);
const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function comparePlayPrompts({
  issue,
  scenes,
  packageFiles,
  stylePath,
  removedTailLines,
  freeze,
  matrix,
  minRepeats,
  preflightOnly = false,
  defaults: {
    repeats: defaultRepeats = "2",
    concurrency: defaultConcurrency = "6",
  } = {},
  args = process.argv.slice(2),
}) {
  const [
    configPath,
    evidencePath,
    blindPath,
    repeatsArg = defaultRepeats,
    concurrencyArg = defaultConcurrency,
  ] = args;
  const arms = matrix
    ? ["baseline", "style"]
    : ["baseline", "short-tail", "style"];
  const repeats = Number(repeatsArg);
  const concurrency = Number(concurrencyArg);
  assert(
    configPath &&
      evidencePath &&
      blindPath &&
      Number.isInteger(repeats) &&
      repeats >= minRepeats &&
      Number.isInteger(concurrency) &&
      concurrency > 0,
    `Usage: node scripts/compare-play-prompts-${issue}.mjs <model-connections-v1.json> <new-private-evidence-dir> <new-blind-dir> [repeats=${defaultRepeats}] [concurrency=${defaultConcurrency}]`,
  );
  const evidence = resolve(evidencePath);
  const blind = resolve(blindPath);
  assert(
    evidence !== blind &&
      !evidence.startsWith(blind + "/") &&
      !blind.startsWith(evidence + "/"),
  );
  const tmp = await mkdtemp(join(tmpdir(), `narraeon-${issue}-`));

  let secrets = [];
  function scrub(value) {
    return secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[REDACTED]"),
      value,
    );
  }

  function redactContinuation(key, value) {
    if (
      /^(encrypted_content|signature|thoughtSignature|thought_signature)$/u.test(
        key,
      ) &&
      typeof value === "string"
    )
      return "[REDACTED]";
    return value;
  }

  async function save(root, filename, value) {
    await writeFile(
      join(root, filename),
      scrub(JSON.stringify(value, redactContinuation, 2)) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }

  async function styleOverlay(candidates) {
    const root = join(tmp, "style-compiler");
    await mkdir(root);
    await cp(join(source, "src"), join(root, "src"), { recursive: true });
    await cp(join(source, "package.json"), join(root, "package.json"));
    await symlink(
      join(source, "node_modules"),
      join(root, "node_modules"),
      "dir",
    );
    const path = join(root, "src/shared/default-preset-host.ts");
    let text = await readFile(path, "utf8");
    for (const [locale, candidate] of Object.entries(candidates)) {
      const title =
        locale === "en" ? "Prose texture and pacing" : "叙事质感与节奏";
      const pattern = new RegExp(
        '^ {2}"blocks/prose\\.md": `# ' + title + "\\n[^\\x60]*`,$",
        "mu",
      );
      assert.match(text, pattern);
      text = text.replace(
        pattern,
        () => '  "blocks/prose.md": ' + JSON.stringify(candidate) + ",",
      );
    }
    await writeFile(path, text);
    return root;
  }

  function shortTailPreset(
    base,
    { parsePlayPresetFiles, revisionForPlayPresetFiles },
  ) {
    const orchestration = parse(base.files["orchestration.yaml"]);
    orchestration.playPrompts.overrides = removedTailLines.map((builtin) => ({
      builtin,
      turnGuide: "",
    }));
    const files = {
      ...base.files,
      "orchestration.yaml": stringify(orchestration),
    };
    const parsed = parsePlayPresetFiles(files);
    assert.equal(parsed.kind, "valid");
    return {
      ...base,
      files,
      definition: parsed.definition,
      revision: revisionForPlayPresetFiles(files),
    };
  }

  async function checkpoint(worlds, worldId) {
    const { head, history, state, additionalMaterials, narrativeCheckpoint } =
      await worlds.recoverEndpoint(worldId);
    return { head, history, state, additionalMaterials, narrativeCheckpoint };
  }

  function stateChanges(before, after) {
    const index = (state) =>
      new Map(state.map(({ path, contents }) => [path, contents]));
    const left = index(before.state);
    const right = index(after.state);
    return [...new Set([...left.keys(), ...right.keys()])]
      .sort()
      .flatMap((path) => {
        const earlier = left.get(path) ?? null;
        const later = right.get(path) ?? null;
        return earlier === later
          ? []
          : [{ path, before: earlier, after: later }];
      });
  }

  function size(text) {
    return { codePoints: [...text].length, utf8Bytes: Buffer.byteLength(text) };
  }

  function parseResponsesStream(text) {
    return text.split(/\r?\n/u).flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") return [data];
      try {
        return [JSON.parse(data)];
      } catch {
        return [{ malformedData: true, ...size(data) }];
      }
    });
  }

  function providerMetadata(events) {
    const disclosures = new Map();
    const usage = [];
    for (const event of events) {
      if (typeof event !== "object" || event === null) continue;
      const payload = event.response ?? event;
      const identity = Object.fromEntries(
        [
          "model",
          "model_version",
          "system_fingerprint",
          "created",
          "created_at",
        ]
          .filter((key) => ["string", "number"].includes(typeof payload[key]))
          .map((key) => [key, payload[key]]),
      );
      if (Object.keys(identity).length)
        disclosures.set(JSON.stringify(identity), identity);
      if (
        payload.usage &&
        !usage.some(({ values }) => isDeepStrictEqual(values, payload.usage))
      )
        usage.push({
          event: event.type ?? "chat.completion.chunk",
          values: payload.usage,
        });
    }
    return {
      disclosures: [...disclosures.values()],
      usage,
      eventCount: events.length,
      malformedEvents: events.filter((event) => event?.malformedData).length,
    };
  }

  async function execute() {
    delete process.env.NARRAEON_PROVIDER_TRACE_PATH;
    await mkdir(evidence, { mode: 0o700 });
    if (!preflightOnly || !matrix) await mkdir(blind, { mode: 0o700 });
    const config = resolve(configPath);
    assert.equal(config.split(/[\\/]/u).at(-1), "model-connections-v1.json");
    const stored = JSON.parse(await readFile(config, "utf8"));
    secrets = stored.connections
      .flatMap(({ apiKey, baseUrl }) => [apiKey, baseUrl])
      .filter(Boolean);
    const { ModelConnectionStore } = await load(
      source,
      "runtime/model/ModelConnectionStore.ts",
    );
    const { FileNativeModelHost } = await load(
      source,
      "runtime/model/FileNativeModelAdapters.ts",
    );
    const { FileNativeWorldStore } = await load(
      source,
      "runtime/world/FileNativeWorldStore.ts",
    );
    const { PlayCallChain } = await load(
      source,
      "runtime/play/PlayCallChain.ts",
    );
    const presetModule = await load(
      source,
      "runtime/play/FileNativePlayPresetStore.ts",
    );
    const { FileNativePromptCompiler } = await load(
      source,
      "runtime/prompt/FileNativePromptCompiler.ts",
    );
    const connections = {};
    if (matrix) {
      for (const provider of matrix.providers) {
        const matching = stored.connections.filter(
          (item) =>
            item.provider === provider && item.modelId === matrix.modelId,
        );
        assert.equal(
          matching.length,
          1,
          `Expected one saved ${provider} connection`,
        );
        const [selected] = matching;
        const root = join(tmp, "connection-" + provider);
        await mkdir(root, { mode: 0o700 });
        await writeFile(
          join(root, "model-connections-v1.json"),
          JSON.stringify({
            schemaVersion: stored.schemaVersion,
            activeConnectionId: selected.id,
            connections: [selected],
          }),
          { mode: 0o600, flag: "wx" },
        );
        connections[provider] = await new ModelConnectionStore(root).bind();
      }
    } else {
      const active = await new ModelConnectionStore(dirname(config)).bind();
      assert.equal(
        active.provider,
        "openai_responses",
        "Use the existing Responses experiment connection",
      );
      connections[active.provider] = active;
    }
    const providers = Object.keys(connections);
    const connection = connections[providers[0]];
    for (const selected of Object.values(connections)) {
      freeze?.assertConnection(selected);
      assert(
        !selected.modelPrompt?.markdown?.trim(),
        "Select an experiment connection without a user model prompt",
      );
    }

    let frozenRequests;
    const candidate = await readFile(stylePath, "utf8");
    const candidates = { [defaultLocale]: candidate };
    if (matrix) candidates.en = await readFile(matrix.enStylePath, "utf8");
    const { FileNativePromptCompiler: StyleCompiler } = await load(
      await styleOverlay(candidates),
      "runtime/prompt/FileNativePromptCompiler.ts",
    );
    const presetsByLocale = new Map(
      [...new Set(scenes.map((scene) => scene.locale ?? defaultLocale))].map(
        (locale) => {
          const baseline = presetModule.builtinDefaultPlayPresetBinding(locale);
          return [
            locale,
            {
              baseline,
              ...(!matrix && {
                "short-tail": shortTailPreset(baseline, presetModule),
              }),
              style: baseline,
            },
          ];
        },
      ),
    );
    const binding = new FileNativeModelHost(connection).binding();
    const seeds = new Map();
    for (const scene of scenes) {
      const root = join(tmp, "seed-" + scene.id);
      const worlds = new FileNativeWorldStore(root);
      const created = await worlds.createFromContentPackage({
        operationId: `issue-${issue}-seed`,
        sourcePackageId: `synthetic-${issue}`,
        sourcePackageTitle: scene.title,
        packageFiles: packageFiles(scene),
        prompt: {
          modelBinding: binding,
          hostBinding: presetModule.presetHostBinding(
            presetsByLocale.get(scene.locale ?? defaultLocale).baseline,
          ),
        },
      });
      assert.equal(created.outcome, "created");
      const worldId = created.world.worldId;
      seeds.set(scene.id, {
        root,
        worldId,
        snapshot: await checkpoint(worlds, worldId),
      });
    }
    await save(evidence, "manifest.json", {
      ...(matrix
        ? {
            connections: Object.fromEntries(
              providers.map((provider) => {
                const selected = connections[provider];
                return [
                  provider,
                  {
                    modelBinding: new FileNativeModelHost(selected).binding(),
                    reasoningEffort: selected.reasoningEffort,
                    reasoningSummary: selected.reasoningSummary,
                    thinkingMode: selected.thinkingMode,
                    thinkingBudgetTokens: selected.thinkingBudgetTokens,
                    responsesTurnInstructions:
                      selected.responsesTurnInstructions,
                  },
                ];
              }),
            ),
            styleByLocale: Object.fromEntries(
              Object.entries(candidates).map(([lang, markdown]) => [
                lang,
                { markdown, sha256: digest(markdown) },
              ]),
            ),
          }
        : { locale: defaultLocale }),
      arms,
      repeats,
      concurrency,
      modelBinding: binding,
      removedTailLines,
      styleSha256: digest(candidate),
      ...(freeze
        ? { issue, candidate, rubric: freeze.rubric, protocol: freeze.protocol }
        : {}),
      settings: {
        dialect: connection.dialect,
        reasoningEffort: connection.reasoningEffort,
        reasoningSummary: connection.reasoningSummary,
        thinkingMode: connection.thinkingMode,
        thinkingBudgetTokens: connection.thinkingBudgetTokens,
      },
      scenes: scenes.map((scene) => ({
        ...scene,
        files: packageFiles(scene),
        snapshot: seeds.get(scene.id).snapshot,
      })),
    });

    async function run(scene, repeat, arm, offline, provider = providers[0]) {
      const id = [scene.id, ...(matrix ? [provider] : []), repeat, arm].join(
        "--",
      );
      const locale = scene.locale ?? defaultLocale;
      const seed = seeds.get(scene.id);
      const root = join(tmp, offline ? "offline-" + offline.id + "-" + id : id);
      const turns = [];
      let record;
      let error;
      let offlineRequest;
      try {
        await cp(seed.root, root, { recursive: true });
        const worlds = new FileNativeWorldStore(root);
        const playPreset = presetsByLocale.get(locale)[arm];
        const hostBinding = presetModule.presetHostBinding(playPreset);
        const compiler =
          arm === "style"
            ? new StyleCompiler({ locale })
            : new FileNativePromptCompiler({ locale });
        const chains = new PlayCallChain(worlds, compiler);
        assert.deepEqual(await checkpoint(worlds, seed.worldId), seed.snapshot);
        const nativeHost = new FileNativeModelHost(
          offline?.connection ?? connections[provider],
          async (url, init) => {
            assert(!offline, "An offline preflight cannot dispatch");
            const body =
              typeof init.body === "string" ? JSON.parse(init.body) : null;
            if (
              frozenRequests &&
              record.turn === 1 &&
              record.exchanges.length === 1
            ) {
              assert.deepEqual(
                body,
                frozenRequests.firstRequests[
                  `${scene.id}:${matrix ? provider + ":" : ""}${arm}`
                ].body,
              );
            }
            const wire = { body, ...size(init.body ?? ""), status: null };
            if (matrix) {
              const pathname = new URL(url).pathname;
              wire.endpoint =
                pathname.match(/\/(responses|chat\/completions)$/u)?.[0] ??
                "unknown";
              assert.equal(
                wire.endpoint,
                provider === "openai_responses"
                  ? "/responses"
                  : "/chat/completions",
              );
              wire.sentAt = new Date().toISOString();
            }
            record.wire.push(wire);
            const response = await fetch(url, init);
            wire.status = response.status;
            wire.contentType = response.headers.get("content-type");
            if (response.ok) {
              record.streams.push(
                response
                  .clone()
                  .text()
                  .then(
                    (raw) => {
                      const events = parseResponsesStream(raw);
                      if (matrix) {
                        wire.responseMetadata = providerMetadata(events);
                      } else {
                        wire.responseEvents = events;
                      }
                    },
                    () => {
                      wire.unreadable = true;
                    },
                  ),
              );
            }
            return response;
          },
        );
        const modelHost = {
          binding: () => nativeHost.binding(),
          modelPrompt: () => nativeHost.modelPrompt(),
          previewRequest: (request) => nativeHost.previewRequest(request),
          ...(freeze && {
            freezeRequest: (request) => nativeHost.freezeRequest(request),
            matchesBinding: (expected) => nativeHost.matchesBinding(expected),
          }),
          exchange: async (request, observer) => {
            const preview = nativeHost.previewRequest(request).body;
            const entry = {
              preview,
              previewSize: size(JSON.stringify(preview)),
              instructionsSize: size(preview.instructions ?? ""),
              compilerBudgetEstimate: request.bootstrap.budget,
              logicalMessages: request.bootstrap.logicalMessages,
              appendedKinds: request.appended.map((item) => item.kind),
            };
            record.exchanges.push(entry);
            if (offline) {
              offlineRequest = { preview, request };
              return {
                text: locale === "en" ? "Offline preflight." : "离线预检。",
              };
            }
            const response = await nativeHost.exchange(request, {
              ...observer,
              signal: AbortSignal.any([
                ...(observer?.signal ? [observer.signal] : []),
                AbortSignal.timeout(180_000),
              ]),
            });
            entry.response = {
              text: response.text,
              toolCalls: response.toolCalls,
              usage: response.usage,
              stopReason: response.stopReason,
            };
            return response;
          },
        };
        const inputs = offline ? scene.turns.slice(0, 1) : scene.turns;
        for (const [index, playerText] of inputs.entries()) {
          const before = await checkpoint(worlds, seed.worldId);
          record = {
            turn: index + 1,
            playerText,
            before,
            wire: [],
            exchanges: [],
            streams: [],
          };
          turns.push(record);
          const playInput = {
            worldId: seed.worldId,
            chainId: `prompt-${issue}`,
            exchangeId: `prompt-${issue}-${index + 1}`,
            playerText,
            modelHost,
          };
          const view =
            index === 0
              ? await chains.start({
                  ...playInput,
                  hostBinding,
                  playPreset,
                  modelBinding: nativeHost.binding(),
                })
              : await chains.append({
                  ...playInput,
                  resolvePrompt: async () => ({ hostBinding, playPreset }),
                });
          const after = await checkpoint(worlds, seed.worldId);
          const final =
            after.history.length > before.history.length &&
            after.history.at(-1)?.role === "narrator"
              ? after.history.at(-1).exactText
              : null;
          Object.assign(record, {
            after,
            runtimeStatus: view.status,
            failureCode: view.lastFailure?.code,
            finalNarrative: final,
            changes: stateChanges(before, after),
            ...(freeze && {
              playerViews: await worlds.renderPlayerViewsAtHead(
                seed.worldId,
                after.head,
              ),
            }),
            toolEvents: view.events.filter(
              ({ kind }) => kind === "tool_call" || kind === "tool_result",
            ),
          });
          // Context events are cumulative. Extract only additions for this turn.
          const previous = turns.at(-2)?.lastEventId ?? 0;
          record.toolEvents = record.toolEvents.filter(
            ({ id }) => id > previous,
          );
          record.lastEventId = Math.max(
            previous,
            ...view.events.map(({ id }) => id),
          );
          await Promise.all(record.streams);
          if (view.status !== "ready" || final === null) break;
        }
      } catch (cause) {
        error = { name: cause.name, message: cause.message };
        if (record) await Promise.all(record.streams);
      } finally {
        for (const turn of turns) delete turn.streams;
      }
      if (offline) {
        assert.equal(error, undefined);
        assert(offlineRequest, JSON.stringify(turns[0]?.failureCode));
        offline.inspect(offlineRequest.preview, offlineRequest.request);
        assert.equal(
          turns[0]?.finalNarrative,
          locale === "en" ? "Offline preflight." : "离线预检。",
        );
        return;
      }
      const status =
        !error &&
        turns.length === scene.turns.length &&
        turns.every(
          ({ runtimeStatus, finalNarrative }) =>
            runtimeStatus === "ready" && finalNarrative !== null,
        )
          ? "complete"
          : "incomplete";
      const result = {
        id,
        sceneId: scene.id,
        ...(matrix && { provider }),
        repeat,
        arm,
        status,
        error,
        turns,
      };
      await save(evidence, id + ".json", result);
      process.stdout.write(
        id +
          " " +
          status +
          " " +
          turns.map(({ wire }) => wire.length).join(",") +
          "\n",
      );
      return result;
    }

    if (freeze) {
      frozenRequests = await freeze.preflight({
        connection,
        connections,
        candidates,
        scenes,
        arms,
        run,
      });
      await save(evidence, "frozen-requests.json", frozenRequests);
      if (preflightOnly) return;
    }

    const tasks = Array.from(
      { length: repeats },
      (_, index) => index + 1,
    ).flatMap((repeat) =>
      scenes.flatMap((_, rank) => {
        const sceneIndex = matrix ? (rank + repeat - 1) % scenes.length : rank;
        const scene = scenes[sceneIndex];
        const factors = matrix
          ? arms.flatMap((_, armIndex) =>
              providers.map((provider, providerIndex) => [
                provider,
                arms[(armIndex + providerIndex) % arms.length],
              ]),
            )
          : arms.map((arm) => [providers[0], arm]);
        return factors.map((_, index) => {
          const [provider, arm] =
            factors[(index + repeat - 1 + sceneIndex) % factors.length];
          return { scene, repeat, arm, provider };
        });
      }),
    );
    const results = [];
    let next = 0;
    async function worker() {
      while (next < tasks.length) {
        const { scene, repeat, arm, provider } = tasks[next++];
        results.push(await run(scene, repeat, arm, undefined, provider));
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    const mappings = [];
    const inputChecks = [];
    const blindGroups = [];
    for (const scene of scenes) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const members = results.filter(
          (result) => result.sceneId === scene.id && result.repeat === repeat,
        );
        const anonymous = members
          .map((result) => ({ label: randomUUID().slice(0, 12), result }))
          .sort((left, right) => left.label.localeCompare(right.label));
        mappings.push(
          ...anonymous.map(({ label, result }) => ({
            label,
            ...Object.fromEntries(
              [
                "id",
                "sceneId",
                "repeat",
                "arm",
                ...(matrix ? ["provider"] : []),
              ].map((key) => [key, result[key]]),
            ),
          })),
        );
        blindGroups.push({
          scene: scene.title,
          repeat,
          opening: scene.opening,
          facts: scene.situation,
          playerInputs: scene.turns,
          readings: anonymous.map(({ label, result }) => ({
            label,
            narrative: scene.turns.map(
              (_, index) => result.turns[index]?.finalNarrative ?? null,
            ),
          })),
        });

        for (const right of members.filter(({ arm }) => arm !== "baseline")) {
          const left = members.find(
            ({ arm, provider }) =>
              arm === "baseline" && provider === right.provider,
          );
          if (matrix) {
            const check = matrix.verifyWirePair(
              scene,
              left,
              right,
              frozenRequests,
            );
            inputChecks.push({ left: left.id, right: right.id, ...check });
            continue;
          }
          const a = left.turns[0]?.wire[0]?.body;
          const b = right.turns[0]?.wire[0]?.body;
          if (!a || !b) {
            inputChecks.push({ left: left.id, right: right.id, missing: true });
            continue;
          }
          const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
          const changedRequestFields = keys.filter(
            (key) => !isDeepStrictEqual(a[key], b[key]),
          );
          inputChecks.push({
            left: left.id,
            right: right.id,
            arm: right.arm,
            changedRequestFields,
            shorterInstructions:
              right.arm === "short-tail"
                ? size(b.instructions ?? "").utf8Bytes <
                  size(a.instructions ?? "").utf8Bytes
                : undefined,
            baselineItemCount: a.input.length,
            candidateItemCount: b.input.length,
            changedItems: a.input.flatMap((item, index) =>
              isDeepStrictEqual(item, b.input[index])
                ? []
                : [{ index, role: item.role, type: item.type }],
            ),
            initialPreviewMatchesWire: [left, right].map((run) =>
              isDeepStrictEqual(
                run.turns[0].exchanges[0].preview,
                run.turns[0].wire[0].body,
              ),
            ),
            styleChangesOnlyProse:
              right.arm === "style"
                ? (() => {
                    const current = left.turns[0].exchanges[0].logicalMessages;
                    const changed = right.turns[0].exchanges[0].logicalMessages;
                    return isDeepStrictEqual(
                      current.map((item) =>
                        item.promptId === "play.prose"
                          ? changed.find(
                              ({ promptId }) => promptId === "play.prose",
                            )
                          : item,
                      ),
                      changed,
                    );
                  })()
                : undefined,
          });
        }
      }
    }
    await save(evidence, "blind-mapping.json", mappings);
    await save(evidence, "summary.json", {
      inputChecks,
      runs: results.map(({ id, status, error, turns }) => ({
        id,
        status,
        error,
        turns: turns.map(
          ({
            turn,
            runtimeStatus,
            failureCode,
            toolEvents,
            changes,
            exchanges,
            wire,
            finalNarrative,
          }) => ({
            turn,
            runtimeStatus,
            failureCode,
            narrativeSize: finalNarrative == null ? null : size(finalNarrative),
            transportStatuses: wire.map(({ status }) => status),
            tools: (toolEvents ?? []).map(({ kind, name, ok }) => ({
              kind,
              name,
              ok,
            })),
            changedPaths: (changes ?? []).map(({ path }) => path),
            usage: exchanges.map(
              ({ previewSize, instructionsSize, response }) => ({
                previewSize,
                instructionsSize,
                stopReason: response?.stopReason,
                usage: response?.usage,
              }),
            ),
          }),
        ),
      })),
    });
    if (freeze)
      await writeFile(join(blind, "rubric.md"), freeze.rubric, {
        flag: "wx",
        mode: 0o600,
      });
    const markdown = [
      "# 多轮游玩盲评",
      "",
      "每组包含相同起点和玩家输入。每段只采用存档中已提交的最终正文。〔缺〕表示该轮没有已提交正文。",
      "",
    ];
    for (const group of blindGroups) {
      markdown.push(
        `## ${group.scene} · 第 ${group.repeat} 组`,
        "",
        group.opening,
        "",
        ...group.facts.map((fact) => "- " + fact),
        "",
        "### 玩家输入",
        "",
        ...group.playerInputs.map((input, index) => `${index + 1}. ${input}`),
        "",
      );
      for (const sample of group.readings) {
        markdown.push(`### 样本 ${sample.label}`, "");
        for (const [index, narrative] of sample.narrative.entries())
          markdown.push(
            `#### 第 ${index + 1} 轮`,
            "",
            narrative ?? "〔缺〕",
            "",
          );
      }
    }
    await writeFile(join(blind, "readings.md"), scrub(markdown.join("\n")), {
      flag: "wx",
      mode: 0o600,
    });
    if (freeze && !matrix) {
      for (const scene of scenes) {
        const heading = "## " + scene.title + " ·";
        const first = markdown.findIndex((line) => line.startsWith(heading));
        const end = markdown.findIndex(
          (line, index) =>
            index > first &&
            line.startsWith("## ") &&
            !line.startsWith(heading),
        );
        await writeFile(
          join(blind, `readings-${scene.id}.md`),
          scrub(
            [
              ...markdown.slice(0, 4),
              ...markdown.slice(first, end === -1 ? undefined : end),
            ].join("\n"),
          ),
          { flag: "wx", mode: 0o600 },
        );
      }
    }
    await save(blind, "readings.json", blindGroups);
    const controlsFailed = inputChecks.some((check) => {
      if (matrix) return !check.ok;
      if (
        check.missing ||
        check.baselineItemCount !== check.candidateItemCount ||
        !check.initialPreviewMatchesWire.every(Boolean)
      )
        return true;
      if (check.arm === "short-tail")
        return (
          !check.shorterInstructions ||
          !isDeepStrictEqual(check.changedRequestFields, ["instructions"])
        );
      return (
        !check.styleChangesOnlyProse ||
        check.changedItems.length !== 1 ||
        !isDeepStrictEqual(check.changedRequestFields.sort(), [
          "input",
          "prompt_cache_key",
        ])
      );
    });
    if (controlsFailed)
      process.stderr.write(
        "First-request controls failed; inspect private summary.json.\n",
      );
    if (controlsFailed || results.some(({ status }) => status !== "complete"))
      process.exitCode = 1;
  }

  try {
    await execute();
  } catch (error) {
    process.stderr.write(scrub(error.name + ": " + error.message) + "\n");
    process.exitCode = 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
