import { expect, test } from "vitest";

import { FileNativePromptCompiler } from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import {
  DocumentCandidateSettingImprovement,
  type SettingAuthorAdapter,
} from "../../src/runtime/setting/DocumentCandidateSettingImprovement.ts";
import { WorldDocumentStore } from "../../src/runtime/world/WorldDocumentStore.ts";

test("设定完善采用预设作者提示，同时始终追加内置工具机械契约", async () => {
  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    authorPrompt:
      "# 我的设定方法\n\n自定义唯一标记：只完善城市场景的生活节奏。",
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(snapshotAuthorRequest(request));
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("完善城市生活"));

  expect(requests[0]?.messages[0]).toMatchObject({ role: "system" });
  const system = requests[0]?.messages[0]?.content ?? "";
  expect(system).toContain("自定义唯一标记");
  expect(system).not.toContain("系统推荐的设定完善方法");
  expect(system).toContain("Runtime 设定完善工具与机械契约");
  expect(system).toContain("setting_write_file");
  expect(requests[0]?.tools).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
  ]);
});

test("设定完善以 append-only 会话创建和修改文件原生候选并生成完整审阅", async () => {
  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  const adapter: SettingAuthorAdapter = {
    async next(request) {
      await Promise.resolve();
      requests.push(snapshotAuthorRequest(request));
      if (requests.length === 1) {
        return { role: "assistant", content: plan(), toolCalls: [] };
      }
      if (requests.length === 3)
        return {
          role: "assistant",
          content: "运行完整候选自检。",
          toolCalls: [
            {
              id: "preview-complete-candidate",
              name: "setting_preview_candidate",
              arguments: {},
            },
          ],
        };
      if (requests.length === 4)
        return {
          role: "assistant",
          content: "候选已完成。",
          toolCalls: [
            { id: "finish", name: "setting_finish_candidate", arguments: {} },
          ],
        };
      return {
        role: "assistant",
        content: "候选已完成。",
        toolCalls: [
          {
            id: "read-opening",
            name: "setting_read",
            arguments: { path: "opening.md" },
          },
          {
            id: "write-opening",
            name: "setting_write_file",
            arguments: { path: "opening.md", contents: updatedOpening() },
          },
          {
            id: "read-rule",
            name: "setting_read",
            arguments: { path: "world/rules/cultivation.md" },
          },
          {
            id: "read-qinlong",
            name: "setting_read",
            arguments: { path: "world/characters/qinlong.yaml" },
          },
          {
            id: "create-character",
            name: "setting_write_file",
            arguments: {
              path: "world/characters/awu.yaml",
              contents: yamlSource({
                ref: "awu",
                title: "阿雾",
                summary: "阿雾的自然语言设定。",
                body: "对澄的态度: 好奇\n",
              }),
            },
          },
          {
            id: "patch-rule",
            name: "setting_write_file",
            arguments: {
              path: "world/rules/cultivation.md",
              contents: markdownSource({
                ref: "cultivation",
                title: "修炼规则",
                summary: "自然语言规则。",
                body: "境界没有数值上限，由师承、心境与叙事共同解释。",
              }),
            },
          },
          {
            id: "patch-character",
            name: "setting_patch",
            arguments: {
              document: "character.qinlong",
              op: "add",
              locator: ["关系", "阿雾"],
              value: { 态度: "戒备但愿意合作", 信任: 150 },
            },
          },
          {
            id: "patch-frame",
            name: "setting_write_file",
            arguments: {
              path: "control/blocks/world.md",
              contents:
                "# 世界主持规则\n\n关系变化通过行为表达；持续结果写回自然所有者。\n",
            },
          },
        ],
      };
    },
  };
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter,
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  const planned = await improvement.start(
    planFirst("增加阿雾并扩展人物关系和修炼规则"),
  );
  expect(planned.kind).toBe("plan");
  const ready = await improvement.confirmPlan();
  expect(ready.kind).toBe("candidate");
  if (ready.kind !== "candidate") throw new Error("候选未完成");
  expect(ready.review.status).toBe("usable");
  expect(ready.review.diff.map(({ path }) => path)).toEqual([
    "control/blocks/world.md",
    "opening.md",
    "world/characters/awu.yaml",
    "world/characters/qinlong.yaml",
    "world/rules/cultivation.md",
  ]);
  expect(ready.review.preview.compilation.logicalMessages.length).toBe(4);
  expect(
    ready.files.find(({ path }) => path.endsWith("qinlong.yaml"))?.contents,
  ).toContain("# 保留作者注释");
  expect(requests[1]?.messages.slice(-3)).toEqual([
    expect.objectContaining({ role: "user" }),
    expect.objectContaining({ role: "assistant", content: plan() }),
    expect.objectContaining({ role: "user" }),
  ]);
  expect(
    requests[1]?.messages.some(
      ({ role, content }) =>
        role === "user" && content.includes("增加阿雾并扩展人物关系和修炼规则"),
    ),
  ).toBe(true);
  expect(requests[0]).toMatchObject({
    tools: ["setting_list", "setting_search", "setting_read"],
    maxOutputTokens: 16_384,
  });
  expect(requests[0]?.messages[0]).toMatchObject({ role: "system" });
  expect(requests[0]?.messages[0]?.content).toContain("最小合法格式");
  expect(requests[0]?.messages[0]?.content).toContain(
    "愿望、意图、尝试、计划、可能性、预测",
  );
  expect(requests[0]?.messages[0]?.content).toContain("这些设定将怎样被使用");
  expect(requests[0]?.messages[0]?.content).toContain(
    "通用的裁决与状态维护判据由主持预设提供",
  );
  expect(requests[0]?.messages[0]?.content).not.toMatch(
    /人物文档|地点文档|物品文档/u,
  );
  expect(requests[0]?.messages[0]?.content).toContain("opening.md");
  expect(requests[0]?.messages[0]?.content).toContain("完整读取");
  expect(requests[0]?.messages[0]?.content).toContain("不受影响时保留");
  // 开场白与游玩调用链的叙事共用一套文体：小说质感、世界已在运转、决策点由场面
  // 推出来而不是由叙述者点名。玩家此刻还没有输入可承接，所以代演一概不许。
  expect(requests[0]?.messages[0]?.content).toContain("互动式小说的第一页");
  expect(requests[0]?.messages[0]?.content).toContain(
    "不要把所有人定格成等待启动的布景",
  );
  expect(requests[0]?.messages[0]?.content).toContain("那是主持人的声音");
  expect(requests[0]?.messages[0]?.content).toContain(
    "最后一句写某个人做的一件具体的事",
  );
  expect(requests[0]?.messages[0]?.content).toContain("他等着你的回答");
  expect(requests[0]?.messages[0]?.content).toContain(
    "不得替玩家决定行动、台词或内心",
  );
  // 新建文档的 id 是 Runtime 分配的随机值，作者无从预测；回执只回报它能用来
  // 寻址的 @短引用。
  expect(
    requests[2]?.messages.find(
      ({ toolCallId }) => toolCallId === "create-character",
    )?.content,
  ).toContain("- 创建 @awu · world/characters/awu.yaml");
  expect(requests[1]?.tools).toContain("setting_write_file");
  expect(requests[1]?.tools).toContain("setting_patch");
  expect(requests[1]?.maxOutputTokens).toBe(16_384);
  expect(JSON.stringify(requests[1])).not.toContain("/home/");
  expect(improvement.currentFiles()).toEqual(baseFiles());
  await improvement.apply((files) => expect(files).toEqual(ready.files));
  expect(improvement.currentFiles()).toEqual(ready.files);
  expect(
    ready.review.preview.compilation.logicalMessages.find(
      ({ role }) => role === "world_context",
    )?.markdown,
  ).toContain(updatedOpening().trim());
});

test("计划阶段可只读当前树，且用户选定文件会直接注入首个请求", async () => {
  const injectedSentinel = "直接注入唯一标记：青铜月照耀旧王都";
  const toolReadSentinel = "只读工具唯一标记：秦龙保留旧誓言";
  const files = baseFiles().map((file) => {
    if (file.path === "opening.md")
      return { ...file, contents: `${file.contents}${injectedSentinel}\n` };
    if (file.path === "world/characters/qinlong.yaml")
      return {
        ...file,
        contents: `${file.contents}备注: ${toolReadSentinel}\n`,
      };
    return file;
  });
  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  const improvement = new DocumentCandidateSettingImprovement({
    files,
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(snapshotAuthorRequest(request));
        if (requests.length === 1)
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "read-qinlong",
                name: "setting_read",
                arguments: { path: "world/characters/qinlong.yaml" },
              },
            ],
          };
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  const result = await improvement.start(
    planFirst("基于旧王都和秦龙的现状完善关系", ["opening.md"]),
  );

  expect(result.kind).toBe("plan");
  expect(requests[0]?.tools).toEqual([
    "setting_list",
    "setting_search",
    "setting_read",
  ]);
  expect(JSON.stringify(requests[0])).toContain(injectedSentinel);
  expect(JSON.stringify(requests[0])).not.toContain(toolReadSentinel);
  expect(JSON.stringify(requests[1])).toContain(toolReadSentinel);
  expect(requests[1]?.messages.at(-1)).toMatchObject({
    role: "tool",
    toolCallId: "read-qinlong",
  });
});

test("计划阶段通过固定 WorldDocumentStore 快照列出、搜索和读取 world 文档", async () => {
  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(snapshotAuthorRequest(request));
        if (requests.length === 1)
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "list-characters",
                name: "setting_list",
                arguments: { directory: "world/characters", limit: 10 },
              },
              {
                id: "search-qinlong",
                name: "setting_search",
                arguments: {
                  query: "秦龙",
                  within: "world/characters",
                  caseSensitive: true,
                  limit: 10,
                },
              },
              {
                id: "read-qinlong",
                name: "setting_read",
                arguments: {
                  path: "world/characters/qinlong.yaml",
                  maxBytes: 65_536,
                },
              },
            ],
          };
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("先精确了解秦龙，再制定计划"));

  const toolMessages = requests[1]?.messages.filter(
    ({ role }) => role === "tool",
  );
  expect(toolMessages?.[0]?.content).toContain("范围：world · characters");
  expect(toolMessages?.[0]?.content).toContain("world/characters/qinlong.yaml");
  expect(toolMessages?.[1]?.content).toContain("原始命中");
  expect(toolMessages?.[1]?.content).toContain("第 4 行");
  expect(toolMessages?.[2]?.content).toContain("# 精确读取 @qinlong");
  expect(toolMessages?.[2]?.content).toContain("范围：world · @qinlong");
  // 文档身份是 Runtime 内部值，模型一律用 @短引用寻址；回显 id 会诱导作者把
  // 它写进 $ref 和 control 文件，而新建文档的 id 根本不是它能预测的。
  expect(toolMessages?.[2]?.content).not.toContain("id: character.qinlong");
  expect(toolMessages?.[2]?.content).not.toContain("id：character.qinlong");
});

test("AI 能看到 catalog 的真实路径关联诊断并在结束候选前自行修复", async () => {
  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(snapshotAuthorRequest(request));
        if (requests.length === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (requests.length === 2)
          return {
            role: "assistant",
            content: "先建立状态文档和目录关联并运行候选自检。",
            toolCalls: [
              {
                id: "create-wrong-path",
                name: "setting_write_file",
                arguments: {
                  path: "world/state.qinming.yaml",
                  contents: yamlSource({
                    ref: "qinming-status",
                    title: "启铭的当前状态",
                    summary: "启铭的体力与法力。",
                    body: "体力: 80\n法力: 40\n",
                  }),
                },
              },
              {
                id: "write-frame-with-states",
                name: "setting_write_file",
                arguments: {
                  path: "control/frame.yaml",
                  contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: catalog, directory: states, maxEntries: 24 }
  - slot: { kind: additional_materials }
`,
                },
              },
              {
                id: "preview-wrong-association",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        if (requests.length === 3) {
          const diagnostic = request.messages.at(-1);
          expect(diagnostic).toMatchObject({
            role: "tool",
            toolCallId: "preview-wrong-association",
          });
          expect(diagnostic?.content).toMatch(
            /states.*world\/states\/<文件>\.(?:yaml|yml|md).*直接子文档/u,
          );
          return {
            role: "assistant",
            content: "已按诊断移动到 catalog 对应的真实目录并再次自检。",
            toolCalls: [
              {
                id: "read-wrong-path",
                name: "setting_read",
                arguments: { path: "world/state.qinming.yaml" },
              },
              {
                id: "move-to-correct-path",
                name: "setting_move",
                arguments: {
                  from: "world/state.qinming.yaml",
                  to: "world/states/qinming.yaml",
                },
              },
              {
                id: "preview-correct-association",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        const successfulPreview = request.messages.at(-1);
        expect(successfulPreview).toMatchObject({
          role: "tool",
          toolCallId: "preview-correct-association",
        });
        expect(successfulPreview?.content).toContain("# 候选自检通过");
        return {
          role: "assistant",
          content: "最终候选已通过自检。",
          toolCalls: [
            { id: "finish", name: "setting_finish_candidate", arguments: {} },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("把启铭的动态体力和法力拆到状态目录"));
  const result = await improvement.confirmPlan();

  expect(result.files).toContainEqual(
    expect.objectContaining({ path: "world/states/qinming.yaml" }),
  );
  expect(result.files).not.toContainEqual(
    expect.objectContaining({ path: "world/state.qinming.yaml" }),
  );
  expect(result.review.diff.map(({ path, kind }) => ({ path, kind }))).toEqual([
    { path: "control/frame.yaml", kind: "modify" },
    { path: "world/states/qinming.yaml", kind: "create" },
  ]);
  expect(requests).toHaveLength(4);
  expect(requests[0]?.messages[0]?.content).toContain(
    "world/states/qinming.yaml",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "state/states/qinming.yaml",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "world/state.qinming.yaml",
  );
  expect(requests[0]?.messages[0]?.content).toContain("从上到下");
  expect(requests[1]?.tools).toContain("setting_preview_candidate");
  expect(requests[1]?.tools).toContain("setting_move");
});

test("创建 world 文档通过 revision 分配身份并消解短引用冲突", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "创建阿雾文档并检查完整候选。",
            toolCalls: [
              {
                id: "create-awu",
                name: "setting_write_file",
                arguments: {
                  path: "world/characters/awu.yaml",
                  contents: yamlSource({
                    ref: "qinlong",
                    title: "阿雾",
                    summary: "在雨夜来到宿舍的陌生人。",
                    body: "关系:\n  秦龙: 戒备\n",
                  }),
                },
              },
              {
                id: "patch-created-awu",
                name: "setting_patch",
                arguments: {
                  document: "world/characters/awu.yaml",
                  op: "add",
                  locator: ["状态"],
                  value: "等待接触",
                },
              },
              {
                id: "preview-created",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        expect(request.messages.at(-1)?.content).toContain("# 候选自检通过");
        return {
          role: "assistant",
          content: "候选完成。",
          toolCalls: [
            {
              id: "finish-created",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("增加阿雾"));
  const result = await improvement.confirmPlan();
  const snapshot = WorldDocumentStore.open({
    layout: "content_package",
    files: result.files,
  });
  const created = snapshot.query({
    kind: "read_document",
    document: { logicalPath: "world/characters/awu.yaml" },
    maxBytes: 65_536,
  });

  expect(created.kind).toBe("read_document");
  if (created.kind !== "read_document") throw new Error("新文档不可读取");
  expect(created.document.documentId).toMatch(/^doc\.[0-9a-f]{32}$/u);
  expect(created.document.shortRef).toBe("qinlong-2");
  expect(created.body).toContain("秦龙: 戒备");
  expect(created.body).toContain("状态: 等待接触");
});

test("有序 revision 批次允许 move 后按新路径 replace 已完整读取的文档", async () => {
  const from = "world/characters/qinlong.yaml";
  const to = "world/people/qinlong.yaml";
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "按顺序移动并替换秦龙文档，然后检查候选。",
            toolCalls: [
              {
                id: "read-before-move-replace",
                name: "setting_read",
                arguments: { path: from },
              },
              {
                id: "move-before-replace",
                name: "setting_move",
                arguments: { from, to },
              },
              {
                id: "replace-after-move",
                name: "setting_write_file",
                arguments: {
                  path: to,
                  contents: character(
                    "character.qinlong",
                    "qinlong",
                    "秦龙",
                    "关系: {}\n衣着: 深蓝色运动背心",
                  ),
                },
              },
              {
                id: "preview-after-move-replace",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        return {
          role: "assistant",
          content: "候选完成。",
          toolCalls: [
            {
              id: "finish-after-move-replace",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("移动并更新秦龙文档"));
  const result = await improvement.confirmPlan();

  expect(result.files).not.toContainEqual(
    expect.objectContaining({ path: from }),
  );
  expect(result.files.find(({ path }) => path === to)?.contents).toContain(
    "深蓝色运动背心",
  );
  expect(result.review.diff.map(({ path, kind }) => ({ path, kind }))).toEqual([
    { path: from, kind: "delete" },
    { path: to, kind: "create" },
  ]);
});

test("用户直接注入的损坏 world 文档可按同一快照授权整份 replace 修复", async () => {
  const damagedPath = "world/characters/qinlong.yaml";
  const damagedFiles = baseFiles().map((file) =>
    file.path === damagedPath ? { ...file, contents: "not: [valid\n" } : file,
  );
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: damagedFiles,
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1) {
          expect(JSON.stringify(request.messages)).toContain("not: [valid");
          return { role: "assistant", content: plan(), toolCalls: [] };
        }
        if (round === 2)
          return {
            role: "assistant",
            content: "用完整原文修复损坏文档。",
            toolCalls: [
              {
                id: "repair-damaged",
                name: "setting_write_file",
                arguments: {
                  path: damagedPath,
                  contents: character(
                    "character.qinlong",
                    "qinlong",
                    "秦龙",
                    "关系: {}",
                  ),
                },
              },
              {
                id: "preview-repaired",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        expect(request.messages.at(-1)?.content).toContain("# 候选自检通过");
        return {
          role: "assistant",
          content: "修复完成。",
          toolCalls: [
            {
              id: "finish-repaired",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(
    planFirst("修复秦龙文档", ["world/characters/qinlong.yaml"]),
  );
  const result = await improvement.confirmPlan();

  expect(result.review.status).toBe("usable");
  expect(result.review.diff).toEqual([
    expect.objectContaining({ path: damagedPath, kind: "modify" }),
  ]);
  expect(
    result.files.find(({ path }) => path === damagedPath)?.contents,
  ).toContain("id: character.qinlong");
});

test("revision 替换候选快照后拒绝旧 cursor，并要求重新建立读取授权", async () => {
  let round = 0;
  let previousCursor = "";
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "先读取并取得目录 cursor。",
            toolCalls: [
              {
                id: "read-before-patch",
                name: "setting_read",
                arguments: { path: "world/characters/qinlong.yaml" },
              },
              {
                id: "list-before-patch",
                name: "setting_list",
                arguments: { directory: "world", limit: 1 },
              },
            ],
          };
        if (round === 3) {
          const listing = request.messages.find(
            ({ toolCallId }) => toolCallId === "list-before-patch",
          )?.content;
          previousCursor =
            /下一页 cursor：(\S+)/u.exec(listing ?? "")?.[1] ?? "";
          expect(previousCursor).not.toBe("");
          return {
            role: "assistant",
            content: "修改秦龙。",
            toolCalls: [
              {
                id: "patch-qinlong",
                name: "setting_patch",
                arguments: {
                  document: "@qinlong",
                  op: "add",
                  locator: ["衣着"],
                  value: "深蓝色运动背心",
                },
              },
            ],
          };
        }
        if (round === 4)
          return {
            role: "assistant",
            content: "验证旧 cursor 已失效。",
            toolCalls: [
              {
                id: "reuse-old-cursor",
                name: "setting_list",
                arguments: {
                  directory: "world",
                  limit: 1,
                  cursor: previousCursor,
                },
              },
            ],
          };
        if (round === 5) {
          expect(request.messages.at(-1)?.content).toContain("cursor_invalid");
          return {
            role: "assistant",
            content: "重新自检。",
            toolCalls: [
              {
                id: "preview-after-cursor",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        return {
          role: "assistant",
          content: "完成。",
          toolCalls: [
            {
              id: "finish-after-cursor",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("调整秦龙衣着"));
  const result = await improvement.confirmPlan();

  expect(
    result.files.find(({ path }) => path.endsWith("qinlong.yaml"))?.contents,
  ).toContain("衣着: 深蓝色运动背心");
});

test("revision 后可以继续修改同一份文档而不必重读", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "先读后改。",
            toolCalls: [
              {
                id: "read-once",
                name: "setting_read",
                arguments: { path: "world/characters/qinlong.yaml" },
              },
              {
                id: "patch-once",
                name: "setting_patch",
                arguments: {
                  document: "@qinlong",
                  op: "add",
                  locator: ["衣着"],
                  value: "白色球衣",
                },
              },
            ],
          };
        if (round === 3)
          return {
            role: "assistant",
            content: "不重新读取，继续修改。",
            toolCalls: [
              {
                id: "patch-twice",
                name: "setting_patch",
                arguments: {
                  document: "@qinlong",
                  op: "replace",
                  locator: ["衣着"],
                  value: "黑色球衣",
                },
              },
            ],
          };
        if (round === 4) {
          expect(
            request.messages.find(
              ({ toolCallId }) => toolCallId === "patch-twice",
            )?.content,
          ).toContain("revision 已接受");
          return {
            role: "assistant",
            content: "检查候选。",
            toolCalls: [
              {
                id: "preview-after-patch",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        return {
          role: "assistant",
          content: "完成。",
          toolCalls: [
            {
              id: "finish-after-read",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("连续调整秦龙衣着"));
  const result = await improvement.confirmPlan();
  expect(
    result.files.find(({ path }) => path.endsWith("qinlong.yaml"))?.contents,
  ).toContain("衣着: 黑色球衣");
  expect(improvement.currentFiles()).toEqual(baseFiles());
});

test("修改世界文档后写 opening.md 不需要重新读取", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "先读开场白和人物。",
            toolCalls: [
              {
                id: "read-opening",
                name: "setting_read",
                arguments: { path: "opening.md" },
              },
              {
                id: "read-qinlong",
                name: "setting_read",
                arguments: { path: "world/characters/qinlong.yaml" },
              },
            ],
          };
        if (round === 3)
          return {
            role: "assistant",
            content: "先改人物，再据此同步开场白。",
            toolCalls: [
              {
                id: "patch-qinlong",
                name: "setting_patch",
                arguments: {
                  document: "@qinlong",
                  op: "add",
                  locator: ["衣着"],
                  value: "白色球衣",
                },
              },
              {
                id: "write-opening",
                name: "setting_write_file",
                arguments: { path: "opening.md", contents: updatedOpening() },
              },
            ],
          };
        if (round === 4) {
          expect(
            request.messages.find(
              ({ toolCallId }) => toolCallId === "write-opening",
            )?.content,
          ).toContain("已在隔离候选写入 opening.md");
          return {
            role: "assistant",
            content: "自检。",
            toolCalls: [
              {
                id: "preview-after-opening",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        return {
          role: "assistant",
          content: "完成。",
          toolCalls: [
            {
              id: "finish-after-opening",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("调整秦龙衣着并同步开场白"));
  const result = await improvement.confirmPlan();

  expect(result.files.find(({ path }) => path === "opening.md")?.contents).toBe(
    updatedOpening(),
  );
  expect(
    result.files.find(({ path }) => path.endsWith("qinlong.yaml"))?.contents,
  ).toContain("衣着: 白色球衣");
});

test("读出 Markdown 正文后可以原样改好写回，不必自己拼技术头", async () => {
  const rulePath = "world/rules/cultivation.md";
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "先读规则。",
            toolCalls: [
              {
                id: "read-rule",
                name: "setting_read",
                arguments: { path: rulePath },
              },
            ],
          };
        if (round === 3) {
          // 作者把上一轮读到的正文原样改好写回，没有 $document front matter。
          const body = request.messages
            .find(({ toolCallId }) => toolCallId === "read-rule")
            ?.content.split("[可写正文开始；locator 相对于这里]\n")[1]
            ?.split("\n[可写正文")[0];
          expect(body).toBe("# 修炼规则\n\n境界由故事解释。");
          return {
            role: "assistant",
            content: "改好写回。",
            toolCalls: [
              {
                id: "write-rule",
                name: "setting_write_file",
                arguments: {
                  path: rulePath,
                  contents: `${body?.replace("境界由故事解释。", "境界由师承与心境共同解释。") ?? ""}\n`,
                },
              },
            ],
          };
        }
        if (round === 4) {
          expect(
            request.messages.find(
              ({ toolCallId }) => toolCallId === "write-rule",
            )?.content,
          ).toContain("revision 已接受");
          return {
            role: "assistant",
            content: "自检。",
            toolCalls: [
              {
                id: "preview-rule",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        return {
          role: "assistant",
          content: "完成。",
          toolCalls: [
            {
              id: "finish-rule",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("调整修炼规则的解释口径"));
  const result = await improvement.confirmPlan();

  const rule = result.files.find(({ path }) => path === rulePath)?.contents;
  expect(rule).toContain("境界由师承与心境共同解释。");
  expect(rule).toContain("id: rule.cultivation");
  expect(rule).toContain("title: 修炼规则");
});

test("同一轮内先自检再结束候选会被接受", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        return {
          role: "assistant",
          content: "自检后立即结束。",
          toolCalls: [
            {
              id: "preview-same-response",
              name: "setting_preview_candidate",
              arguments: {},
            },
            {
              id: "finish-same-response",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("不做修改直接确认当前设定"));

  await expect(improvement.confirmPlan()).resolves.toMatchObject({
    kind: "candidate",
  });
  expect(round).toBe(2);
});

test("候选自检和真实 Prompt Preview 复用会话内当前文档快照", async () => {
  let round = 0;
  let receivedSnapshot = false;
  let previewCalls = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "检查固定候选。",
            toolCalls: [
              {
                id: "preview-fixed-snapshot",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        return {
          role: "assistant",
          content: "完成。",
          toolCalls: [
            {
              id: "finish-fixed-snapshot",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (candidate) => {
      previewCalls += 1;
      receivedSnapshot = candidate instanceof WorldDocumentStore;
      return previewSnapshot(candidate);
    },
  });

  await improvement.start(planFirst("只检查当前候选"));
  await improvement.confirmPlan();

  expect(receivedSnapshot).toBe(true);
  expect(previewCalls).toBe(1);
});

test("未等待 setting_preview_candidate 整体通过时不能完成候选", async () => {
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "直接结束。",
            toolCalls: [
              {
                id: "finish-too-early",
                name: "setting_finish_candidate",
                arguments: {},
              },
            ],
          };
        if (round === 3) {
          expect(request.messages.at(-1)?.content).toMatch(
            /未被接受.*setting_preview_candidate/u,
          );
          return {
            role: "assistant",
            content: "先运行真实预览。",
            toolCalls: [
              {
                id: "preview-before-finish",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        expect(request.messages.at(-1)?.content).toContain("# 候选自检通过");
        return {
          role: "assistant",
          content: "现在完成。",
          toolCalls: [
            {
              id: "finish-after-preview",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("验证候选"));
  const result = await improvement.confirmPlan();

  expect(result.kind).toBe("candidate");
  expect(round).toBe(4);
});

test("计划阶段拒绝写工具，直接模式则跳过计划并生成完整候选", async () => {
  const original = baseFiles();
  let planningRound = 0;
  const planning = new DocumentCandidateSettingImprovement({
    files: original,
    adapter: {
      async next(request) {
        await Promise.resolve();
        planningRound += 1;
        if (planningRound === 2) {
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: "forbidden-write",
          });
          expect(request.messages.at(-1)?.content).toContain("计划阶段只允许");
          return { role: "assistant", content: plan(), toolCalls: [] };
        }
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "forbidden-write",
              name: "setting_write_file",
              arguments: {
                path: "world/characters/qinlong.yaml",
                contents: "不应写入",
              },
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });
  await expect(planning.start(planFirst("只制定计划"))).resolves.toMatchObject({
    kind: "plan",
  });
  expect(planning.currentFiles()).toEqual(original);

  const requests: Parameters<SettingAuthorAdapter["next"]>[0][] = [];
  const direct = new DocumentCandidateSettingImprovement({
    files: original,
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(snapshotAuthorRequest(request));
        if (requests.length === 1)
          return {
            role: "assistant",
            content: "更新开场白。",
            toolCalls: [
              { id: "list", name: "setting_list", arguments: {} },
              {
                id: "write-opening",
                name: "setting_write_file",
                arguments: { path: "opening.md", contents: updatedOpening() },
              },
            ],
          };
        if (requests.length === 2)
          return {
            role: "assistant",
            content: "检查候选。",
            toolCalls: [
              {
                id: "preview-direct",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        return {
          role: "assistant",
          content: "候选已完成。",
          toolCalls: [
            { id: "finish", name: "setting_finish_candidate", arguments: {} },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  const result = await direct.start({
    goal: "无需计划，直接检查并生成候选",
    contextPaths: ["opening.md"],
    mode: "direct_candidate",
  });

  expect(result.kind).toBe("candidate");
  if (result.kind !== "candidate") throw new Error("直接候选未生成");
  expect(requests).toHaveLength(3);
  expect(requests[0]?.tools).toContain("setting_write_file");
  expect(JSON.stringify(requests[0])).toContain(opening().trim());
  expect(JSON.stringify(requests[0])).toContain("跳过可见创作计划");
  expect(result.review.diff).toContainEqual(
    expect.objectContaining({ path: "opening.md", kind: "modify" }),
  );
  await expect(direct.confirmPlan()).rejects.toThrow(/没有可确认的创作计划/u);
});

test("直接注入只接受固定当前树中的文本文件", async () => {
  let providerCalls = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next() {
        await Promise.resolve();
        providerCalls += 1;
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await expect(
    improvement.start(planFirst("读取不存在的文件", ["world/missing.yaml"])),
  ).rejects.toThrow(/注入文件不存在/u);
  await expect(
    improvement.start(planFirst("拒绝重复选择", ["opening.md", "opening.md"])),
  ).rejects.toThrow(/注入文件路径重复/u);
  await expect(
    improvement.start(planFirst("拒绝不安全路径", ["../opening.md"])),
  ).rejects.toThrow(/路径不安全/u);
  expect(providerCalls).toBe(0);

  const binary = new DocumentCandidateSettingImprovement({
    files: [
      ...baseFiles(),
      { path: "assets/map.png", contents: "AA==", encoding: "base64" },
    ],
    adapter: {
      async next() {
        await Promise.resolve();
        providerCalls += 1;
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: () => {
      throw new Error("不应生成预览");
    },
  });
  await expect(
    binary.start(planFirst("拒绝二进制上下文", ["assets/map.png"])),
  ).rejects.toThrow(/二进制文件不能直接注入/u);
  expect(providerCalls).toBe(0);
});

test("既有开场白必须完整读取后才能更新，缺失时可直接创建", async () => {
  const calls: SettingAuthorToolCallBatch[] = [
    [
      {
        id: "write-without-read",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: updatedOpening() },
      },
      { id: "finish", name: "setting_finish_candidate", arguments: {} },
    ],
    [
      {
        id: "read-before-repair",
        name: "setting_read",
        arguments: { path: "opening.md" },
      },
      {
        id: "write-after-read",
        name: "setting_write_file",
        arguments: { path: "opening.md", contents: updatedOpening() },
      },
    ],
  ];
  const improvement = improvementWithCalls(baseFiles(), calls);
  await improvement.start(planFirst("调整开场局面"));
  const repaired = await improvement.confirmPlan();
  expect(
    repaired.files.find(({ path }) => path === "opening.md")?.contents,
  ).toBe(updatedOpening());

  const missing = improvementWithCalls(
    baseFiles().filter(({ path }) => path !== "opening.md"),
    [
      [
        {
          id: "create-opening",
          name: "setting_write_file",
          arguments: { path: "opening.md", contents: updatedOpening() },
        },
        { id: "finish", name: "setting_finish_candidate", arguments: {} },
      ],
    ],
  );
  await missing.start(planFirst("补全开场白"));
  const created = await missing.confirmPlan();
  expect(created.files).toContainEqual({
    path: "opening.md",
    contents: updatedOpening(),
  });

  const unfinished = improvementWithCalls(
    baseFiles().filter(({ path }) => path !== "opening.md"),
    [[{ id: "finish", name: "setting_finish_candidate", arguments: {} }]],
  );
  await unfinished.start(planFirst("不要遗漏开场白"));
  await expect(unfinished.confirmPlan()).rejects.toThrow(/候选.*可修复.*上限/u);
});

test("工具或 Preview 失败与放弃都不会污染固定目标", async () => {
  const original = baseFiles();
  let round = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: original,
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 3) {
          expect(request.messages.at(-1)?.content).toContain("候选路径不安全");
          return {
            role: "assistant",
            content: "运行候选预览。",
            toolCalls: [
              {
                id: "preview-failed-candidate",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        if (round === 4) {
          expect(request.messages.at(-1)?.content).toContain(
            "真实 Prompt Preview 编译失败",
          );
          throw new Error("provider unavailable");
        }
        return {
          role: "assistant",
          content: "错误候选",
          toolCalls: [
            {
              id: "bad",
              name: "setting_write_file",
              arguments: { path: "../escape.md", contents: "x" },
            },
          ],
        };
      },
    },
    preview: () => {
      throw new Error("preview failed");
    },
  });
  await improvement.start(planFirst("修改设定"));
  await expect(improvement.confirmPlan()).rejects.toThrow(
    "provider unavailable",
  );
  improvement.discard();
  expect(improvement.currentFiles()).toEqual(original);
});

test("真实 Prompt Preview 失败后必须重新自检，成功后才可完成", async () => {
  let round = 0;
  let previewCalls = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: baseFiles(),
    adapter: {
      async next(request) {
        await Promise.resolve();
        round += 1;
        if (round === 1)
          return { role: "assistant", content: plan(), toolCalls: [] };
        if (round === 2)
          return {
            role: "assistant",
            content: "运行预览。",
            toolCalls: [
              {
                id: "preview-fails",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        if (round === 3) {
          expect(request.messages.at(-1)?.content).toContain(
            "真实 Prompt Preview 编译失败",
          );
          return {
            role: "assistant",
            content: "重新运行预览。",
            toolCalls: [
              {
                id: "preview-recovers",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        expect(request.messages.at(-1)?.content).toContain("# 候选自检通过");
        return {
          role: "assistant",
          content: "完成。",
          toolCalls: [
            {
              id: "finish-after-recovery",
              name: "setting_finish_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => {
      previewCalls += 1;
      if (previewCalls === 1) throw new Error("preview unavailable");
      return previewSnapshot(snapshot);
    },
  });

  await improvement.start(planFirst("验证预览恢复"));
  const result = await improvement.confirmPlan();

  expect(result.review.status).toBe("usable");
  expect(previewCalls).toBe(2);
});

test("control 写入可创建缺失文件且 YAML patch 接受 Runtime 短引用", async () => {
  const withoutControlBlock = baseFiles().filter(
    ({ path }) => path !== "control/blocks/world.md",
  );
  let candidateRound = 0;
  const improvement = new DocumentCandidateSettingImprovement({
    files: withoutControlBlock,
    adapter: {
      async next(request) {
        await Promise.resolve();
        if (!request.messages.some(({ role }) => role === "assistant"))
          return { role: "assistant", content: plan(), toolCalls: [] };
        candidateRound += 1;
        if (candidateRound === 2)
          return {
            role: "assistant",
            content: "检查候选。",
            toolCalls: [
              {
                id: "preview-control",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        if (candidateRound === 3)
          return {
            role: "assistant",
            content: "完成。",
            toolCalls: [
              {
                id: "finish-control",
                name: "setting_finish_candidate",
                arguments: {},
              },
            ],
          };
        return {
          role: "assistant",
          content: "完成",
          toolCalls: [
            {
              id: "read-qinlong",
              name: "setting_read",
              arguments: { path: "world/characters/qinlong.yaml" },
            },
            {
              id: "patch-ref",
              name: "setting_patch",
              arguments: {
                document: "@qinlong",
                op: "add",
                locator: ["衣着"],
                value: "黑色运动背心",
              },
            },
            {
              id: "write-control",
              name: "setting_write_file",
              arguments: {
                path: "control/blocks/world.md",
                contents: "# 世界主持规则\n\n持续结果写回自然所有者。\n",
              },
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("修复候选并调整秦龙衣着"));
  const result = await improvement.confirmPlan();

  expect(
    result.files.find(({ path }) => path.endsWith("qinlong.yaml"))?.contents,
  ).toContain("衣着: 黑色运动背心");
  expect(result.files).toContainEqual(
    expect.objectContaining({ path: "control/blocks/world.md" }),
  );
});

// onDelta 是回调，不属于可快照的请求内容。
function snapshotAuthorRequest(
  request: Parameters<SettingAuthorAdapter["next"]>[0],
) {
  const snapshot = { ...request };
  delete snapshot.onDelta;
  return structuredClone(snapshot);
}

function plan(): string {
  return `# 创作计划\n\n## 主要体验\n人物关系推进\n## 次要体验\n修炼探索\n## 反复游玩循环\n互动、反馈、持续变化\n## 焦点\n人物选择\n## 节奏\n慢热\n## 冲突\n信任差异\n## 信息结构\n通过行为披露\n## 语气边界\n克制，不替玩家行动\n## 明确排除项\n不引入数值 schema`;
}

function baseFiles() {
  return [
    {
      path: "opening.md",
      contents: opening(),
    },
    {
      path: "world/characters/qinlong.yaml",
      contents: character("character.qinlong", "qinlong", "秦龙", "关系: {}"),
    },
    {
      path: "world/current-situation.yaml",
      contents: character(
        "situation.current",
        "current",
        "当前情境",
        "人物:\n  - $ref: character.qinlong",
      ),
    },
    {
      path: "world/rules/cultivation.md",
      contents: `---\n$document:\n  id: rule.cultivation\n  ref: cultivation\n  title: 修炼规则\n  summary: 自然语言规则。\n  aliases: []\n---\n# 修炼规则\n\n境界由故事解释。\n`,
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
      contents: `format: narraeon.player-views/v1\nviews:\n  - id: relations\n    title: 人物关系\n    items:\n      - id: qinlong-relations\n        label: 秦龙的关系\n        select: { document: character.qinlong, locator: { yaml: [关系] } }\n`,
    },
  ];
}

function character(
  id: string,
  ref: string,
  title: string,
  body: string,
): string {
  return `$document:\n  id: ${id}\n  ref: ${ref}\n  title: ${title}\n  summary: ${title}的自然语言设定。\n  aliases: []\n# 保留作者注释\n${body}\n`;
}

// setting_write_file always takes the whole source; the store owns id and ref,
// so what the author writes for `id` here is deliberately arbitrary.
function yamlSource(input: {
  ref: string;
  title: string;
  summary: string;
  body: string;
}): string {
  return `$document:\n  id: 由 Runtime 决定\n  ref: ${input.ref}\n  title: ${input.title}\n  summary: ${input.summary}\n  aliases: []\n${input.body}`;
}

function markdownSource(input: {
  ref: string;
  title: string;
  summary: string;
  body: string;
}): string {
  return `---\n$document:\n  id: 由 Runtime 决定\n  ref: ${input.ref}\n  title: ${input.title}\n  summary: ${input.summary}\n  aliases: []\n---\n# ${input.title}\n\n${input.body}\n`;
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
        "candidate.message.genesis.narrator": openingText(snapshot.files),
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
      contextWindowTokens: 32000,
      maxOutputTokens: 2000,
    },
  });
}

type SettingAuthorToolCallBatch = Parameters<
  SettingAuthorAdapter["next"]
>[0]["messages"][number]["toolCalls"];

function improvementWithCalls(
  files: ReturnType<typeof baseFiles>,
  batches: SettingAuthorToolCallBatch[],
) {
  let planned = false;
  return new DocumentCandidateSettingImprovement({
    files,
    adapter: {
      async next(request) {
        await Promise.resolve();
        if (!planned) {
          planned = true;
          return { role: "assistant", content: plan(), toolCalls: [] };
        }
        const batch = batches.shift();
        if (batch !== undefined)
          return { role: "assistant", content: "完成", toolCalls: batch };
        const lastToolResult = request.messages.at(-1)?.content ?? "";
        if (lastToolResult.includes("# 候选自检未通过"))
          return { role: "assistant", content: "无法完成", toolCalls: [] };
        if (lastToolResult.includes("# 候选自检通过"))
          return {
            role: "assistant",
            content: "完成",
            toolCalls: [
              {
                id: "auto-finish",
                name: "setting_finish_candidate",
                arguments: {},
              },
            ],
          };
        return {
          role: "assistant",
          content: "检查候选",
          toolCalls: [
            {
              id: "auto-preview",
              name: "setting_preview_candidate",
              arguments: {},
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });
}

function planFirst(goal: string, contextPaths: string[] = []) {
  return { goal, contextPaths, mode: "plan_first" as const };
}

function opening(): string {
  return "宿舍门在你面前合上。秦龙抱着球衣，等你先开口。\n";
}

function updatedOpening(): string {
  return "雨声压住走廊里的脚步。阿雾站在宿舍门边，秦龙放下球衣，两人都在等你的反应。\n";
}

function openingText(
  files: readonly { path: string; contents: string }[],
): string {
  return files.find(({ path }) => path === "opening.md")?.contents ?? "";
}
