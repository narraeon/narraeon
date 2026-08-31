import {
  defaultAppLocale,
  isAppLocale,
  type AppLocale,
} from "../protocol/appPreferences.ts";

let activeLocale: AppLocale = defaultAppLocale;

const englishMessages: Record<string, string> = {
  "正在读取工作区…": "Loading workspace…",
  工作区读取失败: "Failed to load the workspace",
  "内容包当前树已整批保存。": "The content package tree has been saved.",
  "内容包已重命名。": "The content package has been renamed.",
  "内容包 ZIP 自身大小超过安全上限。":
    "The content package ZIP exceeds the safety limit.",
  "ZIP 内容包已导入为新的本地身份。":
    "The ZIP content package was imported with a new local identity.",
  "请先保存手动编辑，再开始 AI 设定完善。":
    "Save manual edits before starting setting improvement.",
  "创作计划已生成；计划阶段只读取了当前设定。":
    "The creation plan is ready; the planning phase only read the current setting.",
  "候选已通过机械检查；可整批应用或放弃。":
    "The candidate passed mechanical checks and can now be applied or discarded.",
  "已按你的意见重出创作计划。":
    "The creation plan has been regenerated from your feedback.",
  "候选已按你的意见修改并重新通过机械检查。":
    "The candidate was revised from your feedback and passed mechanical checks again.",
  "设定候选已整批应用。": "The setting candidate has been applied.",
  "设定候选已放弃，当前树未改变。":
    "The setting candidate was discarded; the current tree is unchanged.",
  "请先保存并启用一份模型配置。": "Save and enable a model connection first.",
  "世界已重命名为“{name}”。": "World renamed to “{name}”.",
  "删除世界“{title}”？它的全部提交、历史和存档都会从本机移除，且无法撤销。":
    "Delete world “{title}”? All of its commits, history, and saved data will be removed from this device. This cannot be undone.",
  "世界已从本机删除。": "The world has been deleted from this device.",
  操作失败: "Operation failed",
  未命名世界: "Untitled world",
  模型连接: "Model connection",
  完成原因: "Provider completion reason",
  原生续传载荷: "Provider-native continuation payload",
  不可用: "Unavailable",
  尚未配置: "Not configured",
  内容包: "Content package",
  内容包编辑方式: "Content package editing mode",
  "已放弃未保存修改；内容包当前树未改变。":
    "Unsaved edits were discarded; the current content package tree is unchanged.",
  "Narraeon · 本地优先": "Narraeon · Local first",
  世界工作区: "World workspace",
  "创作内容包，连接 AI 主持，让每个世界独立演化。":
    "Create content packages, connect a model host, and let every world evolve independently.",
  返回工作区: "Back to workspace",
  手动编辑: "Edit manually",
  "AI 完善": "Setting improvement",
  新建世界: "Create world",
  从当前内容包创建: "Create from current content package",
  界面语言: "Interface language",
  "界面语言已保存。": "Interface language saved.",
  简体中文: "Simplified Chinese",
  "扩展 iframe 加载失败": "Extension iframe failed to load",
  "下一次真实 Prompt Preview": "Next real Prompt Preview",
  "每个后置请求在主调用链完成后单独派发一次，共用同一段冻结前缀，彼此看不见对方，也不会进入之后的模型上下文。请求提示、产物格式和显示位置都可在当前页面编辑。":
    "Each follow-up is dispatched once after the main call chain. They share the same frozen prefix, cannot see one another, and never enter later model context. Edit each request prompt, artifact format, and display location here.",
  "上次模型请求没有完整返回。保持输入框为空并点击“追加上下文”，就会原样发送已保存的请求；不会追加玩家指令，中断片段也不会进入模型上下文。":
    "The previous model request did not return completely. Leave the input empty and append context to resend the saved request unchanged. No player instruction is appended, and the interrupted fragment does not enter model context.",
  产物调试器: "Artifact debugger",
  扩展状态: "Extension status",
  核心已提交: "Core committed",
  核心未提交: "Core not committed",
  "已完成请求：": "Completed requests:",
  无: "None",
  玩家视图面板诊断: "Player-view panel diagnostics",
  玩家视图面板: "Player-view panel",
  "已提交玩家视图投影 · head：": "Committed player-view projection · head:",
  "bridge 事件（": "Bridge events (",
  来源: "Source",
  世界端点: "World endpoint",
  未提交: "Uncommitted",
  "保存／投影": "Retention / projection",
  "renderer 状态": "Renderer status",
  最终内容: "Final content",
  "regex steps（structured_payload 以规范化 JSON 文本为输入）":
    "Regex steps (structured_payload uses normalized JSON text as input)",
  "artifact 内容超过宿主渲染上限":
    "Artifact content exceeds the host rendering limit",
  正则规则数量超过宿主上限: "The number of regex rules exceeds the host limit",
  "markdown_html 规则只作用于 Markdown 转换后的 HTML":
    "markdown_html rules apply only to HTML produced from Markdown",
  正则转换次数超过宿主上限:
    "The number of regex transformations exceeds the host limit",
  正则输出超过宿主字节上限: "Regex output exceeds the host byte limit",
  "Markdown HTML DOM 大小超过宿主上限":
    "The Markdown HTML DOM exceeds the host size limit",
  正则执行失败: "Regex execution failed",
  "正则规则失败，实例显示 raw artifact（可恢复）":
    "A regex rule failed; the instance is showing the raw artifact and can recover",
  "正则规则失败，实例进入错误状态并显示 raw artifact":
    "A regex rule failed; the instance entered an error state and is showing the raw artifact",
  "document renderer 必须包含唯一 narraeon:content marker":
    "A document renderer must contain exactly one narraeon:content marker",
  "ArtifactExtensionMount 必须位于 ArtifactExtensionHost 内":
    "ArtifactExtensionMount must be inside ArtifactExtensionHost",
  "文档 renderer 无效": "Invalid document renderer",
  扩展报告了未知诊断: "The extension reported an unknown diagnostic",
  "当前调用链正在提交，暂不能修改草稿":
    "The current call chain is committing; its draft cannot be changed yet",
  "composer.set_draft.text 必须是字符串":
    "composer.set_draft.text must be a string",
  "扩展资源不可用，显示 raw artifact。":
    "Extension resources are unavailable; showing the raw artifact.",
  恢复此扩展: "Restore this extension",
  停用此扩展: "Disable this extension",
  本地可信代码: "Trusted local code",
  扩展展帧加载失败: "Extension iframe failed to load",
  产物诊断: "Artifact diagnostics",
  内容包当前树: "Current content-package tree",
  "逐份编辑 YAML／Markdown；整批保存时才原子替换已保存版本。":
    "Edit YAML and Markdown files individually; the saved version is replaced atomically only when the whole draft is saved.",
  内容包编辑状态: "Content-package editing status",
  "已保存版本：": "Saved version:",
  可用: "Usable",
  需要修复: "Needs repair",
  有未保存修改: "Unsaved changes",
  草稿与已保存版本一致: "Draft matches the saved version",
  内容包文件统计: "Content-package file counts",
  全部文件: "All files",
  开场白: "Opening text",
  世界内容: "World content",
  控制文件: "Control files",
  内容包文件: "Content-package files",
  当前草稿: "Current draft",
  文件: "Files",
  筛选文件: "Filter files",
  "人物、地点或文件名": "Character, location, or file name",
  内容包文件树: "Content-package file tree",
  "没有匹配的文件。": "No files match.",
  新建文件: "Create file",
  新文件路径: "New file path",
  "新文件先加入本地草稿；Runtime 会在整批保存时检查路径与内容。":
    "A new file is added to the local draft first. Runtime validates its path and content when the whole draft is saved.",
  加入草稿: "Add to draft",
  文件编辑器: "File editor",
  当前草稿没有文件: "The current draft has no files",
  "从左侧新建第一份文件，或返回工作区导入已有内容包。":
    "Create the first file from the left, or return to the workspace and import an existing content package.",
  从草稿移除: "Remove from draft",
  文件路径: "File path",
  应用新路径: "Apply new path",
  二进制资源不在文本编辑器展开:
    "Binary resources are not expanded in the text editor",
  "当前 Base64 内容会原样保留；如需替换资源，请重新导入内容包。":
    "The current Base64 content is preserved exactly. Reimport the content package to replace the resource.",
  文件内容: "File content",
  "Ctrl / ⌘ + S 整批保存": "Ctrl / ⌘ + S saves the whole draft",
  行: "Lines",
  字符: "Characters",
  已保存版本诊断: "Saved-version diagnostics",
  已保存版本有: "The saved version has",
  "已保存版本有 {count} 项需要修复":
    "The saved version has {count} issue(s) to repair",
  项需要修复: "issue(s) to repair",
  "诊断对应上一次保存；整批保存后会按新草稿重新检查。":
    "Diagnostics describe the last save. Saving the whole draft checks the new draft again.",
  草稿尚未保存: "Draft not saved",
  当前树已保存: "Current tree saved",
  "保存会把整棵草稿作为一个候选原子替换，不会逐文件提交。":
    "Saving atomically replaces the entire tree with one candidate; files are not committed one at a time.",
  整批保存: "Save all changes",
  放弃未保存修改: "Discard unsaved changes",
  内容包操作: "Content-package actions",
  "请先整批保存或放弃当前草稿，再操作已保存内容包。":
    "Save or discard the current draft before acting on the saved content package.",
  内容包名称: "Content-package name",
  重命名: "Rename",
  复制为新本地身份: "Copy as a new local identity",
  "导出 ZIP": "Export ZIP",
  删除内容包: "Delete content package",
  "请输入文件路径。": "Enter a file path.",
  "路径必须是使用 / 的内容包相对路径。":
    "The path must be relative to the content package and use / separators.",
  "路径不能包含空目录、. 或 ..。":
    "The path cannot contain empty directories, . or ...",
  "当前文件原生 V1 不接受 manifest 或 JSON 内容文件。":
    "File-native V1 does not accept a manifest or JSON content files.",
  "当前草稿中已经存在同一路径。":
    "The current draft already contains that path.",
  二进制资源: "Binary resource",
  玩家首次行动前看到的开场白:
    "Opening text shown before the player's first action",
  会复制为世界状态的设定文档: "Setting document copied into world state",
  会复制为世界控制的作者资产: "Author asset copied into world control",
  内容包文本资源: "Content-package text resource",
  "写下玩家首次行动前立即看到的局面……":
    "Describe the situation visible immediately before the player's first action…",
  "$document:\n  id: character.example\n  ref: example\n  title: 示例人物\n  summary: 一句话稳定简介。\n  aliases: []\n":
    "$document:\n  id: character.example\n  ref: example\n  title: Alex Morgan\n  summary: A stable one-sentence description.\n  aliases: []\n",
  "---\n$document:\n  id: rule.example\n  ref: example\n  title: 示例规则\n  summary: 一句话稳定简介。\n  aliases: []\n---\n\n# 示例规则\n":
    "---\n$document:\n  id: rule.example\n  ref: example\n  title: Example rule\n  summary: A stable one-sentence description.\n  aliases: []\n---\n\n# Example rule\n",
  "输入 UTF-8 文本内容……": "Enter UTF-8 text…",
  确认修正内容: "Review correction",
  份文档会变化: "document(s) will change",
  修正前: "Before correction",
  修正后: "After correction",
  "查看内容 hash": "View content hash",
  "查看端点、附加材料和下一次提示词":
    "View the endpoint, additional material, and next prompt",
  父端点: "Parent endpoint",
  候选版本: "Candidate version",
  完整附加材料清单差异: "Complete additional-material diff",
  下一次真实提示词: "Next real Prompt Preview",
  应用这笔修正: "Apply this correction",
  放弃修正草稿: "Discard correction draft",
  世界文件: "World files",
  "当前 state 文档": "Current state documents",
  尚无已提交叙事: "No committed narrative yet",
  "Runtime 诊断": "Runtime diagnostics",
  "创建 operation": "Creation operation",
  历史条目: "History entries",
  没有文件: "No files",
  继续游玩: "Continue playing",
  世界: "Worlds",
  进入世界: "Open world",
  删除: "Delete",
  世界名称: "World name",
  保存世界名称: "Save world name",
  保存: "Save",
  取消: "Cancel",
  还没有正在游玩的世界: "No worlds in play yet",
  "先新建内容包，或上传一份 ZIP，再整理开场与世界文档并创建独立世界。":
    "Create a content package or upload a ZIP, then prepare its opening and world documents and create an independent world.",
  工作区状态: "Workspace status",
  当前预设: "Current preset",
  尚未选择: "Not selected",
  可用内容包: "Usable content packages",
  份: "total",
  "内容包是世界模板；创建后的世界会独立保存状态、控制与历史。":
    "A content package is a world template. A created world stores its own state, control, and history.",
  创作工作台: "Authoring workbench",
  "四个入口各自完成一件事，运行中的世界从上方直接进入。":
    "Each of the four entries has one job. Open active worlds directly above.",
  四个任务入口: "Four task entries",
  内容编辑: "Content editing",
  "编辑内容包里的开场、世界文档与控制文件。":
    "Edit a content package's opening, world documents, and control files.",
  从空白内容包开始: "Start with a blank content package",
  预设: "Presets",
  "编辑提示块库、叙事规则、后置请求与扩展资源。":
    "Edit prompt blocks, narrative rules, follow-up requests, and extension resources.",
  选择预设: "Choose a preset",
  "从一份可用内容包复制出独立演化的世界。":
    "Copy a usable content package into an independently evolving world.",
  需要可用内容包: "Usable content package required",
  提示词预览: "Prompt Preview",
  "检查真实 role、材料、工具、预算与缓存边界。":
    "Inspect real roles, material, tools, budgets, and cache boundaries.",
  模型已就绪: "Model ready",
  需要模型连接: "Model connection required",
  新建内容包: "Create content package",
  待修复: "Needs repair",
  "可编辑、预览并创建新世界": "Ready to edit, preview, and create a world",
  打开并修复当前树中的问题: "Open and repair issues in the current tree",
  从一组人类可读文件开始: "Start with human-readable files",
  "内容包由 opening.md、world 与 control 组成，可以从空白新建，也可以上传一份内容包 ZIP。":
    "A content package contains opening.md, world, and control. Create one from scratch or upload a content-package ZIP.",
  "导入 ZIP": "Import ZIP",
  "选择本应用导出或遵循相同结构的内容包 ZIP；导入会创建新的本地身份，不覆盖同名内容包。":
    "Choose a ZIP exported by this app or one with the same structure. Import creates a new local identity and never overwrites a package with the same name.",
  "内容包 ZIP": "Content-package ZIP",
  "内容包 ZIP 文件": "Content-package ZIP file",
  "选择 ZIP 文件": "Choose ZIP file",
  "正在导入…": "Importing…",
  默认模型: "Default model",
  "模型连接已保存并启用；后续请求只使用当前配置。":
    "The model connection was saved and enabled. Later requests use only the current configuration.",
  "已切换当前模型配置；Runtime 不会自动故障转移。":
    "The current model configuration was switched. Runtime does not fail over automatically.",
  "模型配置已从本机删除。":
    "The model configuration was deleted from this device.",
  "保存多份本机配置并明确切换。API Key 不会返回浏览器；切换失败时 Runtime 不会悄悄改用另一份配置。":
    "Save multiple local configurations and switch explicitly. API keys are never returned to the browser, and Runtime does not silently use another configuration when a switch fails.",
  当前配置: "Current configuration",
  尚未启用: "Not enabled",
  先保存一份可用连接: "Save a usable connection first",
  新建配置: "New configuration",
  编辑配置: "Edit configuration",
  新建另一份: "Create another",
  提供商: "Provider",
  配置名称: "Configuration name",
  协议适配器: "Protocol adapter",
  已填入: "Using",
  "的内置端点；手动修改后按自定义端点保存。":
    "'s built-in endpoint. After a manual edit it will be saved as a custom endpoint.",
  新配置必填: "Required for a new configuration",
  "端点或协议已改变，必须重新填写":
    "The endpoint or protocol changed; enter it again",
  留空以保留当前端点的现有凭据:
    "Leave blank to keep the existing credential for this endpoint",
  "旧凭据只会为同一协议和端点保留，不会静默转发到新端点。":
    "An old credential is retained only for the same protocol and endpoint; it is never silently forwarded to a new endpoint.",
  "模型 ID": "Model ID",
  "正在拉取…": "Fetching…",
  从端点拉取模型: "Fetch models from endpoint",
  "可在模型 ID 输入框中选择已拉取结果。":
    "Fetched results can be selected in the Model ID field.",
  "真实 context window": "Actual context window",
  "最大输出 tokens": "Maximum output tokens",
  "正在保存…": "Saving…",
  保存模型连接并启用: "Save and enable model connection",
  放弃修改: "Discard changes",
  重置新配置: "Reset new configuration",
  已保存模型配置: "Saved model configurations",
  已保存配置: "Saved configurations",
  "尚未保存模型配置。": "No model configurations saved yet.",
  当前使用: "In use",
  模型: "Model",
  端点: "Endpoint",
  "窗口 / 输出": "Window / output",
  凭据: "Credential",
  已保存在本机: "Saved on this device",
  未配置: "Not configured",
  "正在切换…": "Switching…",
  切换到此配置: "Switch to this configuration",
  正在编辑: "Editing",
  编辑: "Edit",
  "正在删除…": "Deleting…",
  "先切换到另一份配置，才能删除当前配置。":
    "Switch to another configuration before deleting the current one.",
  模型配置操作失败: "Model-configuration action failed",
};

const playPresetEnglishMessages: Record<string, string> = {
  玩法预设操作失败: "Play-preset action failed",
  "当前玩法有未保存修改；请先保存或撤销，再切换预设。":
    "The current play preset has unsaved changes. Save or discard them before switching presets.",
  "已撤销当前未保存修改。": "Current unsaved changes were discarded.",
  "preset.yaml/call-chain.yaml 与结构化编辑同时修改；请保留一种编辑方式后再保存，避免静默覆盖。":
    "preset.yaml/call-chain.yaml and the structured editor were both changed. Keep one version before saving to avoid a silent overwrite.",
  "玩法文件与结构化草稿已保存。":
    "Play files and the structured draft were saved.",
  "玩法预设业务文件已导出。": "Play-preset files were exported.",
  "导入文件必须是 UTF-8 玩法业务文件数组":
    "The imported file must be an array of UTF-8 play files",
  导入玩法: "Import play preset",
  "玩法预设已导入为新的本地身份；请显式启用其中的 JavaScript。":
    "The play preset was imported as a new local identity. Enable its JavaScript explicitly if you trust it.",
  玩法预设: "Play presets",
  "在同一处管理设定完善方法、主持规则、调用链、界面产物与可信本地代码。":
    "Manage setting-improvement methods, host rules, call chains, interface artifacts, and trusted local code in one place.",
  新调用链与设定完善当前使用:
    "New call chains and setting-improvement sessions currently use",
  未选择: "Not selected",
  "已经开始的模型会话继续使用冻结 revision":
    "Model sessions already in progress keep their frozen revision",
  玩法预设工作区: "Play-preset workspace",
  玩法预设列表: "Play-preset list",
  本地预设: "Local presets",
  "选择一个本地身份开始编辑。": "Choose a local identity to start editing.",
  当前玩法: "Current play preset",
  结构有效: "Structure valid",
  需要修复: "Needs repair",
  已停用: "Disabled",
  新建与导入玩法预设: "Create and import play presets",
  新建或导入: "Create or import",
  新玩法预设名称: "New play-preset name",
  "已新建普通玩法预设。": "A regular play preset was created.",
  新建空白预设: "Create blank preset",
  复制推荐: "Copy recommended preset",
  导入玩法文件: "Import play files",
  导入玩法预设文件: "Import play-preset file",
  "还没有玩法预设。": "There are no play presets yet.",
  玩法预设文件编辑器: "Play-preset file editor",
  "· 修改只影响之后开始的全新上下文":
    "· Changes affect only new contexts started later",
  未保存修改: "Unsaved changes",
  已保存: "Saved",
  "JavaScript 已启用": "JavaScript enabled",
  "JavaScript 已停用": "JavaScript disabled",
  预设名称: "Preset name",
  玩法预设名称: "Play-preset name",
  预设操作: "Preset actions",
  玩法预设身份管理: "Play-preset identity management",
  "这些操作只管理这份本地预设；内容编辑和保存仍在页面底部完成。":
    "These actions manage only this local preset. Edit and save its content at the bottom of the page.",
  "玩法预设状态已更新。": "Play-preset status updated.",
  启用预设: "Enable preset",
  停用预设: "Disable preset",
  "JavaScript 已停用；raw/document 仍可预览。":
    "JavaScript is disabled; raw and document content can still be previewed.",
  "JavaScript 已显式启用（本地可信代码）。":
    "JavaScript is explicitly enabled as trusted local code.",
  "停用 JavaScript": "Disable JavaScript",
  "启用 JavaScript（本地可信代码）": "Enable JavaScript (trusted local code)",
  "已复制为独立本地身份。": "Copied as an independent local identity.",
  复制为新预设: "Copy as new preset",
  导出业务文件: "Export play files",
  "玩法预设已删除；删空后会自动重建默认预设。":
    "The play preset was deleted. Deleting the last preset automatically rebuilds the default.",
  删除预设: "Delete preset",
  "导入的 JavaScript 默认停用；启用表示你信任这些本地文件，而不是获得安全沙箱保证。":
    "Imported JavaScript is disabled by default. Enabling it means you trust these local files; it does not provide a security sandbox.",
  玩法预设摘要: "Play-preset summary",
  后置请求: "Follow-up requests",
  产物输出: "Artifact outputs",
  界面挂载: "Interface mounts",
  普通文件: "Regular files",
  玩法预设编辑区域: "Play-preset editing area",
  "该玩法文件路径已经存在。": "That play-file path already exists.",
  "已加入普通文件草稿；保存时会通过 codec 校验。":
    "The regular file was added to the draft and will be validated by the codec when saved.",
  结构化编辑暂不可用: "Structured editing is unavailable",
  "当前草稿无法生成结构投影。请到“高级文件”修复 preset.yaml 或 call-chain.yaml，保存后再回来。":
    "The current draft cannot produce a structured projection. Repair preset.yaml or call-chain.yaml under Advanced files, save, and return here.",
  前往高级文件: "Go to Advanced files",
  预览当前预设: "Preview current preset",
  "产物外观与真实调用链提示词都留在这里检查，不会调用模型或离开当前预设。":
    "Inspect artifact appearance and real call-chain prompts here without calling a model or leaving the current preset.",
  "正在生成真实编译/产物预览…":
    "Generating real compilation and artifact previews…",
  工作台静态错误: "Workbench static error",
  当前预设的真实提示词预览: "Real prompt preview for the current preset",
  真实调用链预览: "Real call-chain preview",
  "请先保存当前修改；真实预览只编译已冻结的有效 revision。":
    "Save the current changes first. A real preview compiles only a frozen valid revision.",
  "当前 revision 需要修复，暂时不能编译真实调用链。":
    "The current revision needs repair and cannot compile a real call chain yet.",
  "当前宿主没有提供提示词预览面板。":
    "The current host does not provide a Prompt Preview panel.",
  "preset.yaml/call-chain.yaml 与结构化字段均有未保存修改；请撤销其中一侧后再保存，避免 stale structure 覆盖 raw YAML。":
    "preset.yaml/call-chain.yaml and structured fields both have unsaved changes. Discard one side before saving so stale structure cannot overwrite raw YAML.",
  草稿尚未保存: "Draft not saved",
  结构校验通过: "Structure validation passed",
  草稿需要修复: "Draft needs repair",
  撤销未保存修改: "Discard unsaved changes",
  保存修改: "Save changes",
  "已将该冻结 revision 设为当前玩法。":
    "That frozen revision is now the current play preset.",
  应用为当前玩法: "Use as current play preset",
  "AI 设定完善": "Setting improvement",
  "这份文字决定 AI 怎样理解、规划和创作内容包设定；每次开始完善时会冻结当前预设 revision。":
    "This text tells the model how to understand, plan, and author content-package settings. Each session freezes the current preset revision.",
  "工具为什么不在这里？": "Why are the tools not editable here?",
  "Runtime 继续内置 setting_* 工具定义、参数、说明、只读／写入阶段边界和候选终态协议。预设只能编辑创作语义，不能替换这些机械契约。":
    "Runtime owns the setting_* definitions, parameters, descriptions, read/write phase boundaries, and candidate settlement protocol. A preset can edit authoring semantics but cannot replace these mechanical contracts.",
  沿用系统推荐提示: "Use the system-recommended prompt",
  "这是一份功能加入前保存的 v1 预设。打开页面不会改写它；写入后才会产生新的预设 revision。":
    "This v1 preset was saved before the feature existed. Opening this page does not rewrite it; writing the prompt creates a new preset revision.",
  系统推荐设定完善提示词: "System-recommended setting-improvement prompt",
  写入预设并编辑: "Write into preset and edit",
  设定完善创作提示: "Setting-improvement authoring prompt",
  "# 叙事规则\n\n说明 AI 每次写玩家可见正文时都应遵守的规则。\n":
    "# Narrative rules\n\nDescribe the rules the model must follow whenever it writes player-visible prose.\n",
  "# 新后置请求\n\n说明主调用链完成后，需要额外整理成什么界面内容。\n":
    "# New follow-up request\n\nDescribe the interface content to prepare after the main call chain completes.\n",
  新后置请求: "New follow-up request",
  调用链: "Call chain",
  界面扩展: "Interface extensions",
  "先编辑 AI 主响应要遵守的文字规则，再按需添加主响应结束后的界面产物。提示内容直接显示，不需要填写文件路径。":
    "Edit the prose rules for the model's main response, then add interface artifacts after it as needed. Prompt content appears directly; no file path is required.",
  "选择产物显示在哪里，并用普通表单配置玩家视图和扩展文件；无需手写 JSON。":
    "Choose where artifacts appear and configure player views and extension files with regular forms; no handwritten JSON is needed.",
  "保存有效 revision 后生成真实预览。":
    "Save a valid revision to generate real previews.",
  "频道是什么？": "What is a channel?",
  "频道只是“产物送到哪里”的内部连线：后置请求产出内容，页面按同名频道把它放到你选择的位置。普通编辑只需选显示位置，技术地址会自动保留。":
    "A channel is the internal connection that routes an artifact. A follow-up produces content, and the page places it at the location selected for the matching channel. Regular editing only chooses a display location; the technical address is preserved automatically.",
  产物显示位置: "Artifact display locations",
  "每项都来自“调用链”中的一个真实产物输出。":
    "Every item comes from a real artifact output in the call chain.",
  "当前没有后置产物。先在“调用链”新增后置请求，这里才会出现可放置的内容。":
    "There are no follow-up artifacts. Add a follow-up request under Call chain before choosing where its content appears.",
  显示位置: "Display location",
  未连接到当前产物的旧频道:
    "Legacy channels not connected to current artifacts",
  随预设加载的界面文件: "Interface files loaded with the preset",
  "勾选 renderer、脚本和样式等前端资源。这里只选择已有文件，不需要写数组格式。":
    "Select existing frontend resources such as renderers, scripts, and styles. No array syntax is needed.",
  界面扩展文件: "Interface-extension files",
  "当前还没有 renderer、脚本或样式文件。":
    "There are no renderer, script, or style files yet.",
  叙事提示块: "Narrative prompt blocks",
  新增叙事提示块: "Add narrative prompt block",
  "这些文字和主持规则一起进入稳定 bootstrap，约束调用链中的玩家可见正文。下方直接显示真实内容。":
    "These blocks enter the stable bootstrap with the host rules and constrain player-visible prose in the call chain. Their real content appears below.",
  "尚未声明叙事提示块；通用文风仍由主持块提供。":
    "No narrative prompt blocks are declared; the host blocks still provide the general prose style.",
  删除: "Delete",
  新增后置请求: "Add follow-up request",
  "每个后置请求在主调用链完成后单独派发一次，共用同一段冻结前缀，彼此看不见对方，也不会进入之后的模型上下文。请求提示、产物格式和显示位置都可在当前页面编辑。":
    "Each follow-up is dispatched once after the main call chain. They share the same frozen prefix, cannot see one another, and never enter later model context. Edit each request prompt, artifact format, and display location here.",
  "没有后置请求；主调用链完成后不会再派发额外请求。":
    "There are no follow-up requests; no additional request is dispatched after the main call chain.",
  显示名: "Display name",
  这次额外请求要做什么: "What should this additional request do?",
  输出到界面的产物: "Artifacts output to the interface",
  "产物不是世界事实；它只是这次额外请求生成的界面内容。":
    "An artifact is not a world fact; it is interface content generated by this additional request.",
  新增产物: "Add artifact",
  "后置请求至少需要一项产物才能保存为有效预设。":
    "A follow-up request needs at least one artifact before the preset can be saved as valid.",
  高级请求设置: "Advanced request settings",
  稳定标识: "Stable identifier",
  "本次所有产物合计上限（bytes）":
    "Combined limit for all artifacts in this request (bytes)",
  "正在读取产物预览……": "Loading artifact preview…",
  不在页面显示: "Do not display on the page",
  使用哪份内容: "Content to use",
  "这份提示文件不存在；请改选已有内容或到高级文件修复。":
    "This prompt file does not exist. Choose existing content or repair it under Advanced files.",
  " 不在页面显示": " Not displayed on the page",
  删除产物: "Delete artifact",
  产物标识: "Artifact identifier",
  内容格式: "Content format",
  "Markdown 文本": "Markdown text",
  纯文本: "Plain text",
  结构化数据: "Structured data",
  同频道已有内容时: "When the channel already has content",
  替换上一份: "Replace previous item",
  追加一份: "Append an item",
  "按 key 更新": "Update by key",
  仅短暂显示: "Display briefly",
  保存但不显示: "Save without displaying",
  "AI 必须生成这项产物": "The model must generate this artifact",
  高级产物设置: "Advanced artifact settings",
  技术频道地址: "Technical channel address",
  "更新 key": "Update key",
  保存到: "Retain in",
  随权威提交保留: "Keep with the authority commit",
  只保留到本次操作结束: "Keep until this operation ends",
  不持久保存: "Do not persist",
  何时失效: "Expiration",
  下一次操作开始: "When the next operation starts",
  世界端点变化: "When the world endpoint changes",
  本次操作结束: "When this operation ends",
  显式清除: "When explicitly cleared",
  永不自动失效: "Never expire automatically",
  单次最多输出次数: "Maximum outputs per request",
  界面模板: "Interface template",
  使用内置显示: "Use built-in display",
  "模板 revision": "Template revision",
  模板模式: "Template mode",
  静态文档: "Static document",
  "可交互 app": "Interactive app",
  正则处理规则: "Regex processing rules",
  不使用: "None",
  脚本: "Scripts",
  "没有脚本文件。": "No script files.",
  样式与资源: "Styles and resources",
  "没有资源文件。": "No resource files.",
  "当前严格数据格式（只读）": "Current strict data format (read-only)",
  "常用设置无需改它；需要重写完整 contract 时再到高级文件编辑 call-chain.yaml。":
    "Common settings do not require editing this data. Use call-chain.yaml under Advanced files only when replacing the full contract.",
  未命名提示内容: "Untitled prompt content",
  玩家状态: "Player status",
  "当前没有可显示内容。": "There is no content to display.",
  玩家视图面板: "Player-view panels",
  "把世界控制里已经定义好的玩家视图，持续显示在游玩页面。它不调用模型，也不改世界。":
    "Keep player views defined in world control visible on the play page. This does not call a model or change the world.",
  新增玩家视图面板: "Add player-view panel",
  "当前没有玩家视图面板。": "There are no player-view panels.",
  玩家视图: "Player view",
  删除面板: "Delete panel",
  面板标题: "Panel title",
  读取哪个玩家视图: "Player view to read",
  排列方式: "Layout",
  纵向排列: "Vertical",
  网格排列: "Grid",
  没有内容时: "When empty",
  隐藏面板: "Hide panel",
  显示说明: "Show explanation",
  显示空值: "Show empty values",
  空内容说明: "Empty-state explanation",
  高级面板设置: "Advanced panel settings",
  面板稳定标识: "Stable panel identifier",
  技术频道: "Technical channel",
  主题标识: "Theme identifier",
  "只显示这些项目（每行一个，可留空）":
    "Show only these items (one per line; may be empty)",
  分组: "Groups",
  "把已选项目按组显示；每个项目 ID 单独一行。":
    "Display selected items in groups; enter one item ID per line.",
  新分组: "New group",
  新增分组: "Add group",
  分组标题: "Group title",
  分组标识: "Group identifier",
  "项目 ID（每行一个）": "Item IDs (one per line)",
  删除分组: "Delete group",
  完整预设文件: "Complete preset files",
  "常用设置应在前面的表单完成。这里保留完整 YAML、Markdown、HTML、脚本和样式，并说明每份文件负责什么。":
    "Use the earlier forms for common settings. This section keeps complete YAML, Markdown, HTML, scripts, and styles and explains each file's responsibility.",
  "三个核心 YAML 文件的用途": "Purpose of the three core YAML files",
  快速跳转文件: "Quick file navigation",
  玩法预设文件: "Play-preset files",
  玩法预设文件列表: "Play-preset file list",
  完整文件内容: "Complete file content",
  新增高级文件: "Add advanced file",
  "新文件路径（prompt/regex/renderer/script/asset）":
    "New file path (prompt/regex/renderer/script/asset)",
  新增玩法文件路径: "New play-file path",
  加入文件草稿: "Add file to draft",
  预设入口: "Preset entry point",
  "核心 YAML": "Core YAML",
  "连接设定完善提示、调用链、界面显示位置、玩家视图面板和扩展资源；它回答“这份预设由哪些部分组成”。":
    "Connects the setting-improvement prompt, call chain, display locations, player-view panels, and extension resources. It defines the parts of this preset.",
  调用链与产物: "Call chain and artifacts",
  "声明主响应使用哪些叙事提示、结束后有哪些后置请求，以及每个请求可以生成什么产物。":
    "Declares the narrative prompts used by the main response, its follow-up requests, and the artifacts each request can produce.",
  主持规则顺序: "Host-rule order",
  "决定 Runtime 机械说明、主持规则块和世界指令以什么顺序进入稳定 bootstrap。":
    "Determines the order in which Runtime instructions, host-rule blocks, and world instructions enter the stable bootstrap.",
  主持规则: "Host rules",
  "跨世界成立的主持语义；是否发送给模型以及发送顺序由“提示内容”页控制。":
    "Host semantics shared across worlds. The Prompt content page controls whether and in what order they are sent to the model.",
  设定完善提示: "Setting-improvement prompt",
  "约束 AI 怎样理解、规划和创作内容包；工具定义、参数与说明仍由 Runtime 内置。":
    "Constrains how the model understands, plans, and authors a content package. Runtime still owns tool definitions, parameters, and descriptions.",
  调用链提示: "Call-chain prompt",
  "主响应或某个后置请求实际读取的 Markdown 指令；普通编辑可在“调用链”直接修改。":
    "Markdown instructions read by the main response or a follow-up. Edit them directly under Call chain.",
  "把产物内容或玩家视图变成页面上的 HTML 结构。":
    "Turns artifact content or player views into HTML on the page.",
  界面交互脚本: "Interface interaction scripts",
  "为 renderer 添加本地交互；导入预设后默认停用，只有显式信任后才执行。":
    "Adds local interaction to a renderer. Imported scripts are disabled until explicitly trusted.",
  界面样式或资源: "Interface styles or resources",
  扩展资源: "Extension resources",
  "供 renderer 或脚本读取的样式、文字或其他普通资源。":
    "Styles, text, or other regular resources read by a renderer or script.",
  产物文本处理规则: "Artifact text-processing rules",
  "在显示前对产物正文执行有界、可预览的正则处理。":
    "Runs bounded, previewable regex processing on artifact content before display.",
  未命名文件: "Untitled file",
  "随玩法预设保存和导出的普通业务文件。":
    "A regular play file saved and exported with the preset.",
  真实产物预览: "Real artifact preview",
  "保存有效 revision 后可预览产物 contract、regex 与冻结 renderer。":
    "Save a valid revision to preview artifact contracts, regex processing, and frozen renderers.",
  "真实产物预览（只读）": "Real artifact preview (read-only)",
  "样例由当前冻结文件生成；此处不调用模型、不写入世界，只复用生产 regex/renderer 编码。":
    "Samples come from the current frozen files. This preview calls no model, writes no world state, and reuses the production regex and renderer code.",
  "当前预设没有 artifact output contract。":
    "The current preset has no artifact output contract.",
  "raw/document fallback 失败": "Raw/document fallback failed",
  "renderer 预览失败": "Renderer preview failed",
  "内置 renderer 预览失败": "Built-in renderer preview failed",
  "这是当前样例实际显示在游戏页面上的效果；不会调用模型或写入世界。":
    "This is how the current sample actually appears on the play page. It does not call a model or write to the world.",
  "JavaScript 已停用；app 样例仅以 raw/document fallback 显示，不执行作者脚本。":
    "JavaScript is disabled. The app sample uses only the raw/document fallback and does not execute author scripts.",
  页面上的效果: "Appearance on the page",
  "无自定义 renderer；使用内置文本/Markdown/HTML renderer。":
    "No custom renderer; using the built-in text, Markdown, or HTML renderer.",
  无法生成预览: "Unable to generate preview",
  "技术细节：频道、处理规则与产物协议":
    "Technical details: channels, processing rules, and artifact protocol",
  "raw payload 与 emit schema": "Raw payload and emit schema",
  "regex pipeline / 最终内容": "Regex pipeline / final content",
  "emit 后：": "After emit:",
  "）；explicit clear 后：": "); after explicit clear:",
  "触发后：": "After trigger:",
  "app 初始消息（只读协议预览）":
    "Initial app messages (read-only protocol preview)",
  "app preview ready；已发送 render.update。":
    "App preview ready; render.update sent.",
  "等待 app preview ready…": "Waiting for app preview ready…",
  "frame.yaml 无法更新。": "frame.yaml could not be updated.",
  主持规则内容: "Host-rule content",
  "直接阅读和编辑每条跨世界主持规则。启用的规则按顺序进入模型；停用只是不发送，内容仍会随预设保存和导出。":
    "Read and edit each cross-world host rule directly. Enabled rules enter the model in order. Disabled rules are not sent but remain saved and exported with the preset.",
  "frame.yaml 在这里做什么？": "What does frame.yaml do here?",
  "它只保存“哪些主持规则已启用、按什么顺序发送”。你在下方勾选或排序时，页面会同步更新它，不必手写路径。":
    "It stores only which host rules are enabled and their send order. The page updates it when you select or reorder rules; no path editing is needed.",
  "frame.yaml 引用了不存在的块：": "frame.yaml references a missing block:",
  "当前预设还没有主持规则内容。":
    "The current preset has no host-rule content.",
  主持规则列表: "Host-rule list",
  未启用: "Disabled",
  已启用: "Enabled",
  发送给模型: "Send to model",
  上移: "Move up",
  下移: "Move down",
  完整规则内容: "Complete rule content",
  "roles.author_instruction 必须是数组":
    "roles.author_instruction must be an array",
};

Object.assign(englishMessages, playPresetEnglishMessages);

const promptPreviewEnglishMessages: Record<string, string> = {
  "我观察当前场景。": "I observe the current scene.",
  "真实编译已完成；没有调用模型，也没有改变内容或世界。":
    "Real compilation completed without calling a model or changing content or world state.",
  全新上下文会发送什么: "What a new context sends",
  "真实编译，0 次模型调用，不会创建候选或写入权威状态。":
    "Real compilation, zero model calls, and no candidate creation or authority writes.",
  提示词预览: "Prompt Preview",
  "用真实编译器检查全新上下文会发送什么：逻辑 role、Markdown、材料、工具、预算与 Provider 映射。":
    "Use the real compiler to inspect what a new context sends: logical roles, Markdown, material, tools, budgets, and Provider mapping.",
  预览性质: "Preview properties",
  只读检查: "Read-only inspection",
  "0 次模型调用": "Zero model calls",
  不会创建候选或写入权威状态:
    "Does not create candidates or write authority state",
  决定这次检查什么: "Choose what to inspect",
  "内容包首轮 · 全新上下文": "Content-package first turn · new context",
  "还没有内容包。先新建并修好一份内容包，才能编译真实提示词。":
    "There are no content packages. Create and repair one before compiling a real prompt.",
  内容包: "Content package",
  预览内容包: "Content package to preview",
  " · 需要修复": " · needs repair",
  预览玩家输入: "Preview player input",
  "这段原文只进入本次预览，不会写入历史，也不会成为真实玩家行动。":
    "This text enters only the preview. It is not written to history or treated as a real player action.",
  "这份内容包仍需修复；真实首轮预览要求有效的 opening.md、世界文档和控制框架。":
    "This content package still needs repair. A real first-turn preview requires a valid opening.md, world documents, and control frame.",
  "正在编译真实预览…": "Compiling real preview…",
  生成真实预览: "Generate real preview",
  重新生成真实预览: "Regenerate real preview",
  本次固定绑定: "Bindings fixed for this preview",
  主持预设: "Host preset",
  没有当前预设: "No current preset",
  工作区当前选择: "Current workspace selection",
  模型连接: "Model connection",
  没有当前模型: "No current model",
  请先配置并启用模型: "Configure and enable a model first",
  模型窗口: "Model window",
  开场白边界: "Opening-text boundary",
  不作为模型历史注入: "Not injected as model history",
  "opening.md 只保留为玩家可见的 genesis 叙事":
    "opening.md remains only as player-visible genesis narrative",
  玩法预设: "Play preset",
  使用内置玩法的完整工具集合:
    "Use the built-in play preset's complete tool set",
  等待生成预览: "Waiting to generate preview",
  生成后按四个视角检查: "Inspect the result from four perspectives",
  "逻辑消息、材料与工具、Provider 映射、预算与诊断。":
    "Logical messages, material and tools, Provider mapping, and budgets and diagnostics.",
  未知预设: "Unknown preset",
  编译通过: "Compilation passed",
  编译检查结果: "Compilation checks",
  "Runtime 不预估上下文": "Runtime does not estimate context",
  预算可容纳: "Within budget",
  内部字段无泄漏: "No internal-field leakage",
  权威状态未改变: "Authority state unchanged",
  逻辑消息: "Logical messages",
  "稳定 bootstrap": "Stable bootstrap",
  "；另有 1 条玩家追加": "; plus one player append",
  真实工具: "Real tools",
  生产调用链全集: "Complete production call-chain set",
  上下文检查: "Context check",
  所需上下文: "Required context",
  "由 Provider 判断": "Determined by Provider",
  "Runtime 不据此拦截请求": "Runtime does not block requests on this basis",
  窗口配置: "Window configuration",
  窗口占用: "Window usage",
  上下文窗口占用: "Context-window usage",
  预览结果分区: "Preview sections",
  玩法绑定: "Play binding",
  材料与工具: "Material and tools",
  "Provider 映射": "Provider mapping",
  预算与诊断: "Budget and diagnostics",
  首条玩家追加: "First player append",
  "稳定 bootstrap 之后，玩家原文作为普通 user 消息原样追加。":
    "After the stable bootstrap, the player's original text is appended unchanged as a regular user message.",
  玩法绑定与调用链工具: "Play binding and call-chain tools",
  "· 叙事规则进入稳定 bootstrap， 后置请求在主调用链完成后独立派发。":
    "· Narrative rules enter the stable bootstrap; follow-up requests are dispatched independently after the main call chain.",
  玩法文件: "Play files",
  "冻结工具、叙事规则与后置产物契约":
    "Frozen tools, narrative rules, and follow-up artifact contracts",
  工具全集: "Complete tool set",
  "Provider 工具策略": "Provider tool strategy",
  "definitions：稳定全集": "Definitions: stable complete set",
  稳定前缀: "Stable prefix",
  频道挂载: "Channel mounts",
  无: "None",
  "全新上下文发送这份稳定前缀；玩家原文随后作为普通消息追加。Runtime 不再插入裁决、叙事或结算 delta。":
    "A new context sends this stable prefix, then appends the player's original text as a regular message. Runtime no longer inserts adjudication, narrative, or settlement deltas.",
  条逻辑消息: "logical message(s)",
  "调用链可用工具：": "Call-chain tools:",
  "· 后置请求：": "· Follow-up requests:",
  "这次编译没有逻辑消息。": "This compilation has no logical messages.",
  "逻辑消息与最终 Markdown": "Logical messages and final Markdown",
  "这里先保留产品逻辑 role；Provider 如何映射在下一分区单独展示。":
    "This view preserves product-level logical roles. The next section shows how Provider mapping changes them.",
  逻辑消息顺序: "Logical-message order",
  块: "blocks",
  字符: "characters",
  消息块来源: "Message-block sources",
  "最终 Markdown 正文": "Final Markdown body",
  块之间已按真实编译顺序合并: "Blocks merged in the real compilation order",
  材料覆盖与调用链工具: "Material coverage and call-chain tools",
  "来源由真实 slot 展开；未提供边界和可继续读取入口不会被隐藏。":
    "Sources are expanded from real slots. Missing boundaries and continuation entries remain visible.",
  "Slot 覆盖": "Slot coverage",
  项: "items",
  来源完整: "Source complete",
  来源尚未完整: "Source incomplete",
  无需继续读取: "No further read needed",
  本次真实工具: "Real tools in this request",
  "本次没有按需读取工具。": "This request has no on-demand read tools.",
  个: "total",
  "查看说明与 input schema": "View description and input schema",
  "Provider 映射 ·": "Provider mapping ·",
  "展示编译器交给当前 Adapter 的真实 system 块和消息顺序。":
    "Shows the real system blocks and message order passed from the compiler to the current adapter.",
  消息角色与顺序: "Message roles and order",
  "条 bootstrap": "bootstrap message(s)",
  " + 1 条玩家追加": " + one player append",
  "紧随 bootstrap 的首条追加": "First append after bootstrap",
  原样发送: "Sent unchanged",
  "查看 Provider 映射原始结构": "View raw Provider mapping",
  消息正文: "Message body",
  工具定义: "Tool definitions",
  本地输出预留: "Local output reserve",
  本地尾部预留: "Local tail reserve",
  安全余量: "Safety margin",
  "Runtime 不估算上下文，也不会据此拒绝 Provider 请求。":
    "Runtime does not estimate context and never rejects a Provider request on that basis.",
  "所有数值来自本次真实编译结果，不由 Web 重新估算。":
    "All values come from this real compilation and are not re-estimated by the web app.",
  上下文预算: "Context budget",
  可容纳: "Fits",
  "Provider 窗口配置": "Provider window configuration",
  "合计 / 模型窗口": "Total / model window",
  "估算器：": "Estimator:",
  稳定前缀与缓存: "Stable prefix and cache",
  "稳定前缀 fingerprint": "Stable-prefix fingerprint",
  缓存断点: "Cache breakpoint",
  首个动态边界: "First dynamic boundary",
  内部字段泄漏扫描通过: "Internal-field leakage scan passed",
  "Runtime 生成正文未发现以下内部字段。":
    "No listed internal fields were found in Runtime-generated prose.",
  查看固定诊断绑定与完整原始结果:
    "View fixed diagnostic bindings and the complete raw result",
  真实提示词编译失败: "Real prompt compilation failed",
};

Object.assign(englishMessages, promptPreviewEnglishMessages);

const settingImprovementEnglishMessages: Record<string, string> = {
  "例如：秦龙的动机再具体一点，别改开场白。":
    "For example: Make Alex's motivation more specific, but do not change the opening.",
  本次生成进度: "Generation progress",
  正在生成创作计划: "Generating creation plan",
  正在生成候选: "Generating candidate",
  第: "Round",
  轮: "",
  "正在建立连接…": "Connecting…",
  工具调用: "Tool calls",
  "Provider 派发": "Provider dispatches",
  自检未通过: "Failed checks",
  协议错误: "Protocol errors",
  正在写: "Writing",
  思考中: "Reasoning",
  正文: "Text",
  "最近自检：": "Latest check:",
  已有: "No output for",
  "秒没有收到任何输出，模型调用可能已经卡住。":
    "seconds; the model call may be stuck.",
  "AI 设定完善": "Setting improvement",
  "AI 会基于当前树完善设定：可以先只读现有文件并确认计划，也可以直接生成隔离候选。 只有最后整批应用才会替换当前内容包；已有世界不会改变。":
    "The model can improve the current tree by first reading files and proposing a plan, or by generating an isolated candidate directly. Only applying the whole candidate replaces the content package; existing worlds remain unchanged.",
  当前内容包: "Current content package",
  正在完善: "Improving",
  可用于创建世界: "Ready to create a world",
  需要修复: "Needs repair",
  设定完善进度: "Setting-improvement progress",
  描述目标: "Describe the goal",
  说清想获得的体验: "Describe the desired experience",
  可选计划: "Optional plan",
  只读现有设定后确认方向: "Read the current setting, then confirm direction",
  审阅并应用: "Review and apply",
  核对完整差异与提示词: "Inspect the complete diff and prompt",
  "当前创作会话及直接注入文件已固定。应用或放弃前，手动编辑、上下文选择和内容包切换会暂时停用。":
    "The current authoring session and directly injected files are frozen. Manual editing, context selection, and content-package switching stay disabled until the candidate is applied or discarded.",
  需要先连接模型: "Connect a model first",
  "创作计划和候选文件都由当前模型生成。":
    "The current model generates the creation plan and candidate files.",
  配置模型连接: "Configure model connection",
  "第 1 步": "Step 1",
  "这次想把设定完善成什么样？": "How should this setting be improved?",
  "写玩家最终会感受到什么、哪里薄弱、哪些内容不要改。无需描述文件名或技术格式。":
    "Describe what players should feel, what is weak, and what must not change. You do not need file names or technical formats.",
  设定完善目标: "Setting-improvement goal",
  "例如：我想让学院生活更有日常节奏。补足室友之间的目标与矛盾，保留轻松基调，不增加数值化好感度，也不要预写未来剧情。":
    "For example: Give academy life a stronger everyday rhythm. Add goals and conflicts between roommates, keep the light tone, do not add numeric affinity, and do not prewrite future plot.",
  目标示例: "Goal examples",
  "可以这样写：": "Try one of these:",
  "正在生成创作计划…": "Generating creation plan…",
  生成可见创作计划: "Generate visible creation plan",
  "正在直接生成候选…": "Generating candidate directly…",
  "跳过计划，直接生成候选": "Skip plan and generate candidate",
  "计划阶段只能读取；直接生成也仍需在最后审阅并整批应用。":
    "The planning phase is read-only. A directly generated candidate still requires final review and whole-candidate application.",
  创作目标已提交: "Authoring goal submitted",
  方向已提交: "Direction submitted",
  "第 2 步": "Step 2",
  "确认 AI 理解的创作方向": "Confirm the model's understanding",
  "这里仍然只是计划。AI 已可只读当前树，但确认前不能修改；若方向不对，放弃后修改目标。":
    "This is still only a plan. The model can read the current tree but cannot modify it before confirmation. If the direction is wrong, discard it and change the goal.",
  "正在生成并检查候选…": "Generating and checking candidate…",
  确认计划并生成候选: "Confirm plan and generate candidate",
  放弃整批候选: "Discard whole candidate",
  "让 AI 调整计划": "Ask the model to revise the plan",
  "方向不对时不必放弃重来：写下要改什么，AI 会在同一次会话里重出完整计划。":
    "If the direction is wrong, describe the correction instead of starting over. The model will produce a complete revised plan in the same session.",
  "正在重新规划…": "Replanning…",
  按意见重出计划: "Regenerate plan from feedback",
  创作计划已确认: "Creation plan confirmed",
  已确认: "Confirmed",
  "第 2 步 · 可选": "Step 2 · optional",
  已跳过可见计划: "Visible plan skipped",
  "本次按你的目标直接生成候选，仍需审阅完整差异后才能应用。":
    "This candidate was generated directly from your goal and still requires review of the complete diff before application.",
  "AI 的起点": "Model starting point",
  当前设定: "Current setting",
  个文件: "files",
  "计划阶段可通过只读工具查看整棵已保存当前树；勾选的文本文件会额外完整注入首个模型请求。":
    "Read-only tools can inspect the entire saved tree during planning. Selected text files are additionally injected in full into the first model request.",
  手动编辑尚未保存: "Manual edits are not saved",
  "这些修改不会进入 AI 候选；请先返回手动编辑并整批保存。":
    "These changes will not enter the model candidate. Return to manual editing and save the whole draft first.",
  当前设定文件统计: "Current setting file counts",
  开场白: "Opening text",
  世界内容: "World content",
  控制文件: "Control files",
  "直接注入给 AI": "Inject directly into the model",
  "适合指定本次完善必须先看到的核心人物、规则或当前情境。":
    "Use this for core characters, rules, or the current situation that this session must see first.",
  全选文本文件: "Select all text files",
  清空注入: "Clear injected files",
  "当前内容包还没有文件。": "The current content package has no files.",
  筛选文件: "Filter files",
  "例如 characters 或 frame": "For example, characters or frame",
  当前设定文件: "Current setting files",
  "没有匹配的文件。": "No files match.",
  开场: "Opening",
  世界: "World",
  控制: "Control",
  二进制: "Binary",
  注入: "Inject",
  "这是二进制资源，内容不在此处展开。":
    "This is a binary resource; its content is not expanded here.",
  "第 3 步": "Step 3",
  "审阅候选，再决定是否应用": "Review the candidate before applying",
  机械检查通过: "Mechanical checks passed",
  候选需要修复: "Candidate needs repair",
  候选摘要: "Candidate summary",
  文件变化: "File changes",
  新建: "Create",
  修改: "Update",
  删除: "Delete",
  机械检查诊断: "Mechanical-check diagnostics",
  完整文件差异: "Complete file diff",
  "逐个展开检查；这里显示的就是整批应用将替换的内容。":
    "Expand each item to inspect exactly what applying the whole candidate will replace.",
  "AI 没有改动任何文件。": "The model did not change any files.",
  应用前: "Before",
  应用后: "After",
  这是一次整批替换: "This is a whole-candidate replacement",
  "不能只勾选部分文件。放弃会丢弃整个隔离候选，当前内容包保持不变。":
    "Individual files cannot be selected. Discarding removes the entire isolated candidate and leaves the current content package unchanged.",
  "正在整批应用…": "Applying whole candidate…",
  整批应用候选: "Apply whole candidate",
  "正在放弃…": "Discarding…",
  "让 AI 继续改这份候选": "Ask the model to revise this candidate",
  "只有一两处不满意时不必整批放弃：写下要改什么，AI 会在当前候选上接着改，已经对的部分保留。":
    "If only a few parts are wrong, describe the corrections instead of discarding everything. The model will continue from the current candidate and preserve what already works.",
  "正在修改候选…": "Revising candidate…",
  按意见继续修改: "Continue revision from feedback",
  真实提示词预览: "Real Prompt Preview",
  "候选已通过和真实请求同源的编译检查。":
    "The candidate passed the same compilation checks used by a real request.",
  无内部字段泄漏: "No internal-field leakage",
  模型: "Model",
  逻辑消息: "Logical messages",
  工具: "Tools",
  上下文检查: "Context check",
  预算: "Budget",
  "由 Provider 判断": "Determined by Provider",
  查看逻辑消息正文: "View logical message bodies",
  查看材料覆盖与预算: "View material coverage and budget",
  来源: "Source",
  状态: "Status",
  查看真实工具定义: "View real tool definitions",
  "查看最终 Provider 请求结构": "View final Provider request structure",
};

Object.assign(englishMessages, settingImprovementEnglishMessages);

const worldFrameEnglishMessages: Record<string, string> = {
  可视化编排: "Visual arrangement",
  世界提示框架: "World prompt frame",
  "安排世界专属指令与确定性材料位置；这里不保存人物、地点或当前事实。":
    "Arrange world-specific instructions and deterministic material locations. Characters, places, and current facts are not stored here.",
  世界提示框架草稿状态: "World prompt-frame draft status",
  "V1 格式": "V1 format",
  格式待修复: "Format needs repair",
  可视化已同步: "Visual editor synchronized",
  "仅可编辑 YAML": "YAML editing only",
  "当前 YAML 暂时无法可视化": "Current YAML cannot be visualized yet",
  "下面的高级编辑器会原样保留草稿；修复后可视化页面会自动恢复。":
    "The advanced editor below preserves the draft exactly. The visual editor returns automatically after repair.",
  "format 不是当前世界框架版本":
    "format is not the current world-frame version",
  "Runtime 只接受": "Runtime accepts only",
  "修复为 V1 格式": "Repair as V1 format",
  世界提示框架流程: "World prompt-frame flow",
  "Markdown 提示块": "Markdown prompt blocks",
  份世界指令: "world instruction(s)",
  "进入逻辑 role": "Enter logical role",
  精确文档与目录: "Exact documents and directories",
  个材料插槽: "material slot(s)",
  "01 · 权威绑定": "01 · authority binding",
  当前情境绑定: "Current-situation binding",
  未解析: "Unresolved",
  已解析: "Resolved",
  "`current_situation` 插槽会从这里读取唯一当前情境文档，不按文件名或标题猜测。":
    "The `current_situation` slot reads the one current-situation document bound here; it never guesses from a file name or title.",
  当前情境文档: "Current-situation document",
  选择一份世界文档: "Choose a world document",
  "（当前未解析）": "(currently unresolved)",
  "02 · 世界专属指令": "02 · world-specific instructions",
  提示块顺序: "Prompt-block order",
  个块: "blocks",
  "这些 Markdown 块按顺序进入主持预设预留的世界指令位置；正文仍在独立文件中编辑。":
    "These Markdown blocks enter the host preset's world-instruction position in order. Their bodies remain editable in separate files.",
  世界指令顺序: "World-instruction order",
  引用的文件不存在: "Referenced file does not exist",
  调整顺序: "Reorder",
  上移: "Move up",
  下移: "Move down",
  移除: "Remove",
  "尚未加入世界提示块。": "No world prompt blocks have been added.",
  "要加入的 Markdown 块": "Markdown block to add",
  没有可加入的未引用块: "No unreferenced blocks are available",
  加入指令顺序: "Add to instruction order",
  "03 · 确定性材料": "03 · deterministic material",
  上下文材料顺序: "Context-material order",
  个插槽: "slots",
  "Runtime 只按这些精确位置取材。顺序会进入真实 prompt，但不会推断“相关人物”或“重要历史”。":
    "Runtime reads material only from these exact locations. The order enters the real prompt, but Runtime never infers related characters or important history.",
  从上到下就是实际注入顺序: "Top to bottom is the real injection order",
  "每张卡片右上角都有“上移 / 下移”；移动后序号会立即更新。":
    "Use Move up or Move down on each card. Sequence numbers update immediately.",
  必需插槽还未成对: "Required slots are not paired yet",
  当前情境: "Current situation",
  "个 · 附加材料": " · additional material",
  个: "total",
  补上当前情境: "Add current situation",
  补上附加材料: "Add additional material",
  新增材料类型: "Add material type",
  新增材料插槽: "Add material slot",
  "高级：直接编辑 frame.yaml": "Advanced: edit frame.yaml directly",
  "可视化修改会把 YAML 重新整理为稳定格式；需要修复未知字段或保留当前原文时可在这里编辑。":
    "Visual changes rewrite YAML into a stable format. Edit here to repair unknown fields or preserve the current source exactly.",
  "直接编辑 control/frame.yaml": "Edit control/frame.yaml directly",
  调整注入顺序: "Change injection order",
  "YAML 路径": "YAML path",
  "Markdown 标题路径": "Markdown heading path",
  "选择实际 YAML 文件": "Choose an actual YAML file",
  历史消息句柄: "History-message handle",
  选择实际文档文件: "Choose an actual document file",
  "只列出内容包中带可识别 $document 技术头的实际文件。":
    "Only actual files with a recognizable $document technical header are listed.",
  选择实际世界目录: "Choose an actual world directory",
  "（当前没有可关联文档）": "(no documents can be associated)",
  份文档: "documents",
  "只列出当前内容包内确实包含可识别文档的目录。":
    "Only directories that actually contain recognizable documents in this content package are listed.",
  "先选择来源 YAML 文件": "Choose the source YAML file first",
  "当前手动路径：": "Current manual path:",
  "（未解析）": "(unresolved)",
  列表: "List",
  对象: "Object",
  " 个 $ref": " $ref value(s)",
  "当前无 $ref": "No $ref values",
  "选择 YAML 文件后，这里会解析其中可持久定位的对象和列表。":
    "After choosing a YAML file, persistently addressable objects and lists are resolved here.",
  " 已解析 ": " Resolved ",
  " 个可选节点，其中 ": " selectable nodes, of which ",
  " 个当前包含 $ref。": " currently contain $ref.",
  "高级：手动填写字段路径": "Advanced: enter field path manually",
  "每行一个层级；留空表示文档根":
    "One level per line; blank means document root",
  缺失时阻止请求: "Block request when missing",
  "关闭后，目标暂时不存在时会明确略过。":
    "When disabled, a temporarily missing target is explicitly skipped.",
  不是可视化编辑器支持的列表形状:
    "The list shape is not supported by the visual editor",
  "可在高级 YAML 中修复，或明确重置为空列表后重新编排。":
    "Repair it in advanced YAML, or explicitly reset it to an empty list and arrange it again.",
  重置: "Reset",
  "frame.yaml 顶层必须是 YAML map。":
    "The top level of frame.yaml must be a YAML map.",
  "YAML 无法解析。": "YAML could not be parsed.",
  "整份 YAML": "Whole YAML document",
  "先在 world/ 的子目录中创建带 $document 技术头的文档。":
    "Create a document with a $document technical header in a world/ subdirectory first.",
  "先创建一份带 $document 技术头的 YAML 世界文档。":
    "Create a YAML world document with a $document technical header first.",
  "先创建一份带 $document 技术头的世界文档。":
    "Create a world document with a $document technical header first.",
  "从上方绑定读取紧接着的叙事不能忘记的短期局面。":
    "Read the short-term situation that immediately following narrative must not forget from the binding above.",
  附加材料: "Additional material",
  "展开当前端点为全新上下文保存的完整精确材料清单。":
    "Expand the complete exact material list saved at the current endpoint for a new context.",
  整份文档: "Whole document",
  "精确加入一份世界文档。": "Include one world document exactly.",
  文档局部节点: "Document node",
  "精确加入 YAML 路径或 Markdown 标题子树。":
    "Include a YAML path or Markdown heading subtree exactly.",
  有界目录: "Bounded directory",
  "列出一级目录中的标题、简介和短引用，不展开正文。":
    "List titles, summaries, and short references in one directory level without expanding bodies.",
  显式引用目标: "Explicit reference target",
  "读取 YAML 节点中的 $ref，并加入一层目标文档。":
    "Read a $ref from a YAML node and include one level of target documents.",
  最近叙事: "Recent narrative",
  "带上最近几条已提交玩家／主持原文；没有此前叙事时会明确标为空，调用链据此延续未写入文档的细节。":
    "Include recent committed player and host messages. With no earlier narrative, the slot is explicitly empty so the call chain can continue details not written into documents.",
  精确历史消息: "Exact history message",
  "按 Runtime 句柄加入一条已提交叙事。":
    "Include one committed narrative message by Runtime handle.",
  未知插槽: "Unknown slot",
  "当前可视化编辑器不识别此类型；可移动、移除或在 YAML 中修复。":
    "The visual editor does not recognize this type. Move or remove it, or repair it in YAML.",
};

Object.assign(englishMessages, worldFrameEnglishMessages);

const worldPageEnglishMessages: Record<string, string> = {
  衣着: "Clothing",
  "正在从当前世界重新拼接上下文…": "Rebuilding context from the current world…",
  "正在把玩家输入追加到现有上下文…":
    "Appending player input to the existing context…",
  "正在原样发送上次未完成的模型请求…":
    "Resending the previous incomplete model request unchanged…",
  "正在沿现有上下文继续生成…": "Continuing from the existing context…",
  "正在取消模型生成…": "Cancelling model generation…",
  "模型生成已取消。": "Model generation cancelled.",
  生成已取消: "Generation cancelled",
  "本轮生成已停止；已提交的玩家原文保留，未完成的模型输出不会进入故事。":
    "This generation was stopped. The committed player message is preserved, and incomplete model output will not enter the story.",
  "模型调用已经结束，正在刷新结果…":
    "The model call has already ended; refreshing the result…",
  模型调用失败: "Model call failed",
  "模型请求中断；清空输入后点击追加上下文即可原样发送上次请求。":
    "The model request was interrupted. Clear the input and append context to resend the previous request unchanged.",
  "调用链处理失败；旧请求不能重发，请使用全新上下文。":
    "Call-chain processing failed. The old request cannot be resent; start a new context.",
  "AI 已沿现有上下文继续生成，没有追加玩家指令。":
    "The model continued from the existing context without appending a player instruction.",
  "调用链已返回；模型完成的叙事和世界变化已经分别提交。":
    "The call chain returned. Completed narrative and world changes were committed separately.",
  "控制草稿已通过真实提示词预览；确认后才会整批应用。":
    "The control draft passed a real Prompt Preview and will be applied as a whole only after confirmation.",
  "世界控制已整批应用。": "World control was applied as a whole.",
  "修正草稿已预览；应用前世界状态没有变化。":
    "The correction draft was previewed. World state remains unchanged until application.",
  "连续性修正已作为一笔新提交应用，旧历史保持不变。":
    "The continuity correction was applied as a new commit; previous history remains unchanged.",
  "修正草稿已放弃，世界端点没有推进。":
    "The correction draft was discarded and the world endpoint did not advance.",
  "修改后的玩家提交不能为空。": "The edited player message cannot be empty.",
  "正在当前世界中保存修改，并舍弃这条消息之后的当前时间线…":
    "Saving the edit in the current world and leaving the later current timeline behind…",
  "修改已保存在当前世界；配置模型后点击“追加上下文”即可继续生成。":
    "The edit was saved in the current world. After configuring a model, append context to continue generation.",
  "修改已保存，正在从修改稿继续生成…":
    "Edit saved; continuing from the edited message…",
  "修改已保存，但模型请求中断；点击“追加上下文”即可原样重发。":
    "The edit was saved, but the model request was interrupted. Append context to resend it unchanged.",
  "修改已保存，但模型请求失败；请使用全新上下文继续。":
    "The edit was saved, but the model request failed. Continue with a new context.",
  "修改已保存在当前世界，并已从修改稿继续。":
    "The edit was saved in the current world and play continued from it.",
  "世界名称已保存。": "World name saved.",
  "← 返回工作区": "← Back to workspace",
  "正在打开世界…": "Opening world…",
  工作区: "Workspace",
  正在游玩的世界: "World in play",
  世界概况: "World overview",
  条已提交消息: "committed messages",
  条已加载叙事: "loaded narrative messages",
  模型调用中: "Model call in progress",
  调用链已中断: "Call chain interrupted",
  世界已保存: "World saved",
  世界页面: "World page",
  游玩: "Play",
  当前文档: "Current documents",
  已提交叙事: "Committed narrative",
  世界管理: "World management",
  世界游玩: "World play",
  本次模型调用进度: "Current model-call progress",
  "正在建立调用…": "Establishing the model call…",
  "已运行 {seconds} 秒": "Running for {seconds} seconds",
  尚未收到模型数据: "No model data received yet",
  刚刚收到新数据: "New data received just now",
  "{seconds} 秒没有新数据": "No new data for {seconds} seconds",
  返回推理: "Returned reasoning",
  工具参数: "Tool arguments",
  "{count} 字": "{count} characters",
  "Provider 尚未返回可区分的增量；这可能是排队、模型内部思考或网络等待。":
    "The Provider has not returned a distinguishable delta yet; it may be queued, thinking internally, or waiting on the network.",
  "已有 {seconds} 秒没有收到任何新数据，模型调用可能已经卡住；你可以继续等待或取消。":
    "No new data has arrived for {seconds} seconds. The model call may be stuck; you can keep waiting or cancel it.",
  "正在准备模型请求…": "Preparing the model request…",
  "正在等待模型响应…": "Waiting for the model response…",
  "思考中（正在接收 Provider 返回推理）":
    "Reasoning (receiving Provider-returned reasoning)",
  "正在输出正文…": "Streaming response text…",
  "正在处理工具调用…": "Processing tool calls…",
  "正在生成界面产物…": "Generating interface artifacts…",
  "正在取消…": "Cancelling…",
  取消生成: "Cancel generation",
  故事: "Story",
  模型响应中: "Model responding",
  调用链记录: "Call-chain record",
  "正在加载…": "Loading…",
  加载更早的故事: "Load earlier story",
  加载更早的已提交叙事: "Load earlier committed narrative",
  全新上下文从这里开始: "A new context begins here",
  故事还没有开始: "The story has not started",
  "描述你的行动，从当前世界开始一条调用链。":
    "Describe your action to start a call chain from the current world.",
  "需要先配置模型连接才能游玩。":
    "Configure a model connection before playing.",
  配置模型: "Configure model",
  "上次模型请求没有完整返回。保持输入框为空并点击“追加上下文”，就会原样发送已保存的请求；不会追加玩家指令，中断片段也不会进入模型上下文。":
    "The previous model request did not return completely. Leave the input empty and append context to resend the saved request unchanged. No player instruction is appended, and the interrupted fragment does not enter model context.",
  你的行动: "Your action",
  "描述你的行动；也可以留空并追加，让 AI 沿现有上下文续写…":
    "Describe your action, or leave it blank and append to let the model continue from existing context…",
  "Ctrl / ⌘ + Enter 追加；没有上下文时自动全新开始":
    "Ctrl / ⌘ + Enter appends; without context it starts a new one",
  "正在开始…": "Starting…",
  全新上下文: "New context",
  "正在追加…": "Appending…",
  追加上下文: "Append context",
  玩家视图: "Player view",
  当前情景: "Current situation",
  "这个世界还没有配置常驻玩家视图。":
    "This world has no persistent player view configured.",
  "你仍然可以正常游玩；未显示不代表秘密。":
    "You can still play normally; not being shown does not make something secret.",
  项视图诊断: "view diagnostics",
  份世界状态文件: "world-state files",
  "当前世界没有状态文档。": "The current world has no state documents.",
  "这里只显示已经进入世界权威的玩家与主持原文。":
    "Only original player and host messages committed into world authority appear here.",
  "尚无已提交叙事。": "No committed narrative yet.",
  "这些操作位于故事之外；它们不会被普通游玩 AI 擅自执行。":
    "These actions happen outside the story and cannot be performed unprompted by the regular play model.",
  世界名称: "World name",
  "这是工作区和世界页显示的名字；修改它不会改动故事、状态或历史。":
    "This name appears in the workspace and world page. Changing it does not alter story, state, or history.",
  世界显示名称: "World display name",
  "正在保存…": "Saving…",
  保存名称: "Save name",
  从此刻创建分叉: "Fork from this point",
  "复制当前状态和截至此刻的已提交叙事，得到一个完全独立的新世界。":
    "Copy current state and committed narrative through this point into a completely independent world.",
  "正在创建…": "Creating…",
  创建分叉: "Create fork",
  世界控制: "World control",
  "编辑主持框架和玩家视图。草稿必须先通过真实提示词预览，再整批应用。":
    "Edit the host frame and player views. The draft must pass a real Prompt Preview before it can be applied as a whole.",
  有尚未预览的修改: "Changes have not been previewed",
  当前已应用控制: "Current control applied",
  "模型调用尚未返回；完成或中断后才能应用新控制。":
    "The model call has not returned. New control can be applied after it completes or is interrupted.",
  "世界控制文件（JSON）": "World-control files (JSON)",
  世界控制文件: "World-control files",
  "正在预览…": "Previewing…",
  预览世界控制: "Preview world control",
  "正在应用…": "Applying…",
  整批应用世界控制: "Apply all world-control changes",
  查看真实提示词预览结果: "View real Prompt Preview result",
  连续性修正: "Continuity correction",
  "在故事之外修正当前文档。修正会追加一笔新提交，不会改写旧叙事。":
    "Correct current documents outside the story. A correction appends a new commit and does not rewrite earlier narrative.",
  要修正的文档: "Document to correct",
  "YAML 路径": "YAML path",
  "例如：衣着 或 关系.秦龙.好感":
    "For example: clothing or relationships.Alex.trust",
  新值: "New value",
  修正后的新值: "Corrected value",
  预览整笔修正: "Preview complete correction",
  取消修正草稿: "Cancel correction draft",
  运行详情: "Runtime details",
  "用于排查本地恢复问题，不参与普通游玩。":
    "Used to diagnose local recovery issues; not part of normal play.",
  当前端点: "Current endpoint",
  "世界 ID": "World ID",
  "查看 Runtime 原始诊断": "View raw Runtime diagnostics",
  你: "You",
  主持: "Host",
  未结算: "Unsettled",
  模型调用链: "Model call chain",
  本上下文已提交的世界变化: "World changes committed in this context",
  没有文档变化: "No document changes",
  新建: "Create",
  更新: "Update",
  玩家: "Player",
  修改: "Edit",
  修改后的行动: "Edited action",
  "修改会直接保存在当前世界；这条原提交及其后的内容会离开当前时间线，但旧 Authority 记录仍可恢复。":
    "The edit is saved directly in the current world. The original message and later content leave the current timeline, while the old Authority records remain recoverable.",
  保存修改并继续: "Save edit and continue",
  取消: "Cancel",
  "AI 响应": "Model response",
  模型工具步骤: "Model tool step",
  空模型响应: "Empty model response",
  "查看工具步骤文本（未进入故事）":
    "View tool-step text (not part of the story)",
  "（本次响应只调用了工具）": "(This response only called tools)",
  "待定输出；响应完成前不会进入故事":
    "Pending output; it does not enter the story before the response completes",
  "· 第": "· dispatch",
  次派发: "",
  模型思维链: "Model reasoning",
  "Provider 返回推理（不等同隐藏思维链）":
    "Provider-returned reasoning (not hidden chain of thought)",
  默认折叠: "Collapsed by default",
  "正在接收模型输出…": "Receiving model output…",
  "（本次响应没有文本）": "(This response has no text)",
  查看模型诊断详情: "View model diagnostic details",
  响应完成后可查看模型诊断详情:
    "Model diagnostic details are available after the response completes",
  正在接收的工具调用片段: "Incoming tool-call fragments",
  "Provider usage：输入": "Provider usage: input",
  "· 输出": "· output",
  调用: "Call",
  "复用同 ID 结果": "Reused result with same ID",
  返回: "Result",
  成功: "Success",
  "拒绝／失败": "Rejected / failed",
  "后置请求 ·": "Follow-up request ·",
  未完成: "Incomplete",
  调用链中断: "Call chain interrupted",
  等待玩家追加: "Waiting for player append",
  上下文已结束: "Context ended",
  接收中: "Receiving",
  中断片段: "Interrupted fragment",
  已完成: "Complete",
  "[参数无法序列化]": "[Arguments could not be serialized]",
  "当前没有可显示项目。": "There are no items to display.",
  "[无法显示]": "[Unable to display]",
  操作失败: "Operation failed",
};

Object.assign(englishMessages, worldPageEnglishMessages);

const dynamicEnglishMessages: Record<string, string> = {
  开场: "Opening",
  控制: "Control",
  其他资源: "Other assets",
  "打开 {path}": "Open {path}",
  "文件编辑器：{path}": "File editor: {path}",
  "编辑 {path}": "Edit {path}",
  "$document:\n  id: character.example\n  ref: example\n  title: 示例人物\n  summary: 一句话稳定简介。\n  aliases: []\n":
    "$document:\n  id: character.example\n  ref: example\n  title: Example character\n  summary: A one-sentence stable summary.\n  aliases: []\n",
  "---\n$document:\n  id: rule.example\n  ref: example\n  title: 示例规则\n  summary: 一句话稳定简介。\n  aliases: []\n---\n\n# 示例规则\n":
    "---\n$document:\n  id: rule.example\n  ref: example\n  title: Example rule\n  summary: A one-sentence stable summary.\n  aliases: []\n---\n\n# Example rule\n",
  "{count} 个世界": "{count} world(s)",
  "打开世界：{title}": "Open world: {title}",
  "重命名世界：{title}": "Rename world: {title}",
  "删除世界：{title}": "Delete world: {title}",
  "{count} 份": "{count} package(s)",
  " · {count} 份待修复": " · {count} need repair",
  "{count} 份内容包": "{count} content package(s)",
  "{count} 份可用": "{count} ready",
  "打开内容包：{name}": "Open content package: {name}",
  默认模型: "Default model",
  "已从当前端点拉取 {count} 个模型 ID。":
    "Fetched {count} model ID(s) from the current endpoint.",
  "叙事规则、后置请求与工具契约":
    "Narrative rules, follow-ups, and tool contracts",
  "AI 创作方法；工具契约保持内置":
    "Model authoring method; tool contracts remain built in",
  设定完善: "Setting improvement",
  界面扩展: "Interface extensions",
  "频道挂载、面板与扩展引用":
    "Channel mounts, panels, and extension references",
  提示内容: "Prompt content",
  "阅读、编辑并排序主持规则块": "Read, edit, and order host rule blocks",
  高级文件: "Advanced files",
  带用途说明的完整源文件: "Complete source files with purpose notes",
  产物预览: "Artifact preview",
  "冻结 contract 与 renderer 的真实预览":
    "Real preview of frozen contracts and renderers",
  "已复制推荐{name}；所有文件均可编辑。":
    "Copied the recommended {name}; every file is editable.",
  "{name} 显示位置": "{name} display location",
  "叙事规则 {index}": "Narrative rule {index}",
  "删除叙事提示块 {index}": "Delete narrative prompt block {index}",
  "后置请求 {index} 显示名": "Follow-up {index} display name",
  "后置请求 {index} 标识": "Follow-up {index} identifier",
  "删除后置请求 {id}": "Delete follow-up {id}",
  剧情内容区: "Story area",
  跟随剧情正文显示: "Displayed with the story",
  右侧栏: "Sidebar",
  适合持续状态面板: "Suitable for persistent status panels",
  输入框上方: "Above composer",
  适合行动建议或临时提示: "Suitable for action suggestions or temporary notes",
  输入框下方: "Below composer",
  适合不打断输入的辅助内容:
    "Suitable for supporting content that does not interrupt input",
  浮层: "Overlay",
  覆盖在游玩页面上方: "Displayed over the play page",
  调试区: "Debug area",
  只用于检查原始产物: "Only for inspecting raw artifacts",
  "{label} 内容": "{label} content",
  "编辑提示内容 {path}": "Edit prompt content {path}",
  "{name} 产物标识": "{name} artifact identifier",
  "{name} 内容格式": "{name} content format",
  "{name} 更新方式": "{name} update strategy",
  "{name} 技术频道": "{name} technical channel",
  "{name} 脚本": "{name} scripts",
  "{name} 资源": "{name} assets",
  "玩家视图面板 {index} 标题": "Player-view panel {index} title",
  "玩家视图面板 {index} 视图": "Player-view panel {index} view",
  "玩家视图面板 {index} 显示位置": "Player-view panel {index} display location",
  "玩家视图面板 {index} 脚本": "Player-view panel {index} scripts",
  "玩家视图面板 {index} 资源": "Player-view panel {index} assets",
  "打开玩法文件 {path}": "Open play-preset file {path}",
  "编辑玩法文件 {path}": "Edit play-preset file {path}",
  "产物预览 {request}/{output}": "Artifact preview {request}/{output}",
  "产物预览 {id}": "Artifact preview {id}",
  "frame.yaml 无法更新：{message}": "Could not update frame.yaml: {message}",
  "启用顺序 {index}": "Enabled order {index}",
  "停用 {path}": "Disable {path}",
  "启用 {path}": "Enable {path}",
  "上移 {path}": "Move {path} up",
  "下移 {path}": "Move {path} down",
  "编辑提示块内容 {path}": "Edit prompt-block content {path}",
  "Runtime 系统": "Runtime system",
  "权威、真实工具与提交边界，由 Runtime 固定提供。":
    "Authority, real tools, and commit boundaries are fixed by the Runtime.",
  创作指令: "Author instructions",
  "当前主持预设、世界专属创作政策与玩法叙事规则。":
    "The current host preset, world-specific authoring policy, and play narrative rules.",
  世界上下文: "World context",
  "真实 slot 展开、材料覆盖和当前世界正文。":
    "Real slot expansion, material coverage, and current world content.",
  玩家原文: "Player text",
  "本次预览显式使用的动态玩家输入。":
    "The dynamic player input explicitly used for this preview.",
  已提供: "Provided",
  可选未证明完整: "Optional; completeness not proven",
  分页目录: "Paged catalog",
  当前情境: "Current situation",
  附加材料: "Additional materials",
  材料目录: "Material catalog",
  引用目标: "Reference targets",
  最近叙事: "Recent narrative",
  "最大输出 {count}": "Maximum output {count}",
  "打开第 {index} 条逻辑消息：{title}": "Open logical message {index}: {title}",
  "可继续：{continuation}": "Continuation: {continuation}",
  "按需读取入口：{tools}": "On-demand read entry points: {tools}",
  "Provider 映射 · {provider}": "Provider mapping · {provider}",
  列目录: "List directory",
  搜索: "Search",
  读取: "Read",
  写入: "Write",
  改节点: "Patch node",
  移动: "Move",
  自检: "Check",
  结束候选: "Finish candidate",
  "第 {round} / {maxRounds} 轮": "Round {round} / {maxRounds}",
  "正在输出 {count} 字": "Streaming {count} characters",
  "{seconds} 秒前更新": "Updated {seconds} seconds ago",
  "已有 {seconds} 秒没有收到任何输出，模型调用可能已经卡住。":
    "No output has arrived for {seconds} seconds; the model call may be stuck.",
  "补足人物动机、关系与可持续冲突，让角色更容易推动故事。":
    "Add character motivations, relationships, and sustainable conflicts so the cast can drive the story.",
  "强化可以反复游玩的行动循环，同时保持节奏和信息披露边界。":
    "Strengthen repeatable play loops while preserving pacing and information boundaries.",
  "检查现有设定的缺口，并补齐当前情境、主持原则与玩家视图。":
    "Find gaps in the current setting and complete the current situation, host principles, and player views.",
  "注入 {path}": "Inject {path}",
  整份文档: "Whole document",
  "始终提供一份指定世界文档。": "Always provide one specified world document.",
  文档局部节点: "Document node",
  "只提供一份 YAML 路径或 Markdown 标题下的内容。":
    "Provide only one YAML path or the content under one Markdown heading.",
  显式引用目标: "Explicit reference targets",
  "从一个 YAML 节点读取 $ref，并提供一层目标文档。":
    "Read $ref values from a YAML node and provide one level of target documents.",
  有界目录: "Bounded catalog",
  "提供指定一级目录的标题、简介和短引用目录。":
    "Provide titles, summaries, and short references from one specified top-level directory.",
  "带上最近几条已提交叙事，让全新上下文读得到此前写出的细节。":
    "Include recent committed narrative so a fresh context can read previously written details.",
  "上移 {title}": "Move {title} up",
  "下移 {title}": "Move {title} down",
  "移除指令 {title}": "Remove instruction {title}",
  "上移材料 {index}": "Move material {index} up",
  "下移材料 {index}": "Move material {index} down",
  "移除材料 {index}": "Remove material {index}",
  "文档 {index}": "Document {index}",
  "来源 YAML 文件 {index}": "Source YAML file {index}",
  "从 YAML 哪个字段读取 $ref（插槽 {index}）":
    "YAML field containing $ref (slot {index})",
  "手动 YAML 字段路径（插槽 {index}）": "Manual YAML field path (slot {index})",
  "最多目标数 {index}": "Maximum targets {index}",
  "目录 {index}": "Directory {index}",
  "最多目录项 {index}": "Maximum catalog entries {index}",
  "带上最近几条 {index}": "Recent entries to include {index}",
  "实际关联 {path}；frame.yaml 保存 @短引用：{handle}":
    "Linked to {path}; frame.yaml stores the short reference @{handle}.",
  "实际关联 world/{directory}/；创建世界后对应 state/{directory}/。":
    "Linked to world/{directory}/; after world creation it maps to state/{directory}/.",
  "缺失时阻止请求 {index}": "Block the request when missing {index}",
  "YAML 无法解析：{message}": "Could not parse YAML: {message}",
  "{status} · 第 {attempt} 次派发": "{status} · dispatch {attempt}",
  "调用 {tool}": "Call {tool}",
  "{count} 项产物": "{count} artifact(s)",
  端点方言: "Endpoint dialect",
  协议标准: "Protocol standard",
  "Effort（推理强度）": "Effort (reasoning intensity)",
  "Thinking（思考模式）": "Thinking mode",
  "Thinking 返回内容": "Returned thinking content",
  "Thinking budget tokens": "Thinking budget tokens",
  "手动 token 预算": "Manual token budget",
  "Provider 默认": "Provider default",
  "方言 / Effort / Thinking": "Dialect / effort / thinking",
  "CLIProxyAPI 方言只启用代理明确支持的兼容参数；响应仍按所选协议解析，不从可见文本猜测思考块。Claude 的签名 thinking 请选 Responses 或 Anthropic Messages；Chat Completions 通常只有 reasoning_content，不能承诺无损续传签名。模型名的 (high) 等 thinking 后缀会覆盖请求参数，因此 Effort 与 Thinking 都必须保留“Provider 默认”。":
    "The CLIProxyAPI dialect enables only compatibility parameters explicitly supported by the proxy. Responses are still decoded as the selected protocol; visible text is never guessed to be a thinking block. Use Responses or Anthropic Messages for signed Claude thinking. Chat Completions usually exposes only reasoning_content and cannot guarantee lossless signature continuation. Model-name thinking suffixes such as (high) override request fields, so leave both Effort and Thinking at Provider default.",
  "Effort 控制整份响应投入；Anthropic Thinking 独立控制思考块，手动预算必须小于最大输出。Thinking 返回内容只进入模型诊断；原生续传块仍会原样保存。":
    "Effort controls work across the whole response. Anthropic Thinking independently controls thinking blocks, and a manual budget must be lower than maximum output. Returned thinking is diagnostic only; provider-native continuation blocks are still retained unchanged.",
  "查看实际 HTTP 请求（凭据已省略）":
    "View actual HTTP request (credentials omitted)",
  字节: "bytes",
  缓存策略: "Cache strategy",
  "由 Provider 管理，无显式断点": "Provider-managed; no explicit breakpoint",
  输入: "Input",
  未缓存输入: "Uncached input",
  缓存读取: "Cache read",
  缓存写入: "Cache write",
  推理: "Reasoning",
  "推理（输出内）": "Reasoning (inside output)",
  输出: "Output",
  "输出（含推理）": "Output (includes reasoning)",
  合计: "Total",
  "Token 用量明细": "Token usage breakdown",
  未报告: "Not reported",
  "Provider 报告": "Provider reported",
  "由 Provider 字段计算": "Derived from Provider fields",
  "Provider 未报告": "Not reported by Provider",
  "缓存读取和缓存写入属于输入构成；推理 tokens 已包含在输出 tokens 中，不应重复相加。":
    "Cache-read and cache-write tokens are components of input. Reasoning tokens are already included in output tokens and must not be added twice.",
};

Object.assign(englishMessages, dynamicEnglishMessages);

export function setWebLocale(locale: AppLocale): void {
  if (!isAppLocale(locale)) throw new Error("Unsupported web locale");
  activeLocale = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

export function getWebLocale(): AppLocale {
  return activeLocale;
}

export function uiText(
  chinese: string,
  variables: Readonly<Record<string, string | number>> = {},
): string {
  const template =
    activeLocale === "zh-CN" ? chinese : (englishMessages[chinese] ?? chinese);
  return template.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/gu,
    (match, key: string) => (key in variables ? String(variables[key]) : match),
  );
}
