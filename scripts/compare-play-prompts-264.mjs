import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

import {
  scenes,
  packageFiles,
} from "./fixtures/prompt-comparison-264-scenes.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const candidateFixture = new URL(
  "./fixtures/prompt-comparison-264.md",
  import.meta.url,
);
const locales = ["zh-CN", "en"];
const languageNotes = {
  "zh-CN": "故事正文全用简体中文。玩家输入的中英两行只表达一次行动或发言。",
  en: "Write the final story entirely in English. The two lines of player input are one action or utterance.",
};
const variants = ["current", "candidate"];
const load = (root, path) =>
  import(pathToFileURL(join(root, "src", path)).href);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const [
  configPath,
  evidencePath,
  repeatsArg = "3",
  concurrencyArg = "4",
  filter,
] = process.argv.slice(2);
const repeats = Number(repeatsArg);
const concurrency = Number(concurrencyArg);
const selectedScenes =
  filter === undefined ? scenes : scenes.filter((scene) => scene.id === filter);
assert(
  configPath &&
    evidencePath &&
    selectedScenes.length &&
    Number.isInteger(repeats) &&
    repeats > 0 &&
    Number.isInteger(concurrency) &&
    concurrency > 0,
  "Usage: node scripts/compare-play-prompts-264.mjs <model-connections-v1.json|--preview> <new-evidence-dir> [repeats=3] [concurrency=4] [scene-id]",
);
const preview = configPath === "--preview";
const evidence = resolve(evidencePath);
const tmp = await mkdtemp(join(tmpdir(), "narraeon-264-"));
const overlay = join(tmp, "candidate");
let apiKeys = [];
let binding;
let connection;

function scrub(value) {
  return apiKeys.reduce(
    (text, key) => text.replaceAll(key, "[REDACTED]"),
    value,
  );
}
async function save(name, data) {
  await writeFile(
    join(evidence, name),
    scrub(JSON.stringify(data, null, 2)) + "\n",
    { flag: "wx" },
  );
}

function replaceOnce(source, from, to) {
  assert.equal(
    source.split(from).length,
    2,
    "Expected exactly one candidate insertion point",
  );
  return source.replace(from, () => to);
}

async function prepareCandidate() {
  const fixture = await readFile(candidateFixture, "utf8");
  const fence = String.fromCharCode(96).repeat(3);
  const pattern = new RegExp(
    "^## (zh-CN|en) ([^\n]+)\n\n" +
      fence +
      "markdown\n([\\s\\S]*?)^" +
      fence +
      "$",
    "gm",
  );
  const entries = Object.fromEntries(locales.map((locale) => [locale, {}]));
  for (const [, locale, path, body] of fixture.matchAll(pattern)) {
    assert.equal(entries[locale][path], undefined, "Duplicate candidate block");
    entries[locale][path] = body;
  }
  const hostPath = "shared/default-preset-host.ts";
  const current = await load(source, hostPath);
  const catalog = {};
  for (const locale of locales) {
    const files = current.defaultPresetHostFilesForLocale(locale);
    const { "history-use-guidance": history, ...blocks } = entries[locale];
    assert(history);
    const functional = Object.keys(files).filter(
      (path) => path.startsWith("blocks/") && !path.startsWith("blocks/style-"),
    );
    assert.deepEqual(Object.keys(blocks).sort(), functional.sort());
    const stylePaths = Object.keys(files).filter((path) =>
      path.startsWith("blocks/style-"),
    );
    assert.equal(stylePaths.length, 6);
    catalog[locale] = { ...files, ...blocks };
    if (locale === "zh-CN") {
      for (const path of stylePaths) {
        let opening = true;
        catalog[locale][path] = files[path].replaceAll('"', () => {
          const quote = opening ? "“" : "”";
          opening = !opening;
          return quote;
        });
        assert(opening, "Unpaired straight quote in Chinese style block");
      }
    }
    const intimate = "blocks/style-intimate.md";
    const [before, after] =
      locale === "zh-CN"
        ? [
            "身体体验已经成立时，写清感受落在哪里、怎样变化；不为亲密气氛预设心跳、脸红、僵住或失语。",
            "身体体验已经成立时，写清感受落在哪里、怎样变化；可以写客观触感与本能反应，但不要为了烘托亲密气氛替玩家预设心动、脸红或失语的情感结论。",
          ]
        : [
            "When a bodily experience is established, describe where it is felt and how it changes; do not prescribe a racing heartbeat, blush, freezing or loss of speech for an intimate mood.",
            "When a physical sensation is grounded in the moment, show where it lands and how it shifts; objective touch and involuntary reactions are fine, but never script blushing, a racing heart, or speechlessness as preset romantic feelings for the player.",
          ];
    catalog[locale][intimate] = replaceOnce(
      catalog[locale][intimate],
      before,
      after,
    );
  }

  await mkdir(overlay);
  await cp(join(source, "src"), join(overlay, "src"), { recursive: true });
  await cp(join(source, "package.json"), join(overlay, "package.json"));
  await symlink(
    join(source, "node_modules"),
    join(overlay, "node_modules"),
    "dir",
  );
  const zh = JSON.stringify(catalog["zh-CN"]);
  const en = JSON.stringify(catalog.en);
  await writeFile(
    join(overlay, "src", hostPath),
    'import type { AppLocale } from "../protocol/appPreferences.ts";\n' +
      "export const defaultPresetHostFilesZhCN = " +
      zh +
      ";\n" +
      "export const defaultPresetHostFilesEn = " +
      en +
      ";\n" +
      "export const defaultPresetHostFiles = defaultPresetHostFilesEn;\n" +
      "export function defaultPresetHostFilesForLocale(locale: AppLocale): Record<string, string> {\n" +
      '  return locale === "zh-CN" ? defaultPresetHostFilesZhCN : defaultPresetHostFilesEn;\n}\n',
  );
  const historyPath = join(overlay, "src/shared/history-use-guidance.ts");
  const history = await readFile(historyPath, "utf8");
  const candidateHistory = Object.fromEntries(
    locales.map((locale) => [
      locale,
      entries[locale]["history-use-guidance"].trimEnd(),
    ]),
  );
  await writeFile(
    historyPath,
    replaceOnce(
      history,
      '  return locale === "zh-CN"',
      "  if (!legacy) return (" +
        JSON.stringify(candidateHistory) +
        ")[locale];\n" +
        '  return locale === "zh-CN"',
    ),
  );
  return digest(fixture);
}

async function runtime(root) {
  const [world, play, prompt, preset, model, documents] = await Promise.all([
    load(root, "runtime/world/FileNativeWorldStore.ts"),
    load(root, "runtime/play/PlayCallChain.ts"),
    load(root, "runtime/prompt/FileNativePromptCompiler.ts"),
    load(root, "runtime/play/FileNativePlayPresetStore.ts"),
    load(root, "runtime/model/FileNativeModelAdapters.ts"),
    load(root, "runtime/play/PlayDocumentTools.ts"),
  ]);
  return { ...world, ...play, ...prompt, ...preset, ...model, ...documents };
}

function checkpoint({
  head,
  history,
  state,
  additionalMaterials,
  narrativeCheckpoint,
}) {
  return { head, history, state, additionalMaterials, narrativeCheckpoint };
}

function stateChanges(before, after) {
  const index = (state) =>
    new Map(state.map(({ path, contents }) => [path, contents]));
  const oldFiles = index(before.state);
  const newFiles = index(after.state);
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])]
    .sort()
    .flatMap((path) => {
      const oldContents = oldFiles.get(path) ?? null;
      const newContents = newFiles.get(path) ?? null;
      return oldContents === newContents
        ? []
        : [{ path, before: oldContents, after: newContents }];
    });
}

async function runCase({ rt, scene, locale, variant, repeat, seed }) {
  const id = [scene.id, String(repeat), locale, variant].join("--");
  const root = join(tmp, id);
  await cp(seed.root, root, { recursive: true });
  try {
    const worlds = new rt.FileNativeWorldStore(root);
    const compiler = new rt.FileNativePromptCompiler({ locale });
    const playPreset = rt.builtinDefaultPlayPresetBinding(locale);
    const hostBinding = rt.presetHostBinding(playPreset);
    const before = checkpoint(await worlds.recoverEndpoint(seed.worldId));
    assert.deepEqual(before, seed.checkpoint);
    const common = {
      sceneId: scene.id,
      locale,
      variant,
      repeat,
      input: scene.input,
      turnNote: languageNotes[locale],
      before,
    };
    if (preview) {
      const world = await worlds.bindPlayCallChain(seed.worldId);
      const request = rt.createMinimalFileNativePreviewInput({
        ...binding,
        playerInput: scene.input,
        playerInputPlacement: "append",
        turnNote: languageNotes[locale],
        locale,
      });
      request.hostBinding = hostBinding;
      request.world.documentSnapshot = new rt.FileNativePlayDocuments(
        world.files,
      ).snapshot;
      request.world.additionalMaterials = world.additionalMaterials;
      request.world.history = world.history;
      await save(id + ".json", {
        ...common,
        preview: compiler.preview(request, playPreset),
      });
      return { id, status: "preview" };
    }

    const requests = [];
    const bodies = [];
    const exchanges = [];
    const provider = new rt.FileNativeModelHost(
      connection,
      async (url, init) => {
        assert(requests.length < 24, "Per-case wire request limit reached");
        const entry = {
          method: init.method,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        };
        requests.push(entry);
        // Capture the response separately from the stream the production adapter reads.
        const response = await fetch(url, init);
        entry.status = response.status;
        entry.contentType = response.headers.get("content-type");
        const index = requests.length;
        // Protocol text contains assistant messages, deltas and model metadata.
        // Error bodies can echo credentials or unrelated diagnostics.
        if (response.ok)
          bodies.push(
            response
              .clone()
              .text()
              .then(
                (body) => ({ index, body }),
                () => ({ index, unreadable: true }),
              ),
          );
        return response;
      },
    );
    const modelHost = {
      binding: () => provider.binding(),
      modelPrompt: () => provider.modelPrompt(),
      previewRequest: (request) => provider.previewRequest(request),
      exchange: async (request, observer) => {
        const record = {
          logicalMessages: request.bootstrap.logicalMessages,
          appended: request.appended,
          tools: request.tools,
        };
        exchanges.push(record);
        const response = await provider.exchange(request, {
          ...observer,
          signal: AbortSignal.any([
            observer.signal,
            AbortSignal.timeout(180_000),
          ]),
        });
        record.response = {
          text: response.text,
          toolCalls: response.toolCalls,
          usage: response.usage,
          stopReason: response.stopReason,
        };
        return response;
      },
    };
    assert.deepEqual(modelHost.binding(), binding);
    const chains = new rt.PlayCallChain(worlds, compiler);
    const view = await chains.start({
      worldId: seed.worldId,
      chainId: "issue-264-play",
      exchangeId: "issue-264-input",
      playerText: scene.input,
      turnNote: languageNotes[locale],
      hostBinding,
      playPreset,
      modelBinding: binding,
      modelHost,
    });
    const after = checkpoint(await worlds.recoverEndpoint(seed.worldId));
    const saved = (await worlds.playTimeline.readCurrent(seed.worldId))?.value;
    const status =
      view.status === "ready" &&
      after.history.length > before.history.length &&
      after.history.at(-1)?.role === "narrator"
        ? "complete"
        : "incomplete";
    await save(id + ".json", {
      ...common,
      status,
      runtimeStatus: view.status,
      failureCode: view.lastFailure?.code,
      after,
      changes: stateChanges(before, after),
      finalNarrative:
        status === "complete" ? after.history.at(-1).exactText : null,
      events: saved?.events.filter(
        (event) => event.kind === "tool_call" || event.kind === "tool_result",
      ),
      exchanges,
      requests,
      rawResponses: await Promise.all(bodies),
    });
    const toolSchema = requests[0]?.body?.tools;
    const firstBody = requests[0]?.body;
    const parameterFields = Object.fromEntries(
      Object.entries(firstBody ?? {}).filter(
        ([key]) =>
          ![
            "messages",
            "input",
            "tools",
            "instructions",
            "prompt_cache_key",
          ].includes(key),
      ),
    );
    return {
      id,
      status,
      wireRequests: requests.length,
      toolSchema,
      parameterFields,
      firstBody,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function execute() {
  // Do not inherit optional low-level provider trace file settings.
  delete process.env.NARRAEON_PROVIDER_TRACE_PATH;
  const fixtureHash = await prepareCandidate();
  const current = await runtime(source);
  const candidate = await runtime(overlay);
  if (preview) {
    binding = {
      provider: "chat_completions",
      endpointFingerprint: "preview",
      modelId: "preview",
      protocolConfigFingerprint: "preview",
      contextWindowTokens: 128_000,
      maxOutputTokens: 8192,
    };
  } else {
    const configFile = resolve(configPath);
    assert.equal(configFile.split(/[\\/]/).at(-1), "model-connections-v1.json");
    const stored = JSON.parse(await readFile(configFile, "utf8"));
    apiKeys = stored.connections.map(({ apiKey }) => apiKey).filter(Boolean);
    const { ModelConnectionStore } = await load(
      source,
      "runtime/model/ModelConnectionStore.ts",
    );
    connection = await new ModelConnectionStore(dirname(configFile)).bind();
    binding = new current.FileNativeModelHost(connection).binding();
  }

  await mkdir(evidence, { mode: 0o700 });
  const seeds = new Map();
  for (const scene of selectedScenes) {
    const root = join(tmp, "seed-" + scene.id);
    const worlds = new current.FileNativeWorldStore(root);
    const playPreset = current.builtinDefaultPlayPresetBinding("zh-CN");
    const created = await worlds.createFromContentPackage({
      operationId: "issue-264-seed",
      sourcePackageId: "synthetic-264",
      sourcePackageTitle: scene.id,
      packageFiles: packageFiles(scene),
      prompt: {
        modelBinding: binding,
        hostBinding: current.presetHostBinding(playPreset),
      },
    });
    assert.equal(created.outcome, "created");
    const worldId = created.world.worldId;
    seeds.set(scene.id, {
      root,
      worldId,
      checkpoint: checkpoint(await worlds.recoverEndpoint(worldId)),
    });
  }
  await save("manifest.json", {
    preview,
    repeats,
    concurrency,
    languageNotes,
    fixtureHash,
    modelBinding: binding,
    settings: connection && {
      dialect: connection.dialect,
      reasoningEffort: connection.reasoningEffort,
      reasoningSummary: connection.reasoningSummary,
      thinkingMode: connection.thinkingMode,
      thinkingBudgetTokens: connection.thinkingBudgetTokens,
      modelPrompt:
        connection.modelPrompt === undefined ? "absent" : "configured",
    },
    seeds: selectedScenes.map((scene) => ({
      id: scene.id,
      input: scene.input,
      files: packageFiles(scene),
      checkpoint: seeds.get(scene.id).checkpoint,
    })),
  });

  const cases = [];
  for (let repeat = 1; repeat <= repeats; repeat++)
    for (const scene of selectedScenes) {
      // Rotate launch order across repeats while keeping the four members nearby.
      const arms = locales.flatMap((locale) =>
        variants.map((variant) => ({ locale, variant })),
      );
      arms.push(...arms.splice(0, (repeat - 1) % arms.length));
      for (const { locale, variant } of arms)
        cases.push({
          rt: variant === "current" ? current : candidate,
          scene,
          locale,
          variant,
          repeat,
          seed: seeds.get(scene.id),
        });
    }
  const results = new Array(cases.length);
  let next = 0;
  async function runWorker() {
    while (next < cases.length) {
      const index = next++;
      const run = cases[index];
      const id = [run.scene.id, run.repeat, run.locale, run.variant].join("--");
      try {
        results[index] = await runCase(run);
      } catch (error) {
        await save(id + ".error.json", {
          error: error.name,
          message: error.message,
        });
        results[index] = { id, status: "error" };
      }
      process.stdout.write(id + " " + results[index].status + "\n");
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runWorker));

  const byId = new Map(results.map((result) => [result.id, result]));
  const pairs = [];
  for (const { scene, locale, variant, repeat } of cases) {
    if (variant !== "current" || preview) continue;
    const prefix = [scene.id, repeat, locale].join("--");
    const current = byId.get(prefix + "--current");
    const candidate = byId.get(prefix + "--candidate");
    const before = current.firstBody;
    const after = candidate.firstBody;
    if (!before || !after) continue;
    const field = "messages" in before ? "messages" : "input";
    const left = before[field] ?? [];
    const right = after[field] ?? [];
    pairs.push({
      id: prefix,
      sameSettings: isDeepStrictEqual(
        current.parameterFields,
        candidate.parameterFields,
      ),
      sameCacheKey: before.prompt_cache_key === after.prompt_cache_key,
      sameTools: isDeepStrictEqual(current.toolSchema, candidate.toolSchema),
      sameInstructionsField: isDeepStrictEqual(
        before.instructions,
        after.instructions,
      ),
      sameSequence: isDeepStrictEqual(
        left.map((item) => item.role ?? item.type),
        right.map((item) => item.role ?? item.type),
      ),
      changes: left.flatMap((item, index) =>
        isDeepStrictEqual(item, right[index])
          ? []
          : [{ index, current: item, candidate: right[index] }],
      ),
    });
  }
  await save("summary.json", {
    results: results.map(({ id, status, wireRequests, parameterFields }) => ({
      id,
      status,
      wireRequests,
      parameterFields,
    })),
    pairs,
  });
  if (
    results.some(({ status }) => status !== (preview ? "preview" : "complete"))
  )
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
