import { mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FileNativeModelHost } from "../src/runtime/model/FileNativeModelAdapters.ts";
import { FileNativeWorldStore } from "../src/runtime/world/FileNativeWorldStore.ts";
import { PlayCallChain } from "../src/runtime/play/PlayCallChain.ts";
import { FileNativePromptCompiler } from "../src/runtime/prompt/FileNativePromptCompiler.ts";
import { builtinDefaultPlayPresetBinding } from "../src/runtime/play/FileNativePlayPresetStore.ts";
import { defaultPresetHostFilesForLocale } from "../src/shared/default-preset-host.ts";

// Explicit opt-in live validation, never part of the automated test suite.
// Credentials are read only to create the production host and are never saved.
const [configPath, outputPath, sceneFilter] = process.argv.slice(2);
if (!configPath || !outputPath)
  throw new Error(
    "Usage: node scripts/validate-history-model.mjs <model-connections-v1.json> <evidence-directory> [scenario-id]",
  );
const library = JSON.parse(await readFile(configPath, "utf8"));
const selected = library.connections.find(
  ({ id }) => id === library.activeConnectionId,
);
if (!selected) throw new Error("No active model connection");
const connection = {
  ...selected,
  maxOutputTokens: 32768,
  reasoningEffort:
    selected.provider === "chat_completions"
      ? "high"
      : selected.reasoningEffort,
};
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "narraeon-history-model-"));
const hostBinding = {
  hostPresetId: "history-validation-host",
  files: defaultPresetHostFilesForLocale("zh-CN"),
};
const playPreset = builtinDefaultPlayPresetBinding("zh-CN");
const player = (exactText) => ({ role: "player", exactText });
const narrator = (exactText) => ({ role: "narrator", exactText });
const scenarios = [
  {
    id: "sufficient",
    state: "莉娜就在桌边，蓝色信封在桌上。",
    history: [
      player("我问蓝色信封放在哪里。"),
      narrator("莉娜指向桌面：‘就在这里。’"),
    ],
    request: "请在世界外简洁回答：莉娜刚才把蓝色信封指向哪里？",
  },
  {
    id: "latest",
    hidden: true,
    state: "你正在与莉娜交谈；本页没有保存她刚才的具体原话。",
    history: [
      player("我问接下来应该去哪里。"),
      narrator("莉娜说：‘下一步去旧渡口，等钟声响三次再进仓库。’"),
    ],
    request:
      "请在世界外读取最近四条完整原文，然后简短回答：莉娜最近一次给我的下一步指示是什么？当前上下文没有她的原话。",
  },
  {
    id: "candidate-terms",
    hidden: true,
    state: "你在城镇，先前某次交涉的条件没有写在当前文档中。",
    history: [
      player("我在船坞问阿墨是否能借渡船。"),
      narrator("阿墨答应借你小艇，条件是日落前送回北岸船坞。"),
      player("后来我们谈了天气。"),
      narrator("午后云层散去。"),
      ...Array.from({ length: 12 }, (_, index) =>
        narrator(
          `后来第${index + 1}阵风掠过石桥，街灯逐一点亮；我们没有继续谈之前的交涉。`,
        ),
      ),
    ],
    request:
      "请在世界外核实：我记得某人借过我船，但不记得原词；借船的归还条件是什么？不要按现在的状态猜。",
  },
  {
    id: "failed-attempt",
    hidden: true,
    state: "旧仓库门的本轮状态尚待核对过去原文。",
    history: [
      player("我把仓库门踹开。"),
      narrator("你一脚踹在门板上，门纹丝不动；门闩仍然锁住。"),
    ],
    request: "请在世界外根据过去原文回答：那次踹门后，门打开了吗？",
  },
  {
    id: "late-promise",
    hidden: true,
    state: "你在港口；旧交谈中的承诺没有保存到当前文档。",
    history: [
      narrator(
        "莉娜先说：‘船票的事情我知道。’\n" +
          "码头边一排木箱整齐地靠着墙，海风掠过绳索。".repeat(240) +
          "\n临别时莉娜郑重说：‘我承诺明早把船票送到北塔门口。’",
      ),
    ],
    request:
      "请在世界外查明：莉娜关于船票最后到底承诺了什么，何时送到哪里？需要核实完整上下文。",
  },
  {
    id: "narrator-lie",
    hidden: false,
    state: "宝石在上锁的库房内，守卫尚未见过它。",
    history: [
      narrator(
        "骗子阿洛对你说：‘宝石早被我卖掉了。’随后他避开你的目光，偷偷藏起那张从未签署的收据；你尚未确认他说的是真是假。",
      ),
    ],
    request:
      "请在世界外回答：主持原文里阿洛说卖掉了宝石，这足以认定宝石已卖出吗？当前宝石在哪里？",
  },
  {
    id: "current-correction",
    hidden: true,
    state:
      "玩家明确世界修订：钥匙已交给莉娜保管，你现在没有钥匙。此为当前成立状态。",
    history: [
      player("我把铜钥匙放进自己的口袋。"),
      narrator("铜钥匙在你的口袋里。"),
    ],
    request:
      "请在世界外回答：我现在是否还持有铜钥匙？旧叙事说在我的口袋，当前明确修订与它不同。",
  },
  {
    id: "zero-hit",
    hidden: true,
    state: "旧约定不在当前状态文档中；不能据此断言没有发生。",
    history: [
      player("我答应下次路过时帮他送东西。"),
      narrator("他点头，把一只油布包交给你，托你带到南边。"),
    ],
    request:
      "请在世界外核实我是否在此前历史里说过‘月光誓言’这几个字。搜索范围明确排除本条查询；若只命中本条，可用该命中ref作为before边界重查。若零字面命中，简短说明可确认范围，不要无进展地无限翻页，也不要断言从未许诺。",
  },
  {
    id: "character-knowledge",
    hidden: true,
    state: "莉娜不在密谈现场，对密谈内容一无所知；她现在正和你在桥头聊天。",
    history: [
      narrator(
        "莉娜离开后，阿墨偷偷对你说：‘我把密钥藏在灯塔第三层。别告诉莉娜。’",
      ),
    ],
    request:
      "你把话题转到灯塔。请核对那场密谈，然后只写莉娜在桥头的简短反应；我没有向她透露密谈。",
  },
  {
    id: "historical-player-last",
    state: "先前钥匙已经递给莉娜，她已把它收进口袋；这是当前完成状态。",
    history: [narrator("莉娜站在桌边。"), player("我把钥匙递给莉娜。")],
    request:
      "请在世界外简短回答：最后一条注入的历史玩家原文是否是本轮待执行的行动？本轮只核对，不递交任何东西。",
  },
];
const results = [];
for (const scene of scenarios.filter(
  ({ id }) =>
    !sceneFilter ||
    (sceneFilter === "remaining" ? id !== "sufficient" : id === sceneFilter),
)) {
  const exchanges = [];
  const production = new FileNativeModelHost(connection);
  const worlds = new FileNativeWorldStore(root);
  const packageFiles = [
    { path: "opening.md", contents: "你来到港口。\n" },
    {
      path: "world/current-situation.yaml",
      contents: `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前局面\n  summary: 港口的当前局面。\n  aliases: []\n情况: ${JSON.stringify(scene.state)}\n`,
    },
    {
      path: "control/frame.yaml",
      contents:
        "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n",
    },
    {
      path: "control/blocks/world.md",
      contents: "# 世界规则\n\n这些已提交原文与明确当前修订构成本世界材料。\n",
    },
    {
      path: "control/player-views.yaml",
      contents: "format: narraeon.player-views/v1\nviews: []\n",
    },
  ];
  const created = await worlds.createFromContentPackage({
    operationId: `create-${scene.id}`,
    sourcePackageId: `package-${scene.id}`,
    sourcePackageTitle: scene.id,
    packageFiles,
    prompt: { hostBinding, modelBinding: production.binding() },
  });
  if (created.outcome !== "created") throw new Error("World was not created");
  const worldId = created.world.worldId;
  await worlds.commitPlayStep({
    operationId: `seed-${scene.id}`,
    worldId,
    parentHead: await worlds.currentHead(worldId),
    historyAppend: scene.history,
    nextMaterials: [],
    stateChanges: [],
    ...(scene.hidden
      ? {
          narrativeCheckpoint: {
            contextId: "fixture-completed",
            completedPlayerRounds: scene.history.filter(
              ({ role }) => role === "player",
            ).length,
          },
        }
      : {}),
  });
  const modelHost = {
    binding: () => production.binding(),
    exchange: async (request, observer) => {
      if (exchanges.length >= 12)
        throw new Error(
          "Validation stopped after 12 requests without completion",
        );
      const record = {
        index: exchanges.length + 1,
        appended: request.appended,
        bootstrap: request.bootstrap.logicalMessages,
        toolNames: request.tools.map(({ name }) => name),
      };
      exchanges.push(record);
      const response = await production.exchange(request, {
        ...observer,
        signal: AbortSignal.any([
          observer?.signal ?? new AbortController().signal,
          AbortSignal.timeout(180_000),
        ]),
      });
      record.response = {
        text: response.text,
        toolCalls: response.toolCalls,
        usage: response.usage,
      };
      return response;
    },
  };
  const began = Date.now();
  let outcome;
  try {
    const view = await new PlayCallChain(
      worlds,
      new FileNativePromptCompiler({ locale: "zh-CN" }),
    ).start({
      worldId,
      chainId: `verify-${scene.id}`,
      exchangeId: `verify-${scene.id}`,
      playerText: scene.request,
      hostBinding,
      playPreset,
      modelBinding: modelHost.binding(),
      modelHost,
    });
    outcome = {
      status: view.status,
      final: exchanges.at(-1)?.response?.text ?? "",
      failure: view.lastFailure,
    };
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const calls = exchanges.flatMap(({ response }) => response?.toolCalls ?? []);
  // Each completed tool receipt appears once when appended to the next native
  // request. Read metrics use source boundaries, not model reasoning text.
  const receipts = new Map();
  for (const { appended } of exchanges)
    for (const item of appended)
      if (item.kind === "tool") receipts.set(item.toolCallId, item.markdown);
  const readBodies = [];
  for (const call of calls)
    if (call.name === "history_read") {
      const receipt = receipts.get(call.id) ?? "";
      for (const match of receipt.matchAll(
        /## 位置 \d+[^\n]*?(@history-message-\S+)\n\n\[原文开始\]\n([\s\S]*?)\n\[原文结束；正文完整\]/gu,
      ))
        readBodies.push({
          ref: match[1],
          codePoints: Array.from(match[2]).length,
        });
    }
  const seen = new Set();
  let repeatedOriginalCodePoints = 0;
  for (const body of readBodies) {
    if (seen.has(body.ref)) repeatedOriginalCodePoints += body.codePoints;
    seen.add(body.ref);
  }
  const result = {
    id: scene.id,
    model: connection.modelId,
    provider: connection.provider,
    reasoningEffort: connection.reasoningEffort,
    maxOutputTokens: connection.maxOutputTokens,
    elapsedMs: Date.now() - began,
    request: scene.request,
    outcome,
    calls,
    readMessages: readBodies.length,
    originalCodePoints: readBodies.reduce(
      (total, body) => total + body.codePoints,
      0,
    ),
    repeatedOriginalCodePoints,
    toolOutputCodePoints: [...receipts.values()].reduce(
      (total, markdown) => total + Array.from(markdown).length,
      0,
    ),
    exchanges,
    fixtureRoot: root,
    worldId,
  };
  await writeFile(
    join(output, `${scene.id}.json`),
    JSON.stringify(result, null, 2),
  );
  results.push({ ...result, exchanges: undefined });
  await writeFile(
    join(output, "summary.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({
      id: result.id,
      outcome,
      calls: calls.map(({ name, arguments: args }) => ({
        name,
        arguments: args,
      })),
      readMessages: result.readMessages,
      originalCodePoints: result.originalCodePoints,
      repeatedOriginalCodePoints,
    }),
  );
}

if (results.some(({ outcome }) => outcome.status !== "ready"))
  process.exitCode = 1;
