import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("V1 接受显式的世界重命名请求", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "world.rename",
        worldId: "world-one",
        name: "雾港第一夜",
      },
    }).request,
  ).toEqual({
    type: "world.rename",
    worldId: "world-one",
    name: "雾港第一夜",
  });
});
