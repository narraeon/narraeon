// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { FileNativeCorrectionPanel } from "../../src/web/FileNativeCorrectionPanel.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";

describe("文件原生连续性修正界面", () => {
  afterEach(() => {
    cleanup();
    setWebLocale("zh-CN");
  });

  test.each([
    {
      locale: "zh-CN",
      region: "确认修正内容",
      review: "应用前确认修改",
      checksum: "查看技术校验值",
      details: "查看修改前版本、附加材料和下一次提示词",
      previousVersion: "修改前版本",
      applyLabel: "应用这笔修正",
      cancelLabel: "放弃修正草稿",
    },
    {
      locale: "en",
      region: "Review correction",
      review: "Review before applying",
      checksum: "View technical checksum",
      details:
        "View the previous version, additional material, and next prompt",
      previousVersion: "Previous version",
      applyLabel: "Apply this correction",
      cancelLabel: "Discard correction draft",
    },
  ] as const)("应用前可展开校验值和修改前版本（$locale）", (labels) => {
    setWebLocale(labels.locale);
    const apply = vi.fn();
    const cancel = vi.fn();
    render(
      createElement(FileNativeCorrectionPanel, {
        preview: {
          parentHead: "commit:7",
          candidateVersion: 3,
          diffs: [
            {
              documentId: "character.alex",
              path: "characters/alex.yaml",
              beforeHash: "sha256:before",
              afterHash: "sha256:after",
              before: "衣着: 白色背心",
              after: "衣着: 蓝色训练外套",
            },
          ],
          materials: {
            before: [],
            after: [{ kind: "document", document: "character.alex" }],
          },
          nextPrompt: {
            diagnosticBinding: {
              endpoint: "world-one:commit:7",
              commit: "commit:7",
              hostPresetId: "host",
              controlFingerprint: "control",
              modelId: "model",
            },
            compilation: {
              logicalMessages: [
                {
                  role: "world_context",
                  markdown: "# Next real request\n\nCurrent situation",
                  blocks: [
                    {
                      source: "@current-situation",
                      markdown: "Current situation",
                    },
                  ],
                },
              ],
              provider: {},
              tools: [],
              coverage: [
                {
                  slot: "current_situation",
                  source: "@current-situation",
                  status: "resolved",
                  complete: true,
                  continuation: null,
                },
              ],
              budget: {
                estimator: "disabled",
                messageTokens: 0,
                toolTokens: 0,
                outputReserveTokens: 0,
                forcedTailReserveTokens: 0,
                safetyMarginTokens: 0,
                requiredTokens: 0,
                contextWindowTokens: 0,
                status: "not_checked",
              },
              cache: {
                strategy: "provider_managed",
                stablePrefixFingerprint: "cache",
                breakpoints: [],
                estimatedCacheableBytes: 0,
                firstDynamicByte: 0,
              },
            },
            leakage: { status: "clean", checkedFields: [] },
          },
        },
        onApply: apply,
        onCancel: cancel,
      }),
    );

    expect(screen.getByRole("region", { name: labels.region })).toBeTruthy();
    expect(screen.getByText(labels.review, { exact: true })).toBeTruthy();
    expect(screen.getByText("衣着: 白色背心")).toBeTruthy();
    expect(screen.getByText("衣着: 蓝色训练外套")).toBeTruthy();

    const checksumSummary = screen.getByText(labels.checksum, { exact: true });
    const checksumDetails = checksumSummary.closest("details")!;
    expect(checksumDetails.open).toBe(false);
    fireEvent.click(checksumSummary);
    expect(checksumDetails.open).toBe(true);
    expect(
      within(checksumDetails).getByText("sha256:before → sha256:after"),
    ).toBeTruthy();

    const versionSummary = screen.getByText(labels.details, { exact: true });
    const versionDetails = versionSummary.closest("details")!;
    expect(versionDetails.open).toBe(false);
    fireEvent.click(versionSummary);
    expect(versionDetails.open).toBe(true);
    const version = within(versionDetails).getByText(labels.previousVersion, {
      selector: "dt",
      exact: true,
    });
    expect(version.nextElementSibling?.textContent).toBe("commit:7");
    expect(within(versionDetails).getByText(/Next real request/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: labels.applyLabel }));
    fireEvent.click(screen.getByRole("button", { name: labels.cancelLabel }));
    expect(apply).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
