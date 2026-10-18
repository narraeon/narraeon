import { uiText } from "./i18n.ts";

/**
 * Player-facing text for Runtime failures the player can act on. The Runtime
 * keeps its technical English messages (and records them under the log root);
 * unknown messages pass through unchanged so nothing is hidden.
 */
const runtimeErrorTexts: readonly [RegExp, string][] = [
  [
    /^(?:A model request is (?:still|already) running|The call chain is waiting for the model to return)/u,
    "模型正在生成，请等它完成或先取消，再进行这项操作。",
  ],
  [
    /^(?:The parent endpoint of the (?:play|Authority) operation has changed|Another operation has advanced the current world|World advanced before background capture|The call-chain record differs from the current world endpoint|The prepared Authority fact no longer extends the current endpoint)/u,
    "世界刚被其他操作更新，这次操作没有生效。请刷新页面后重试。",
  ],
  [
    /^(?:Play is locked|Timeline editing is locked|World play and other changes are locked|World control drafts are locked) while a world revision is open|^World control is locked while a world revision opens/u,
    "世界正在修订，游玩和其他修改已锁定。请先应用或放弃修订。",
  ],
  [
    /^(?:This world was imported from a backup|This model context was imported from a backup)/u,
    "这个世界来自备份，请先开启全新上下文再继续。",
  ],
  [
    /^(?:The current model context cannot continue|This model context predates durable provider continuation bindings|The selected model connection does not match the frozen model binding)/u,
    "当前上下文无法继续，请使用全新上下文。",
  ],
  [
    /^The selected model protocol differs from this context/u,
    "当前模型协议与此上下文不同。切回原协议即可继续；使用新协议请开启全新上下文。",
  ],
  [
    /^(?:The call chain does not exist|The current world has no model call chain to revise|The model context to revise does not exist|The selected event is not a committed player message)/u,
    "找不到要操作的对话记录，请刷新页面后重试。",
  ],
  [/^World does not exist/u, "世界不存在，可能已被删除。"],
  [
    /^(?:World Authority is being updated by another durable operation|World Authority commit is being serialized by another process|Another world operation is still finishing|This world already has a durable state operation in progress|World storage is being upgraded by another durable operation|World control is frozen by)/u,
    "世界正在处理另一项操作，请稍后重试。",
  ],
  [
    /^(?:The timeline revision was committed, but current-world materialization|The world has accepted but unrepaired materialization|Please repair the world before exporting a backup)/u,
    "上一次修改已保存，但还没有完整写入当前世界。请刷新页面；如果仍然失败，请在世界管理中修复世界。",
  ],
  [
    /^A world backup is being exported/u,
    "正在导出世界备份，请等它完成后再操作。",
  ],
  [
    /^World name must contain 1 to 160 characters/u,
    "世界名称须为 1–160 个字符，且不能换行。",
  ],
  [
    /^(?:Player text must not be empty|Edited player message cannot be empty)/u,
    "玩家输入不能为空。",
  ],
  [
    /^The world-revision worktree changed; refresh it before writing/u,
    "修订内容已在别处更新，请刷新后再保存。",
  ],
  [
    /^Wait for or cancel the running AI response before changing the revision/u,
    "请等待或取消正在进行的 AI 回复，再修改这次修订。",
  ],
];

export function runtimeErrorText(message: string): string {
  for (const [pattern, text] of runtimeErrorTexts)
    if (pattern.test(message)) return uiText(text);
  return message;
}

export function runtimeConnectionErrorText(): string {
  return uiText("无法连接到 Narraeon 服务。请确认服务正在运行、网络连接正常。");
}

export function runtimeUnreadableResponseText(status: number): string {
  return status === 502 || status === 503 || status === 504
    ? uiText(
        "Narraeon 服务暂时不可用（HTTP {status}），可能正在重启，请稍后重试。",
        {
          status,
        },
      )
    : uiText(
        "Narraeon 服务返回了无法识别的响应（HTTP {status}）。请稍后重试；如果使用了反向代理，请检查代理配置。",
        { status },
      );
}
