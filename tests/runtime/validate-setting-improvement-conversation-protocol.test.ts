import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

test("设定完善协议显式区分继续历史与全新上下文", () => {
  const fresh = {
    type: "setting-improvement.message",
    packageId: "package-1",
    requestId: "request-1",
    message: "先讨论一下人物关系",
    continuation: { kind: "fresh_context" },
  } as const;
  expect(
    parseV1Envelope({ protocol: v1Protocol, request: fresh }).request,
  ).toEqual(fresh);

  const continued = {
    type: "setting-improvement.message",
    packageId: "package-1",
    requestId: "request-2",
    message: "接着改",
    continuation: {
      kind: "continue_context",
      sessionId: "setting-00000000-0000-4000-8000-000000000000",
    },
  } as const;
  expect(
    parseV1Envelope({ protocol: v1Protocol, request: continued }).request,
  ).toEqual(continued);

  for (const continuation of [
    undefined,
    { kind: "continue_context" },
    { kind: "fresh_context", sessionId: "unexpected" },
    { kind: "guess" },
  ])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: {
          type: "setting-improvement.message",
          packageId: "package-1",
          requestId: "request-bad",
          message: "bad",
          ...(continuation === undefined ? {} : { continuation }),
        },
      }),
    ).toThrow(/continuation|missing required field/u);
});

test("历史读取和所选对话状态保留，Apply 与 Discard 已从协议删除", () => {
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.status",
        packageId: "package-1",
        sessionId: "setting-00000000-0000-4000-8000-000000000000",
      },
    }).request,
  ).toMatchObject({ type: "setting-improvement.status" });
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.session.read",
        packageId: "package-1",
        sessionId: "setting-00000000-0000-4000-8000-000000000000",
      },
    }).request,
  ).toMatchObject({ type: "setting-improvement.session.read" });
  expect(
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.session.delete",
        packageId: "package-1",
        sessionId: "setting-00000000-0000-4000-8000-000000000000",
      },
    }).request,
  ).toMatchObject({ type: "setting-improvement.session.delete" });

  for (const type of [
    "setting-improvement.apply",
    "setting-improvement.discard",
    "setting-improvement.start",
  ])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: { type, sessionId: "setting-1" },
      }),
    ).toThrow(/does not support command/u);
});

test("设定完善回滚必须精确绑定内容包、对话和历史改动集", () => {
  const rollback = {
    type: "setting-improvement.rollback",
    packageId: "package-1",
    sessionId: "setting-00000000-0000-4000-8000-000000000000",
    changeSetId: "change-set:12",
    path: "opening.md",
  } as const;
  expect(
    parseV1Envelope({ protocol: v1Protocol, request: rollback }).request,
  ).toEqual(rollback);

  for (const changeSetId of [undefined, "", "change-set:-1", "change-set:01"])
    expect(() =>
      parseV1Envelope({
        protocol: v1Protocol,
        request: {
          type: "setting-improvement.rollback",
          packageId: "package-1",
          sessionId: "setting-1",
          path: "opening.md",
          ...(changeSetId === undefined ? {} : { changeSetId }),
        },
      }),
    ).toThrow(/changeSetId|missing required field/u);

  expect(() =>
    parseV1Envelope({
      protocol: v1Protocol,
      request: {
        type: "setting-improvement.rollback",
        packageId: "package-1",
        sessionId: "setting-1",
        changeSetId: "change-set:1",
      },
    }),
  ).toThrow(/path|missing required field/u);
});
