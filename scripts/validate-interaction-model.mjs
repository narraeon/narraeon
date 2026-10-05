import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Opt-in production-provider evidence from newly invented worlds only.
// --list and --preview never load credentials or call a provider.
const scenarios = [
  {
    id: "massage",
    state:
      "你和成年朋友林舟坐在长椅边。他刚跑完步，同意你帮他按腿；按到小腿内侧时他会说那里有些酸，希望你轻一点。按摩尚未开始。",
    input: "我坐在林舟身旁，开始帮他按腿。",
    observe: "呈现力度反馈并保留调整机会；不代玩家答应、换手法或按完整场。",
  },
  {
    id: "lesson",
    state:
      "林舟准备教你第一式。你尚未开始练习；首次试做时他会指出手腕角度偏斜，让你感受并调整。",
    input: "我请林舟开始教我第一式，跟着他的示范试做。",
    observe: "留下对首次纠正的回应机会；不写多轮练习、掌握或课程完成。",
  },
  {
    id: "conversation",
    state: "你和林舟坐在窗边。他明天打算去码头修船，愿意解释自己的计划。",
    input: "我问林舟明天有什么打算。",
    observe: "呈现 NPC 回答；不替玩家追问、评价或接下后续对话。",
  },
  {
    id: "ordinary-actions",
    state:
      "林舟在走廊尽头的房间等你送书。走廊通畅，门关着；他听到敲门会开门并接书。书在你手上，递送已经约好，没有新条件。",
    input: "我走过走廊，敲门，把书递给林舟。",
    observe: "普通走路、敲门和递书自然完成；不对每个动作逐项确认。",
  },
  {
    id: "authorized-skip",
    state:
      "林舟同意你帮他按腿十分钟，过程普通且没有新条件。你们已约好结束后各自休息。",
    input: "我帮他按腿十分钟，略过过程，直接写到按完各自休息。",
    observe: "正常完成明确授权的快进；不因为普通反馈强制停在开始。",
  },
  {
    id: "skip-new-choice",
    state:
      "你去码头找林舟，路上顺利。到达时林舟会提出以你唯一的铜钥匙作抵押才借船。你未接受该交易。",
    input: "略过路程，直接写到我在码头找到林舟。",
    observe: "完成路程并呈现新条件；不代玩家抵押钥匙或借走船。",
  },
  {
    id: "autonomous-checkpoint-scene-change",
    state:
      "你和成年朋友林舟在书房。桌上有他的航海笔记，他愿意借给你到明天下午，没有附加条件；明天下午他会在码头修船。借阅尚未发生。",
    input: "我向林舟借航海笔记，答应明天下午归还。",
    continuationInputs: [
      "我收好笔记，问他明天下午在哪里。",
      "我告诉他明天下午去码头还书。",
      "我向他道别，带着笔记走到街口。",
    ],
    observe:
      "同一上下文连续普通游玩，玩家没有维护指令；自然收尾或换场景后主动整理并打点，借阅、归还约定与当前地点可恢复；不提前代玩家告别、还书或推进到明天。",
  },
  {
    id: "autonomous-checkpoint-ongoing",
    state:
      "你和成年朋友林舟在练功房进行第一次基础课，正在分步练习手腕、手肘和肩部姿势。你刚试做一次，手腕角度偏斜，尚未掌握这套动作；林舟正在逐项指导，没有约定本次课的结束时间。",
    input: "我告诉林舟手腕有些酸，希望今天放慢速度。",
    continuationInputs: [
      "我把手腕放平，再试一次，问他这个角度是否合适。",
      "我告诉他我以前右肩受过伤，练习时想避开大幅抬肩。",
      "我按刚才的指导试着调整手肘，问他还需要注意哪里。",
      "我告诉他我想以后每天傍晚来练基础动作。",
      "我再试一次刚才的动作，问他现在的姿势怎么样。",
    ],
    observe:
      "同一活动跨多轮积累身体限制、练习意向和实际进展；没有玩家维护指令也主动中途整理并打点。保留最新反馈的回应机会与进行中状态，不宣布掌握、课程结束或自行离场；不要求每轮打点。",
  },
  {
    id: "mid-activity-checkpoint",
    state:
      "教学正在进行：林舟刚示范第一式，你试做一次，手腕角度仍偏斜。他的原话是：‘把手腕放平一点，这个握法舒服吗？’你尚未回应，练习未完成。",
    input: "世界外：只整理截至当前的状态并登记检查点，不推进教学。",
    nextInput: "我把手腕放平，问他这个角度是否合适。",
    observe:
      "记录进行中教学与待回应原话后打点；全新上下文承接纠正，不重教开场、不宣称课程完成。",
  },
  {
    id: "tool-prose",
    state:
      "你站在敞开的房门旁，准备关门。林舟坐在桌边；门的开关状态是玩家视图显示的值。",
    input: "我把门关上，告诉林舟可以开始谈了。",
    observe:
      "及时写回门状态；若工具响应混有正文，最终呈现尚未展示的关门与台词，不另加后续谈话。",
  },
  {
    id: "maintenance-only",
    state:
      "教学正在进行，你刚试做第一式。林舟已指出手腕角度偏斜，你尚未回应；没有新的动作、时间推进或教学完成。",
    input: "世界外：只整理现有事实，保留进行中教学和待回应事项。",
    observe: "仅维护现有事实并简洁说明，不新增动作、对话、时间推进或完成状态。",
  },
];

const [configPath, outputPath, sceneFilter, sourcePath] = process.argv.slice(2);
if (configPath === "--list") {
  process.stdout.write(`${JSON.stringify(scenarios, null, 2)}\n`);
} else {
  if (!configPath || !outputPath)
    throw new Error(
      "Usage: node scripts/validate-interaction-model.mjs <explicit-model-connections-v1.json|--preview> <new-evidence-directory> [scenario-id|all] [runtime-source-root] (or --list)",
    );
  const chosen = scenarios.filter(
    ({ id }) => !sceneFilter || sceneFilter === "all" || id === sceneFilter,
  );
  if (!chosen.length) throw new Error("Unknown scenario id");
  const sourceRoot = sourcePath
    ? resolve(sourcePath)
    : fileURLToPath(new URL("..", import.meta.url));
  const load = (path) =>
    import(pathToFileURL(join(sourceRoot, "src", path)).href);
  const [model, world, play, prompt, preset, documents] = await Promise.all([
    load("runtime/model/FileNativeModelAdapters.ts"),
    load("runtime/world/FileNativeWorldStore.ts"),
    load("runtime/play/PlayCallChain.ts"),
    load("runtime/prompt/FileNativePromptCompiler.ts"),
    load("runtime/play/FileNativePlayPresetStore.ts"),
    load("runtime/play/PlayDocumentTools.ts"),
  ]);
  const previewOnly = configPath === "--preview";
  let production;
  if (previewOnly) {
    production = {
      binding: () => ({
        provider: "chat_completions",
        endpointFingerprint: "synthetic-preview",
        modelId: "synthetic-preview",
        protocolConfigFingerprint: "synthetic-preview",
        contextWindowTokens: 128_000,
        maxOutputTokens: 8192,
      }),
    };
  } else {
    const library = JSON.parse(await readFile(resolve(configPath), "utf8"));
    const connection = library.connections.find(
      ({ id }) => id === library.activeConnectionId,
    );
    if (!connection) throw new Error("No active model connection");
    // Use the exact supplied configuration in both variants, without overrides.
    production = new model.FileNativeModelHost(connection);
  }
  const playPreset = preset.builtinDefaultPlayPresetBinding("zh-CN");
  const hostBinding = preset.presetHostBinding(playPreset);
  const output = resolve(outputPath);
  await mkdir(output); // Existing evidence directories are never overwritten.
  const root = await mkdtemp(join(tmpdir(), "narraeon-interaction-model-"));
  try {
    for (const scene of chosen) {
      const worlds = new world.FileNativeWorldStore(root);
      const exchanges = [];
      let turnRequests = 0;
      const modelHost = {
        binding: () => production.binding(),
        exchange: async (request, observer) => {
          if (turnRequests++ >= 24)
            throw new Error("Validation request limit reached");
          const record = {
            bootstrap: request.bootstrap.logicalMessages,
            tools: request.tools,
            appended: request.appended,
          };
          exchanges.push(record);
          const response = await production.exchange(request, {
            ...observer,
            signal: AbortSignal.any([
              observer?.signal ?? new AbortController().signal,
              AbortSignal.timeout(300_000),
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
      const packageFiles = [
        { path: "opening.md", contents: "你与林舟在一起。\n" },
        {
          path: "world/current-situation.yaml",
          contents: `$document:\n  id: situation.current\n  ref: current-situation\n  title: 当前局面\n  summary: 你与林舟的当前局面。\n  aliases: []\n情况: ${JSON.stringify(scene.state)}\n门: ${scene.id === "ordinary-actions" ? "关闭" : "敞开"}\n`,
        },
        {
          path: "control/frame.yaml",
          contents:
            "format: narraeon.world-frame/v1\nbindings:\n  currentSituation: situation.current\ninstructions:\n  - markdown: blocks/world.md\ncontext:\n  - slot: { kind: current_situation }\n  - slot: { kind: additional_materials }\n",
        },
        {
          path: "control/blocks/world.md",
          contents:
            "# 世界规则\n\n你与林舟均为成年人。当前情境正文是本场景已成立的事实与条件。\n",
        },
        {
          path: "control/player-views.yaml",
          contents:
            scene.id === "tool-prose"
              ? "format: narraeon.player-views/v1\nviews:\n  - id: door\n    title: 门\n    items:\n      - id: door\n        label: 门\n        select: { document: '@current-situation', locator: { yaml: [门] } }\n"
              : "format: narraeon.player-views/v1\nviews: []\n",
        },
      ];
      const created = await worlds.createFromContentPackage({
        operationId: `create-${scene.id}`,
        sourcePackageId: `synthetic-${scene.id}`,
        sourcePackageTitle: scene.id,
        packageFiles,
        prompt: { hostBinding, modelBinding: production.binding() },
      });
      if (created.outcome !== "created") throw new Error("World not created");
      const worldId = created.world.worldId;
      if (previewOnly) {
        const binding = await worlds.bindPlayCallChain(worldId);
        const request = prompt.createMinimalFileNativePreviewInput({
          ...production.binding(),
          playerInput: scene.input,
          playerInputPlacement: "append",
          locale: "zh-CN",
        });
        request.hostBinding = hostBinding;
        request.world.documentSnapshot = new documents.FileNativePlayDocuments(
          binding.files,
        ).snapshot;
        request.world.additionalMaterials = binding.additionalMaterials;
        request.world.history = binding.history;
        const preview = new prompt.FileNativePromptCompiler({
          locale: "zh-CN",
        }).preview(request, playPreset);
        await writeFile(
          join(output, `${scene.id}.json`),
          JSON.stringify(
            {
              sourceRoot,
              scenario: scene,
              preview,
              semanticVerdict: "UNASSESSED: compilation only; no provider call",
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
        process.stdout.write(
          `${scene.id}: compiled; semantic result unassessed\n`,
        );
        continue;
      }
      const sends = [];
      const chains = new play.PlayCallChain(
        worlds,
        new prompt.FileNativePromptCompiler({ locale: "zh-CN" }),
      );
      const inputs = [
        { text: scene.input, fresh: true },
        ...(scene.continuationInputs ?? []).map((text) => ({
          text,
          fresh: false,
        })),
        ...(scene.nextInput ? [{ text: scene.nextInput, fresh: true }] : []),
      ];
      let chainId = `${scene.id}-0`;
      for (const [index, { text: playerText, fresh }] of inputs.entries()) {
        turnRequests = 0;
        const exchangeId = `${scene.id}-${index}`;
        if (fresh) chainId = exchangeId;
        const view = fresh
          ? await chains.start({
              worldId,
              chainId,
              exchangeId,
              playerText,
              hostBinding,
              playPreset,
              modelBinding: production.binding(),
              modelHost,
            })
          : await chains.append({
              worldId,
              chainId,
              exchangeId,
              playerText,
              modelHost,
              resolvePrompt: () => Promise.resolve({ hostBinding, playPreset }),
            });
        sends.push({
          playerText,
          context: fresh ? "fresh" : "append",
          status: view.status,
          failure: view.lastFailure,
          endpoint: await worlds.recoverEndpoint(worldId),
        });
        if (view.status !== "ready") break;
      }
      await writeFile(
        join(output, `${scene.id}.json`),
        JSON.stringify(
          {
            sourceRoot,
            modelBinding: production.binding(),
            scenario: scene,
            semanticVerdict:
              "UNASSESSED: manually compare repeated before/after evidence",
            sends,
            exchanges,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      process.stdout.write(
        `${scene.id}: ${sends.at(-1)?.status}; semantic result unassessed\n`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
