import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("V1 correction replace carries the fixed candidate version and write-before hash", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "correction.replace",
        candidateId: "candidate-1",
        expectedVersion: 2,
        target: "@qinlong",
        expectedHash: `sha256:${"a".repeat(64)}`,
        contents: "完整文档原文\n",
      },
    }).request,
  ).toEqual({
    type: "correction.replace",
    candidateId: "candidate-1",
    expectedVersion: 2,
    target: "@qinlong",
    expectedHash: `sha256:${"a".repeat(64)}`,
    contents: "完整文档原文\n",
  });
});
