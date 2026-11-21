import { expect, test } from "vitest";

import { parseV1Envelope, v1Protocol } from "../../src/protocol/v1.ts";

function parse(request: Record<string, unknown>) {
  return parseV1Envelope({ protocol: v1Protocol, request }).request;
}

function expectInvalid(request: Record<string, unknown>, field: string) {
  const decode = () => parse(request);
  expect(decode).toThrow(expect.objectContaining({ code: "invalid_request" }));
  expect(decode).toThrow(field);
}

test("修订消息编辑只接受保留和撤回文件两种策略", () => {
  const request = {
    type: "world.revision.message.edit",
    worldId: "world-1",
    sessionId: "session-1",
    requestId: "request-1",
    messageId: "message-1",
    message: "Updated",
  };
  expectInvalid({ ...request, filePolicy: "fresh_context" }, "filePolicy");
  expectInvalid(request, "filePolicy");
  for (const filePolicy of ["keep", "revert"]) {
    const valid = { ...request, filePolicy };
    expect(parse(valid)).toEqual(valid);
  }
});

test.each([
  { type: "setting-improvement.message", packageId: "package-1" },
  { type: "world.revision.message", worldId: "world-1" },
])("$type 继续对话时需要非空会话 ID", (target) => {
  const request = { ...target, requestId: "request-1", message: "Continue" };
  for (const sessionId of [undefined, "", 1, null])
    expectInvalid(
      { ...request, continuation: { kind: "continue_context", sessionId } },
      "continuation",
    );
  for (const continuation of [
    { kind: "fresh_context" },
    { kind: "continue_context", sessionId: "session-1" },
  ]) {
    const valid = { ...request, continuation };
    expect(parse(valid)).toEqual(valid);
  }
});

test("设定完善状态接受缺省或非空的会话 ID", () => {
  const request = {
    type: "setting-improvement.status",
    packageId: "package-1",
  };
  for (const sessionId of ["", 1, null])
    expectInvalid({ ...request, sessionId }, "sessionId");
  expect(parse(request)).toEqual(request);
  const selected = { ...request, sessionId: "session-1" };
  expect(parse(selected)).toEqual(selected);
});

test.each([
  {
    type: "play.chain.revise-player",
    operationId: "operation-1",
    replacementExchangeId: "exchange-1",
    replacementText: "Updated",
    continuation: "continue_context",
  },
  { type: "play.chain.regenerate-narrative", operationId: "operation-1" },
  { type: "play.timeline.detail" },
  { type: "play.timeline.context" },
])("$type 只接受正的安全整数事件编号", (target) => {
  const request = { ...target, worldId: "world-1", chainId: "chain-1" };
  for (const eventId of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
  ])
    expectInvalid({ ...request, eventId }, "eventId");
  for (const eventId of [1, Number.MAX_SAFE_INTEGER]) {
    const valid = { ...request, eventId };
    expect(parse(valid)).toEqual(valid);
  }
});

test("替换内容包校验每个文件元素的路径、正文和可选编码", () => {
  const request = {
    type: "content.replace",
    packageId: "package-1",
    baseTreeRevision: "revision-1",
  };
  for (const file of [
    null,
    [],
    { contents: "data" },
    { path: "opening.md" },
    { path: "", contents: "data" },
    { path: 7, contents: "data" },
    { path: "opening.md", contents: 7 },
    { path: "opening.md", contents: "data", encoding: "utf8" },
  ])
    expectInvalid({ ...request, files: [file] }, "files");

  const text = { path: "opening.md", contents: "" };
  const binary = {
    path: "assets/beacon.png",
    contents: "AA==",
    encoding: "base64",
  };
  for (const files of [[], [text, binary]]) {
    const valid = { ...request, files };
    expect(parse(valid)).toEqual(valid);
  }
});

test("产物诊断校验世界与操作身份，频道筛选属于产物读取", () => {
  const request = { type: "artifacts.debug", worldId: "world-1" };
  expect(parse(request)).toEqual(request);
  for (const operationId of ["", 1, null])
    expectInvalid({ ...request, operationId }, "operationId");
  expectInvalid({ ...request, worldId: "" }, "worldId");
  const debug = { ...request, operationId: "operation-1" };
  expect(parse(debug)).toEqual(debug);
  expect(parse({ ...debug, channel: null })).toMatchObject(debug);

  const read = { type: "artifacts.read", worldId: "world-1", channel: "notes" };
  expect(parse(read)).toEqual(read);
  expectInvalid({ ...read, channel: null }, "channel");
});
