import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("V1 接受带副本名称的模型配置克隆命令", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "model.copy",
        connectionId: "model-source",
        name: "模型配置（副本）",
      },
    }).request,
  ).toEqual({
    type: "model.copy",
    connectionId: "model-source",
    name: "模型配置（副本）",
  });
});

test("V1 拒绝没有副本名称的模型配置克隆命令", () => {
  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "model.copy",
        connectionId: "model-source",
      },
    }),
  ).toThrow("model.copy.name is invalid");
});
