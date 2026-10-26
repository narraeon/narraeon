import { expect, test } from "vitest";
import {
  HistoryQuery,
  type HistoryMessageInput,
} from "../../src/runtime/history/HistoryQuery.ts";
import { renderHistoryResult } from "../../src/runtime/history/HistoryRendering.ts";

// Five committed messages with background on two of them. The pre-#124
// receipt for this input measured 1735 bytes for history_list and 1511 for
// history_search; the list budget is 60% of that.
const LIST_BYTES_BEFORE_124 = 1735;
const background = {
  kind: "snapshot" as const,
  value: "时间: 第一天\n地点: 码头",
};
const messages: HistoryMessageInput[] = [
  {
    id: "message.genesis.narrator",
    role: "narrator",
    isOpening: true,
    text: "你站在码头的入口，潮水正在退去。",
  },
  {
    id: "message.1.1.player",
    role: "player",
    text: "我踹开码头的门。",
    background,
  },
  {
    id: "message.1.2.narrator",
    role: "narrator",
    text: "门后那封信藏着码头的密码。",
    background,
  },
  { id: "message.2.1.player", role: "player", text: "我读完信，记下密码。" },
  {
    id: "message.2.2.narrator",
    role: "narrator",
    text: "密码与码头的潮汐表吻合。",
  },
];
const disclaimer = "历史背景仅说明采集位置的状态";

test("history_list 五条消息回执至少减少 40%，且逐条不再重复背景免责声明", () => {
  const list = renderHistoryResult(
    new HistoryQuery("当前时间线", messages).list({}),
    "zh-CN",
  ).markdown;
  expect(Buffer.byteLength(list, "utf8")).toBeLessThanOrEqual(
    Math.floor(LIST_BYTES_BEFORE_124 * 0.6),
  );
  expect(list).not.toContain(disclaimer);
  expect(list).not.toContain("role=");
  expect(list).not.toContain("[部分原文预览]");
  expect(list).not.toContain("续页只传");
  expect(list).toContain("密码与码头的潮汐表吻合。");
  expect(list).toContain("@history-message-message.2.2.narrator");
});

test("history_search 回执不再重复规范化、排序与续页契约说明", () => {
  const search = renderHistoryResult(
    new HistoryQuery("当前时间线", messages).search({ queries: ["密码"] }),
    "zh-CN",
  ).markdown;
  expect(search).not.toContain("Normalization:");
  expect(search).not.toContain("排序依据");
  expect(search).not.toContain("全部命中均在所示片段内");
  expect(search).not.toContain(disclaimer);
  expect(search).toContain("命中消息总数: 3");
  expect(search).toContain("门后那封信藏着码头的密码。");
});
