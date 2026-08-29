import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { FileNativeAiFailureLog } from "../../src/runtime/model/AiFailureLog.ts";
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
      "```markdown\n# Creation plan\n```\n# Other heading\n\nThis text is long enough, but its first real level-one heading violates the creation-plan contract.",
    ),
    (request) => {
      expect(request.messages.at(-1)).toMatchObject({
        role: "user",
      });
      expect(request.messages.at(-1)?.content).toContain("Creation plan");
      return assistant(
        "```markdown\n# False heading\n```\n# Creation plan: Dorm story\n\nPreserve the existing characters and world constraints. Improve only the requested relationships and opening hook, then run the complete candidate check.",
      );
    },
  ]);
  const improvement = createImprovement(adapter);

  const result = await improvement.start(planFirst());
  expect(result.kind).toBe("plan");
  if (result.kind !== "plan") throw new Error("Expected a creation plan");
  expect(result.markdown).toContain("# Creation plan: Dorm story");
});

test("AI 输出格式检查未通过时保存原始交换和 reasoning", async () => {
  const root = await mkdtemp(join(tmpdir(), "narraeon-setting-format-log-"));
  try {
    const invalid: AuthorResponse = {
      role: "assistant",
      content: "Plan text without a level-one heading.",
      reasoningContent: "I mistakenly thought the heading could be omitted.",
      toolCalls: [],
      diagnostics: {
        captureId: "setting-format-capture-1",
        provider: "chat_completions",
        endpoint: "https://provider.invalid/v1/chat/completions",
        context: {
          scope: "setting_improvement",
          requestId: "setting_improvement",
          operationId: "setting-format-log",
          requestAttempt: 1,
          exchange: 1,
        },
        request: {
          method: "POST",
          contentType: "application/json",
          body: '{"messages":[{"role":"user","content":"Generate a plan"}]}',
        },
        response: {
          status: 200,
          statusText: "OK",
          contentType: "text/event-stream",
          body: 'data: {"reasoning_content":"I mistakenly thought the heading could be omitted.","content":"Plan text without a level-one heading."}\n\n',
          bodyComplete: true,
        },
        reasoning: "I mistakenly thought the heading could be omitted.",
      },
    };
    const repaired: AuthorResponse = {
      ...assistant(validPlan()),
      diagnostics: {
        captureId: "setting-format-capture-2",
        provider: "chat_completions",
        endpoint: "https://provider.invalid/v1/chat/completions",
        context: {
          scope: "setting_improvement",
          requestId: "setting_improvement",
          operationId: "setting-format-log",
          requestAttempt: 1,
          exchange: 2,
        },
        request: {
          method: "POST",
          contentType: "application/json",
          body: '{"messages":[{"role":"user","content":"Repair the format"}]}',
        },
        response: {
          status: 200,
          statusText: "OK",
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ content: validPlan() })}\n\n`,
          bodyComplete: true,
        },
      },
    };
    const adapter = new ScriptedAdapter([invalid, repaired]);
    const logRoot = join(root, "ai-failures");
    const improvement = new DocumentCandidateSettingImprovement({
      files: baseFiles(),
      adapter,
      preview: previewSnapshot,
      failureLog: new FileNativeAiFailureLog(logRoot),
    });

    await expect(improvement.start(planFirst())).resolves.toMatchObject({
      kind: "plan",
    });

    const names = (await readdir(logRoot)).filter((value) =>
      value.endsWith(".jsonl"),
    );
    expect(names).toHaveLength(1);
    const entries = (await readFile(join(logRoot, names[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failure = entries.find(({ type }) => type === "failure") as {
      failures: { kind: string; message: string }[];
    };
    expect(failure.failures).toHaveLength(1);
    expect(failure.failures[0]?.kind).toBe("format_validation");
    expect(failure.failures[0]?.message).toContain("Creation plan");
    const exchanges = entries
      .filter(({ type }) => type === "exchange")
      .map(({ exchange }) => exchange) as {
      response?: { body: string };
      reasoning?: string;
    }[];
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]?.response?.body).toContain(
      "without a level-one heading",
    );
    expect(exchanges[0]?.reasoning).toBe(
      "I mistakenly thought the heading could be omitted.",
    );
    expect(exchanges[1]?.response?.body).toContain("# Creation plan");
    expect(entries.at(-1)).toMatchObject({
      type: "resolved",
      message:
        "The setting-improvement plan passed format validation in a later model exchange.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("两条 revision 的第二条出错时只有它拿到诊断，另一条被告知去处", async () => {
  const revisions: SettingAuthorToolCall[] = [
    {
      id: "create-valid",
      name: "setting_write_file",
      arguments: {
        path: "world/characters/first.yaml",
        contents:
          "$document:\n  id: x\n  ref: first\n  title: First character\n  summary: The first document in a batch that must not be applied.\n  aliases: []\nstatus: pending\n",
      },
    },
    {
      id: "create-invalid",
      name: "setting_write_file",
      arguments: {
        path: "world/characters/second.yaml",
        contents: "status: missing technical header\n",
      },
    },
  ];
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("Create the batch.", revisions),
    (request) => {
      const results = request.messages.filter(
        ({ role, toolCallId }) =>
          role === "tool" &&
          (toolCallId === "create-valid" || toolCallId === "create-invalid"),
      );
      expect(results).toHaveLength(2);
      // Only call 2 carries diagnostics; call 1 only learns that the batch failed.
      const [first, second] = results;
      expect(second?.content).toContain("$document technical header");
      expect(first?.content).toContain("This call was valid");
      expect(first?.content).toContain("Call 2 of 2");
      expect(first?.content).toContain("world/characters/second.yaml");
      expect(first?.content).not.toContain("$document technical header");
      return assistant("Check the unchanged candidate.", [
        previewCall("preview"),
      ]);
    },
    assistant("Finish.", [finishCall("finish")]),
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
        contents: `$document:\n  id: x\n  ref: ${ref}\n  title: Character ${String(index)}\n  summary: Character ${String(index)} created in this batch.\n  aliases: []\nstatus: present\n`,
      },
    }),
  );
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("Create the batch.", writes),
    (request) => {
      const results = writes.map((call) =>
        request.messages.find(({ toolCallId }) => toolCallId === call.id),
      );
      for (const [index, ref] of ["alpha", "beta", "gamma"].entries()) {
        const content = results[index]?.content ?? "";
        expect(content).toContain(`Created @${ref}`);
        expect(content).toContain(
          "2 other document(s) in the same batch were committed together",
        );
        // Each call receives only its own result, not a copy of the batch list.
        for (const other of ["alpha", "beta", "gamma"].filter(
          (name) => name !== ref,
        ))
          expect(content).not.toContain(`Created @${other}`);
      }
      return assistant("Check the candidate.", [previewCall("preview")]);
    },
    assistant("Finish.", [finishCall("finish")]),
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
    assistant("Try the update.", [
      {
        id: "stale-authorization",
        name: "setting_patch",
        arguments: {
          document: "@alex",
          op: "replace",
          locator: ["relationships"],
          value: { player: "familiar" },
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
      "World-document read authorization does not belong to the current candidate snapshot",
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

test("已Preview的候选遇到非法查询后，同响应 finish 被拒绝且下一轮才能结束", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("Check first.", [previewCall("preview")]),
    assistant("Read and then finish.", [
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
      ).toContain("WorldDocumentStore query rejected");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-too-soon",
        )?.content,
      ).toContain("This response contains an unresolved error");
      return assistant("Finish after repair.", [finishCall("finish-repaired")]);
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
    assistant("Check first.", [previewCall("preview")]),
    assistant("Try to finish after an invalid revision.", [
      {
        id: "invalid-revision",
        name: "setting_write_file",
        arguments: {
          path: "world/characters/invalid.yaml",
          contents: "status: missing technical header\n",
        },
      },
      finishCall("finish-after-revision"),
    ]),
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "invalid-revision",
        )?.content,
      ).toContain("$document technical header");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-after-revision",
        )?.content,
      ).toContain("This response contains an unresolved error");
      return assistant("Try to finish after an unknown tool.", [
        { id: "unknown-before-finish", name: "setting_unknown", arguments: {} },
        finishCall("finish-after-unknown"),
      ]);
    },
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "unknown-before-finish",
        )?.content,
      ).toContain("Unsupported setting-improvement tool");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-after-unknown",
        )?.content,
      ).toContain("This response contains an unresolved error");
      return assistant("Finish after repair.", [finishCall("finish-repaired")]);
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
      arguments: { query: "missing", within: "@missing" },
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
    assistant("Check first.", [previewCall("preview")]),
    assistant("Try to finish after invalid queries.", [
      ...rejectedCalls,
      finishCall("finish-after-query-errors"),
    ]),
    (request) => {
      for (const call of rejectedCalls) {
        const message = request.messages.find(
          ({ toolCallId }) => toolCallId === call.id,
        );
        expect(message).toMatchObject({ role: "tool", toolCallId: call.id });
        expect(message?.content).toMatch(
          /Runtime argument error|query rejected/u,
        );
      }
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-after-query-errors",
        )?.content,
      ).toContain("This response contains an unresolved error");
      return assistant("Finish after repair.", [
        finishCall("finish-query-repaired"),
      ]);
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
        document: "@alex",
        op: "replace",
        locator: ["relationships"],
        value: { player: "familiar" },
      },
    },
    {
      id: "unauthorized-situation",
      name: "setting_patch",
      arguments: {
        document: "@current",
        op: "replace",
        locator: ["characters"],
        value: [{ $ref: "character.alex" }],
      },
    },
  ];
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    assistant("Try a missing locator first.", [
      {
        id: "revision-rejected",
        name: "setting_patch",
        arguments: {
          document: "@alex",
          op: "replace",
          locator: ["missing"],
          value: "x",
        },
      },
    ]),
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "revision-rejected",
        )?.content,
      ).toContain("revision was rejected");
      return assistant("Try the unauthorized batch.", unauthorized);
    },
    (request) => {
      const results = unauthorized.map((call) =>
        request.messages.find(({ toolCallId }) => toolCallId === call.id),
      );
      expect(results).toHaveLength(2);
      expect(results.every((message) => message?.role === "tool")).toBe(true);
      expect(new Set(results.map((message) => message?.content)).size).toBe(1);
      expect(results[0]?.content).toContain(
        "Read @alex completely before changing it",
      );
      return assistant("Check the unchanged candidate.", [
        previewCall("preview"),
      ]);
    },
    assistant("Place the final-state tool incorrectly with an unknown tool.", [
      finishCall("finish-not-last"),
      { id: "unknown", name: "setting_unknown", arguments: {} },
    ]),
    (request) => {
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "finish-not-last",
        )?.content,
      ).toContain("must be called last");
      expect(
        request.messages.find(({ toolCallId }) => toolCallId === "unknown")
          ?.content,
      ).toContain("Unsupported setting-improvement tool");
      return assistant("Finish after repair.", [finishCall("finish")]);
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
    assistant("Try to write.", [
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
      ).toContain("Unsafe candidate path");
      expect(
        request.messages.find(
          ({ toolCallId }) => toolCallId === "empty-contents",
        )?.content,
      ).toContain("must be a non-empty string");
      return assistant("Check the candidate.", [previewCall("preview")]);
    },
    assistant("Finish.", [finishCall("finish")]),
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
        "## Creation plan\n\nThe format is invalid but the text is long enough, so this round is a repairable plan error.",
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
        "#Creation plan\n\nThis false heading has no space and must hit the repair limit on round nine. Extra text keeps the failure about format, not length.",
      ),
    ),
  );
  await expect(
    createImprovement(ninthPlanAdapter).start(planFirst()),
  ).rejects.toThrow(/plan phase exceeded its repair limit/u);

  const candidateAdapter = new ScriptedAdapter([
    assistant(validPlan()),
    ...Array.from({ length: 8 }, () =>
      assistant("This candidate-phase response has no tool call."),
    ),
    assistant("Check the candidate.", [previewCall("preview")]),
    assistant("Finish.", [finishCall("finish")]),
  ]);
  const candidate = createImprovement(candidateAdapter);
  await candidate.start(planFirst());
  await expect(candidate.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });

  const independentAdapter = new ScriptedAdapter([
    ...Array.from({ length: 8 }, () =>
      assistant(
        "## Creation plan\n\nPlan errors consume the planning budget but must not affect the candidate phase's independent repair counter.",
      ),
    ),
    assistant(validPlan()),
    ...Array.from({ length: 8 }, () =>
      assistant("Invalid candidate-phase plain-text response."),
    ),
    assistant("Check the candidate.", [previewCall("independent-preview")]),
    assistant("Finish.", [finishCall("independent-finish")]),
  ]);
  const independent = createImprovement(independentAdapter);
  await independent.start(planFirst());
  await expect(independent.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
});

test.each([
  [
    "candidate plain text",
    () => assistant("Candidate response with no tool call."),
  ],
  [
    "finish 缺少当前Preview",
    () => assistant("Finish.", [finishCall("finish-without-preview")]),
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
    /candidate phase exceeded its repair limit/u,
  );
  expect(adapter.requests).toHaveLength(10);
});

test("自检未通过走独立预算，第 16 次仍可修复，第 17 次才中断", async () => {
  const adapter = new ScriptedAdapter([
    assistant(validPlan()),
    ...Array.from({ length: 17 }, () =>
      assistant("Check the candidate.", [previewCall("preview-failure")]),
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
    /candidate failed too many checks/u,
  );
  expect(adapter.requests).toHaveLength(18);
});

test("进行中的 start、confirm 和 apply 都拒绝 discard，且失败后恢复可用状态", async () => {
  const startGate = deferred<AuthorResponse>();
  const starting = createImprovement({ next: () => startGate.promise });
  const startPromise = starting.start(planFirst());
  expect(() => starting.discard()).toThrow(/operation is running/u);
  startGate.resolve(assistant(validPlan()));
  await startPromise;

  const confirmGate = deferred<AuthorResponse>();
  let candidateRound = 0;
  const confirming = createImprovement({
    async next() {
      candidateRound += 1;
      if (candidateRound === 1) return assistant(validPlan());
      if (candidateRound === 2) return confirmGate.promise;
      return assistant("Finish.", [finishCall("finish-confirm")]);
    },
  });
  await confirming.start(planFirst());
  const confirmPromise = confirming.confirmPlan();
  await expect(confirming.confirmPlan()).rejects.toThrow(
    /There is no creation plan to confirm/u,
  );
  expect(() => confirming.discard()).toThrow(/operation is running/u);
  confirmGate.resolve(
    assistant("Check the candidate.", [previewCall("preview-confirm")]),
  );
  await confirmPromise;

  const applyGate = deferred<void>();
  const applying = confirming.apply(() => applyGate.promise);
  expect(() => confirming.discard()).toThrow(/operation is running/u);
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
        return assistant("Read.", [
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
        return assistant("Check the candidate.", [
          previewCall("retry-preview"),
        ]);
      }
      return assistant("Finish.", [finishCall("retry-finish")]);
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

// onDelta is a callback and is not part of the serializable request snapshot.
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
    goal: "Improve relationships in the dorm world",
    contextPaths: [],
    mode: "plan_first" as const,
  };
}

function validPlan(): string {
  return "# Creation plan: Dorm world\n\nPreserve existing characters, the current situation, and player agency. Add only observable relationship behavior and an opening hook, then run the complete candidate check before applying.";
}

function baseFiles() {
  return [
    {
      path: "opening.md",
      contents:
        "The dormitory door closes in front of you. Alex holds a jersey and waits.\n",
    },
    {
      path: "world/characters/alex.yaml",
      contents: `$document:\n  id: character.alex\n  ref: alex\n  title: Alex\n  summary: The basketball forward's current state and relationships.\n  aliases: []\nrelationships: {}\n`,
    },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current\n  title: Current situation\n  summary: The situation unfolding in the dormitory.\n  aliases: []\ncharacters:\n  - $ref: character.alex\n`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n`,
    },
    {
      path: "control/blocks/world.md",
      contents:
        "# World hosting rules\n\nWrite durable results back to their natural owners.\n",
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
        "candidate.message.genesis.narrator":
          "The dormitory door closes in front of you.",
      },
      additionalMaterials: [
        {
          kind: "history_message",
          message: "candidate.message.genesis.narrator",
        },
      ],
    },
    playerInputPlacement: "bootstrap",
    playerInput: "Preview",
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
