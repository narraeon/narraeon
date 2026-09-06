import { describe, expect, test } from "vitest";
import { stringify } from "yaml";
import {
  ContentWorkspace,
  minimalFileNativeContentScaffold,
} from "../../src/runtime/content/ContentWorkspace.ts";

const definition = {
  id: "panel_request",
  displayName: "Panel",
  enabled: true,
  mount: "story",
  prompt: { role: "author_instruction", markdown: "prompts/panel.md" },
  artifacts: [
    {
      name: "panel",
      channel: "panel",
      strategy: "replace",
      contentType: "text/html",
      renderer: "renderers/panel.html",
      rendererRevision: "v1",
      save: "commit",
      invalidation: "explicit_clear",
    },
  ],
  maxArtifactBytes: 32768,
};
function packageFiles(followups: unknown = [definition]) {
  return [
    ...minimalFileNativeContentScaffold(),
    {
      path: "control/followups.yaml",
      contents: stringify(
        { format: "narraeon.package-followups/v1", followups },
        { aliasDuplicateObjects: false },
      ),
    },
    {
      path: "control/prompts/panel.md",
      contents: "Emit panel from the settled story.",
    },
    {
      path: "control/renderers/panel.html",
      contents: "<h2>Package renderer</h2><!-- narraeon:content -->",
    },
  ];
}

describe("内容包后置请求", () => {
  test("Runtime 检查完整声明，包括禁用项；损坏声明明确不可用，旧包无需声明", () => {
    const workspace = new ContentWorkspace("/unused-package-inspection");
    expect(
      workspace.inspectCurrentTreeContentPackage(
        minimalFileNativeContentScaffold(),
      ).status,
    ).toBe("usable");
    expect(
      workspace.inspectCurrentTreeContentPackage(packageFiles()).status,
    ).toBe("usable");
    for (const followups of [
      null,
      {},
      [{ ...definition, enabled: "false" }],
      [
        {
          ...definition,
          enabled: false,
          prompt: {
            role: "author_instruction",
            markdown: "prompts/missing.md",
          },
        },
      ],
      [definition, definition],
    ]) {
      const inspected = workspace.inspectCurrentTreeContentPackage(
        packageFiles(followups),
      );
      expect(inspected.status).toBe("needs_repair");
      expect(inspected.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid_package_followups",
            path: "control/followups.yaml",
          }),
        ]),
      );
    }
  });
});

import {
  FileNativePromptCompiler,
  createMinimalFileNativePreviewInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";
import {
  applyPlayPresetStructuredEditor,
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  toPlayPresetStructuredEditor,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { validPlayFollowup } from "../../src/runtime/prompt/PromptCompilationCodec.ts";

function presetBinding(groupEnabled = true) {
  const original = parsePlayPresetFiles(defaultPlayPresetFiles);
  if (original.kind !== "valid") throw original.error;
  const structure = toPlayPresetStructuredEditor(original.definition);
  structure.followupItems = [
    { id: "panel_request", kind: "user", enabled: true },
    { id: "package:followups", kind: "content-package", enabled: groupEnabled },
    { id: "builtin:summary", kind: "builtin", enabled: true },
  ];
  structure.extensionRefs = ["renderers/panel.html"];
  structure.followups = [
    {
      id: "panel_request",
      displayName: "Panel",
      prompt: { role: "author_instruction", path: "prompts/panel.md" },
      artifacts: [
        {
          name: "panel",
          channel: "panel",
          strategy: "replace",
          contentType: "text/html",
          renderer: "renderers/panel.html",
          rendererRevision: "v1",
          rendererMode: "document",
          save: "commit",
          invalidation: "explicit_clear",
          required: false,
          maxEmits: 1,
        },
      ],
      maxArtifactBytes: 32768,
    },
  ];
  const files = applyPlayPresetStructuredEditor(
    {
      ...defaultPlayPresetFiles,
      "prompts/panel.md": "Preset request",
      "renderers/panel.html": "<h2>Preset renderer</h2>",
    },
    structure,
  );
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "preset",
    name: "Preset",
    revision: "revision",
    files,
    definition: parsed.definition,
    scriptsEnabled: false,
  };
}
function previewInput(files = packageFiles()) {
  const input = createMinimalFileNativePreviewInput({
    provider: "chat_completions",
    modelId: "test",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
    playerInput: "Hello",
    playerInputPlacement: "append",
  });
  input.world.documentSnapshot = WorldDocumentStore.open({
    layout: "content_package",
    files,
  });
  return input;
}

test("真实编译在组位置展开并隔离同名来源，禁用保留定义但不派发；冻结资源可精确恢复", () => {
  const files = packageFiles([
    definition,
    { ...definition, id: "disabled_request", enabled: false },
    { ...definition, id: "another_request" },
  ]);
  const compiler = new FileNativePromptCompiler();
  const compiled = compiler.compilePlayCallChain(
    previewInput(files),
    presetBinding(),
  );
  expect(compiled.followups.map((item) => item.id)).toEqual([
    "panel_request",
    "package:panel_request",
    "package:another_request",
    "builtin:summary",
  ]);
  const packageRequest = compiled.followups[1]!;
  expect(packageRequest.artifacts[0]).toMatchObject({
    name: "panel",
    channel: "package:panel",
  });
  expect(packageRequest.frozenResources).toEqual({
    mount: "story",
    files: {
      "renderers/panel.html":
        "<h2>Package renderer</h2><!-- narraeon:content -->",
    },
  });
  expect(validPlayFollowup(JSON.parse(JSON.stringify(packageRequest)))).toBe(
    true,
  );
  expect(packageRequest.logicalMessages[0]?.markdown).toContain(
    "Emit panel from the settled story.",
  );
  const legacy = presetBinding();
  delete legacy.definition.followupItems;
  expect(
    compiler
      .compilePlayCallChain(previewInput(files), legacy)
      .followups.map((item) => item.id),
  ).toEqual([
    "panel_request",
    "package:panel_request",
    "package:another_request",
  ]);
  expect(packageRequest.allowedTools).toEqual([
    "artifact_emit",
    "artifact_clear",
  ]);
  expect(
    compiler.previewPlayPreset(previewInput(files), presetBinding()).playPreset
      ?.followups,
  ).toEqual(compiled.followups);
  expect(
    compiler
      .compilePlayCallChain(previewInput(files), presetBinding(false))
      .followups.map((item) => item.id),
  ).toEqual(["panel_request", "builtin:summary"]);
  expect(
    compiler
      .compilePlayCallChain(previewInput(packageFiles([])), presetBinding())
      .followups.map((item) => item.id),
  ).toEqual(["panel_request", "builtin:summary"]);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";
import { ScriptedModelHost } from "../../src/runtime/model/ModelHost.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import { projectArtifactForFrontend } from "../../src/runtime/extension/FrontendExtensionBundle.ts";
import { FileNativeWorldRevisionStore } from "../../src/runtime/world-revision/FileNativeWorldRevisionStore.ts";
import { WorldRevisionWorkspace } from "../../src/runtime/world-revision/WorldRevisionWorkspace.ts";

test("包复制/ZIP、世界复制、真实主链派发和冷恢复隔离来源；修改经世界修订发布", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-package-followups-"));
  try {
    const workspace = new ContentWorkspace(join(root, "content"));
    const source = await workspace.createCurrentTreeContentPackage();
    const files = packageFiles([
      definition,
      { ...definition, id: "disabled_request", enabled: false },
    ]);
    await workspace.replaceCurrentTreeContentPackage(source.localId, files);
    const copy = await workspace.copyCurrentTreeContentPackage(source.localId);
    const exported = await workspace.exportCurrentTreeContentPackage(
      source.localId,
    );
    const imported = await workspace.importPortableContentPackageArchive(
      exported.archive,
    );
    expect(copy.localId).not.toBe(source.localId);
    expect(imported.localId).not.toBe(copy.localId);
    for (const localId of [copy.localId, imported.localId]) {
      const read = await workspace.readCurrentTreeContentPackage(localId);
      expect(read.files).toEqual(expect.arrayContaining(files));
      expect(read.status).toBe("usable");
    }
    const worlds = new FileNativeWorldStore(root);
    const input = previewInput();
    const modelBinding = {
      ...input.modelBinding,
      endpointFingerprint: "fixture",
      protocolConfigFingerprint: "fixture",
    };
    const created = await worlds.createFromContentPackage({
      operationId: "package-world",
      sourcePackageId: source.localId,
      sourcePackageTitle: "Package world",
      packageFiles: files,
      prompt: { hostBinding: input.hostBinding, modelBinding },
    });
    if (created.outcome !== "created") throw new Error("No world");
    const worldId = created.world.worldId;
    await workspace.replaceCurrentTreeContentPackage(
      source.localId,
      packageFiles([]),
    );
    await workspace.deleteCurrentTreeContentPackage(source.localId);
    const binding = await worlds.bindPlayCallChain(worldId);
    expect(binding.files["control/renderers/panel.html"]).toBe(
      "<h2>Package renderer</h2><!-- narraeon:content -->",
    );
    const preset = presetBinding();
    preset.scriptsEnabled = true;
    const scripted = new ScriptedModelHost({
      binding: modelBinding,
      steps: [
        { outcome: "response", text: "The door opens." },
        {
          outcome: "response",
          toolCalls: [
            {
              id: "preset-panel",
              name: "artifact_emit",
              arguments: { output: "panel", payload: "PRESET OUTPUT" },
            },
          ],
        },
        {
          outcome: "response",
          toolCalls: [
            {
              id: "package-panel",
              name: "artifact_emit",
              arguments: { output: "panel", payload: "PACKAGE OUTPUT" },
            },
          ],
        },
        {
          outcome: "response",
          toolCalls: [
            {
              id: "recap",
              name: "artifact_emit",
              arguments: { output: "recap", payload: "RECAP" },
            },
          ],
        },
      ],
    });
    const artifacts = new FileNativeArtifactStore(root);
    const view = await new PlayCallChain(
      worlds,
      new FileNativePromptCompiler(),
      artifacts,
    ).start({
      worldId,
      chainId: "package-chain",
      exchangeId: "first",
      playerText: "Open",
      hostBinding: input.hostBinding,
      playPreset: preset,
      modelBinding,
      modelHost: scripted,
    });
    expect(view.status).toBe("ready");
    expect(scripted.requests).toHaveLength(4);
    expect(JSON.stringify(scripted.requests[2])).toContain("The door opens.");
    expect(JSON.stringify(scripted.requests[2])).not.toContain("PRESET OUTPUT");
    expect(JSON.stringify(scripted.requests[3])).not.toContain(
      "PACKAGE OUTPUT",
    );
    expect((await worlds.readAuthorityHistory(worldId)).commits).toHaveLength(
      2,
    );
    const restored = await new FileNativeArtifactStore(
      root,
    ).readActiveProjection(worldId);
    expect(restored.map((item) => item.channel)).toEqual(
      expect.arrayContaining(["panel", "package:panel", "builtin:summary"]),
    );
    const packageArtifact = restored.find(
      (item) => item.requestId === "package:panel_request",
    )!;
    expect(
      projectArtifactForFrontend(packageArtifact, preset).trustedLocalCode,
    ).toBe(false);
    expect(
      projectArtifactForFrontend(
        packageArtifact,
        null,
        "missing_revision",
        true,
      ).trustedLocalCode,
    ).toBe(false);
    expect(projectArtifactForFrontend(packageArtifact, null)).toMatchObject({
      status: "ready",
      mount: "story",
      renderer: {
        document: "<h2>Package renderer</h2><!-- narraeon:content -->",
        scripts: [],
      },
    });
    expect(
      projectArtifactForFrontend(
        restored.find((item) => item.requestId === "panel_request")!,
        preset,
      ),
    ).toMatchObject({
      status: "ready",
      renderer: { document: "<h2>Preset renderer</h2>" },
    });
    const revisions = new WorldRevisionWorkspace({
      worlds,
      store: new FileNativeWorldRevisionStore(root),
    });
    const epoch = await revisions.open(worldId);
    const broken = epoch.files.map((file) =>
      file.path === "control/followups.yaml"
        ? { ...file, contents: "format: broken" }
        : file,
    );
    await expect(
      revisions.replace({
        worldId,
        epochId: epoch.epochId,
        expectedRevision: epoch.revision,
        files: broken,
      }),
    ).rejects.toThrow();
    const nextFiles = epoch.files.map((file) =>
      file.path === "control/renderers/panel.html"
        ? { ...file, contents: "<h2>Revised world renderer</h2>" }
        : file,
    );
    await expect(
      revisions.replace({
        worldId,
        epochId: "unowned-epoch",
        expectedRevision: epoch.revision,
        files: nextFiles,
      }),
    ).rejects.toThrow();
    const changed = await revisions.replace({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
      files: nextFiles,
    });
    expect(
      (await worlds.readSurface(worldId, "control")).find(
        (file) => file.path === "renderers/panel.html",
      )?.contents,
    ).toContain("Package renderer");
    await revisions.apply({
      worldId,
      epochId: epoch.epochId,
      expectedRevision: changed.revision,
    });
    expect(
      (
        await new FileNativeWorldStore(root).readSurface(worldId, "control")
      ).find((file) => file.path === "renderers/panel.html")?.contents,
    ).toContain("Revised world renderer");
    expect(
      projectArtifactForFrontend(
        (
          await new FileNativeArtifactStore(root).readActiveProjection(worldId)
        ).find((item) => item.requestId === "package:panel_request")!,
        null,
      ).renderer?.document,
    ).toContain("Package renderer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { V1Runtime } from "../../src/runtime/V1Runtime.ts";

test("包脚本授权属于本地来源，导入/复制不带授权；可信预设不放行包资源，撤权与代码变化立即失效", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-package-trust-"));
  try {
    const runtime = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    const content = (await call(runtime, { type: "content.create" })) as {
      localId: string;
    };
    await call(runtime, {
      type: "content.replace",
      packageId: content.localId,
      files: packageFiles(),
    });
    expect(
      await call(runtime, {
        type: "content.scripts.read",
        packageId: content.localId,
      }),
    ).toMatchObject({ enabled: false });
    expect(
      await call(runtime, {
        type: "content.scripts.set",
        packageId: content.localId,
        enabled: true,
      }),
    ).toMatchObject({ enabled: true });
    const restarted = new V1Runtime({
      dataRoot: root,
      configRoot: join(root, "config"),
    });
    expect(
      await call(restarted, {
        type: "content.scripts.read",
        packageId: content.localId,
      }),
    ).toMatchObject({ enabled: true });
    const copy = (await call(restarted, {
      type: "content.copy",
      packageId: content.localId,
    })) as { localId: string };
    expect(
      await call(restarted, {
        type: "content.scripts.read",
        packageId: copy.localId,
      }),
    ).toMatchObject({ enabled: false });
    await call(restarted, {
      type: "content.replace",
      packageId: content.localId,
      files: packageFiles().map((file) =>
        file.path === "control/renderers/panel.html"
          ? { ...file, contents: "<script>NEW CODE</script>" }
          : file,
      ),
    });
    expect(
      await call(restarted, {
        type: "content.scripts.read",
        packageId: content.localId,
      }),
    ).toMatchObject({ enabled: false });
    expect(
      await call(restarted, {
        type: "content.scripts.set",
        packageId: content.localId,
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import type { V1Request } from "../../src/protocol/v1.ts";
async function call(runtime: V1Runtime, request: V1Request) {
  return (await runtime.handle(request)).result;
}

test("包声明拒绝伪造权限、枚举数组和不安全 YAML，停用也不能掩盖坏资源", () => {
  const workspace = new ContentWorkspace("/unused-package-strict");
  for (const entry of [
    { ...definition, scriptsEnabled: true },
    {
      ...definition,
      artifacts: [{ ...definition.artifacts[0], strategy: ["replace"] }],
    },
    { ...definition, mount: ["story"] },
    {
      ...definition,
      enabled: false,
      artifacts: [
        { ...definition.artifacts[0], assets: ["assets/missing.css"] },
      ],
    },
  ])
    expect(
      workspace.inspectCurrentTreeContentPackage(packageFiles([entry])).status,
    ).toBe("needs_repair");
  for (const declaration of [
    "format: narraeon.package-followups/v1\nfollowups: &items []",
    "format: narraeon.package-followups/v1\nfollowups: []\nfollowups: []",
    "format: narraeon.package-followups/v1\nfollowups: !!seq []",
  ]) {
    const files = packageFiles().map((file) =>
      file.path === "control/followups.yaml"
        ? { ...file, contents: declaration }
        : file,
    );
    expect(workspace.inspectCurrentTreeContentPackage(files).status).toBe(
      "needs_repair",
    );
  }
});

test("世界在创建/分叉发布时独立复制本地源码授权，源包撤权不污染世界，资源变化不继承旧授权", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-package-grants-"));
  try {
    const content = new ContentWorkspace(root);
    const source = await content.createCurrentTreeContentPackage();
    await content.replaceCurrentTreeContentPackage(
      source.localId,
      packageFiles(),
    );
    await content.packageScriptPermissions(source.localId, true);
    const worlds = new FileNativeWorldStore(root);
    const preview = previewInput();
    const creation = {
      sourcePackageId: source.localId,
      sourcePackageTitle: "Trusted source",
      packageFiles: packageFiles(),
      prompt: {
        hostBinding: preview.hostBinding,
        modelBinding: preview.modelBinding,
      },
    };
    const one = await worlds.createFromContentPackage({
      ...creation,
      operationId: "grant-one",
      packageScriptGrants: await content.readPackageScriptGrants(
        source.localId,
      ),
    });
    const two = await worlds.createFromContentPackage({
      ...creation,
      operationId: "grant-two",
    });
    await content.packageScriptPermissions(source.localId, false);
    expect(await worlds.packageScriptPermissions(one.world.worldId)).toEqual({
      enabled: true,
    });
    expect(await worlds.packageScriptPermissions(two.world.worldId)).toEqual({
      enabled: false,
    });
    const fork = await worlds.deriveWorld({
      operationId: "grant-fork",
      sourceWorldId: one.world.worldId,
      sourceHead: "genesis",
      hostPresetId: preview.hostBinding.hostPresetId,
    });
    await worlds.packageScriptPermissions(one.world.worldId, false);
    expect(
      await new FileNativeWorldStore(root).packageScriptPermissions(
        fork.world.worldId,
      ),
    ).toEqual({ enabled: true });
    expect(await worlds.packageScriptPermissions(one.world.worldId)).toEqual({
      enabled: false,
    });
    await worlds.packageScriptPermissions(one.world.worldId, true);
    const revisions = new WorldRevisionWorkspace({
      worlds,
      store: new FileNativeWorldRevisionStore(root),
    });
    const epoch = await revisions.open(one.world.worldId);
    const revised = await revisions.replace({
      worldId: one.world.worldId,
      epochId: epoch.epochId,
      expectedRevision: epoch.revision,
      files: epoch.files.map((file) =>
        file.path === "control/renderers/panel.html"
          ? { ...file, contents: "<main>Changed executable source</main>" }
          : file,
      ),
    });
    await revisions.apply({
      worldId: one.world.worldId,
      epochId: epoch.epochId,
      expectedRevision: revised.revision,
    });
    expect(await worlds.packageScriptPermissions(one.world.worldId)).toEqual({
      enabled: false,
    });
    expect(await worlds.packageScriptPermissions(fork.world.worldId)).toEqual({
      enabled: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
