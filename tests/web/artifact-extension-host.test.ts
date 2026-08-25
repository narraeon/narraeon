// @vitest-environment jsdom

import { describe, expect, test } from "vitest";

import {
  applyRegexPipeline,
  artifactInstanceKey,
  buildDocumentSrcDoc,
  buildDocumentTemplateSrcDoc,
  isExtensionBridgeMessage,
  isExtensionBridgeResponse,
  markdownToHtml,
  type FrontendArtifactProjection,
} from "../../src/web/ArtifactExtensionHost.tsx";

function artifact(
  overrides: Partial<FrontendArtifactProjection> = {},
): FrontendArtifactProjection {
  return {
    recordId: "record-1",
    worldId: "world-1",
    operationId: "operation-1",
    playPresetId: "preset-1",
    playPresetRevision: "rev-1",
    requestId: "narrate",
    requestAttempt: 1,
    output: "panel",
    channel: "panel",
    contentType: "text/plain",
    payload: "hello",
    projection: "replace",
    save: "commit",
    sequence: 1,
    head: "head-1",
    frontend: {
      status: "ready",
      preset: { id: "preset-1", revision: "rev-1" },
      mount: "sidebar",
      regex: [],
      trustedLocalCode: false,
      fallback: "none",
    },
    ...overrides,
  };
}

describe("ArtifactExtensionHost pipeline", () => {
  test("Markdown 转换先转义原文并提供稳定 HTML", () => {
    expect(markdownToHtml("# 标题\n\n**正文** <script>alert(1)</script>")).toBe(
      "<h1>标题</h1>\n<p><strong>正文</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
    expect(buildDocumentSrcDoc("<p>trusted</p>", "text/html")).toBe(
      "<p>trusted</p>",
    );
  });

  test("按显式 order/scope 记录每一步且不修改 raw", () => {
    const result = applyRegexPipeline({
      payload: "hello **world**",
      contentType: "text/markdown",
      rules: [
        {
          order: 2,
          scope: "markdown_html",
          pattern: "WORLD",
          flags: "i",
          replace: "reader",
          maxMatches: 1,
          errorPolicy: "fail",
        },
        {
          order: 1,
          scope: "raw_text",
          pattern: "hello",
          flags: "g",
          replace: "welcome",
          maxMatches: 1,
          errorPolicy: "fail",
        },
      ],
    });
    expect(result.original).toBe("hello **world**");
    expect(result.final).toContain("welcome");
    expect(result.final).toContain("reader");
    expect(result.steps.map(({ order }) => order)).toEqual([1, 2]);
  });

  test("structured payload 与错误 fallback 有界", () => {
    const structured = applyRegexPipeline({
      payload: { status: "draft" },
      contentType: "application/json",
      rules: [
        {
          order: 1,
          scope: "structured_payload",
          pattern: "draft",
          flags: "g",
          replace: "ready",
          maxMatches: 1,
          errorPolicy: "fail",
        },
      ],
    });
    expect(structured.final).toContain('"ready"');

    const fallback = applyRegexPipeline({
      payload: "raw",
      contentType: "text/plain",
      rules: [
        {
          order: 1,
          scope: "raw_text",
          pattern: "[",
          flags: "",
          replace: "x",
          maxMatches: 1,
          errorPolicy: "fallback",
        },
      ],
    });
    expect(fallback.fallback).toBe(true);
    expect(fallback.final).toBe("raw");
    expect(fallback.steps[0]?.status).toBe("fallback");
    expect(fallback.failure).toBe("fallback");
    const fail = applyRegexPipeline({
      payload: "raw",
      contentType: "text/plain",
      rules: [
        {
          order: 1,
          scope: "raw_text",
          pattern: "[",
          flags: "",
          replace: "x",
          maxMatches: 1,
          errorPolicy: "fail",
        },
      ],
    });
    expect(fail.failure).toBe("fail");
    expect(fail.steps[0]?.status).toBe("failed");
  });

  test("projection strategy 决定 instance identity，app revision 才重建", () => {
    const replace = artifact();
    const updated = artifact({ recordId: "record-2", sequence: 2 });
    expect(artifactInstanceKey(replace)).toBe(artifactInstanceKey(updated));
    const append = artifact({ projection: "append" });
    expect(artifactInstanceKey(append)).not.toBe(
      artifactInstanceKey({ ...append, recordId: "record-2" }),
    );
    const app = artifact({
      frontend: {
        ...replace.frontend,
        renderer: {
          mode: "app",
          revision: "v1",
          document: "<main></main>",
          scripts: [],
          assets: [],
          trustedLocalCode: true,
        },
      },
    });
    expect(artifactInstanceKey(app)).not.toBe(
      artifactInstanceKey({
        ...app,
        frontend: {
          ...app.frontend,
          renderer: { ...app.frontend.renderer!, revision: "v2" },
        },
      }),
    );
  });

  test("bridge 需要 namespace、instance id、nonce 且只接受白名单命令", () => {
    const expected = { instanceId: "instance-1", nonce: "nonce-1" };
    expect(
      isExtensionBridgeMessage(
        {
          namespace: "narraeon.extension.v1",
          command: "composer.set_draft",
          ...expected,
          requestId: "request-1",
          payload: { text: "draft" },
        },
        expected,
      ),
    ).toBe(true);
    expect(
      isExtensionBridgeMessage(
        {
          namespace: "narraeon.extension.v1",
          command: "runtime.request",
          ...expected,
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isExtensionBridgeMessage(
        {
          namespace: "narraeon.extension.v1",
          command: "panel.close",
          instanceId: "other",
          nonce: expected.nonce,
        },
        expected,
      ),
    ).toBe(false);
    expect(
      isExtensionBridgeResponse({
        namespace: "narraeon.extension.v1",
        type: "bridge.response",
        requestId: "request-1",
        instanceId: expected.instanceId,
        nonce: expected.nonce,
        ok: true,
        payload: { accepted: true },
      }),
    ).toBe(true);
  });

  test("document renderer 使用显式 marker，错误不会隐式解释模板", () => {
    expect(
      buildDocumentTemplateSrcDoc({
        template:
          "<!doctype html><main data-testid=content><!-- narraeon:content --></main><!-- narraeon:payload -->",
        content: "hello",
        contentType: "text/plain",
        payload: { ok: true },
      }),
    ).toContain("<pre>hello</pre>");
    expect(() =>
      buildDocumentTemplateSrcDoc({
        template: "<main>without marker</main>",
        content: "hello",
        contentType: "text/plain",
      }),
    ).toThrow("content marker");
  });
});
