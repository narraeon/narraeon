import { expect, test } from "vitest";
import {
  resolvePromptArrangement,
  customizePromptArrangement,
} from "../../src/shared/prompt-arrangement.ts";
import type {
  BuiltinPlayPrompt,
  OrderedPlayPrompt,
} from "../../src/shared/ordered-play-prompts.ts";

const mechanics: BuiltinPlayPrompt = {
  id: "play.mechanics",
  name: "Mechanics",
  body: "tools",
  required: true,
  category: "mechanics",
};
const policy: BuiltinPlayPrompt = {
  id: "play.policy",
  name: "Policy",
  body: "old body",
  required: false,
  category: "policy",
  turnGuide: "default",
};
const catalog = [mechanics, policy];
const user: OrderedPlayPrompt = {
  id: "mine",
  kind: "user",
  name: "Clone",
  body: "old body",
  enabled: true,
};

test("a new catalog resolves without editing saved customizations, preserving interleaving and clear overrides", () => {
  const saved = customizePromptArrangement(
    [
      {
        id: "play.mechanics",
        kind: "builtin",
        builtin: "play.mechanics",
        enabled: true,
      },
      user,
      {
        id: "play.policy",
        kind: "builtin",
        builtin: "play.policy",
        enabled: false,
        messageRole: "assistant",
        turnGuide: "",
      },
      { id: "world", kind: "world", messageRole: "user" },
    ],
    catalog,
  );
  const before = JSON.stringify(saved);
  const next = [
    mechanics,
    { ...policy, body: "new body" },
    { ...policy, id: "play.new" },
  ];
  const resolved = resolvePromptArrangement(saved, next);
  expect(resolved.map((e) => e.id)).toEqual([
    "play.mechanics",
    "mine",
    "play.policy",
    "play.new",
    "world",
  ]);
  expect(resolved[1]).toEqual(user);
  expect(resolved[2]).toMatchObject({
    enabled: false,
    messageRole: "assistant",
    turnGuide: "",
  });
  expect(resolved[3]).toMatchObject({ kind: "builtin", enabled: true });
  expect(resolvePromptArrangement(saved, next)).toEqual(resolved);
  expect(JSON.stringify(saved)).toBe(before);
});

test("retired builtin settings including an empty tail resolve at their old position without a write", () => {
  const next: BuiltinPlayPrompt[] = [
    mechanics,
    { ...policy, id: "play.prose" },
    { ...policy, id: "play.scene" },
  ];
  const saved = {
    entries: [user],
    order: [
      "builtin:play.mechanics",
      "entry:mine",
      "builtin:play.style",
      "entry:world",
    ],
    overrides: [
      {
        builtin: "play.style",
        enabled: false,
        messageRole: "assistant" as const,
        turnGuide: "",
      },
    ],
  };
  expect(resolvePromptArrangement(saved, next)).toEqual([
    {
      id: "play.mechanics",
      kind: "builtin",
      builtin: "play.mechanics",
      enabled: true,
    },
    user,
    {
      id: "play.prose",
      kind: "builtin",
      builtin: "play.prose",
      enabled: false,
      messageRole: "assistant",
      turnGuide: "",
    },
    {
      id: "play.scene",
      kind: "builtin",
      builtin: "play.scene",
      enabled: false,
      messageRole: "assistant",
      turnGuide: "",
    },
    { id: "world", kind: "world" },
  ]);
});

test("an option-group selection suppresses newly shipped default alternatives", () => {
  const first: BuiltinPlayPrompt = {
    ...policy,
    id: "play.first",
    category: "choice",
    group: "person",
  };
  const second: BuiltinPlayPrompt = { ...first, id: "play.second" };
  const saved = customizePromptArrangement(
    [
      {
        id: mechanics.id,
        kind: "builtin",
        builtin: mechanics.id,
        enabled: true,
      },
      { id: first.id, kind: "builtin", builtin: first.id, enabled: false },
      { id: second.id, kind: "builtin", builtin: second.id, enabled: true },
      { id: "world", kind: "world" },
    ],
    [mechanics, first, second],
  );
  const next = [mechanics, { ...first, id: "play.new-default" }, first, second];
  expect(
    resolvePromptArrangement(saved, next)
      .filter((e) => e.kind === "builtin" && e.enabled)
      .map((e) => e.id),
  ).toEqual(["play.mechanics", "play.second"]);
});

test("portable customizations reject malformed or duplicate content and mechanical bypasses", async () => {
  const { parsePromptArrangement } =
    await import("../../src/runtime/play/OrderedPlayPrompts.ts");
  for (const invalid of [
    { entries: [user, user] },
    {
      entries: [
        { id: "one", kind: "world" },
        { id: "two", kind: "world" },
      ],
    },
    { overrides: [{ builtin: "play.mechanics", enabled: false }] },
    { overrides: [{ builtin: "play.mechanics", messageRole: "assistant" }] },
    {
      overrides: [
        { builtin: "play.policy", id: "duplicate" },
        { builtin: "play.mechanics", id: "duplicate" },
      ],
    },
    { entries: [{ ...user, body: 42 }] },
    { order: ["builtin:unknown"] },
    {
      overrides: [
        { builtin: "play.policy", body: "Editable mechanical prose" },
      ],
    },
  ])
    expect(() => parsePromptArrangement(invalid, catalog)).toThrow();
});

test("legacy and sparse parsing share successor precedence even when explicit settings follow a retired block", async () => {
  const { parseOrderedPlayPrompts } =
    await import("../../src/runtime/play/OrderedPlayPrompts.ts");
  const next = [
    mechanics,
    { ...policy, id: "play.prose" },
    { ...policy, id: "play.scene" },
  ];
  const entries: OrderedPlayPrompt[] = [
    { id: mechanics.id, kind: "builtin", builtin: mechanics.id, enabled: true },
    {
      id: "old",
      kind: "builtin",
      builtin: "play.style",
      enabled: false,
      messageRole: "assistant",
      turnGuide: "",
    },
    {
      id: "play.scene",
      kind: "user",
      name: "Existing user",
      body: "Keep this",
      enabled: true,
    },
    {
      id: "explicit",
      kind: "builtin",
      builtin: "play.prose",
      enabled: true,
      messageRole: "user",
    },
    { id: "world", kind: "world" },
  ];
  const parsed = parseOrderedPlayPrompts(entries, next);
  expect(parsed.find((e) => e.id === "explicit")).toMatchObject({
    builtin: "play.prose",
    enabled: true,
    messageRole: "user",
  });
  expect(
    parsed.find((e) => e.kind === "builtin" && e.builtin === "play.scene"),
  ).toMatchObject({ enabled: false, messageRole: "assistant", turnGuide: "" });
  expect(parsed.find((e) => e.id === "play.scene")).toMatchObject({
    kind: "user",
    body: "Keep this",
  });
  expect(new Set(parsed.map((e) => e.id)).size).toBe(parsed.length);
});

test("an explicit successor keeps its position across a retired order key", async () => {
  const { parsePromptArrangement } =
    await import("../../src/runtime/play/OrderedPlayPrompts.ts");
  const next = [
    mechanics,
    { ...policy, id: "play.prose" },
    { ...policy, id: "play.scene" },
  ];
  const arrangement = {
    entries: [user],
    overrides: [
      { builtin: "play.style", enabled: false },
      { builtin: "play.prose", enabled: true },
    ],
    order: [
      "builtin:play.mechanics",
      "builtin:play.style",
      "entry:mine",
      "builtin:play.prose",
      "entry:world",
    ],
  };
  expect(parsePromptArrangement(arrangement, next).map((e) => e.id)).toEqual([
    "play.mechanics",
    "play.scene",
    "mine",
    "play.prose",
    "world",
  ]);
});

test.each([0, 1])(
  "an existing alias survives a new catalog identity before or after it (%s)",
  async (offset) => {
    const { parsePromptArrangement } =
      await import("../../src/runtime/play/OrderedPlayPrompts.ts");
    const original: OrderedPlayPrompt[] = [
      {
        id: mechanics.id,
        kind: "builtin",
        builtin: mechanics.id,
        enabled: true,
      },
      {
        id: "play.future",
        kind: "builtin",
        builtin: policy.id,
        enabled: false,
      },
      { id: "world", kind: "world" },
    ];
    const arrangement = customizePromptArrangement(original, catalog);
    const next = [...catalog];
    next.splice(1 + offset, 0, { ...policy, id: "play.future" });
    const effective = parsePromptArrangement(arrangement, next);
    expect(
      effective.filter(
        (e) => !(e.kind === "builtin" && e.builtin === "play.future"),
      ),
    ).toEqual(original);
    expect(
      effective.find(
        (e) => e.kind === "builtin" && e.builtin === "play.future",
      ),
    ).toMatchObject({ id: "builtin-play.future-1" });
    expect(
      resolvePromptArrangement(
        customizePromptArrangement(effective, next),
        next,
      ),
    ).toEqual(effective);
  },
);

test("conversion does not persist a default catalog order merely because a newer default is absent", () => {
  expect(
    customizePromptArrangement(
      [
        {
          id: mechanics.id,
          kind: "builtin",
          builtin: mechanics.id,
          enabled: true,
        },
        { id: "world", kind: "world" },
      ],
      catalog,
    ),
  ).toEqual({});
});
