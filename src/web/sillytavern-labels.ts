import { uiText } from "./i18n.ts";
import type {
  SillyTavernConversion,
  SillyTavernDiagnosticCode,
  SillyTavernDiagnosticResult,
  SillyTavernSettingCategory,
} from "../shared/sillytavern-preset.ts";

type ExplanationCode =
  | SillyTavernDiagnosticCode
  | SillyTavernDiagnosticResult
  | SillyTavernSettingCategory
  | SillyTavernConversion["target"][number]["kind"];
export function explainSillyTavernDiagnostic(code: ExplanationCode): string {
  const messages: Record<ExplanationCode, string> = {
    missing_builtin: uiText("源文件未携带此内建定义。"),
    marker: uiText("动态材料占位，无静态正文。"),
    unsupported_macro: uiText("包含不支持的宏，保留原文并停用。"),
    depth_injection: uiText("历史深度插入不能等价迁移，保留原文并停用。"),
    trigger: uiText("生成触发条件不能等价迁移，保留原文并停用。"),
    overrides: uiText(
      "main/jailbreak 未禁止覆盖时，角色卡的 system_prompt/post_history_instructions 可替换正文；这与发送角色或变量重复赋值无关。保留原文并停用。",
    ),
    unsupported_fields: uiText("包含不支持的字段，保留原文并停用。"),
    unsupported_field: uiText("不支持的字段"),
    prompt_selection: uiText("提示选择结果"),
    not_selected: uiText("未选择"),
    enabled: uiText("已导入并启用"),
    model: uiText("模型（未迁移）"),
    generation: uiText("生成设置（未迁移）"),
    unplaced: uiText("未编排提示选中后会保留为停用项。"),
    ignored_setting: uiText("设置未迁移"),
    connection: uiText("连接或凭据（未迁移）"),
    sampling: uiText("采样与生成（未迁移）"),
    extension: uiText("扩展（未迁移）"),
    ignored: uiText("已忽略"),
    disabled: uiText("已保留并停用"),
    not_imported: uiText("未导入"),
    user: uiText("导入的用户提示"),
    builtin: uiText("Narraeon 系统提示"),
    world: uiText("Narraeon 世界占位"),
    tail: uiText("尾部提示"),
  };
  return messages[code];
}

export function sillyTavernErrorMessage(message: string): string {
  const translations: Record<string, string> = {
    st_invalid_json: uiText("JSON 格式无效"),
    st_legacy_prompt_format_is_unsupported: uiText("不支持旧版提示格式"),
    st_unsupported_preset_format: uiText("不支持此 SillyTavern 预设格式"),
    st_expected_object: uiText("需要对象"),
    st_expected_array: uiText("需要数组"),
    st_expected_string: uiText("需要字符串"),
    st_expected_boolean: uiText("需要布尔值"),
    st_expected_number: uiText("需要数字"),
    st_expected_nonempty_string: uiText("需要非空字符串"),
    st_duplicate_identifier: uiText("提示身份重复"),
    st_expected_string_or_number: uiText("需要字符串或数字"),
    st_expected_string_array: uiText("需要字符串数组"),
    st_expected_prompt_content: uiText("需要提示正文"),
    st_unsupported_role: uiText("不支持此角色"),
    st_duplicate_order_identifier: uiText("顺序中身份重复"),
    st_unknown_prompt_reference: uiText("顺序引用了未知提示"),
    st_unknown_order_field: uiText("顺序中包含未知字段"),
    st_unknown_group_field: uiText("顺序组包含未知字段"),
    st_expected_character_identifier: uiText("需要角色组身份"),
    st_duplicate_character_group: uiText("角色组身份重复"),
    st_unknown_group: uiText("未知顺序组"),
    st_choose_a_character_group: uiText("请选择顺序组"),
    st_invalid_selection: uiText("选择无效"),
    "SillyTavern source exceeds the size limit": uiText("源文件超过大小限制"),
    "The file does not match this orchestration’s original SillyTavern import":
      uiText("这个文件与原先导入的 SillyTavern 预设不匹配。"),
  };
  const match = /^(.*): (.+) \[(st_[a-z_]+)\]$/u.exec(message);
  if (match)
    return `${match[1]}: ${translations[match[3]!] ?? match[2]} [${match[3]}]`;
  return translations[message] ?? message;
}
