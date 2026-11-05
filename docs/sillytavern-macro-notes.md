# SillyTavern 宏阅读参考

宏涵盖角色和上下文、格式、变量、条件、随机与其他扩展；在 SillyTavern 中可用 `/? macros` 查看当前实例的列表。聊天局部变量与全局变量的作用域不同，外部聊天状态也可能已有变量。新宏引擎支持嵌套与块（包括 `#` 保留空白）；旧引擎按宏类别替换，不能假定预设目录即求值顺序。本工作区只提供保守静态阅读，不模拟执行。

参考：[官方宏文档](https://docs.sillytavern.app/usage/core-concepts/macros/)、[变量宏源码](https://github.com/SillyTavern/SillyTavern/blob/06bde939f/public/scripts/macros/definitions/variable-macros.js)、[宏引擎源码](https://github.com/SillyTavern/SillyTavern/tree/06bde939f/public/scripts/macros)。

以下是本地 SillyTavern 1.19.0（`06bde939f`）的常见类别和例子，不穷举别名。扩展可增补宏，实际可用列表以该实例的 `/? macros` 为准。

| 类别 | 典型宏 |
| --- | --- |
| 角色与用户 | `user`、`char`、`persona`、`group`、`charDescription`、`charPersonality` |
| 聊天 | `lastMessage`、`lastUserMessage`、`lastCharMessage`、`lastMessageId` |
| 局部与全局变量 | `setvar`、`getvar`、`addvar`、`deletevar`、`setglobalvar`、`getglobalvar` |
| 条件与简写 | `if`、`else`，以及相关条件语法 |
| 格式与注释 | `space`、`newline`、`trim`、`noop`、`//` |
| 随机与骰子 | `random`、`pick`、`roll` |
| 日期与时间 | `date`、`time`、`weekday`、`datetimeformat` |
| 模型、模板与扩展 | `model`、`systemPrompt`、`original`、`hasExtension`、`outlet` |
