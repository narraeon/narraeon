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
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// #349 supplies the English Markdown and these summaries; #347 supplies Chinese Markdown.
const summaries = {
  en: "Uses detail for active changes and focus while leaving unchanged scenery in the background, separates speakers by cadence, diction, and turn-taking, and scales pacing to the moment without filler; setting documents should not imitate narrative prose style.",
  "zh-CN":
    "细节服务当下动作与信息，持续不变的旧景留在背景，多人对话以句长、用词与接话方向自然区分；篇幅随分量与玩家重心调节。设定文档无需仿写叙事腔调。",
};
const [, , englishPath, outputPath] = process.argv;
assert(
  englishPath && outputPath,
  "Usage: node scripts/verify-prose-authoring-351.mjs <issue-349-english.md> <new-output-dir>",
);
const repo = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bodies = {
  en: await readFile(englishPath, "utf8"),
  "zh-CN": await readFile(
    join(repo, "scripts/fixtures/prompt-comparison-347-style.md"),
    "utf8",
  ),
};
assert.equal(
  sha256(bodies.en),
  "7a284e6815da9ff501ba13f8068f1c0067fc743f730fb44d0b613fda9f5e4ed3",
  "Use the verbatim #349 English candidate, including its final LF",
);

const proseId = "play.prose";
const trialId = "play.prose-experiment-351-en";
const trialName = "Prose Texture and Pacing (English Trial #351)";
const englishFilename = "english-prose-trial.orchestration.json";
const model = {
  provider: "chat_completions",
  modelId: "offline-351",
  contextWindowTokens: 128_000,
  maxOutputTokens: 4096,
};
const localeEvidence = {};
const scratch = await mkdtemp(join(tmpdir(), "narraeon-351-"));
const load = (root, path) =>
  import(pathToFileURL(join(root, "src", path)).href);

async function overlay() {
  const root = join(scratch, "overlay");
  await cp(join(repo, "src"), join(root, "src"), { recursive: true });
  await cp(join(repo, "package.json"), join(root, "package.json"));
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  const path = join(root, "src/shared/ordered-play-prompts.ts");
  const source = await readFile(path, "utf8");
  const match =
    /(block\("prose", \{\n {6}category: "policy",\n {6}authorSummary:) zh\n {8}\? "[^\n]+"\n {8}: "[^\n]+",/u;
  assert.match(source, match);
  await writeFile(
    path,
    source.replace(
      match,
      (_, prefix) =>
        `${prefix} zh ? ${JSON.stringify(summaries["zh-CN"])} : ${JSON.stringify(summaries.en)},`,
    ),
  );
  const { defaultPresetHostFilesForLocale } = await load(
    root,
    "shared/default-preset-host.ts",
  );
  for (const [locale, body] of Object.entries(bodies)) {
    defaultPresetHostFilesForLocale(locale)["blocks/prose.md"] = body;
  }
  return root;
}

async function openRuntime(root, name, locale) {
  const { V1Runtime } = await load(root, "runtime/V1Runtime.ts");
  const runtime = new V1Runtime({
    dataRoot: join(scratch, name, "data"),
    configRoot: join(scratch, name, "config"),
  });
  await runtime.initialize();
  const request = async (input) => (await runtime.handle(input)).result;
  await request({ type: "preferences.save", locale });
  await request({
    type: "model.save",
    connection: {
      ...model,
      presetId: "custom",
      name: "Offline probe",
      baseUrl: "https://offline.invalid/v1",
      apiKey: "offline-probe",
    },
  });
  return request;
}

async function selectUserProse(request, defaultId, { id, name, body }) {
  const { preset } = await request({ type: "play.copy", presetId: defaultId });
  const prompts = [...preset.structure.playPrompts];
  const index = prompts.findIndex(({ id }) => id === proseId);
  const builtin = prompts[index];
  assert.equal(builtin?.builtin, proseId);
  assert.equal(builtin.enabled, true);
  prompts.splice(
    index,
    1,
    { ...builtin, enabled: false },
    {
      id,
      kind: "user",
      name,
      body,
      enabled: true,
      messageRole: builtin.messageRole ?? "system",
    },
  );
  const saved = await request({
    type: "play.save",
    presetId: preset.id,
    name,
    files: preset.files,
    structure: { ...preset.structure, playPrompts: prompts },
  });
  assert.equal(saved.currentPresetId, defaultId);
  assert.equal(saved.preset.draft.validation.status, "valid");
  await request({ type: "play.select", presetId: preset.id });
  return preset.id;
}

function matchingMessages(wire, value) {
  return wire.messages.flatMap(({ role, content }, index) =>
    typeof content === "string" && content.includes(value)
      ? [{ index, role, content }]
      : [],
  );
}

function oneMessage(wire, value) {
  const hits = matchingMessages(wire, value);
  assert.equal(
    hits.length,
    1,
    `Expected exactly one message containing ${value.split("\n")[0]}`,
  );
  assert.equal(hits[0].content.split(value).length, 2);
  return hits[0];
}

async function probe(request, locale, expected) {
  const playerText =
    locale === "en" ? "I look at the doorway." : "我看了一眼门口。";
  const { localId: packageId } = await request({
    type: "content.create-sample",
    locale,
  });
  const {
    world: { worldId },
  } = await request({
    type: "world.create",
    operationId: `create-${expected.id}`,
    packageId,
    model,
  });
  const play = await request({
    type: "prompt.preview",
    packageId,
    playerInput: playerText,
    model,
  });
  const { logicalMessages, turnGuide } = play.compilation;
  assert.equal(turnGuide.lines.length, 8);
  const playSource =
    expected.id === proseId
      ? `runtime:ordered/${proseId}`
      : `preset:prompt/${expected.id}`;
  const proseIndex = logicalMessages.findIndex(
    ({ promptId }) => promptId === expected.id,
  );
  assert.equal(logicalMessages[proseIndex - 1]?.promptId, "play.stop-beat");
  assert.equal(logicalMessages[proseIndex + 1]?.promptId, "play.scene");
  assert.deepEqual(logicalMessages[proseIndex], {
    role: "author_instruction",
    messageRole: "system",
    promptId: expected.id,
    blocks: [{ source: playSource, markdown: expected.body }],
    markdown: expected.body.trim(),
  });
  assert.equal(
    logicalMessages.some(({ promptId }) => promptId === proseId),
    expected.id === proseId,
  );

  const sent = [];
  const originalFetch = globalThis.fetch;
  const firstRequest = () => {
    assert.equal(sent.length, 1, "Expected one mock dispatch per entry point");
    return sent.pop();
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://offline.invalid/v1/chat/completions");
    assert.equal(init.method, "POST");
    sent.push(JSON.parse(init.body));
    return Response.json({
      choices: [
        {
          message: { role: "assistant", content: "Offline probe reply." },
          finish_reason: "stop",
        },
      ],
    });
  };

  try {
    const chain = await request({
      type: "play.chain.start",
      worldId,
      chainId: `chain-${expected.id}`,
      exchangeId: "first",
      playerText,
    });
    assert.equal(chain.status, "ready");
    const playWire = firstRequest();
    const prose = oneMessage(playWire, expected.body.trim());
    assert.deepEqual(
      prose,
      oneMessage(play.wireRequest.body, expected.body.trim()),
    );
    assert.equal(prose.index, proseIndex);
    assert.equal(prose.role, "system");
    assert.equal(prose.content, expected.body.trim());
    for (const summary of [
      expected.originalSummary,
      ...Object.values(summaries),
    ])
      assert.deepEqual(matchingMessages(playWire, summary), []);
    const guide = { role: "user", content: turnGuide.text };
    assert.deepEqual(playWire.messages.slice(-2), [
      play.initialAppend.provider,
      guide,
    ]);
    assert.deepEqual(
      play.wireRequest.body.messages.slice(-2),
      playWire.messages.slice(-2),
    );

    const authoring = {};
    for (const surface of ["setting-improvement", "world.revision"]) {
      const target =
        surface === "setting-improvement" ? { packageId } : { worldId };
      const session = await request({
        type: `${surface}.message`,
        ...target,
        requestId: "first",
        message: playerText,
        continuation: { kind: "fresh_context" },
      });
      assert.equal(session.runStatus, "ready");
      const wire = firstRequest();
      const preview = await request({
        type: `${surface}.request.preview`,
        ...target,
        sessionId: session.sessionId,
        requestId: "first",
      });
      const messages = preview.compilation.logicalMessages;
      const referenceIndex = messages.findIndex(
        ({ promptId }) => promptId === "author.play-reference",
      );
      const reference = messages[referenceIndex];
      assert.equal(reference.role, "world_context");
      assert.equal(preview.compilation.turnGuide, undefined);
      const source = `preset:${expected.id === proseId ? "builtin" : "prompt"}/${expected.id}`;
      const section = `### ${source}\n\n${expected.authorText}\n\n---`;
      assert(reference.markdown.includes(section));
      const message = oneMessage(wire, section);
      assert.equal(message.index, referenceIndex);
      assert.equal(message.role, "system");
      assert(
        message.content.includes(
          `<world_material>\n${reference.markdown}\n</world_material>`,
        ),
      );
      const dir = surface === "setting-improvement" ? "world/" : "state/";
      const documentNote =
        locale === "en"
          ? `Do not imitate their sentences, pacing or staged gestures in ${dir}`
          : `不要模仿这些块的句式、节奏或镜头写入 ${dir}`;
      assert(message.content.includes(documentNote));
      for (const { source: id, text } of turnGuide.lines)
        assert(message.content.includes(`- ${text} （${id}）`));
      assert.equal(
        wire.messages.filter(({ role }) => role === "user").length,
        1,
      );
      for (const forbidden of expected.absentInAuthoring)
        assert.deepEqual(matchingMessages(wire, forbidden), []);
      authoring[surface] = {
        source,
        wireMessageIndex: message.index,
        wireRole: message.role,
        referenceTextSha256: sha256(expected.authorText),
        documentNote,
      };
    }
    return {
      turnGuide,
      evidence: {
        playSource,
        playWireMessageIndex: prose.index,
        playWireRole: prose.role,
        playTextSha256: sha256(prose.content),
        guideWireMessageIndex: playWire.messages.length - 1,
        guideWireRole: guide.role,
        authoring,
      },
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function candidateHeading(locale) {
  return bodies[locale].split("\n\n")[1];
}

let englishPortable;
try {
  const future = await overlay();
  const { builtinPlayPrompts } = await load(
    repo,
    "shared/ordered-play-prompts.ts",
  );
  const { builtinPlayPrompts: futureCatalog } = await load(
    future,
    "shared/ordered-play-prompts.ts",
  );
  for (const locale of Object.keys(bodies)) {
    const { body, authorSummary } = builtinPlayPrompts(locale).find(
      ({ id }) => id === proseId,
    );
    const otherLocale = locale === "en" ? "zh-CN" : "en";
    const wrongLanguage = [
      summaries[otherLocale],
      candidateHeading(otherLocale),
    ];
    const candidateBody = bodies[locale];
    const userProse = {
      body: candidateBody,
      originalSummary: authorSummary,
      authorText: candidateBody,
      absentInAuthoring: [
        ...wrongLanguage,
        authorSummary,
        summaries[locale],
        `### preset:builtin/${proseId}\n`,
      ],
    };
    const shipped = await openRuntime(repo, `shipped-${locale}`, locale);
    const { currentPresetId: defaultId, presets } = await shipped({
      type: "play.read",
    });
    assert.equal(presets.find(({ id }) => id === defaultId)?.name, "default");
    const baseline = await probe(shipped, locale, {
      id: proseId,
      body,
      originalSummary: authorSummary,
      authorText: authorSummary,
      absentInAuthoring: [
        ...wrongLanguage,
        summaries[locale],
        candidateHeading(locale),
        body.trim(),
      ],
    });

    const promoted = await openRuntime(future, `promoted-${locale}`, locale);
    const { currentPresetId: promotedId } = await promoted({
      type: "play.read",
    });
    const builtin = await probe(promoted, locale, {
      id: proseId,
      body: candidateBody,
      originalSummary: authorSummary,
      authorText: summaries[locale],
      absentInAuthoring: [
        ...wrongLanguage,
        authorSummary,
        candidateHeading(locale),
        candidateBody.trim(),
      ],
    });
    const copied = futureCatalog(locale).find(({ id }) => id === proseId);
    const cloneId = "play.prose-clone-351";
    await selectUserProse(promoted, promotedId, {
      id: cloneId,
      name: `${copied.name} copy`,
      body: copied.body,
    });
    const clone = await probe(promoted, locale, { ...userProse, id: cloneId });

    const id = locale === "en" ? trialId : "play.prose-experiment-347";
    const name =
      locale === "en" ? trialName : "叙事质感与节奏（#347 文风试用）";
    let portable;
    if (locale === "en") {
      const presetId = await selectUserProse(shipped, defaultId, {
        id,
        name,
        body: candidateBody,
      });
      const { files } = await shipped({ type: "play.export", presetId });
      portable = JSON.stringify(files, null, 2) + "\n";
    } else {
      const path = join(
        repo,
        "docs/orchestrations/chinese-prose-trial.orchestration.json",
      );
      portable = await readFile(path, "utf8");
    }
    const files = JSON.parse(portable);
    // An independent application config checks the same import/export path a user takes.
    const importer = await openRuntime(repo, `import-${locale}`, locale);
    const { currentPresetId: preImportId, presets: originalPresets } =
      await importer({ type: "play.read" });
    const original = originalPresets.find(({ id }) => id === preImportId);
    const imported = await importer({ type: "play.import", name, files });
    assert.equal(imported.preset.validation.status, "valid");
    const { currentPresetId: postImportId, presets: updatedPresets } =
      await importer({ type: "play.read" });
    assert.equal(imported.currentPresetId, preImportId);
    assert.equal(postImportId, preImportId);
    assert.deepEqual(
      updatedPresets.find(({ id }) => id === preImportId),
      original,
    );
    const reexport = (
      await importer({ type: "play.export", presetId: imported.preset.id })
    ).files;
    assert.deepEqual(reexport, files);
    const selected = await importer({
      type: "play.select",
      presetId: imported.preset.id,
    });
    assert.equal(selected.currentPresetId, imported.preset.id);
    const trial = await probe(importer, locale, { ...userProse, id });
    await importer({ type: "play.select", presetId: preImportId });
    assert.equal(
      (await importer({ type: "play.read" })).currentPresetId,
      preImportId,
    );

    for (const candidate of [builtin, clone, trial])
      assert.deepEqual(candidate.turnGuide, baseline.turnGuide);
    if (locale === "en") englishPortable = portable;
    localeEvidence[locale] = {
      candidateSha256: sha256(candidateBody),
      summarySha256: sha256(summaries[locale]),
      portableSha256: sha256(portable),
      originalSelectionAfterImport: original.name,
      byteIdenticalPortableFiles: true,
      turnGuide: baseline.turnGuide,
      baseline: baseline.evidence,
      builtin: builtin.evidence,
      clone: clone.evidence,
      trial: trial.evidence,
    };
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const output = resolve(outputPath);
await mkdir(output);
await writeFile(join(output, englishFilename), englishPortable, { flag: "wx" });
await writeFile(
  join(output, "verification.json"),
  JSON.stringify(
    {
      protocol: model.provider,
      transport: "offline mock",
      locales: localeEvidence,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
process.stdout.write(
  `Verified English and Chinese play, setting improvement and world revision. Evidence: ${output}\n`,
);
