/** Rejected material-list shapes shared by the material-selection tests. */
export const invalidMaterialLists: readonly {
  label: string;
  value: unknown;
}[] = [
  { label: "缺 kind", value: [{ document: "x" }] },
  {
    label: "未知 kind",
    value: [{ kind: "future", document: "x" }],
  },
  {
    label: "document 非字符串",
    value: [{ kind: "document", document: 1 }],
  },
  {
    label: "document 空串",
    value: [{ kind: "document", document: "" }],
  },
  {
    label: "node 缺 locator",
    value: [{ kind: "node", document: "x" }],
  },
  {
    label: "空 yaml locator",
    value: [{ kind: "node", document: "x", locator: { yaml: [] } }],
  },
  {
    label: "空 markdown locator",
    value: [{ kind: "node", document: "x", locator: { markdown: [] } }],
  },
  {
    label: "元素额外字段",
    value: [{ kind: "document", document: "x", extra: true }],
  },
  {
    label: "locator 额外字段",
    value: [
      {
        kind: "node",
        document: "x",
        locator: { yaml: ["x"], extra: true },
      },
    ],
  },
  {
    label: "双 locator",
    value: [
      {
        kind: "node",
        document: "x",
        locator: { yaml: ["x"], markdown: ["x"] },
      },
    ],
  },
  {
    label: "空 message",
    value: [{ kind: "history_message", message: "" }],
  },
  {
    label: "空 commit",
    value: [{ kind: "history_commit", commit: "" }],
  },
  {
    label: "yaml 数字段",
    value: [{ kind: "node", document: "x", locator: { yaml: [0] } }],
  },
  {
    label: "超过 32 项",
    value: Array.from({ length: 33 }, (_, index) => ({
      kind: "history_message",
      message: `history-message-${index}`,
    })),
  },
];
