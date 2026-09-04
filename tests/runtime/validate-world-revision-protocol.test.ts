import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

const epochId = "revision-00000000-0000-4000-8000-000000000000";
const changeSetId = "change-set:00000000-0000-4000-8000-000000000001";

test("世界修订协议绑定持久 epoch、CAS revision 与精确回滚目标", () => {
  const requests = [
    { type: "world.revision.open", worldId: "world-1" },
    { type: "world.revision.overview", worldId: "world-1" },
    {
      type: "world.revision.status",
      worldId: "world-1",
      sessionId: "world-session-1",
    },
    {
      type: "world.revision.files.replace",
      worldId: "world-1",
      epochId,
      expectedRevision: "revision-fingerprint",
      files: [{ path: "state/current.yaml", contents: "contents" }],
    },
    {
      type: "world.revision.rollback",
      worldId: "world-1",
      epochId,
      changeSetId,
      path: "state/current.yaml",
    },
    {
      type: "world.revision.apply",
      worldId: "world-1",
      epochId,
      expectedRevision: "revision-fingerprint",
    },
    { type: "world.revision.discard", worldId: "world-1", epochId },
  ] as const;

  for (const request of requests)
    expect(parseV1Envelope({ protocol: v1Protocol, request }).request).toEqual(
      request,
    );
});

test("世界修订对话显式选择全新或继续上下文", () => {
  const fresh = {
    type: "world.revision.message",
    worldId: "world-1",
    requestId: "request-1",
    message: "检查当前世界",
    continuation: { kind: "fresh_context" },
  } as const;
  expect(
    parseV1Envelope({ protocol: v1Protocol, request: fresh }).request,
  ).toEqual(fresh);

  const continued = {
    ...fresh,
    requestId: "request-2",
    continuation: {
      kind: "continue_context",
      sessionId: "world-session-00000000-0000-4000-8000-000000000000",
    },
  } as const;
  expect(
    parseV1Envelope({ protocol: v1Protocol, request: continued }).request,
  ).toEqual(continued);
});

test("世界修订协议拒绝模糊 epoch 与回滚目标", () => {
  for (const request of [
    {
      type: "world.revision.apply",
      worldId: "world-1",
      epochId: "revision-latest",
      expectedRevision: "fingerprint",
    },
    {
      type: "world.revision.rollback",
      worldId: "world-1",
      epochId,
      changeSetId: "change-set:latest",
      path: "state/current.yaml",
    },
    {
      type: "world.revision.rollback",
      worldId: "world-1",
      epochId,
      changeSetId,
      path: "",
    },
    {
      type: "world.revision.discard",
      worldId: "world-1",
      epochId: "revision-00000000-0000-1000-8000-000000000000",
    },
  ])
    expect(() => parseV1Envelope({ protocol: v1Protocol, request })).toThrow(
      /epochId|rollback target|\.path/u,
    );
});

test("世界修订状态只接受非空的可选会话 ID", () => {
  for (const sessionId of ["", 1, null])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: {
          type: "world.revision.status",
          worldId: "world-1",
          sessionId,
        },
      }),
    ).toThrow(/world\.revision\.status\.sessionId/u);
});
