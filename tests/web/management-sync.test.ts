// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { V1Request } from "../../src/protocol/v1.ts";
import { PackageScriptPermissionControl } from "../../src/web/PackageScriptPermissionControl.tsx";
import { setWebLocale } from "../../src/web/i18n.ts";
import { CreateWorldScreen } from "../../src/web/CreateWorldScreen.tsx";
import { ProtagonistTemplateManager } from "../../src/web/ProtagonistTemplateManager.tsx";
import { App } from "../../src/web/App.tsx";
import type { RuntimeClient } from "../../src/web/runtimeClient.ts";

afterEach(cleanup);

test("a rejected package rename synchronizes the list while keeping the editable name and reason", async () => {
  window.history.replaceState(null, "", "#/");
  let reads = 0;
  let writes = 0;
  const request = vi.fn(async (input: V1Request) => {
    await Promise.resolve();
    if (input.type === "workspace.read") {
      reads++;
      return {
        preferences: { locale: "zh-CN" },
        contentPackages: [
          {
            localId: "package",
            title: "Original",
            status: "usable",
            gameplay: { mode: "interactive-fiction" },
          },
        ],
        worlds: [],
        playPresets: { currentPresetId: "", presets: [] },
        storageNotices: [],
        model: {
          configured: false,
          activeConnectionId: null,
          connections: [],
          presets: [],
        },
      };
    }
    if (input.type === "content.rename") {
      writes++;
      throw new Error("Name rejected by Runtime");
    }
    throw new Error(input.type);
  });
  render(
    createElement(App, { client: { request } as unknown as RuntimeClient }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "重命名内容包：Original" }),
  );
  fireEvent.change(screen.getByLabelText("内容包标题"), {
    target: { value: "Keep this name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存内容包标题" }));
  await screen.findByText("Name rejected by Runtime");
  expect(screen.getByLabelText<HTMLInputElement>("内容包标题").value).toBe(
    "Keep this name",
  );
  expect(
    screen.getByRole("button", { name: "打开内容包：Original" }),
  ).toBeTruthy();
  expect(writes).toBe(1);
  expect(reads).toBe(2);
});

test("a lost permission receipt rereads only its permission, keeps the last value during outage and offers a read-only retry", async () => {
  setWebLocale("zh-CN");
  let enabled = false;
  let offline = false;
  let writes = 0;
  let reads = 0;
  const request = vi.fn(async (input: V1Request) => {
    await Promise.resolve();
    if (input.type === "content.scripts.read") {
      reads++;
      if (offline) throw new Error("offline");
      return { enabled };
    }
    if (input.type === "content.scripts.set") {
      writes++;
      enabled = input.enabled;
      offline = true;
      throw new Error("receipt lost");
    }
    throw new Error(`Unexpected ${input.type}`);
  });
  render(
    createElement(PackageScriptPermissionControl, {
      client: { request },
      kind: "content",
      id: "package-1",
    }),
  );
  const checkbox = await screen.findByRole<HTMLInputElement>("checkbox");
  await waitFor(() => expect(checkbox.disabled).toBe(false));
  fireEvent.click(checkbox);
  await screen.findByText("暂时无法同步");
  expect(checkbox.checked).toBe(false);
  expect(writes).toBe(1);
  expect(reads).toBe(2);
  offline = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(checkbox.checked).toBe(true));
  expect(screen.queryByText("暂时无法同步")).toBeNull();
  expect(writes).toBe(1);
  expect(reads).toBe(3);
});

test("creation previews retry their own read and ignore late results for a previous package", async () => {
  setWebLocale("zh-CN");
  const old = Promise.withResolvers<{
    files: { path: string; contents: string }[];
  }>();
  let templateReads = 0;
  let openingReads = 0;
  const client = {
    request: vi.fn(async (input: V1Request): Promise<unknown> => {
      if (input.type === "protagonist-templates.read") {
        if (++templateReads === 1) throw new Error("transient");
        return { templates: [{ id: "hero", name: "Hero", body: "Body" }] };
      }
      if (input.type === "content.read") {
        if (input.packageId === "old") return old.promise;
        if (++openingReads === 1) throw new Error("transient");
        return { files: [{ path: "opening.md", contents: "Current opening" }] };
      }
      throw new Error(input.type);
    }),
  } as unknown as Pick<RuntimeClient, "request">;
  const props = {
    client,
    packages: [
      {
        localId: "old",
        title: "Old",
        gameplay: { mode: "interactive-fiction" as const },
        status: "usable" as const,
      },
      {
        localId: "new",
        title: "New",
        gameplay: { mode: "interactive-fiction" as const },
        status: "usable" as const,
      },
    ],
    selectedId: "old",
    selectedTemplateId: "",
    pending: false,
    modelConfigured: true,
    onSelect: vi.fn(),
    onTemplateSelect: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onConfigureModel: vi.fn(),
  };
  const view = render(createElement(CreateWorldScreen, props));
  await screen.findByRole("option", { name: "Hero" });
  view.rerender(
    createElement(CreateWorldScreen, { ...props, selectedId: "new" }),
  );
  await screen.findByText("Current opening");
  old.resolve({ files: [{ path: "opening.md", contents: "Stale opening" }] });
  await waitFor(() => expect(screen.queryByText("Stale opening")).toBeNull());
  expect(templateReads).toBe(2);
  expect(openingReads).toBe(2);
});

test("template save loses its receipt: the refreshed list and unsaved editor text remain independent", async () => {
  setWebLocale("zh-CN");
  const onChange = vi.fn();
  let writes = 0;
  const request = vi.fn(async (input: V1Request) => {
    await Promise.resolve();
    if (input.type === "protagonist-templates.save") {
      writes++;
      throw new Error("lost receipt");
    }
    if (input.type === "protagonist-templates.read")
      return {
        templates: [{ id: "new", name: "Saved template", body: "Saved body" }],
      };
    throw new Error(input.type);
  });
  render(
    createElement(ProtagonistTemplateManager, {
      client: { request } as unknown as Pick<RuntimeClient, "request">,
      templates: [],
      onChange,
      onClose: vi.fn(),
    }),
  );
  fireEvent.change(screen.getByLabelText("模板名称"), {
    target: { value: "Saved template" },
  });
  fireEvent.change(screen.getByLabelText("模板正文"), {
    target: { value: "Saved body" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({
      templates: [{ id: "new", name: "Saved template", body: "Saved body" }],
    }),
  );
  expect(screen.getByLabelText<HTMLInputElement>("模板名称").value).toBe(
    "Saved template",
  );
  expect(writes).toBe(1);
});
