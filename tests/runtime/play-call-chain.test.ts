import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  parseV1Envelope,
  type V1PlayCallChainView,
} from "../../src/protocol/v1.ts";
import type { ContentTreeFile } from "../../src/runtime/content/ContentWorkspace.ts";
import {
  ModelHostOutcomeUnknownError,
  ScriptedModelHost,
  type ModelHost,
  type ModelHostBinding,
  type ModelHostExchange,
} from "../../src/runtime/model/ModelHost.ts";
import { FileNativeAiFailureLog } from "../../src/runtime/model/AiFailureLog.ts";
import {
  defaultPlayPresetFiles,
  parsePlayPresetFiles,
  type PlayPresetBinding,
} from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import { PlayCallChain } from "../../src/runtime/play/PlayCallChain.ts";
import { FileNativeArtifactStore } from "../../src/runtime/artifact/FileNativeArtifactStore.ts";
import {
  FileNativePromptCompiler,
  type FileNativePromptInput,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";
import { V1Runtime } from "../../src/runtime/V1Runtime.ts";
import { FileNativeWorldStore } from "../../src/runtime/world/FileNativeWorldStore.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("协议允许空的追加输入，用现有请求上下文触发续写", () => {
  expect(() =>
    parseV1Envelope({
      protocol: "narraeon.runtime/v1",
      request: {
        type: "play.chain.append",
        worldId: "world-1",
        chainId: "chain-1",
        exchangeId: "exchange-1",
        playerText: "",
      },
    }),
  ).not.toThrow();
});

test("模型自行交替文本与工具，每个完成响应立即推进世界并可追加上下文", async () => {
  const { worlds, worldId } = await createWorld("play-chain");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-door",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "秦龙已经把宿舍门打开。",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "秦龙推开门，侧身示意你先走。" },
      { outcome: "response", text: "走廊里的感应灯随脚步依次亮起。" },
    ],
  });
  const chains = new PlayCallChain(worlds);

  const first = await chains.start({
    worldId,
    chainId: "play-chain-contract",
    exchangeId: "exchange-first",
    playerText: "我示意秦龙开门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(first).toMatchObject({
    status: "ready",
    baselineHead: "genesis",
    parentHead: "commit:3",
    changedDocuments: [
      {
        kind: "replace",
        ref: "@current-situation",
        path: "current-situation.yaml",
      },
    ],
  });
  expect(first.events.map(({ kind }) => kind)).toEqual([
    "player",
    "assistant",
    "tool_call",
    "tool_result",
    "assistant",
  ]);
  const patchResult = first.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "tool_result" }
    > => event.kind === "tool_result" && event.callId === "patch-door",
  );
  expect(patchResult?.markdown).toBe(
    "# world_patch 成功\n\n文档已发生变化。\n\n# Runtime 写入\n\n本次响应中的世界变化已写入端点 commit:2。",
  );
  expect(patchResult?.markdown).not.toContain("秦龙守在宿舍门边。");
  expect(patchResult?.markdown).not.toContain("秦龙已经把宿舍门打开。");
  expect(modelHost.requests[1]?.appended.at(-1)).toEqual({
    kind: "tool",
    toolCallId: "patch-door",
    markdown: patchResult?.markdown,
  });
  expect(modelHost.requests[0]?.tools.map(({ name }) => name)).toEqual([
    "context_list",
    "context_search",
    "context_read",
    "world_patch",
    "world_create",
  ]);
  expect(modelHost.requests[0]?.maxOutputTokens).toBe(
    modelBinding().maxOutputTokens,
  );
  expect(modelHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "我示意秦龙开门。" },
  ]);
  expect(
    modelHost.requests[0]?.bootstrap.logicalMessages.some(
      ({ role }) => role === "player_input",
    ),
  ).toBe(false);
  expect(JSON.stringify(modelHost.requests[0]?.bootstrap)).not.toContain(
    "门外传来三声短促的铃响。",
  );
  expect(JSON.stringify(modelHost.requests[0]?.bootstrap)).toContain(
    "当前世界没有更早的玩家原文或主持叙事",
  );
  const authorPrompt = modelHost.requests[0]?.bootstrap.logicalMessages
    .filter(({ role }) => role === "author_instruction")
    .map(({ markdown }) => markdown)
    .join("\n");
  // 玩法叙事块作为普通作者指令进入 bootstrap。
  expect(authorPrompt).toContain("最后一句写某个人做的一件具体的事");

  const continued = await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-second",
    playerText: "我走进走廊。",
    modelHost,
  });

  expect(continued).toMatchObject({ status: "ready", parentHead: "commit:5" });
  expect(modelHost.requests.at(-1)?.appended.at(-1)).toEqual({
    kind: "player",
    text: "我走进走廊。",
  });
  const requestCount = modelHost.requests.length;
  const duplicateAppend = await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-second",
    playerText: "我走进走廊。",
    modelHost,
  });
  expect(duplicateAppend.parentHead).toBe("commit:5");
  expect(modelHost.requests).toHaveLength(requestCount);
  expect(await worlds.currentHead(worldId)).toBe("commit:5");
  const endpoint = await worlds.recoverEndpoint(worldId);
  expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
    "门外传来三声短促的铃响。\n",
    "我示意秦龙开门。",
    "秦龙推开门，侧身示意你先走。",
    "我走进走廊。",
    "走廊里的感应灯随脚步依次亮起。",
  ]);
  expect(
    endpoint.state.find(({ path }) => path === "current-situation.yaml")
      ?.contents,
  ).toContain("秦龙已经把宿舍门打开。");
});

test("world_patch no-op 保留匹配的紧凑工具结果且不推进世界", async () => {
  const { worlds, worldId } = await createWorld("play-chain-patch-no-op");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-same-situation",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "秦龙守在宿舍门边。",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "秦龙仍站在门边。" },
    ],
  });

  const view = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-patch-no-op-contract",
    exchangeId: "play-chain-patch-no-op-exchange",
    playerText: "我看向秦龙。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.parentHead).toBe("commit:2");
  expect(
    view.events.find(
      (event) => event.kind === "assistant" && event.exchange === 1,
    ),
  ).not.toHaveProperty("committedHead");
  const patchResult = view.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "tool_result" }
    > =>
      event.kind === "tool_result" && event.callId === "patch-same-situation",
  );
  expect(patchResult?.markdown).toBe("# world_patch 成功\n\n文档未发生变化。");
  expect(modelHost.requests[1]?.appended.at(-1)).toEqual({
    kind: "tool",
    toolCallId: "patch-same-situation",
    markdown: patchResult?.markdown,
  });
});

test("冷启动恢复 world_create 授予的写权限，后续无需重新读取即可 patch", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-create-authorization-cold-recovery",
  );
  const interruptedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "create-cold-character",
            name: "world_create",
            arguments: {
              parent: "@dir-/",
              codec: "yaml",
              refHint: "cold-character",
              title: "冷启动角色",
              summary: "用于验证创建后写授权。",
              aliases: [],
              body: "状态: 初始\n",
            },
          },
        ],
      },
      { outcome: "unknown", message: "创建后的下一次模型请求中断。" },
    ],
  });

  const interrupted = await new PlayCallChain(worlds).start({
    worldId,
    chainId: "play-chain-create-authorization-cold-recovery",
    exchangeId: "play-chain-create-authorization-cold-recovery-player",
    playerText: "记下一个新角色。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: interruptedHost,
  });
  expect(interrupted).toMatchObject({
    status: "interrupted",
    parentHead: "commit:2",
  });

  const recoveredHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-cold-character",
            name: "world_patch",
            arguments: {
              target: "@cold-character",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["状态"] },
                  value: "冷启动后已更新",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "新角色的记录已经更新。" },
    ],
  });
  const recovered = await new PlayCallChain(worlds).append({
    worldId,
    chainId: interrupted.chainId,
    exchangeId: "play-chain-create-authorization-cold-recovery-resume",
    playerText: "",
    modelHost: recoveredHost,
  });

  expect(recovered.status).toBe("ready");
  expect(recovered.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "patch-cold-character",
      ok: true,
    }),
  );
  expect(
    (await worlds.recoverEndpoint(worldId)).state.find(
      ({ path }) => path === "cold-character.yaml",
    )?.contents,
  ).toContain("状态: 冷启动后已更新");
});

test("派生世界恢复所选分叉点的文档写授权，不携带分叉点之后的状态", async () => {
  const { worlds, worldId } = await createWorld(
    "play-chain-create-authorization-derived",
  );
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "create-derived-character",
            name: "world_create",
            arguments: {
              parent: "@dir-/",
              codec: "yaml",
              refHint: "derived-character",
              title: "派生角色",
              summary: "用于验证分叉点写授权。",
              aliases: [],
              body: "状态: 初始\n",
            },
          },
        ],
      },
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-source-derived-character",
            name: "world_patch",
            arguments: {
              target: "@derived-character",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["状态"] },
                  value: "来源世界后续状态",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "来源世界继续向前。" },
    ],
  });
  const sourceChains = new PlayCallChain(worlds);
  const source = await sourceChains.start({
    worldId,
    chainId: "play-chain-create-authorization-derived-source",
    exchangeId: "play-chain-create-authorization-derived-player",
    playerText: "建立一份可以分叉的记录。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const createHead = source.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "assistant" }
    > => event.kind === "assistant" && event.exchange === 1,
  )?.committedHead;
  expect(createHead).toBe("commit:2");
  expect(
    (await worlds.recoverEndpoint(worldId)).state.find(
      ({ path }) => path === "derived-character.yaml",
    )?.contents,
  ).toContain("状态: 来源世界后续状态");

  const derived = await worlds.deriveWorld({
    operationId: "derive-create-authorization-at-create-head",
    sourceWorldId: worldId,
    sourceHead: createHead!,
    hostPresetId: "play-chain-host",
  });
  const derivedTrace = await sourceChains.forkToDerivedWorld({
    sourceWorldId: worldId,
    sourceHead: createHead!,
    targetWorldId: derived.world.worldId,
  });
  expect(derivedTrace).not.toBeNull();

  const derivedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        toolCalls: [
          {
            id: "patch-derived-branch-character",
            name: "world_patch",
            arguments: {
              target: "@derived-character",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["状态"] },
                  value: "派生世界独立状态",
                },
              ],
            },
          },
        ],
      },
      { outcome: "response", text: "派生世界从分叉点继续。" },
    ],
  });
  const continued = await new PlayCallChain(worlds).append({
    worldId: derived.world.worldId,
    chainId: derivedTrace!.chainId,
    exchangeId: "patch-derived-branch-with-restored-authorization",
    playerText: "",
    modelHost: derivedHost,
  });

  expect(continued.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "patch-derived-branch-character",
      ok: true,
    }),
  );
  expect(
    (await worlds.recoverEndpoint(derived.world.worldId)).state.find(
      ({ path }) => path === "derived-character.yaml",
    )?.contents,
  ).toContain("状态: 派生世界独立状态");
  expect(
    (await worlds.recoverEndpoint(derived.world.worldId)).state.find(
      ({ path }) => path === "derived-character.yaml",
    )?.contents,
  ).not.toContain("来源世界后续状态");
});

test("全新上下文只重建模型上下文，持久保留此前调用轨迹并允许从旧节点派生", async () => {
  const { worlds, worldId, root } = await createWorld(
    "play-chain-fresh-display-history",
  );
  const firstHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        reasoningContent: "旧上下文思维链。",
        toolCalls: [
          {
            id: "old-context-list",
            name: "context_list",
            arguments: {},
          },
        ],
      },
      { outcome: "response", text: "旧上下文的可见叙事。" },
    ],
  });
  const chains = new PlayCallChain(worlds);
  const first = await chains.start({
    worldId,
    chainId: "play-chain-old-context",
    exchangeId: "exchange-old-context",
    playerText: "旧上下文玩家输入。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: firstHost,
  });
  const sourceHead = first.parentHead;
  const singleContextRecord =
    await worlds.readPlayCallChain<Record<string, unknown>>(worldId);
  expect(singleContextRecord).not.toBeNull();
  delete singleContextRecord!.previousContexts;
  await worlds.writePlayCallChain(worldId, singleContextRecord);

  const secondHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "新上下文的可见叙事。" }],
  });
  const second = await chains.start({
    worldId,
    chainId: "play-chain-new-context",
    exchangeId: "exchange-new-context",
    playerText: "新上下文玩家输入。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: secondHost,
  });
  const withHistory = second;

  expect(secondHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "新上下文玩家输入。" },
  ]);
  expect(withHistory.previousContexts).toHaveLength(1);
  expect(withHistory.previousContexts?.[0]?.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      reasoning: "旧上下文思维链。",
    }),
  );
  expect(withHistory.previousContexts?.[0]?.events).toContainEqual(
    expect.objectContaining({ kind: "tool_call", name: "context_list" }),
  );
  expect(withHistory.previousContexts?.[0]?.events).toContainEqual(
    expect.objectContaining({ kind: "tool_result", name: "context_list" }),
  );

  const cold = await new PlayCallChain(worlds).inspectWorld(worldId);
  expect(cold?.previousContexts).toEqual(withHistory.previousContexts);

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const branch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-from-previous-fresh-context",
      sourceWorldId: worldId,
      sourceHead,
    })
  ).result as { world: { worldId: string } };
  const branchTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: branch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  expect(branchTrace?.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      reasoning: "旧上下文思维链。",
    }),
  );
  expect(branchTrace?.events).toContainEqual(
    expect.objectContaining({ kind: "tool_call", name: "context_list" }),
  );
});

test("从调用链节点派生会保留截至该节点的调用轨迹，并可在玩家节点空输入重新生成", async () => {
  const { worlds, worldId, root } = await createWorld("play-chain-derive");
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        reasoningContent: "先确认宿舍门的当前状态。",
        toolCalls: [
          {
            id: "patch-derived-door",
            name: "world_patch",
            arguments: {
              target: "@current-situation",
              edits: [
                {
                  op: "replace",
                  locator: { yaml: ["情况"] },
                  value: "秦龙已经把宿舍门打开。",
                },
              ],
            },
          },
        ],
      },
      {
        outcome: "response",
        text: "秦龙推开门，侧身示意你先走。",
        reasoningContent: "状态已经更新，现在给出可见叙事。",
      },
    ],
  });
  const sourceChains = new PlayCallChain(worlds);
  const source = await sourceChains.start({
    worldId,
    chainId: "play-chain-derive-source",
    exchangeId: "exchange-source-player",
    playerText: "我示意秦龙开门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const playerHead = source.events.find(
    (event) => event.kind === "player",
  )?.committedHead;
  expect(playerHead).toBe("commit:1");

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const completedBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-completed-call-chain",
      sourceWorldId: worldId,
      sourceHead: source.parentHead,
    })
  ).result as { world: { worldId: string } };
  const completedTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: completedBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;

  expect(completedTrace).toMatchObject({
    worldId: completedBranch.world.worldId,
    parentHead: "genesis",
    status: "ready",
  });
  expect(completedTrace?.chainId).not.toBe(source.chainId);
  expect(completedTrace?.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      reasoning: "先确认宿舍门的当前状态。",
    }),
  );
  expect(completedTrace?.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_call",
      name: "world_patch",
    }),
  );
  expect(completedTrace?.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      name: "world_patch",
    }),
  );

  const toolResponseHead = source.events.find(
    (
      event,
    ): event is Extract<
      V1PlayCallChainView["events"][number],
      { kind: "assistant" }
    > =>
      event.kind === "assistant" &&
      event.reasoning === "先确认宿舍门的当前状态。",
  )?.committedHead;
  expect(toolResponseHead).toBe("commit:2");
  const toolBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-tool-call-chain",
      sourceWorldId: worldId,
      sourceHead: toolResponseHead!,
    })
  ).result as { world: { worldId: string } };
  const toolTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: toolBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  expect(toolTrace?.events.map(({ kind }) => kind)).toEqual([
    "player",
    "assistant",
    "tool_call",
    "tool_result",
  ]);
  const continuedToolHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "秦龙把门彻底推开。" }],
  });
  await new PlayCallChain(worlds).append({
    worldId: toolBranch.world.worldId,
    chainId: toolTrace!.chainId,
    exchangeId: "continue-derived-tool-response",
    playerText: "",
    modelHost: continuedToolHost,
  });
  expect(
    continuedToolHost.requests[0]?.appended.map(({ kind }) => kind),
  ).toEqual(["player", "assistant", "tool"]);

  const playerBranch = (
    await runtime.handle({
      type: "world.derive",
      operationId: "derive-player-call-chain",
      sourceWorldId: worldId,
      sourceHead: playerHead!,
    })
  ).result as { world: { worldId: string } };
  const playerTrace = (
    await runtime.handle({
      type: "play.chain.inspect",
      worldId: playerBranch.world.worldId,
    })
  ).result as V1PlayCallChainView | null;
  expect(playerTrace).toMatchObject({
    worldId: playerBranch.world.worldId,
    parentHead: "genesis",
    status: "ready",
    events: [
      expect.objectContaining({
        kind: "player",
        text: "我示意秦龙开门。",
        committedHead: "genesis",
      }),
    ],
  });
  expect(playerTrace?.events).toHaveLength(1);

  const regeneratedHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "秦龙重新考虑后，直接拉开了门。" }],
  });
  const regenerated = await new PlayCallChain(worlds).append({
    worldId: playerBranch.world.worldId,
    chainId: playerTrace!.chainId,
    exchangeId: "regenerate-from-player",
    playerText: "",
    modelHost: regeneratedHost,
  });
  expect(regenerated.status).toBe("ready");
  expect(regeneratedHost.requests[0]?.appended).toEqual([
    { kind: "player", text: "我示意秦龙开门。" },
  ]);
  expect(
    (await worlds.recoverEndpoint(playerBranch.world.worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我示意秦龙开门。",
    "秦龙重新考虑后，直接拉开了门。",
  ]);
  await runtime.handle({
    type: "world.derive",
    operationId: "derive-player-call-chain",
    sourceWorldId: worldId,
    sourceHead: playerHead!,
  });
  expect(await worlds.currentHead(playerBranch.world.worldId)).toBe("commit:1");
});

test("修改历史玩家提交会从其父端点派生，并只把修改稿提交到新世界", async () => {
  const { worlds, worldId, root } = await createWorld("play-chain-edit-player");
  const sourceHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "秦龙说八点在宿舍楼下集合。" },
      { outcome: "response", text: "秦龙点头，说会提前五分钟下楼。" },
    ],
  });
  const sourceChains = new PlayCallChain(worlds);
  await sourceChains.start({
    worldId,
    chainId: "play-chain-edit-source",
    exchangeId: "exchange-edit-first",
    playerText: "我问秦龙几点集合。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost: sourceHost,
  });
  const source = await sourceChains.append({
    worldId,
    chainId: "play-chain-edit-source",
    exchangeId: "exchange-edit-second",
    playerText: "那我提前五分钟下楼。",
    modelHost: sourceHost,
  });
  const editedEvent = source.events.find(
    (event) =>
      event.kind === "player" && event.exchangeId === "exchange-edit-second",
  );
  expect(editedEvent).toMatchObject({ committedHead: "commit:3" });

  const runtime = new V1Runtime({
    dataRoot: root,
    configRoot: join(root, "config"),
  });
  await runtime.initialize();
  const branched = (
    await runtime.handle({
      type: "play.chain.branch",
      operationId: "branch-before-edited-player",
      sourceWorldId: worldId,
      sourceChainId: source.chainId,
      sourceEventId: editedEvent!.id,
    })
  ).result as {
    world: { worldId: string };
    playCallChain: V1PlayCallChainView;
  };

  expect(branched.playCallChain).toMatchObject({
    worldId: branched.world.worldId,
    parentHead: "genesis",
    status: "ready",
  });
  expect(
    branched.playCallChain.events
      .filter((event) => event.kind === "player")
      .map(({ text }) => text),
  ).toEqual(["我问秦龙几点集合。"]);
  expect(
    (await worlds.recoverEndpoint(branched.world.worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我问秦龙几点集合。",
    "秦龙说八点在宿舍楼下集合。",
  ]);

  const replacementHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [{ outcome: "response", text: "秦龙答应七点四十五就在楼下等你。" }],
  });
  await new PlayCallChain(worlds).append({
    worldId: branched.world.worldId,
    chainId: branched.playCallChain.chainId,
    exchangeId: "exchange-edited-replacement",
    playerText: "那我们提前十五分钟集合。",
    modelHost: replacementHost,
  });

  expect(
    (await worlds.recoverEndpoint(branched.world.worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我问秦龙几点集合。",
    "秦龙说八点在宿舍楼下集合。",
    "那我们提前十五分钟集合。",
    "秦龙答应七点四十五就在楼下等你。",
  ]);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我问秦龙几点集合。",
    "秦龙说八点在宿舍楼下集合。",
    "那我提前五分钟下楼。",
    "秦龙点头，说会提前五分钟下楼。",
  ]);

  const firstPlayerEvent = source.events.find(
    (event) =>
      event.kind === "player" && event.exchangeId === "exchange-edit-first",
  );
  const firstBranch = (
    await runtime.handle({
      type: "play.chain.branch",
      operationId: "branch-before-first-player",
      sourceWorldId: worldId,
      sourceChainId: source.chainId,
      sourceEventId: firstPlayerEvent!.id,
    })
  ).result as {
    world: { worldId: string };
    playCallChain: V1PlayCallChainView;
  };
  expect(firstBranch.playCallChain.events).toEqual([]);
  expect(
    (await worlds.recoverEndpoint(firstBranch.world.worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual(["门外传来三声短促的铃响。\n"]);
});

test("中断后留空追加会原样发送已保存的模型请求，不追加玩家指令或中断片段", async () => {
  const { worlds, worldId } = await createWorld("play-chain-retry");
  const requests: ModelHostExchange[] = [];
  let attempt = 0;
  const modelHost: ModelHost = {
    binding: modelBinding,
    exchange(request, observer) {
      requests.push(structuredClone(request));
      attempt += 1;
      if (attempt === 1) {
        observer?.onDelta?.({ kind: "reasoning", text: "先确认门是否能打开" });
        observer?.onDelta?.({ kind: "text", text: "秦龙刚把门推开一半" });
        return Promise.reject(
          new ModelHostOutcomeUnknownError("Provider 流在半途断开。"),
        );
      }
      return Promise.resolve({
        text: "秦龙把门完全推开，走廊的冷风灌了进来。",
      });
    },
  };
  const chains = new PlayCallChain(worlds);

  const interrupted = await chains.start({
    worldId,
    chainId: "play-chain-retry-contract",
    exchangeId: "exchange-retry",
    playerText: "我让秦龙打开门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(interrupted).toMatchObject({
    status: "interrupted",
    parentHead: "commit:1",
    lastFailure: "Provider 流在半途断开。",
  });
  expect(interrupted.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      text: "秦龙刚把门推开一半",
      reasoning: "先确认门是否能打开",
      status: "interrupted",
    }),
  );

  const recoveredChains = new PlayCallChain(worlds);
  const recovered = await recoveredChains.inspectWorld(worldId);
  expect(recovered).toMatchObject({
    status: "interrupted",
    canRetry: true,
  });
  expect(recovered?.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      reasoning: "先确认门是否能打开",
      status: "interrupted",
    }),
  );
  const completed = await recoveredChains.append({
    worldId,
    chainId: interrupted.chainId,
    exchangeId: "continue-without-player-input",
    playerText: "",
    modelHost,
  });

  expect(completed).toMatchObject({
    status: "ready",
    parentHead: "commit:2",
    lastFailure: null,
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(completed.events.filter(({ kind }) => kind === "player")).toHaveLength(
    1,
  );
  const endpoint = await worlds.recoverEndpoint(worldId);
  expect(endpoint.history.map(({ exactText }) => exactText)).toEqual([
    "门外传来三声短促的铃响。\n",
    "我让秦龙打开门。",
    "秦龙把门完全推开，走廊的冷风灌了进来。",
  ]);
  expect(endpoint.history.map(({ exactText }) => exactText)).not.toContain(
    "秦龙刚把门推开一半",
  );
});

test("空输入追加会从完整逻辑 transcript 继续生成，并把 Provider 文本增量实时投影", async () => {
  const { worlds, worldId } = await createWorld("play-chain-empty-continue");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        text: "秦龙先推开了门。",
        reasoningContent: "先确认门口没有障碍。",
        deltas: [
          { kind: "reasoning", text: "先确认门口" },
          { kind: "reasoning", text: "没有障碍。" },
          { kind: "text", text: "秦龙先" },
          { kind: "text", text: "推开了门。" },
        ],
      },
      { outcome: "response", text: "他随后走进走廊。" },
    ],
  });
  const deltas: string[] = [];
  const reasoningDeltas: string[] = [];
  const chains = new PlayCallChain(worlds);
  const first = await chains.start({
    worldId,
    chainId: "play-chain-empty-continue-contract",
    exchangeId: "exchange-first",
    playerText: "我示意秦龙开门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
    observer: {
      onAssistantDelta(delta) {
        if (delta.kind === "text") deltas.push(delta.text);
        if (delta.kind === "reasoning") reasoningDeltas.push(delta.text);
      },
    },
  });
  expect(deltas).toEqual(["秦龙先", "推开了门。"]);

  expect(reasoningDeltas).toEqual(["先确认门口", "没有障碍。"]);
  expect(first.events).toContainEqual(
    expect.objectContaining({
      kind: "assistant",
      reasoning: "先确认门口没有障碍。",
    }),
  );

  const continued = await chains.append({
    worldId,
    chainId: first.chainId,
    exchangeId: "exchange-empty",
    playerText: "",
    modelHost,
  });

  expect(continued.status).toBe("ready");
  expect(continued.events.filter(({ kind }) => kind === "player")).toHaveLength(
    1,
  );
  expect(modelHost.requests[1]?.appended).toEqual([
    { kind: "player", text: "我示意秦龙开门。" },
    {
      kind: "assistant",
      text: "秦龙先推开了门。",
      reasoningContent: "先确认门口没有障碍。",
      toolCalls: [],
    },
  ]);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我示意秦龙开门。",
    "秦龙先推开了门。",
    "他随后走进走廊。",
  ]);
});

test("AI 工具被 Runtime 拒绝时保存产生该调用的原始交换与 reasoning", async () => {
  const { worlds, worldId, root } = await createWorld("play-tool-failure-log");
  const logRoot = join(root, "logs", "ai-failures");
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      {
        outcome: "response",
        reasoningContent: "先直接修改一个没有读过的节点。",
        toolCalls: [
          {
            id: "invalid-world-patch",
            name: "world_patch",
            arguments: { target: "@missing", edits: [] },
          },
        ],
        diagnostics: {
          captureId: "play-tool-failure-capture-1",
          provider: "chat_completions",
          endpoint: "https://provider.invalid/v1/chat/completions",
          context: {
            scope: "play_call_chain",
            requestId: "play_call_chain",
            operationId: "play-tool-failure-log-chain",
            requestAttempt: 1,
            exchange: 1,
          },
          request: {
            method: "POST",
            contentType: "application/json",
            body: '{"messages":[{"role":"user","content":"打开门"}]}',
          },
          response: {
            status: 200,
            statusText: "OK",
            contentType: "text/event-stream",
            body: 'data: {"reasoning_content":"先直接修改一个没有读过的节点。"}\n\n',
            bodyComplete: true,
          },
          reasoning: "先直接修改一个没有读过的节点。",
        },
      },
      {
        outcome: "response",
        text: "我先重新查看当前记录。",
        diagnostics: {
          captureId: "play-tool-failure-capture-2",
          provider: "chat_completions",
          endpoint: "https://provider.invalid/v1/chat/completions",
          context: {
            scope: "play_call_chain",
            requestId: "play_call_chain",
            operationId: "play-tool-failure-log-chain",
            requestAttempt: 1,
            exchange: 2,
          },
          request: {
            method: "POST",
            contentType: "application/json",
            body: '{"messages":[{"role":"tool","content":"参数错误"}]}',
          },
          response: {
            status: 200,
            statusText: "OK",
            contentType: "text/event-stream",
            body: 'data: {"content":"我先重新查看当前记录。"}\n\n',
            bodyComplete: true,
          },
        },
      },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    undefined,
    new FileNativeAiFailureLog(logRoot),
  );

  const view = await chains.start({
    worldId,
    chainId: "play-tool-failure-log-chain",
    exchangeId: "play-tool-failure-log-exchange",
    playerText: "打开门。",
    hostBinding: hostBinding(),
    playPreset: playPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.status).toBe("ready");
  expect(view.events).toContainEqual(
    expect.objectContaining({
      kind: "tool_result",
      callId: "invalid-world-patch",
      ok: false,
    }),
  );
  const names = (await readdir(logRoot)).filter((value) =>
    value.endsWith(".jsonl"),
  );
  expect(names).toHaveLength(1);
  const entries = (await readFile(join(logRoot, names[0]!), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const failure = entries.find(({ type }) => type === "failure") as {
    failures: { kind: string; details: unknown }[];
  };
  expect(failure.failures).toHaveLength(1);
  expect(failure.failures[0]?.kind).toBe("tool_execution");
  const details = failure.failures[0]?.details as {
    calls: { id: string; ok: boolean }[];
  };
  expect(details.calls).toEqual([
    expect.objectContaining({ id: "invalid-world-patch", ok: false }),
  ]);
  const exchanges = entries
    .filter(({ type }) => type === "exchange")
    .map(({ exchange }) => exchange) as {
    request: { body: string };
    reasoning?: string;
  }[];
  expect(exchanges).toHaveLength(2);
  expect(exchanges[0]?.request.body).toContain("打开门");
  expect(exchanges[0]?.reasoning).toBe("先直接修改一个没有读过的节点。");
  expect(exchanges[1]?.request.body).toContain("参数错误");
  expect(entries.at(-1)).toMatchObject({
    type: "resolved",
    message: "游玩调用链已在后续模型交换中恢复并完整结束。",
  });
});

async function createWorld(label: string): Promise<{
  worlds: FileNativeWorldStore;
  worldId: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `narraeon-${label}-`));
  roots.push(root);
  const worlds = new FileNativeWorldStore(root);
  const created = await worlds.createFromContentPackage({
    operationId: `create-${label}-world`,
    sourcePackageId: `${label}-package`,
    packageFiles: worldFiles(),
    prompt: { hostBinding: hostBinding(), modelBinding: modelBinding() },
  });
  if (created.outcome !== "created") throw new Error("world was not created");
  return { worlds, worldId: created.world.worldId, root };
}

function playPreset(): PlayPresetBinding {
  const files = structuredClone(defaultPlayPresetFiles);
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "builtin-default",
    name: "default",
    revision: "builtin-default-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function hostBinding(): FileNativePromptInput["hostBinding"] {
  return {
    hostPresetId: "play-chain-host",
    files: {
      "frame.yaml": `format: narraeon.host-frame/v1
roles:
  runtime_system:
    - builtin: runtime.play-contract
    - builtin: runtime.tool-contract
    - builtin: runtime.operation-contract
  author_instruction:
    - markdown: blocks/style.md
    - include: world.instructions
  world_context:
    - builtin: runtime.coverage
    - include: world.context
`,
      "blocks/style.md": "# 风格\n\n克制、具体，不替玩家行动。\n",
    },
  };
}

function modelBinding(): ModelHostBinding {
  return {
    provider: "chat_completions",
    endpointFingerprint: "play-chain-endpoint",
    modelId: "play-chain-model",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8_192,
    protocolConfigFingerprint: "play-chain-protocol",
  };
}

function worldFiles(): ContentTreeFile[] {
  return [
    { path: "opening.md", contents: "门外传来三声短促的铃响。\n" },
    {
      path: "world/current-situation.yaml",
      contents: `$document:
  id: situation.current
  ref: current-situation
  title: 当前情境
  summary: 宿舍门边的局面。
  aliases: []
情况: 秦龙守在宿舍门边。
`,
    },
    {
      path: "control/frame.yaml",
      contents: `format: narraeon.world-frame/v1
bindings:
  currentSituation: situation.current
instructions:
  - markdown: blocks/world.md
context:
  - slot: { kind: current_situation }
  - slot: { kind: history, recent: 2 }
  - slot: { kind: additional_materials }
`,
    },
    {
      path: "control/blocks/world.md",
      contents: "# 世界规则\n\n持续结果写回自然所有者。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
}

test("后置请求在整轮结束后各跑一次，共享同一主链前缀且互不可见", async () => {
  const { worlds, root, worldId } = await createWorld("play-chain-followup");
  const artifacts = new FileNativeArtifactStore(root);
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "秦龙把门推开，风灌了进来。" },
      {
        outcome: "response",
        text: "面板已生成。",
        toolCalls: [
          {
            id: "emit-status",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 9 } },
          },
        ],
      },
      {
        outcome: "response",
        text: "选项已生成。",
        toolCalls: [
          {
            id: "emit-options",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "跟上去" } },
          },
        ],
      },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );

  const view = await chains.start({
    worldId,
    chainId: "play-chain-followup-contract",
    exchangeId: "exchange-first",
    playerText: "我示意秦龙开门。",
    hostBinding: hostBinding(),
    playPreset: followupPlayPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.status).toBe("ready");
  expect(modelHost.requests).toHaveLength(3);

  // 主链只有第一次请求；后两次是后置请求，它们的前缀必须逐字等于主链
  // 结束时的 transcript，彼此都看不到对方的提示或输出。
  const mainPrefix = [
    { kind: "player", text: "我示意秦龙开门。" },
    {
      kind: "assistant",
      text: "秦龙把门推开，风灌了进来。",
      toolCalls: [],
    },
  ];
  const statusRequest = modelHost.requests[1]!;
  const optionsRequest = modelHost.requests[2]!;
  expect(statusRequest.appended.slice(0, 2)).toEqual(mainPrefix);
  expect(optionsRequest.appended.slice(0, 2)).toEqual(mainPrefix);
  expect(statusRequest.appended).toHaveLength(3);
  expect(optionsRequest.appended).toHaveLength(3);
  expect(optionsRequest.appended[2]).not.toEqual(statusRequest.appended[2]);
  expect(JSON.stringify(optionsRequest.appended)).not.toContain("status_bar");
  expect(JSON.stringify(statusRequest.appended)).not.toContain("面板已生成");

  // 后置请求只拿到产物工具，主链的读写工具一件都不给。
  expect(statusRequest.allowedTools).toEqual([
    "artifact_emit",
    "artifact_clear",
  ]);
  expect(optionsRequest.allowedTools).toEqual([
    "artifact_emit",
    "artifact_clear",
  ]);

  // 轨迹里可见，但没有推进世界权威。
  expect(view.events.filter(({ kind }) => kind === "followup")).toMatchObject([
    { followupId: "status", toolCalls: [{ name: "artifact_emit", ok: true }] },
    { followupId: "options", toolCalls: [{ name: "artifact_emit", ok: true }] },
  ]);
  expect(view.parentHead).toBe("commit:2");
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我示意秦龙开门。",
    "秦龙把门推开，风灌了进来。",
  ]);

  // 产物已激活并绑定到当前端点。
  const projection = await artifacts.readActiveProjection(worldId);
  expect(projection.map(({ output }) => output).sort()).toEqual([
    "options",
    "status_bar",
  ]);

  // 下一次玩家输入直接接在叙事之后，主链里没有后置请求的任何痕迹。
  const nextHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "你跟着他走进走廊。" },
      {
        outcome: "response",
        text: "面板已刷新。",
        toolCalls: [
          {
            id: "emit-status-2",
            name: "artifact_emit",
            arguments: { output: "status_bar", payload: { hp: 7 } },
          },
        ],
      },
      {
        outcome: "response",
        text: "选项已刷新。",
        toolCalls: [
          {
            id: "emit-options-2",
            name: "artifact_emit",
            arguments: { output: "options", payload: { first: "回头看" } },
          },
        ],
      },
    ],
  });
  await chains.append({
    worldId,
    chainId: view.chainId,
    exchangeId: "exchange-second",
    playerText: "我跟上去。",
    modelHost: nextHost,
  });
  expect(nextHost.requests[0]!.appended).toEqual([
    ...mainPrefix,
    { kind: "player", text: "我跟上去。" },
  ]);

  // 每个已结算 exchange 使用新 operation，之前的面板会被取代而不是堆叠。
  const refreshed = await artifacts.readActiveProjection(worldId);
  expect(refreshed).toHaveLength(2);
  expect(refreshed.map(({ payload }) => payload)).toEqual(
    expect.arrayContaining([{ hp: 7 }, { first: "回头看" }]),
  );
});

test("后置请求失败不影响已提交的主链，玩家仍可继续", async () => {
  const { worlds, root, worldId } = await createWorld(
    "play-chain-followup-fail",
  );
  const artifacts = new FileNativeArtifactStore(root);
  const modelHost = new ScriptedModelHost({
    binding: modelBinding(),
    steps: [
      { outcome: "response", text: "秦龙把门推开。" },
      // 必需产物没有提交。
      { outcome: "response", text: "我这轮不发面板。" },
      { outcome: "failure", message: "provider 拒绝了这次后置请求。" },
    ],
  });
  const chains = new PlayCallChain(
    worlds,
    new FileNativePromptCompiler(),
    artifacts,
  );

  const view = await chains.start({
    worldId,
    chainId: "play-chain-followup-fail-contract",
    exchangeId: "exchange-first",
    playerText: "我示意秦龙开门。",
    hostBinding: hostBinding(),
    playPreset: followupPlayPreset(),
    modelBinding: modelBinding(),
    modelHost,
  });

  expect(view.status).toBe("ready");
  expect(view.lastFailure).toBeNull();
  const followups = view.events.filter(({ kind }) => kind === "followup");
  expect(followups).toHaveLength(2);
  expect(followups[0]).toMatchObject({ followupId: "status" });
  expect(followups[1]).toMatchObject({ followupId: "options" });
  expect(
    followups.every(
      (event) => (event as { failure?: string }).failure !== undefined,
    ),
  ).toBe(true);
  expect(
    (await worlds.recoverEndpoint(worldId)).history.map(
      ({ exactText }) => exactText,
    ),
  ).toEqual([
    "门外传来三声短促的铃响。\n",
    "我示意秦龙开门。",
    "秦龙把门推开。",
  ]);
});

/** Two follow-ups on top of the shipped default call chain. */
function followupPlayPreset(): PlayPresetBinding {
  const files = structuredClone(defaultPlayPresetFiles);
  files["preset.yaml"] = `format: narraeon.play-preset/v1
name: followup-test
callChain: call-chain.yaml
mounts:
  panel.status: sidebar
  player.options: composer_below
extensions: []
`;
  files["call-chain.yaml"] = `format: narraeon.play-call-chain/v1
narrative:
  - markdown: prompts/narrate.md
followups:
${followupEntry("status", "状态栏", "status_bar", "panel.status")}${followupEntry(
    "options",
    "行动选项",
    "options",
    "player.options",
  )}`;
  files["prompts/status.md"] = "# 状态栏\n\n输出当前状态。\n";
  files["prompts/options.md"] = "# 行动选项\n\n给出下一步可选行动。\n";
  const parsed = parsePlayPresetFiles(files);
  if (parsed.kind !== "valid") throw parsed.error;
  return {
    id: "followup-test-preset",
    name: "followup-test",
    revision: "followup-test-v1",
    definition: parsed.definition,
    files,
    scriptsEnabled: true,
  };
}

function followupEntry(
  id: string,
  displayName: string,
  output: string,
  channel: string,
): string {
  return `  - id: ${id}
    displayName: ${displayName}
    prompt: { markdown: prompts/${id}.md }
    maxArtifactBytes: 32768
    artifacts:
      - name: ${output}
        channel: ${channel}
        strategy: replace
        contentType: application/json
        save: commit
        invalidation: new_operation
        required: true
        maxEmits: 1
`;
}
