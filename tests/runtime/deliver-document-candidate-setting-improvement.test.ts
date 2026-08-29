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
      "# My setting method\n\nUnique custom marker: improve only the rhythm of city life.",
    adapter: {
      async next(request) {
        await Promise.resolve();
        requests.push(snapshotAuthorRequest(request));
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("Improve city life"));

  expect(requests[0]?.messages[0]).toMatchObject({ role: "system" });
  const system = requests[0]?.messages[0]?.content ?? "";
  expect(system).toContain("Unique custom marker");
  expect(system).not.toContain("Recommended setting-improvement method");
  expect(system).toContain(
    "Runtime setting-improvement tools and mechanical contract",
  );
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
          content: "Run the complete candidate check.",
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
          content: "Candidate complete.",
          toolCalls: [
            { id: "finish", name: "setting_finish_candidate", arguments: {} },
          ],
        };
      return {
        role: "assistant",
        content: "Candidate complete.",
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
            id: "read-alex",
            name: "setting_read",
            arguments: { path: "world/characters/alex.yaml" },
          },
          {
            id: "create-character",
            name: "setting_write_file",
            arguments: {
              path: "world/characters/mia.yaml",
              contents: yamlSource({
                ref: "mia",
                title: "Mia",
                summary: "Mia的自然语言设定。",
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
              document: "character.alex",
              op: "add",
              locator: ["关系", "Mia"],
              value: { 态度: "戒备但愿意合作", 信任: 150 },
            },
          },
          {
            id: "patch-frame",
            name: "setting_write_file",
            arguments: {
              path: "control/blocks/world.md",
              contents:
                "# World Narration Rules\n\nExpress relationship changes through behavior; write durable outcomes back to their natural owner.\n",
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
    planFirst("Add Mia and expand relationships and progression rules"),
  );
  expect(planned.kind).toBe("plan");
  const ready = await improvement.confirmPlan();
  expect(ready.kind).toBe("candidate");
  if (ready.kind !== "candidate") throw new Error("Candidate did not complete");
  expect(ready.review.status).toBe("usable");
  expect(ready.review.diff.map(({ path }) => path)).toEqual([
    "control/blocks/world.md",
    "opening.md",
    "world/characters/alex.yaml",
    "world/characters/mia.yaml",
    "world/rules/cultivation.md",
  ]);
  expect(ready.review.preview.compilation.logicalMessages.length).toBe(4);
  expect(
    ready.files.find(({ path }) => path.endsWith("alex.yaml"))?.contents,
  ).toContain("# 保留作者注释");
  expect(requests[1]?.messages.slice(-3)).toEqual([
    expect.objectContaining({ role: "user" }),
    expect.objectContaining({ role: "assistant", content: plan() }),
    expect.objectContaining({ role: "user" }),
  ]);
  expect(
    requests[1]?.messages.some(
      ({ role, content }) =>
        role === "user" &&
        content.includes(
          "Add Mia and expand relationships and progression rules",
        ),
    ),
  ).toBe(true);
  expect(requests[0]).toMatchObject({
    tools: ["setting_list", "setting_search", "setting_read"],
    maxOutputTokens: 16_384,
  });
  expect(requests[0]?.messages[0]).toMatchObject({ role: "system" });
  expect(requests[0]?.messages[0]?.content).toContain("Minimal valid formats");
  expect(requests[0]?.messages[0]?.content).toContain(
    "Wishes, intentions, attempts, plans, possibilities, predictions",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "How the setting is used",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "The host preset supplies general adjudication and state-maintenance criteria",
  );
  expect(requests[0]?.messages[0]?.content).not.toMatch(
    /character document|location document|item document/u,
  );
  expect(requests[0]?.messages[0]?.content).toContain("opening.md");
  expect(requests[0]?.messages[0]?.content).toContain(
    "completely before changing it",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "Preserve an unaffected opening",
  );
  // The opening and play call chain share an interactive-novel voice: the
  // world is already moving, and the scene presents choices without puppeting
  // a player who has not supplied an action yet.
  expect(requests[0]?.messages[0]?.content).toContain(
    "first page of this interactive novel",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "do not freeze the cast as scenery waiting to be activated",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "that is the host's voice",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "Make the last sentence a specific action someone takes",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "they wait for your answer",
  );
  expect(requests[0]?.messages[0]?.content).toContain(
    "Do not decide the player's action, dialogue, or inner thoughts",
  );
  // Runtime assigns an unpredictable ID to a new document; its receipt exposes
  // only the @short-ref the author can use for addressing.
  expect(
    requests[2]?.messages.find(
      ({ toolCallId }) => toolCallId === "create-character",
    )?.content,
  ).toContain("- Created @mia · world/characters/mia.yaml");
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
  const toolReadSentinel = "只读工具唯一标记：Alex保留旧誓言";
  const files = baseFiles().map((file) => {
    if (file.path === "opening.md")
      return { ...file, contents: `${file.contents}${injectedSentinel}\n` };
    if (file.path === "world/characters/alex.yaml")
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
                id: "read-alex",
                name: "setting_read",
                arguments: { path: "world/characters/alex.yaml" },
              },
            ],
          };
        return { role: "assistant", content: plan(), toolCalls: [] };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  const result = await improvement.start(
    planFirst(
      "Improve relationships using the old capital and Alex current state",
      ["opening.md"],
    ),
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
    toolCallId: "read-alex",
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
                id: "search-alex",
                name: "setting_search",
                arguments: {
                  query: "Alex",
                  within: "world/characters",
                  caseSensitive: true,
                  limit: 10,
                },
              },
              {
                id: "read-alex",
                name: "setting_read",
                arguments: {
                  path: "world/characters/alex.yaml",
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

  await improvement.start(
    planFirst("Understand Alex precisely before making a plan"),
  );

  const toolMessages = requests[1]?.messages.filter(
    ({ role }) => role === "tool",
  );
  expect(toolMessages?.[0]?.content).toContain("Scope: world · characters");
  expect(toolMessages?.[0]?.content).toContain("world/characters/alex.yaml");
  expect(toolMessages?.[1]?.content).toContain("Exact match");
  expect(toolMessages?.[1]?.content).toContain("line 4");
  expect(toolMessages?.[2]?.content).toContain("# Exact read @alex");
  expect(toolMessages?.[2]?.content).toContain("Scope: world · @alex");
  // Document IDs are Runtime-private. Echoing them would encourage the author
  // to place unpredictable identities in $ref values and control files.
  expect(toolMessages?.[2]?.content).not.toContain("id: character.alex");
  expect(toolMessages?.[2]?.content).not.toContain("id：character.alex");
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
            content:
              "Create the state document and directory association, then run the candidate check.",
            toolCalls: [
              {
                id: "create-wrong-path",
                name: "setting_write_file",
                arguments: {
                  path: "world/state.sam.yaml",
                  contents: yamlSource({
                    ref: "sam-status",
                    title: "Sam的当前状态",
                    summary: "Sam的体力与法力。",
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
            /states.*direct children.*world\/states\/<file>\.yaml/u,
          );
          return {
            role: "assistant",
            content:
              "Moved to the catalog actual directory as diagnosed, then checked again.",
            toolCalls: [
              {
                id: "read-wrong-path",
                name: "setting_read",
                arguments: { path: "world/state.sam.yaml" },
              },
              {
                id: "move-to-correct-path",
                name: "setting_move",
                arguments: {
                  from: "world/state.sam.yaml",
                  to: "world/states/sam.yaml",
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
        expect(successfulPreview?.content).toContain(
          "# Candidate check passed",
        );
        return {
          role: "assistant",
          content: "The final candidate passed its check.",
          toolCalls: [
            { id: "finish", name: "setting_finish_candidate", arguments: {} },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(
    planFirst("Move Sam dynamic stamina and magic into the state directory"),
  );
  const result = await improvement.confirmPlan();

  expect(result.files).toContainEqual(
    expect.objectContaining({ path: "world/states/sam.yaml" }),
  );
  expect(result.files).not.toContainEqual(
    expect.objectContaining({ path: "world/state.sam.yaml" }),
  );
  expect(result.review.diff.map(({ path, kind }) => ({ path, kind }))).toEqual([
    { path: "control/frame.yaml", kind: "modify" },
    { path: "world/states/sam.yaml", kind: "create" },
  ]);
  expect(requests).toHaveLength(4);
  expect(requests[0]?.messages[0]?.content).toContain("world/states/alex.yaml");
  expect(requests[0]?.messages[0]?.content).toContain("state/states/alex.yaml");
  expect(requests[0]?.messages[0]?.content).toContain("world/state.alex.yaml");
  expect(requests[0]?.messages[0]?.content).toContain("from top to bottom");
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
            content:
              "Create the Mia document and check the complete candidate.",
            toolCalls: [
              {
                id: "create-mia",
                name: "setting_write_file",
                arguments: {
                  path: "world/characters/mia.yaml",
                  contents: yamlSource({
                    ref: "alex",
                    title: "Mia",
                    summary: "在雨夜来到宿舍的陌生人。",
                    body: "关系:\n  Alex: 戒备\n",
                  }),
                },
              },
              {
                id: "patch-created-mia",
                name: "setting_patch",
                arguments: {
                  document: "world/characters/mia.yaml",
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
        expect(request.messages.at(-1)?.content).toContain(
          "# Candidate check passed",
        );
        return {
          role: "assistant",
          content: "Candidate complete.",
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

  await improvement.start(planFirst("Add Mia"));
  const result = await improvement.confirmPlan();
  const snapshot = WorldDocumentStore.open({
    layout: "content_package",
    files: result.files,
  });
  const created = snapshot.query({
    kind: "read_document",
    document: { logicalPath: "world/characters/mia.yaml" },
    maxBytes: 65_536,
  });

  expect(created.kind).toBe("read_document");
  if (created.kind !== "read_document")
    throw new Error("The new document cannot be read");
  expect(created.document.documentId).toMatch(/^doc\.[0-9a-f]{32}$/u);
  expect(created.document.shortRef).toBe("alex-2");
  expect(created.body).toContain("Alex: 戒备");
  expect(created.body).toContain("状态: 等待接触");
});

test("有序 revision 批次允许 move 后按新路径 replace 已完整读取的文档", async () => {
  const from = "world/characters/alex.yaml";
  const to = "world/people/alex.yaml";
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
            content:
              "Move and replace the Alex document in order, then check the candidate.",
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
                    "character.alex",
                    "alex",
                    "Alex",
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
          content: "Candidate complete.",
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

  await improvement.start(planFirst("Move and update the Alex document"));
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
  const damagedPath = "world/characters/alex.yaml";
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
            content: "Repair the damaged document with complete source.",
            toolCalls: [
              {
                id: "repair-damaged",
                name: "setting_write_file",
                arguments: {
                  path: damagedPath,
                  contents: character(
                    "character.alex",
                    "alex",
                    "Alex",
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
        expect(request.messages.at(-1)?.content).toContain(
          "# Candidate check passed",
        );
        return {
          role: "assistant",
          content: "Repair complete.",
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
    planFirst("Repair the Alex document", ["world/characters/alex.yaml"]),
  );
  const result = await improvement.confirmPlan();

  expect(result.review.status).toBe("usable");
  expect(result.review.diff).toEqual([
    expect.objectContaining({ path: damagedPath, kind: "modify" }),
  ]);
  expect(
    result.files.find(({ path }) => path === damagedPath)?.contents,
  ).toContain("id: character.alex");
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
            content: "Read first and obtain a directory cursor.",
            toolCalls: [
              {
                id: "read-before-patch",
                name: "setting_read",
                arguments: { path: "world/characters/alex.yaml" },
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
            /Next-page cursor: (\S+)/u.exec(listing ?? "")?.[1] ?? "";
          expect(previousCursor).not.toBe("");
          return {
            role: "assistant",
            content: "Update Alex.",
            toolCalls: [
              {
                id: "patch-alex",
                name: "setting_patch",
                arguments: {
                  document: "@alex",
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
            content: "Verify that the old cursor is invalid.",
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
            content: "Run the check again.",
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
          content: "Done.",
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

  await improvement.start(planFirst("Adjust Alex clothing"));
  const result = await improvement.confirmPlan();

  expect(
    result.files.find(({ path }) => path.endsWith("alex.yaml"))?.contents,
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
            content: "Read before changing.",
            toolCalls: [
              {
                id: "read-once",
                name: "setting_read",
                arguments: { path: "world/characters/alex.yaml" },
              },
              {
                id: "patch-once",
                name: "setting_patch",
                arguments: {
                  document: "@alex",
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
            content: "Continue changing without another read.",
            toolCalls: [
              {
                id: "patch-twice",
                name: "setting_patch",
                arguments: {
                  document: "@alex",
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
          ).toContain("revision accepted");
          return {
            role: "assistant",
            content: "Check the candidate.",
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
          content: "Done.",
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

  await improvement.start(planFirst("Adjust Alex clothing repeatedly"));
  const result = await improvement.confirmPlan();
  expect(
    result.files.find(({ path }) => path.endsWith("alex.yaml"))?.contents,
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
            content: "Read the opening and character first.",
            toolCalls: [
              {
                id: "read-opening",
                name: "setting_read",
                arguments: { path: "opening.md" },
              },
              {
                id: "read-alex",
                name: "setting_read",
                arguments: { path: "world/characters/alex.yaml" },
              },
            ],
          };
        if (round === 3)
          return {
            role: "assistant",
            content: "Update the character, then synchronize the opening.",
            toolCalls: [
              {
                id: "patch-alex",
                name: "setting_patch",
                arguments: {
                  document: "@alex",
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
          ).toContain("Updated opening.md in the isolated candidate");
          return {
            role: "assistant",
            content: "Run the check.",
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
          content: "Done.",
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

  await improvement.start(
    planFirst("Adjust Alex clothing and synchronize the opening"),
  );
  const result = await improvement.confirmPlan();

  expect(result.files.find(({ path }) => path === "opening.md")?.contents).toBe(
    updatedOpening(),
  );
  expect(
    result.files.find(({ path }) => path.endsWith("alex.yaml"))?.contents,
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
            content: "Read the rules first.",
            toolCalls: [
              {
                id: "read-rule",
                name: "setting_read",
                arguments: { path: rulePath },
              },
            ],
          };
        if (round === 3) {
          // The author edits the writable body from the previous read without
          // reconstructing the $document front matter.
          const body = request.messages
            .find(({ toolCallId }) => toolCallId === "read-rule")
            ?.content.split(
              "[Writable body starts; locators are relative to this point]\n",
            )[1]
            ?.split("\n[Writable body")[0];
          expect(body).toBe("# 修炼规则\n\n境界由故事解释。");
          return {
            role: "assistant",
            content: "Write the corrected source back.",
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
          ).toContain("revision accepted");
          return {
            role: "assistant",
            content: "Run the check.",
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
          content: "Done.",
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

  await improvement.start(
    planFirst("Adjust how the progression rules are explained"),
  );
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
          content: "Finish immediately after the check.",
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

  await improvement.start(
    planFirst("Confirm the current setting without changes"),
  );

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
            content: "Check the fixed candidate.",
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
          content: "Done.",
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

  await improvement.start(planFirst("Inspect only the current candidate"));
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
            content: "Finish directly.",
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
            /rejected.*setting_preview_candidate/u,
          );
          return {
            role: "assistant",
            content: "Run the real preview first.",
            toolCalls: [
              {
                id: "preview-before-finish",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        expect(request.messages.at(-1)?.content).toContain(
          "# Candidate check passed",
        );
        return {
          role: "assistant",
          content: "Finish now.",
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

  await improvement.start(planFirst("Validate the candidate"));
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
          expect(request.messages.at(-1)?.content).toContain(
            "planning phase allows only",
          );
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
                path: "world/characters/alex.yaml",
                contents: "不应写入",
              },
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });
  await expect(
    planning.start(planFirst("Create only a plan")),
  ).resolves.toMatchObject({
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
            content: "Update the opening.",
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
            content: "Check the candidate.",
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
          content: "Candidate complete.",
          toolCalls: [
            { id: "finish", name: "setting_finish_candidate", arguments: {} },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  const result = await direct.start({
    goal: "Skip planning, inspect, and generate a candidate directly",
    contextPaths: ["opening.md"],
    mode: "direct_candidate",
  });

  expect(result.kind).toBe("candidate");
  if (result.kind !== "candidate")
    throw new Error("Direct candidate was not generated");
  expect(requests).toHaveLength(3);
  expect(requests[0]?.tools).toContain("setting_write_file");
  expect(JSON.stringify(requests[0])).toContain(opening().trim());
  expect(JSON.stringify(requests[0])).toContain(
    "skipped the visible creation plan",
  );
  expect(result.review.diff).toContainEqual(
    expect.objectContaining({ path: "opening.md", kind: "modify" }),
  );
  await expect(direct.confirmPlan()).rejects.toThrow(
    /There is no creation plan to confirm/u,
  );
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
    improvement.start(planFirst("Read a missing file", ["world/missing.yaml"])),
  ).rejects.toThrow(/Injected file does not exist/u);
  await expect(
    improvement.start(
      planFirst("Reject duplicate selection", ["opening.md", "opening.md"]),
    ),
  ).rejects.toThrow(/Duplicate injected file path/u);
  await expect(
    improvement.start(planFirst("Reject an unsafe path", ["../opening.md"])),
  ).rejects.toThrow(/Unsafe candidate path/u);
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
      throw new Error("Preview should not be generated");
    },
  });
  await expect(
    binary.start(planFirst("Reject binary context", ["assets/map.png"])),
  ).rejects.toThrow(/binary file cannot be injected into a model prompt/u);
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
  await improvement.start(planFirst("Adjust the opening situation"));
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
  await missing.start(planFirst("Complete the opening"));
  const created = await missing.confirmPlan();
  expect(created.files).toContainEqual({
    path: "opening.md",
    contents: updatedOpening(),
  });

  const unfinished = improvementWithCalls(
    baseFiles().filter(({ path }) => path !== "opening.md"),
    [[{ id: "finish", name: "setting_finish_candidate", arguments: {} }]],
  );
  await unfinished.start(planFirst("Do not omit the opening"));
  await expect(unfinished.confirmPlan()).rejects.toThrow(
    /candidate phase exceeded its repair limit/u,
  );
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
          expect(request.messages.at(-1)?.content).toContain(
            "Unsafe candidate path",
          );
          return {
            role: "assistant",
            content: "Run the candidate preview.",
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
            "The real Prompt Preview failed to compile",
          );
          throw new Error("provider unavailable");
        }
        return {
          role: "assistant",
          content: "Invalid candidate",
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
  await improvement.start(planFirst("Change the setting"));
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
            content: "Run the preview.",
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
            "The real Prompt Preview failed to compile",
          );
          return {
            role: "assistant",
            content: "Run the preview again.",
            toolCalls: [
              {
                id: "preview-recovers",
                name: "setting_preview_candidate",
                arguments: {},
              },
            ],
          };
        }
        expect(request.messages.at(-1)?.content).toContain(
          "# Candidate check passed",
        );
        return {
          role: "assistant",
          content: "Done.",
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

  await improvement.start(planFirst("Verify preview recovery"));
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
            content: "Check the candidate.",
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
            content: "Done.",
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
          content: "Done",
          toolCalls: [
            {
              id: "read-alex",
              name: "setting_read",
              arguments: { path: "world/characters/alex.yaml" },
            },
            {
              id: "patch-ref",
              name: "setting_patch",
              arguments: {
                document: "@alex",
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
                contents:
                  "# World Narration Rules\n\nWrite durable outcomes back to their natural owner.\n",
              },
            },
          ],
        };
      },
    },
    preview: (snapshot) => previewSnapshot(snapshot),
  });

  await improvement.start(planFirst("修复候选并Adjust Alex clothing"));
  const result = await improvement.confirmPlan();

  expect(
    result.files.find(({ path }) => path.endsWith("alex.yaml"))?.contents,
  ).toContain("衣着: 黑色运动背心");
  expect(result.files).toContainEqual(
    expect.objectContaining({ path: "control/blocks/world.md" }),
  );
});

// onDelta is a callback and is not part of the snapshot-safe request content.
function snapshotAuthorRequest(
  request: Parameters<SettingAuthorAdapter["next"]>[0],
) {
  const snapshot = { ...request };
  delete snapshot.onDelta;
  return structuredClone(snapshot);
}

function plan(): string {
  return `# Creation plan\n\n## Primary experience\nDevelop character relationships\n## Secondary experience\nExplore progression\n## Repeatable play loop\nInteraction, feedback, and persistent change\n## Focus\nCharacter choices\n## Pace\nA gradual build\n## Conflict\nDifferences in trust\n## Information structure\nReveal through behavior\n## Voice boundaries\nRestrained; never decide the player's actions\n## Explicit exclusions\nDo not introduce a numeric schema`;
}

function baseFiles() {
  return [
    {
      path: "opening.md",
      contents: opening(),
    },
    {
      path: "world/characters/alex.yaml",
      contents: character("character.alex", "alex", "Alex", "关系: {}"),
    },
    {
      path: "world/current-situation.yaml",
      contents: character(
        "situation.current",
        "current",
        "当前情境",
        "人物:\n  - $ref: character.alex",
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
      contents:
        "# World Narration Rules\n\nWrite durable outcomes back to their natural owner.\n",
    },
    {
      path: "control/player-views.yaml",
      contents: `format: narraeon.player-views/v1\nviews:\n  - id: relations\n    title: 人物关系\n    items:\n      - id: alex-relations\n        label: Alex的关系\n        select: { document: character.alex, locator: { yaml: [关系] } }\n`,
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
    playerInput: "Preview",
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
          return { role: "assistant", content: "Done", toolCalls: batch };
        const lastToolResult = request.messages.at(-1)?.content ?? "";
        if (lastToolResult.includes("# Candidate check failed"))
          return {
            role: "assistant",
            content: "Unable to finish",
            toolCalls: [],
          };
        if (lastToolResult.includes("# Candidate check passed"))
          return {
            role: "assistant",
            content: "Done",
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
          content: "Check the candidate",
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
  return "宿舍门在你面前合上。Alex抱着球衣，等你先开口。\n";
}

function updatedOpening(): string {
  return "雨声压住走廊里的脚步。Mia站在宿舍门边，Alex放下球衣，两人都在等你的反应。\n";
}

function openingText(
  files: readonly { path: string; contents: string }[],
): string {
  return files.find(({ path }) => path === "opening.md")?.contents ?? "";
}
