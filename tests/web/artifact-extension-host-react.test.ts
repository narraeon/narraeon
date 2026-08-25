// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ArtifactExtensionHost,
  ArtifactExtensionMount,
  type FrontendArtifactProjection,
  type FrontendPlayerViewPanelProjection,
} from "../../src/web/ArtifactExtensionHost.tsx";
import { ArtifactDebugger } from "../../src/web/ArtifactDebugger.tsx";

afterEach(() => cleanup());

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

function host(
  artifacts: FrontendArtifactProjection[],
  onSetComposerDraft = vi.fn(),
  interactionDisabled = false,
) {
  return createElement(
    ArtifactExtensionHost,
    {
      worldId: "world-1",
      artifacts,
      playerViews: { views: [{ id: "view-1", title: "当前" }] },
      interactionDisabled,
      onSetComposerDraft,
      onRefresh: vi.fn(),
    },
    createElement(ArtifactExtensionMount, { mount: "sidebar" }),
  );
}

describe("ArtifactExtensionHost React lifetime", () => {
  test("replace 更新同一 document iframe，append 与多 key 分离", () => {
    const first = artifact();
    const view = render(host([first]));
    const frame = screen.getByTitle("panel");
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("");
    view.rerender(
      host([
        artifact({
          recordId: "record-2",
          payload: "updated",
          sequence: 2,
        }),
      ]),
    );
    expect(screen.getByTitle("panel")).toBe(frame);
    expect(screen.getByTitle("panel").getAttribute("srcdoc")).toContain(
      "updated",
    );

    view.rerender(
      host([
        artifact({ projection: "append" }),
        artifact({
          recordId: "record-2",
          projection: "append",
          key: "second",
          sequence: 2,
        }),
      ]),
    );
    expect(screen.getAllByTitle("panel")).toHaveLength(2);
  });

  test("app revision 改变才换 iframe，并显示本地可信标记", () => {
    const app = (revision: string) =>
      artifact({
        frontend: {
          ...artifact().frontend,
          trustedLocalCode: true,
          renderer: {
            mode: "app",
            revision,
            document: "<main>app</main>",
            scripts: [],
            assets: [],
            trustedLocalCode: true,
          },
        },
      });
    const view = render(host([app("v1")]));
    const first = screen.getByTitle("panel");
    expect(screen.getByText("本地可信代码")).toBeTruthy();
    expect(first.getAttribute("sandbox")).toBe("allow-scripts");
    view.rerender(host([app("v1")]));
    expect(screen.getByTitle("panel")).toBe(first);
    view.rerender(host([app("v2")]));
    expect(screen.getByTitle("panel")).not.toBe(first);
  });

  test("停用脚本的 raw HTML 与 renderer inline script 均留在禁脚本 sandbox", () => {
    render(
      host([
        artifact({
          contentType: "text/html",
          payload: "<script>parent.__rawEscaped = true</script>",
          frontend: {
            ...artifact().frontend,
            trustedLocalCode: false,
            renderer: {
              mode: "document",
              document:
                "<main><!-- narraeon:content --></main><script>parent.__rendererEscaped = true</script>",
              scripts: [],
              assets: [],
              trustedLocalCode: false,
            },
          },
        }),
      ]),
    );
    const frame = screen.getByTitle("panel");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("__rendererEscaped");
  });

  test("bridge composer.set_draft 只接受当前 iframe 的 nonce/instance", () => {
    const onSetComposerDraft = vi.fn();
    render(
      host(
        [
          artifact({
            frontend: {
              ...artifact().frontend,
              trustedLocalCode: true,
              renderer: {
                mode: "app",
                revision: "v1",
                document: "<main>app</main>",
                scripts: [],
                assets: [],
                trustedLocalCode: true,
              },
            },
          }),
        ],
        onSetComposerDraft,
      ),
    );
    const frame = screen.getByTitle<HTMLIFrameElement>("panel");
    const source = frame.getAttribute("srcdoc") ?? "";
    const instanceId = /narraeonInstance=\\?"([^"]+)\\?"/u.exec(source)?.[1];
    const nonce = /narraeonNonce=\\?"([^"]+)\\?"/u.exec(source)?.[1];
    expect(instanceId).toBeTruthy();
    expect(nonce).toBeTruthy();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: {
            namespace: "narraeon.extension.v1",
            command: "composer.set_draft",
            instanceId,
            nonce,
            requestId: "request-1",
            payload: { text: "wrong source" },
          },
        }),
      );
    });
    expect(onSetComposerDraft).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            namespace: "narraeon.extension.v1",
            command: "composer.set_draft",
            instanceId,
            nonce,
            requestId: "request-2",
            payload: { text: "draft from app" },
          },
        }),
      );
    });
    expect(onSetComposerDraft).toHaveBeenCalledWith("draft from app");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: {
            namespace: "narraeon.extension.v1",
            command: "panel.close",
            instanceId,
            nonce,
            requestId: "request-3",
          },
        }),
      );
    });
    const recovery = screen.getByRole("button", { name: "恢复此扩展" });
    expect(recovery).toBeTruthy();
    act(() => recovery.click());
    expect(screen.getByTitle("panel")).toBeTruthy();
  });

  test("通用 bridge 在交互禁用时权威拒绝草稿并保留 response envelope", () => {
    const onSetComposerDraft = vi.fn();
    render(
      host(
        [
          artifact({
            frontend: {
              ...artifact().frontend,
              trustedLocalCode: true,
              renderer: {
                mode: "app",
                revision: "v1",
                document: "<main>app</main>",
                scripts: [],
                assets: [],
                trustedLocalCode: true,
              },
            },
          }),
        ],
        onSetComposerDraft,
        true,
      ),
    );
    const frame = screen.getByTitle<HTMLIFrameElement>("panel");
    const source = frame.getAttribute("srcdoc") ?? "";
    const instanceId = /narraeonInstance=\\?"([^"]+)\\?"/u.exec(source)?.[1];
    const nonce = /narraeonNonce=\\?"([^"]+)\\?"/u.exec(source)?.[1];
    expect(instanceId).toBeTruthy();
    expect(nonce).toBeTruthy();
    const child = frame.contentWindow;
    if (child === null) throw new Error("测试 iframe 缺少 contentWindow");
    const postMessage = vi.spyOn(child, "postMessage");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: child,
          data: {
            namespace: "narraeon.extension.v1",
            command: "composer.set_draft",
            instanceId,
            nonce,
            requestId: "disabled-request",
            payload: { text: "不应写入" },
          },
        }),
      );
    });
    expect(onSetComposerDraft).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "narraeon.extension.v1",
        type: "bridge.response",
        requestId: "disabled-request",
        instanceId,
        nonce,
        ok: false,
        error: "当前调用链正在提交，暂不能修改草稿",
      }),
      "*",
    );
  });

  test("扩展状态摘要无 raw 记录时仍显示核心提交与冷恢复状态", () => {
    render(
      createElement(ArtifactDebugger, {
        records: [],
        extensions: [
          {
            operationId: "operation-failed-before-emit",
            status: "failed",
            message: "扩展首个请求失败",
            completedRequests: [],
            coreCommitted: true,
            head: "commit:1",
          },
        ],
      }),
    );
    expect(screen.getByTestId("artifact-extension-statuses")).toBeTruthy();
    expect(screen.getByText("核心已提交")).toBeTruthy();
    expect(screen.getByText("扩展首个请求失败")).toBeTruthy();
  });

  test("玩家视图面板调试区显示对应 app bridge 事件", () => {
    const panel: FrontendPlayerViewPanelProjection = {
      panelId: "status-panel",
      worldId: "world-1",
      preset: { id: "preset-1", revision: "rev-1" },
      lifecycle: "current_preset",
      source: { kind: "player_view", viewId: "status" },
      authority: "committed_player_view_projection",
      head: "commit:1",
      channel: "player.view.current",
      key: "current",
      contentType: "application/json",
      payload: { viewId: "status", items: [{ id: "clothes", value: "白色" }] },
      projection: "upsert",
      diagnostics: [],
      frontend: artifact().frontend,
    };
    render(
      createElement(ArtifactDebugger, {
        records: [],
        playerViewPanels: [panel],
        bridgeEvents: {
          "player-view:status-panel": ["bridge.ready", "diagnostic"],
        },
      }),
    );
    expect(screen.getByText("bridge 事件（2）")).toBeTruthy();
    expect(screen.getByText("bridge.ready")).toBeTruthy();
    expect(screen.getByText("diagnostic")).toBeTruthy();
  });
});
