import { expect, test } from "vitest";

import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  DocumentCandidateSettingImprovement,
  type SettingAuthorAdapter,
  type SettingAuthorToolCall,
} from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";
import type { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

type AuthorResponse = Awaited<ReturnType<SettingAuthorAdapter["next"]>>;
type ScriptedStep =
  | AuthorResponse
  | Error
  | ((request: Parameters<SettingAuthorAdapter["next"]>[0]) => AuthorResponse);

class ScriptedAdapter implements SettingAuthorAdapter {
  readonly requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  readonly #steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    this.#steps = steps;
  }

  async next(request: Parameters<SettingAuthorAdapter["next"]>[0]) {
    await Promise.resolve();
    this.requests.push(snapshotAuthorRequest(request));
    const step = this.#steps.shift();
    if (step instanceof Error) throw step;
    if (step === undefined) throw new Error("script exhausted");
    return typeof step === "function" ? step(request) : step;
  }
}

test("计划标题按首个围栏外 h1 判定，格式错误以 user role 修复", async () => {
  const adapter = new ScriptedAdapter([
    assistant(
      "```markdown\n# 创作计划\n```\n# 其他标题\n\n这份文本虽然足够长，但首个真实一级标题不符合创作计划契约。",
    ),
    (request) => {
      expect(request.messages.at(-1)).toMatchObject({
        role: "user",
      });
      expect(request.messages.at(-1)?.content).toContain("创作计划");
      return assistant(
        "```markdown\n# 其他伪标题\n```\n# 创作计划：宿舍篇\n\n保留现有人物与世界约束，只完善玩家要求的关系与开场钩子，并在候选中做完整自检。",
      );
    },
  ]);
  const improvement = createImprovement(adapter);

  const result = await improvement.start(planFirst());
  expect(result.kind).toBe("plan");
  if (result.kind !== "plan") throw new Error("预期返回创作计划");
  expect(result.markdown).toContain("# 创作计划：宿舍篇");
});

test("两条 revision 的第二条出错时只有它拿到诊断，另一条被告知去处", async () => {
  const revisions: SettingAuthorToolCall[] = [
    {
      id: "create-valid",
      name: "setting_write_file",
      arguments: {
        path: "world/characters/first.yaml",
        contents:
          "$document:\n  id: x\n  ref: first\n  title: 第一份\n  summary: 这是本轮整批不应落地的第一份文档。\n  aliases: []\n状态: 待定\n",
      },
    },
    {
      id: "create-invalid",
      name: "setting_write_file",
      arguments: {
        path: "world/characters/second.yaml",
        contents: "状态: 缺少技术头\n",
      },
    },
  ];
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("尝试整批创建。", revisions),
    (request) => {
      const results = request.messages.filter(
        ({ role, toolCallId }) =>
          role === "tool" &&
          (toolCallId === "create-valid" || toolCallId === "create-invalid"),
      );
      expect(results).toHaveLength(2);
      // 出错的是第 2 条：只有它带诊断，第 1 条只被告知整批未生效与去处。
      const [first, second] = results;
      expect(second?.content).toContain("$document 技术头");
      expect(first?.content).toContain("本次调用本身没有问题");
      expect(first?.content).toContain("本批次第 2 个调用（共 2 个）");
      expect(first?.content).toContain("world/characters/second.yaml");
      expect(first?.content).not.toContain("$document 技术头");
      return assistant("检查未变的候选。", [previewCall("preview")]);
    },
    assistant("完成。", [finishCall("finish")]),
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  const candidate = await improvement.confirmPlan();

  expect(candidate.files.some(({ path }) => path.includes("first.yaml"))).toBe(
    false,
  );
});

test("整批成功时每个调用只拿到自己那条命令的结果", async () => {
  const writes: SettingAuthorToolCall[] = ["alpha", "beta", "gamma"].map(
    (ref, index) => ({
      id: `write-${ref}`,
      name: "setting_write_file",
      arguments: {
        path: `world/characters/${ref}.yaml`,
        contents: `$document:\n  id: x\n  ref: ${ref}\n  title: 人物${String(index)}\n  summary: 第 ${String(index)} 个批量创建的人物。\n  aliases: []\n状态: 在场\n`,
      },
    }),
  );
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("整批创建。", writes),
    (request) => {
      const results = writes.map((call) =>
        request.messages.find(({ toolCallId }) => toolCallId === call.id),
      );
      for (const [index, ref] of ["alpha", "beta", "gamma"].entries()) {
        const content = results[index]?.content ?? "";
        expect(content).toContain(`创建 @${ref}`);
        expect(content).toContain("同批次另有 2 份文档一并提交");
        // 不再把整批清单复制给每个调用。
        for (const other of ["alpha", "beta", "gamma"].filter(
          (name) => name !== ref,
        ))
          expect(content).not.toContain(`创建 @${other}`);
      }
      return assistant("自检。", [previewCall("preview")]);
    },
    assistant("完成。", [finishCall("finish")]),
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test("读取授权快照身份不匹配会原样中断候选循环", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("尝试修改。", [
      {
        id: "stale-authorization",
        name: "setting_patch",
        arguments: {
          document: "@qinlong",
          op: "replace",
          locator: ["关系"],
          value: { 玩家: "熟悉" },
        },
      },
    ]),
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());
  const previous =
    process.env.NARRAEON_INTERNAL_TEST_STALE_SETTING_READ_AUTHORIZATION;
  process.env.NARRAEON_INTERNAL_TEST_STALE_SETTING_READ_AUTHORIZATION = "1";
  try {
    await expect(improvement.confirmPlan()).rejects.toThrow(
      "世界文档读取授权不属于当前候选快照",
    );
  } finally {
    if (previous === undefined)
      delete process.env
        .NARRAEON_INTERNAL_TEST_STALE_SETTING_READ_AUTHORIZATION;
    else
      process.env.NARRAEON_INTERNAL_TEST_STALE_SETTING_READ_AUTHORIZATION =
        previous;
  }
  expect(adapter.requests).toHaveLength(2);
  expect(improvement.currentFiles()).toEqual(baseFiles());
});

test("已预览的候选遇到非法查询后，同响应 finish 被拒绝且下一轮才能结束", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("先自检。", [previewCall("preview")]),
    assistant("读取后结束。", [
      {
        id: "invalid-read",
        name: "setting_read",
        arguments: { path: "world/missing.yaml" },
      },
      finishCall("finish-too-soon"),
    ]),
    (request) => {
      expect(
        request.messages.find(({ toolCallId }) => toolCallId === "invalid-read")
          ?.content,
      ).toContain("WorldDocumentStore 查询未接受");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-too-soon",
        )?.content,
      ).toContain("本响应中有未处理的错误");
      return assistant("修复后结束。", [finishCall("finish-repaired")]);
    },
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test("非法 revision 与未知工具出现在 finish 前时都阻止同响应结束", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("先自检。", [previewCall("preview")]),
    assistant("非法 revision 后尝试结束。", [
      {
        id: "invalid-revision",
        name: "setting_write_file",
        arguments: {
          path: "world/characters/invalid.yaml",
          contents: "状态: 缺少技术头\n",
        },
      },
      finishCall("finish-after-revision"),
    ]),
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "invalid-revision",
        )?.content,
      ).toContain("$document 技术头");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-after-revision",
        )?.content,
      ).toContain("本响应中有未处理的错误");
      return assistant("未知工具后尝试结束。", [
        { id: "unknown-before-finish", name: "setting_unknown", arguments: {} },
        finishCall("finish-after-unknown"),
      ]);
    },
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "unknown-before-finish",
        )?.content,
      ).toContain("不支持的设定完善工具");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-after-unknown",
        )?.content,
      ).toContain("本响应中有未处理的错误");
      return assistant("修复后结束。", [finishCall("finish-repaired")]);
    },
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test("list、search、read 的参数错与查询失败都会挡住同响应 finish", async () => {
  const rejectedCalls: SettingAuthorToolCall[] = [
    {
      id: "list-args",
      name: "setting_list",
      arguments: { unknown: true },
    },
    {
      id: "list-query",
      name: "setting_list",
      arguments: { directory: "world", cursor: "not-a-cursor" },
    },
    {
      id: "search-args",
      name: "setting_search",
      arguments: { query: "" },
    },
    {
      id: "search-query",
      name: "setting_search",
      arguments: { query: "不存在", within: "@missing" },
    },
    { id: "read-args", name: "setting_read", arguments: {} },
    {
      id: "read-query",
      name: "setting_read",
      arguments: { path: "world/missing.yaml" },
    },
  ];
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("先自检。", [previewCall("preview")]),
    assistant("错误查询后尝试结束。", [
      ...rejectedCalls,
      finishCall("finish-after-query-errors"),
    ]),
    (request) => {
      for (const call of rejectedCalls) {
        const message = request.messages.find(
          ({ toolCallId }) => toolCallId === call.id,
        );
        expect(message).toMatchObject({ role: "tool", toolCallId: call.id });
        expect(message?.content).toMatch(/参数错误|查询未接受/u);
      }
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-after-query-errors",
        )?.content,
      ).toContain("本响应中有未处理的错误");
      return assistant("修复后结束。", [finishCall("finish-query-repaired")]);
    },
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test("revision 形状错、整批读取授权错、finish 位置错和未知工具都闭合成可修复结果", async () => {
  const unauthorized: SettingAuthorToolCall[] = [
    {
      id: "unauthorized-character",
      name: "setting_patch",
      arguments: {
        document: "@qinlong",
        op: "replace",
        locator: ["关系"],
        value: { 玩家: "熟悉" },
      },
    },
    {
      id: "unauthorized-situation",
      name: "setting_patch",
      arguments: {
        document: "@current",
        op: "replace",
        locator: ["人物"],
        value: [{ $ref: "character.qinlong" }],
      },
    },
  ];
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("先尝试不存在的 locator。", [
      {
        id: "revision-rejected",
        name: "setting_patch",
        arguments: {
          document: "@qinlong",
          op: "replace",
          locator: ["不存在"],
          value: "x",
        },
      },
    ]),
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "revision-rejected",
        )?.content,
      ).toContain("revision 未接受");
      return assistant("尝试未授权的整批修改。", unauthorized);
    },
    (request) => {
      const results = unauthorized.map((call) =>
        request.messages.find(({ toolCallId }) => toolCallId === call.id),
      );
      expect(results).toHaveLength(2);
      expect(results.every((message) => message?.role === "tool")).toBe(true);
      expect(new Set(results.map((message) => message?.content)).size).toBe(1);
      expect(results[0]?.content).toContain("必须先完整读取该文档");
      return assistant("检查未变的候选。", [previewCall("preview")]);
    },
    assistant("终态工具位置错且还有未知工具。", [
      finishCall("finish-not-last"),
      { id: "unknown", name: "setting_unknown", arguments: {} },
    ]),
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-not-last",
        )?.content,
      ).toContain("必须最后调用");
      expect(
        request.messages.find(({ toolCallId }) => toolCallId === "unknown")
          ?.content,
      ).toContain("不支持的设定完善工具");
      return assistant("修复后结束。", [finishCall("finish")]);
    },
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test("安全路径与必需字符串参数错误都是可修复工具结果", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("尝试写入。", [
      {
        id: "unsafe-path",
        name: "setting_write_file",
        arguments: { path: "world/../x.md", contents: "x" },
      },
      {
        id: "empty-contents",
        name: "setting_write_file",
        arguments: { path: "control/blocks/x.md", contents: "" },
      },
    ]),
    (request) => {
      expect(
        request.messages.find(({ toolCallId }) => toolCallId === "unsafe-path")
          ?.content,
      ).toContain("候选路径不安全");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "empty-contents",
        )?.content,
      ).toContain("必须是非空字符串");
      return assistant("自检。", [previewCall("preview")]);
    },
    assistant("结束。", [finishCall("finish")]),
  ]);
  const improvement = createImprovement(adapter);
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test("计划与候选的修复计数各自允许 8 次，第 9 次才失败", async () => {
  const planAdapter = new ScriptedAdapter([
    ...Array.from({ length: 8 }, () =>
      assistant(
        "## 创作计划\n\n格式错误但文本长度足够，这一轮应该被当作可修复计划错误。",
      ),
    ),
    assistant(validPlan()),
  ]);
  await expect(
    createImprovement(planAdapter).start(planFirst()),
  ).resolves.toMatchObject({ kind: "plan" });

  const ninthPlanAdapter = new ScriptedAdapter(
    Array.from({ length: 9 }, () =>
      assistant(
        "#创作计划\n\n没有空格的伪标题在第九次必须触发修复上限。这里补足长度避免只命中长度条件。",
      ),
    ),
  );
  await expect(
    createImprovement(ninthPlanAdapter).start(planFirst()),
  ).rejects.toThrow(/计划.*可修复.*上限/u);

  const candidateAdapter = new ScriptedAdapter([
    assistant(validPlan()),
    ...Array.from({ length: 8 }, () =>
      assistant("这是不带工具的候选阶段纯文本回复。"),
    ),
    assistant("自检。", [previewCall("preview")]),
    assistant("完成。", [finishCall("finish")]),
  ]);
  const candidate = createImprovement(candidateAdapter);
  await candidate.start(planFirst());
  await expect(candidate.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });

  const independentAdapter = new ScriptedAdapter([
    ...Array.from({ length: 8 }, () =>
      assistant(
        "## 创作计划\n\n计划错误消耗了计划阶段的额度，但不应该影响后续候选阶段的独立计数器。",
      ),
    ),
    assistant(validPlan()),
    ...Array.from({ length: 8 }, () =>
      assistant("候选阶段的不合规纯文本回复。"),
    ),
    assistant("自检。", [previewCall("independent-preview")]),
    assistant("完成。", [finishCall("independent-finish")]),
  ]);
  const independent = createImprovement(independentAdapter);
  await independent.start(planFirst());
  await expect(independent.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test.each([
  ["候选纯文本", () => assistant("没有任何工具调用的候选回复。")],
  [
    "finish 缺少当前预览",
    () => assistant("结束。", [finishCall("finish-without-preview")]),
  ],
] as const)("%s 第 8 次仍可修复，第 9 次触发上限", async (_, response) => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    ...Array.from({ length: 9 }, response),
  ]);
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter,
    preview: () => {
      throw new Error("preview unavailable");
    },
  });
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).rejects.toThrow(
    /候选.*可修复.*上限/u,
  );
  expect(adapter.requests).toHaveLength(10);
});

test("自检未通过走独立预算，第 16 次仍可修复，第 17 次才中断", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    ...Array.from({ length: 17 }, () =>
      assistant("自检。", [previewCall("preview-failure")]),
    ),
  ]);
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter,
    preview: () => {
      throw new Error("preview unavailable");
    },
  });
  await improvement.start(planFirst());

  await expect(improvement.confirmPlan()).rejects.toThrow(
    /自检未通过次数过多/u,
  );
  expect(adapter.requests).toHaveLength(18);
});

test("进行中的 start、confirm 和 apply 都拒绝 discard，且失败后恢复可用状态", async () => {
  const startGate = deferred<AuthorResponse>();
  const starting = createImprovement({ next: () => startGate.promise });
  const startPromise = starting.start(planFirst());
  expect(() => starting.discard()).toThrow(/进行中/u);
  startGate.resolve(assistant(validPlan()));
  await startPromise;

  const confirmGate = deferred<AuthorResponse>();
  let candidateRound = 0;
  const confirming = createImprovement({
    async next() {
      candidateRound += 1;
      if (candidateRound === 1) return assistant(validPlan());
      if (candidateRound === 2) return confirmGate.promise;
      return assistant("完成。", [finishCall("finish-confirm")]);
    },
  });
  await confirming.start(planFirst());
  const confirmPromise = confirming.confirmPlan();
  await expect(confirming.confirmPlan()).rejects.toThrow(/正在确认|可确认/u);
  expect(() => confirming.discard()).toThrow(/进行中/u);
  confirmGate.resolve(assistant("自检。", [previewCall("preview-confirm")]));
  await confirmPromise;

  const applyGate = deferred<void>();
  const applying = confirming.apply(() => applyGate.promise);
  expect(() => confirming.discard()).toThrow(/进行中/u);
  applyGate.reject(new Error("replace failed"));
  await expect(applying).rejects.toThrow("replace failed");
  await expect(confirming.apply(() => undefined)).resolves.toBeUndefined();
});

test("confirm 硬失败后回到 planned，且重试请求不含上次工具交换", async () => {
  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  let round = 0;
  const improvement = createImprovement({
    async next(request) {
      await Promise.resolve();
      requests.push(snapshotAuthorRequest(request));
      round += 1;
      if (round === 1) return assistant(validPlan());
      if (round === 2)
        return assistant("读取。", [
          {
            id: "failed-attempt-read",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
        ]);
      if (round === 3) throw new Error("provider unavailable");
      if (round === 4) {
        expect(JSON.stringify(request.messages)).not.toContain(
          "failed-attempt-read",
        );
        return assistant("自检。", [previewCall("retry-preview")]);
      }
      return assistant("完成。", [finishCall("retry-finish")]);
    },
  });
  await improvement.start(planFirst());
  await expect(improvement.confirmPlan()).rejects.toThrow(
    "provider unavailable",
  );
  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

// onDelta 是回调，不属于可快照的请求内容。
function snapshotAuthorRequest(
  request: Parameters<SettingAuthorAdapter["next"]>[0],
) {
  const snapshot = { ...request };
  delete snapshot.onDelta;
  return structuredClone(snapshot);
}

function createImprovement(adapter: SettingAuthorAdapter) {
  return new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter,
    preview: previewSnapshot,
  });
}

function assistant(
  content: string,
  toolCalls: SettingAuthorToolCall[] = [],
): AuthorResponse {
  return { role: "assistant", content, toolCalls };
}

function previewCall(id: string): SettingAuthorToolCall {
  return { id, name: "setting_preview_candidate", arguments: {} };
}

function finishCall(id: string): SettingAuthorToolCall {
  return { id, name: "setting_finish_candidate", arguments: {} };
}

function planFirst() {
  return {
    goal: "完善宿舍世界的人物关系",
    contextPaths: [],
    mode: "plan_first" as const,
  };
}

function validPlan(): string {
  return "# 创作计划：宿舍篇\n\n保留已有人物、当前情境和玩家行动权，只补充关系的可观察表现与开局钩子，并在应用前通过完整候选自检。";
}

function baseFiles() {
  return [
    {
      path: "opening.md",
      contents: "宿舍门在你面前合上。秦龙抱着球衣，等你先开口。\n",
    },
    {
      path: "world/characters/qinlong.yaml",
      contents: `$document:\n  id: character.qinlong\n  ref: qinlong\n  title: 秦龙\n  summary: 篮球队前锋的当前状态与关系。\n  aliases: []\n关系: {}\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: 当前情境\n  summary: 宿舍中正在发生的局面。\n  aliases: []\n人物:\n  - $ref: character.qinlong\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents: "# 世界主持规则\n\n持续结果写回自然所有者。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}

function previewSnapshot(snapshot: WorldDocumentStore) {
  return new FileNativePromptCompiler().preview({
    endpoint: { id: "candidate", commit: "candidate" },
    hostBinding: {
      hostPresetId: "host",
      files: {
        "frame.yaml": `format: narraeon.host-frame/v1\nroles:\n  runtime_system:\n    - builtin: runtime.play-contract\n    - builtin: runtime.tool-contract\n    - builtin: runtime.operation-contract\n  author_instruction:\n    - include: world.instructions\n  world_context:\n    - builtin: runtime.coverage\n    - include: world.context\n`,
      },
    },
    world: {
      controlFingerprint: "candidate",
      documentSnapshot: snapshot,
      history: {
        "candidate.message.genesis.narrator": "宿舍门在你面前合上。",
      },
      additionalMaterials: [
        {
          kind: "history_message",
          message: "candidate.message.genesis.narrator",
        },
      ],
    },
    playerInputPlacement: "bootstrap",
    playerInput: "预览",
    modelBinding: {
      provider: "chat_completions",
      modelId: "test",
      contextWindowTokens: 32_000,
      maxOutputTokens: 2_000,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
