// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PresetDraftPreview } from "../../src/web/PresetDraftPreview.tsx";
import type { V1Request } from "../../src/protocol/v1.ts";

afterEach(cleanup);

test("产物草稿首次离线只恢复一次并保留本页输入，重新读取不保存或调用模型", async () => {
  let offline = true;
  const requests: string[] = [];
  const client = {
    request: async <T>(input: V1Request) => {
      await Promise.resolve();
      requests.push(input.type);
      if (offline) throw new Error("offline");
      return {
        revision: "rev",
        structure: { mounts: [] },
        artifactPreviews: [],
      } as T;
    },
  };
  render(
    createElement(PresetDraftPreview, {
      client,
      presetId: "preset",
      revision: "rev",
      files: {},
      structure: {},
      scriptsEnabled: false,
      requestId: "request",
      output: "output",
    }),
  );
  fireEvent.click(screen.getByText("游玩效果预览 · 就地展开"));
  fireEvent.change(screen.getByLabelText("本页输入草稿（尚未发送）"), {
    target: { value: "保持这份样例输入" },
  });
  await screen.findByText("暂时无法同步");
  expect(requests).toEqual(["play.workbench.read", "play.workbench.read"]);
  offline = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.queryByText("暂时无法同步")).toBeNull());
  expect(
    screen.getByLabelText<HTMLTextAreaElement>("本页输入草稿（尚未发送）")
      .value,
  ).toBe("保持这份样例输入");
  expect(requests).toEqual([
    "play.workbench.read",
    "play.workbench.read",
    "play.workbench.read",
  ]);
});
