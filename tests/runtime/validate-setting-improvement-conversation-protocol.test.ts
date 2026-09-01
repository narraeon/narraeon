import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("设定完善协议只有读取、普通消息、停止、精确版本应用和放弃", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.message",
        packageId: "package-1",
        requestId: "request-1",
        message: "先讨论一下人物关系",
      },
    }).request,
  ).toEqual({
    type: "setting-improvement.message",
    packageId: "package-1",
    requestId: "request-1",
    message: "先讨论一下人物关系",
  });

  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.apply",
        sessionId: "setting-1",
        expectedDraftVersion: -1,
      },
    }),
  ).toThrow(/expectedDraftVersion/u);

  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.start",
        improvementId: "legacy",
        packageId: "package-1",
        goal: "legacy generation",
        mode: "plan_first",
        contextPaths: [],
      },
    }),
  ).toThrow(/does not support command/u);
});
