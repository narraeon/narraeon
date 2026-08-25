// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, test } from "vitest";

import { FileNativeWorldSurfaces } from "../../src/web/FileNativeWorldSurfaces.tsx";

describe("文件原生世界页面", () => {
  test("明确浏览 state、control、空 history 和 Runtime 诊断", () => {
    render(
      createElement(FileNativeWorldSurfaces, {
        state: [{ path: "current-situation.yaml", contents: "情况: 安静" }],
        control: [
          { path: "frame.yaml", contents: "format: narraeon.world-frame/v1" },
        ],
        history: [],
        runtime: {
          operationId: "create-op-1",
          parentEndpoint: "genesis",
          historyEntries: 0,
        },
      }),
    );

    expect(
      screen.getByRole("heading", { name: "当前 state 文档" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "control" })).toBeTruthy();
    expect(screen.getByText("尚无已提交叙事")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Runtime 诊断" })).toBeTruthy();
    expect(screen.queryByText(/世界设定/u)).toBeNull();
  });
});
