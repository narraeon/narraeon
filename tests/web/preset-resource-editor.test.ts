import { expect, test } from "vitest";
import {
  editPresetResources,
  presetResourceUsage,
  type PresetResourceDraft,
} from "../../src/web/preset-resource-editor.ts";

function fixture(): PresetResourceDraft {
  return {
    files: {
      "prompts/request.md": "Generate outputs.",
      "assets/shared.css": "body {}",
    },
    structure: {
      name: "test",
      callChainPath: "call-chain.yaml",
      mounts: [],
      playerViewPanels: [],
      extensionRefs: [],
      narrativePrompts: [],
      followups: [
        {
          id: "request",
          displayName: "Request",
          prompt: { role: "author_instruction", path: "prompts/request.md" },
          maxArtifactBytes: 32768,
          artifacts: [
            {
              name: "status",
              channel: "shared",
              strategy: "replace",
              contentType: "text/markdown",
              save: "commit",
              invalidation: "never",
              required: false,
              maxEmits: 1,
            },
          ],
        },
      ],
    },
  };
}
const target = {
  kind: "artifact",
  requestId: "request",
  output: "status",
} as const;

test("binding an existing resource updates its declaration and index as one draft", () => {
  const draft = fixture();
  const before = structuredClone(draft);
  const next = editPresetResources(draft, {
    type: "display",
    target,
    edit: { type: "bind", kind: "assets", path: "assets/shared.css" },
  });
  expect(next.structure.followups[0]!.artifacts[0]!.assets).toEqual([
    "assets/shared.css",
  ]);
  expect(next.structure.extensionRefs).toEqual(["assets/shared.css"]);
  expect(next.files).toEqual(before.files);
  expect(draft).toEqual(before);
});

test.each(["artifact", "panel"] as const)(
  "creating and unlinking a %s resource preserves shared files and index",
  (kind) => {
    const draft = fixture();
    draft.structure.playerViewPanels = [
      {
        id: "panel",
        source: { kind: "player_view", view: "status" },
        channel: "panel",
        key: "current",
        mount: "sidebar",
        rendererMode: "document",
        config: {
          layout: "stack",
          theme: "default",
          empty: "hide",
          emptyMessage: "",
          groups: [],
        },
      },
    ];
    const displayTarget =
      kind === "artifact" ? target : ({ kind: "panel", id: "panel" } as const);
    const next = editPresetResources(draft, {
      type: "display",
      target: displayTarget,
      edit: {
        type: "create",
        kind: "renderer",
        name: "雾港",
        suffix: "html",
        body: "<main>Mist</main>",
      },
    });
    const display =
      kind === "artifact"
        ? next.structure.followups[0]!.artifacts[0]!
        : next.structure.playerViewPanels[0]!;
    const path = display.renderer!;
    expect(path).toMatch(
      /^renderers\/named-_u96fe__u6e2f_\.[a-f0-9-]+\.html$/u,
    );
    expect(next.files[path]).toBe("<main>Mist</main>");
    expect(next.structure.extensionRefs).toEqual([path]);
    const otherTarget =
      kind === "artifact" ? ({ kind: "panel", id: "panel" } as const) : target;
    const shared = editPresetResources(next, {
      type: "display",
      target: otherTarget,
      edit: { type: "bind", kind: "renderer", path },
    });
    const unlinked = editPresetResources(shared, {
      type: "display",
      target: displayTarget,
      edit: { type: "unbind", kind: "renderer", path },
    });
    const current =
      kind === "artifact"
        ? unlinked.structure.followups[0]!.artifacts[0]!
        : unlinked.structure.playerViewPanels[0]!;
    const other =
      kind === "artifact"
        ? unlinked.structure.playerViewPanels[0]!
        : unlinked.structure.followups[0]!.artifacts[0]!;
    expect(current.renderer).toBeUndefined();
    expect(current.rendererRevision).toBeUndefined();
    expect(current.rendererMode).toBe("document");
    expect(other.renderer).toBe(path);
    expect(unlinked.files[path]).toBe("<main>Mist</main>");
    expect(unlinked.structure.extensionRefs).toEqual([path]);
  },
);

test("deleting a resource checks the current declarations and other source before changing files or index", () => {
  const draft = fixture();
  const bound = editPresetResources(draft, {
    type: "display",
    target,
    edit: { type: "bind", kind: "assets", path: "assets/shared.css" },
  });
  expect(() =>
    editPresetResources(bound, {
      type: "delete-resource",
      path: "assets/shared.css",
    }),
  ).toThrow(/referenced/u);
  const unlinked = editPresetResources(bound, {
    type: "display",
    target,
    edit: { type: "unbind", kind: "assets", path: "assets/shared.css" },
  });
  unlinked.files["scripts/consumer.js"] =
    'window.__NARRAEON_ASSETS__["assets/shared.css"]';
  const before = structuredClone(unlinked);
  expect(() =>
    editPresetResources(unlinked, {
      type: "delete-resource",
      path: "assets/shared.css",
    }),
  ).toThrow(/scripts\/consumer.js/u);
  expect(unlinked).toEqual(before);
  delete unlinked.files["scripts/consumer.js"];
  // Stale serialized structure is superseded by the editable declaration tree.
  unlinked.files["preset.yaml"] = 'extensions: ["assets/shared.css"]';
  const removed = editPresetResources(unlinked, {
    type: "delete-resource",
    path: "assets/shared.css",
  });
  expect(removed.files["assets/shared.css"]).toBeUndefined();
  expect(removed.structure.extensionRefs).toEqual([]);
  expect(removed.files["preset.yaml"]).toBe(unlinked.files["preset.yaml"]);
});

test("removing outputs and requests cleans only their unused channels, retaining shared and unrelated mounts and files", () => {
  const draft = fixture();
  const request = draft.structure.followups[0]!;
  request.artifacts.push({
    ...request.artifacts[0]!,
    name: "extra",
    channel: "private",
  });
  draft.structure.followups.push({
    ...request,
    id: "other",
    artifacts: [{ ...request.artifacts[0]!, name: "other" }],
  });
  draft.structure.mounts = [
    { channel: "shared", mount: "sidebar" },
    { channel: "private", mount: "story" },
    { channel: "unrelated", mount: "overlay" },
  ];
  const removed = editPresetResources(draft, {
    type: "remove-artifact",
    requestId: "request",
    output: "extra",
  });
  expect(removed.structure.mounts).toEqual([
    { channel: "shared", mount: "sidebar" },
    { channel: "unrelated", mount: "overlay" },
  ]);
  const one = editPresetResources(draft, {
    type: "remove-followup",
    id: "request",
  });
  expect(one.structure.mounts).toEqual(removed.structure.mounts);
  expect(one.files).toEqual(draft.files);
  expect(
    one.structure.followupItems?.some((item) => item.id === "request"),
  ).toBe(false);
  const all = editPresetResources(one, {
    type: "remove-followup",
    id: "other",
  });
  expect(all.structure.mounts).toEqual([
    { channel: "unrelated", mount: "overlay" },
  ]);
});

test("cloning a request copies direct resources once, preserves output names and settings, and remaps shared channels and mounts", () => {
  const draft = fixture();
  const source = draft.structure.followups[0]!;
  source.artifacts[0]!.renderer = "renderers/view.html";
  source.artifacts[0]!.rendererRevision = "exact-revision";
  source.artifacts[0]!.rendererMode = "app";
  source.artifacts[0]!.assets = ["assets/shared.css"];
  source.artifacts.push({
    ...source.artifacts[0]!,
    name: "another",
    purpose: "Offer actions",
  });
  draft.files["renderers/view.html"] = "<main>Mist</main>";
  draft.structure.mounts = [{ channel: "shared", mount: "composer_below" }];
  const before = structuredClone(draft);
  const next = editPresetResources(draft, {
    type: "clone-followup",
    source: "request",
    id: "copy",
  });
  const clone = next.structure.followups[1]!;
  expect(clone.id).toBe("copy");
  expect(clone.prompt.path).not.toBe(source.prompt.path);
  expect(next.files[clone.prompt.path]).toBe("Generate outputs.");
  expect(clone.artifacts.map((artifact) => artifact.name)).toEqual([
    "status",
    "another",
  ]);
  expect(clone.artifacts[1]!.purpose).toBe("Offer actions");
  expect(clone.artifacts[0]!.rendererRevision).toBe("exact-revision");
  expect(clone.artifacts[0]!.rendererMode).toBe("app");
  expect(clone.artifacts[0]!.channel).not.toBe("shared");
  expect(clone.artifacts[1]!.channel).toBe(clone.artifacts[0]!.channel);
  expect(next.structure.mounts).toEqual([
    { channel: "shared", mount: "composer_below" },
    { channel: clone.artifacts[0]!.channel, mount: "composer_below" },
  ]);
  const renderer = clone.artifacts[0]!.renderer!;
  const css = clone.artifacts[0]!.assets![0]!;
  expect(renderer).not.toBe("renderers/view.html");
  expect(clone.artifacts[1]!.renderer).toBe(renderer);
  expect(clone.artifacts[1]!.assets).toEqual([css]);
  expect(next.files[renderer]).toBe("<main>Mist</main>");
  expect(next.structure.extensionRefs).toEqual([renderer, css]);
  expect(draft).toEqual(before);
});

test("cloning follows cyclic and repeated static source references and rewrites overlapping paths in one pass", () => {
  const draft = fixture();
  const source = draft.structure.followups[0]!;
  source.artifacts[0]!.renderer = "renderers/view.html";
  source.artifacts[0]!.scripts = ["scripts/view.js"];
  source.artifacts[0]!.regex = "regex/display.yaml";
  source.artifacts[0]!.assets = ["assets/data", "assets/data.json"];
  draft.files["prompts/request.md"] =
    'Use "assets/data.json" and "assets/data".';
  draft.files["renderers/view.html"] =
    '<link href="assets/style.css"><!-- scripts/view.js -->';
  draft.files["assets/style.css"] = "/* assets/data.json */";
  draft.files["regex/display.yaml"] = "rules: []\n# assets/data.json";
  draft.files["scripts/view.js"] =
    'const a = window.__NARRAEON_ASSETS__["assets/data"]; const b = "assets/data.json"; const again = "assets/data";';
  draft.files["assets/data"] = '{"next":"assets/data.json"}';
  draft.files["assets/data.json"] = '{"back":"scripts/view.js"}';
  const before = structuredClone(draft);
  const next = editPresetResources(draft, {
    type: "clone-followup",
    source: "request",
    id: "copy",
  });
  const clone = next.structure.followups[1]!;
  const renderer = clone.artifacts[0]!.renderer!;
  const script = clone.artifacts[0]!.scripts![0]!;
  const regex = clone.artifacts[0]!.regex!;
  const [data, json] = clone.artifacts[0]!.assets!;
  const style = next.structure.extensionRefs.find((path) =>
    path.endsWith("-style.css"),
  )!;
  expect(next.files[renderer]).toBe(`<link href="${style}"><!-- ${script} -->`);
  expect(next.files[script]).toBe(
    `const a = window.__NARRAEON_ASSETS__["${data}"]; const b = "${json}"; const again = "${data}";`,
  );
  expect(next.files[data!]).toBe(`{"next":"${json}"}`);
  expect(next.files[json!]).toBe(`{"back":"${script}"}`);
  expect(next.files[style]).toBe(`/* ${json} */`);
  expect(next.files[regex]).toBe(`rules: []\n# ${json}`);
  expect(next.files[clone.prompt.path]).toBe(`Use "${json}" and "${data}".`);
  expect(new Set(next.structure.extensionRefs).size).toBe(6);
  const second = editPresetResources(next, {
    type: "clone-followup",
    source: "request",
    id: "copy_again",
  });
  const secondRefs = second.structure.extensionRefs.filter(
    (path) => !next.structure.extensionRefs.includes(path),
  );
  expect(secondRefs).toHaveLength(6);
  expect(
    secondRefs.some((path) => next.structure.extensionRefs.includes(path)),
  ).toBe(false);
  expect(second.structure.followups[2]!.artifacts[0]!.renderer).not.toBe(
    renderer,
  );
  for (const [path, body] of Object.entries(next.files))
    expect(second.files[path]).toBe(body);
  expect(draft).toEqual(before);
});

test("creating a followup and a script example publishes prompt, declarations, mounts and resources together", () => {
  const empty = fixture();
  empty.structure.followups = [];
  const created = editPresetResources(empty, {
    type: "create-followup",
    id: "new",
    displayName: "New request",
    body: "Generate a recap.",
  });
  const request = created.structure.followups[0]!;
  expect(created.files[request.prompt.path]).toBe("Generate a recap.");
  expect(created.structure.followupItems).toContainEqual({
    kind: "user",
    id: "new",
    enabled: true,
  });
  expect(created.structure.mounts).toEqual([
    { channel: "new.output_1", mount: "story" },
  ]);
  const example = {
    artifact: {
      ...request.artifacts[0]!,
      name: "actions",
      channel: "new.actions",
      renderer: "renderers/actions.html",
      scripts: ["scripts/actions.js"],
      assets: ["assets/actions.css"],
    },
    files: {
      "renderers/actions.html": "<main></main>",
      "scripts/actions.js": "// JS",
      "assets/actions.css": "body {}",
    },
  };
  const next = editPresetResources(created, {
    type: "add-artifact",
    requestId: "new",
    ...example,
    mount: "composer_below",
  });
  expect(next.structure.followups[0]!.artifacts[1]).toEqual(example.artifact);
  expect(next.structure.mounts).toContainEqual({
    channel: "new.actions",
    mount: "composer_below",
  });
  expect(next.structure.extensionRefs).toEqual([
    "renderers/actions.html",
    "scripts/actions.js",
    "assets/actions.css",
  ]);
  for (const [path, body] of Object.entries(example.files))
    expect(next.files[path]).toBe(body);
  expect(created.structure.followups[0]!.artifacts).toHaveLength(1);
});

test.each(["prompts/request.md", "renderers/view.html", "assets/missing.json"])(
  "missing clone resource %s rejects the entire operation",
  (path) => {
    const draft = fixture();
    draft.structure.followups[0]!.artifacts[0]!.renderer =
      "renderers/view.html";
    draft.files["renderers/view.html"] = '<main>"assets/missing.json"</main>';
    draft.files["assets/missing.json"] = "{}";
    delete draft.files[path];
    const before = structuredClone(draft);
    expect(() =>
      editPresetResources(draft, {
        type: "clone-followup",
        source: "request",
        id: "copy",
      }),
    ).toThrow(path);
    expect(draft).toEqual(before);
  },
);

test("static path recognition excludes remote, absolute, relative and dynamic paths and retains full longer names", () => {
  const draft = fixture();
  draft.structure.followups[0]!.artifacts[0]!.scripts = ["scripts/view.js"];
  draft.files["scripts/view.js"] =
    'const query = "assets/missing.json?cache=1"; const remote = "https://example.com/assets/shared.css"; const absolute = "/assets/shared.css"; const relative = "./assets/shared.css"; const dynamic = `assets/${name}.css`; const prefix = `assets/shared${suffix}.css`; const longer = "assets/shared.css.extra";';
  draft.files["assets/shared.css.extra"] = "long";
  const cloned = editPresetResources(draft, {
    type: "clone-followup",
    source: "request",
    id: "copy",
  });
  const script = cloned.structure.followups[1]!.artifacts[0]!.scripts![0]!;
  const longer = cloned.structure.extensionRefs.find((path) =>
    path.endsWith("-shared.css.extra"),
  )!;
  expect(cloned.files[script]).toContain(`const longer = "${longer}"`);
  expect(cloned.files[script]).toContain(
    "const prefix = `assets/shared${suffix}.css`",
  );
  expect(cloned.files[script]).toContain(
    "https://example.com/assets/shared.css",
  );
  expect(cloned.structure.extensionRefs).toHaveLength(2);
  const removed = editPresetResources(draft, {
    type: "delete-resource",
    path: "assets/shared.css",
  });
  expect(removed.files["assets/shared.css"]).toBeUndefined();
});

test("missing bind and conflicting example files never change the original draft", () => {
  const draft = fixture();
  const before = structuredClone(draft);
  expect(() =>
    editPresetResources(draft, {
      type: "display",
      target,
      edit: { type: "bind", kind: "scripts", path: "scripts/missing.js" },
    }),
  ).toThrow("scripts/missing.js");
  expect(() =>
    editPresetResources(draft, {
      type: "add-artifact",
      requestId: "request",
      artifact: { ...draft.structure.followups[0]!.artifacts[0]!, name: "new" },
      files: { "assets/first.css": "new", "assets/shared.css": "overwrite" },
    }),
  ).toThrow("assets/shared.css");
  expect(draft).toEqual(before);
});

test("creating and removing a pure interface panel retains its resources and unrelated channel configuration", () => {
  const draft = fixture();
  const created = editPresetResources(draft, {
    type: "create-panel",
    id: "panel",
    title: "World status",
    emptyMessage: "No data",
  });
  expect(created.structure.playerViewPanels[0]).toMatchObject({
    id: "panel",
    source: { kind: "player_view", view: "status" },
    mount: "sidebar",
    rendererMode: "document",
    config: { title: "World status" },
  });
  const bound = editPresetResources(created, {
    type: "display",
    target: { kind: "panel", id: "panel" },
    edit: { type: "bind", kind: "assets", path: "assets/shared.css" },
  });
  const removed = editPresetResources(bound, {
    type: "remove-panel",
    id: "panel",
  });
  expect(removed.structure.playerViewPanels).toEqual([]);
  expect(removed.files).toEqual(draft.files);
  expect(removed.structure.extensionRefs).toEqual(["assets/shared.css"]);
});

test.each(["create-followup", "clone-followup"] as const)(
  "%s refuses an existing identity or prompt instead of overwriting it",
  (type) => {
    const draft = fixture();
    const action =
      type === "create-followup"
        ? { type, id: "request", displayName: "Duplicate", body: "Overwrite" }
        : { type, id: "request", source: "request" };
    const before = structuredClone(draft);
    expect(() => editPresetResources(draft, action)).toThrow(/already exists/u);
    expect(draft).toEqual(before);
  },
);

test("cloning the system recap retains its runtime story mount and makes a complete editable user request", () => {
  const draft = fixture();
  const next = editPresetResources(draft, {
    type: "clone-followup",
    source: "builtin:summary",
    id: "recap_copy",
  });
  const clone = next.structure.followups[1]!;
  expect(clone.artifacts[0]!.name).toBe("recap");
  expect(next.files[clone.prompt.path]).toContain("主叙事已完成");
  expect(next.structure.mounts).toEqual([
    { channel: clone.artifacts[0]!.channel, mount: "story" },
  ]);
  expect(next.structure.followupItems).toContainEqual({
    id: "recap_copy",
    kind: "user",
    enabled: true,
  });
});

test.each(["href=", "href =", "href\t=", "href\n="])(
  "unquoted static HTML attribute %s is cloned and protects its source from deletion",
  (attribute) => {
    const draft = fixture();
    draft.structure.followups[0]!.artifacts[0]!.renderer =
      "renderers/view.html";
    draft.files["renderers/view.html"] =
      `<link ${attribute}assets/shared.css><script src=scripts/view.js></script>`;
    draft.files["scripts/view.js"] = "// static source";
    expect(() =>
      editPresetResources(draft, {
        type: "delete-resource",
        path: "assets/shared.css",
      }),
    ).toThrow(/referenced/u);
    const next = editPresetResources(draft, {
      type: "clone-followup",
      source: "request",
      id: "copy",
    });
    const renderer = next.structure.followups[1]!.artifacts[0]!.renderer!;
    const css = next.structure.extensionRefs.find((path) =>
      path.endsWith("-shared.css"),
    )!;
    const script = next.structure.extensionRefs.find((path) =>
      path.endsWith("-view.js"),
    )!;
    expect(next.files[renderer]).toBe(
      `<link ${attribute}${css}><script src=${script}></script>`,
    );
    expect(next.files[css]).toBe("body {}");
    expect(next.files[script]).toBe("// static source");
  },
);

test("one resource usage index reports declarations and distinct referencing files without counting self or structure", () => {
  const draft = fixture();
  draft.structure.followups[0]!.artifacts[0]!.assets = ["assets/shared.css"];
  draft.files["assets/shared.css"] = "/* assets/shared.css */";
  draft.files["scripts/consumer.js"] =
    "'assets/shared.css'; 'assets/shared.css'; 'assets/missing.json'";
  draft.files["preset.yaml"] = "assets/shared.css";
  draft.files["call-chain.yaml"] = "assets/shared.css";
  const usage = presetResourceUsage(draft);
  expect(usage.get("assets/shared.css")).toEqual({
    declared: true,
    sources: ["scripts/consumer.js"],
  });
  expect(usage.get("assets/missing.json")).toEqual({
    declared: false,
    sources: ["scripts/consumer.js"],
  });
  expect(usage.get("prompts/request.md")).toEqual({
    declared: true,
    sources: [],
  });
});
