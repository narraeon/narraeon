// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { WorldPromptMaintenance } from "../../src/protocol/worldMaintenance.ts";
import { setWebLocale } from "../../src/web/i18n.ts";
import { WorldMaintenancePanel } from "../../src/web/WorldMaintenancePanel.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setWebLocale("zh-CN");
});

test.each(["zh-CN", "en"] as const)(
  "world maintenance numbers use the selected %s locale on a different host locale",
  (locale) => {
    // Emulate a host whose grouping and decimal marks differ from the UI's.
    vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
      this: number,
      locales,
      options,
    ) {
      return new Intl.NumberFormat(locales ?? "de-DE", options).format(this);
    });
    setWebLocale(locale);
    const report: WorldPromptMaintenance = {
      unit: "utf8_bytes",
      worldMaterialsBytes: 12_345,
      checkpointHistoryBytes: 0,
      authorInstructionBytes: 0,
      runtimeInstructionBytes: 0,
      toolDefinitionBytes: 0,
      documents: [
        {
          shortRef: "chronicle",
          title: "Chronicle",
          bodyBytes: 12_345,
          injectedBytes: 5_678,
          advisoryBytes: 25_000,
          overAdvisory: false,
          baselineKind: "world_origin",
          baselineBytes: 10_000,
          growthBytes: 2_345,
          growthRatio: 1.2345,
          observedContexts: 2_000,
          bodyChangedContexts: 1_234,
          metadataChangedContexts: 1_025,
          lastBodyWrite: null,
          lastMetadataWrite: null,
        },
      ],
      slots: [
        {
          id: "chronicle",
          bytes: 13_456,
          advisoryBytes: 30_000,
          overAdvisory: false,
          documents: ["chronicle"],
        },
      ],
    };
    render(createElement(WorldMaintenancePanel, { report }));
    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(
      [
        "12,345",
        "5,678",
        "25,000",
        `${locale === "en" ? "World creation" : "世界创建"}: 10,000`,
        "+2,345 (1.23×)",
        "1,234 / 1,025",
      ],
    );
    expect(screen.getByText(/chronicle: 13,456 \/ 30,000/u)).toBeTruthy();
  },
);
