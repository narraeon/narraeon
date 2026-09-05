// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AuthoringPromptPreview } from "../../src/web/AuthoringPromptPreview.tsx";
import type { V1SettingPromptPreview } from "../../src/protocol/v1.ts";

afterEach(cleanup);
const compilation: V1SettingPromptPreview["compilation"] = {
  logicalMessages: [
    {
      role: "author_instruction",
      markdown: "NEW_AUTHOR_ORDER",
      blocks: [{ source: "author", markdown: "NEW_AUTHOR_ORDER" }],
    },
  ],
  provider: { messages: [] },
  cache: {
    strategy: "provider_managed",
    stablePrefixFingerprint: "test",
    breakpoints: [],
    estimatedCacheableBytes: 0,
    firstDynamicByte: 0,
  },
  tools: [],
  coverage: [],
  budget: {
    estimator: "disabled",
    messageTokens: 0,
    toolTokens: 0,
    outputReserveTokens: 100,
    forcedTailReserveTokens: 0,
    safetyMarginTokens: 0,
    requiredTokens: 0,
    contextWindowTokens: 1000,
    status: "not_checked",
  },
};

test("author candidate preview stays separate from retained legacy request evidence", async () => {
  render(
    createElement(AuthoringPromptPreview, {
      requests: [
        {
          requestId: "old",
          legacyBootstrap: true,
          compilation: {
            ...compilation,
            logicalMessages: [
              {
                role: "author_instruction",
                markdown: "OLD_AUTHOR_ORDER",
                blocks: [],
              },
            ],
          },
        },
      ],
      onPreview: () => Promise.resolve(compilation),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "预览下一条请求" }));
  await screen.findByText("NEW_AUTHOR_ORDER");
  expect(screen.getByText("OLD_AUTHOR_ORDER")).toBeDefined();
  expect(screen.getByText("旧会话原始提示")).toBeDefined();
  expect(screen.getByText("下一次发送候选（未发送）")).toBeDefined();
});
