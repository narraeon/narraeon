import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("设定完善开始请求显式携带启动方式和 Runtime 解析的上下文路径", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.start",
        improvementId: "improvement-1",
        packageId: "package-1",
        goal: "Improve the existing setting",
        mode: "plan_first",
        contextPaths: ["opening.md", "world/current-situation.yaml"],
      },
    }).request,
  ).toMatchObject({
    mode: "plan_first",
    contextPaths: ["opening.md", "world/current-situation.yaml"],
  });

  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.start",
        improvementId: "improvement-2",
        packageId: "package-1",
        goal: "Improve the existing setting",
        mode: "unknown",
        contextPaths: [],
      },
    }),
  ).toThrow(/setting-improvement\.start\.mode/u);

  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.start",
        improvementId: "improvement-3",
        packageId: "package-1",
        goal: "Improve the existing setting",
        mode: "direct_candidate",
        contextPaths: ["opening.md", 42],
      },
    }),
  ).toThrow(/setting-improvement\.start\.contextPaths/u);
});
