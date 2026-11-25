import { expect, type Page } from "@playwright/test";

import type { ContentTreeFile, V1Request } from "../../src/protocol/v1.ts";
import { test } from "../support/isolatedRuntimeTest.ts";

test.use({ runtimeScope: "world-document-metadata" });

const yamlPath = "locations/harbor.yml";
const markdownPath = "rules/gates.md";
const yamlBody =
  "\n# author's weather notes\nweather:   calm # opening state\nsea: { tide: low }\n";
const yamlSource = `# file comment\n$document:\n  id: location.harbor\n  ref: old-harbor\n  title: Old Harbor # title comment\n  summary: >- # summary comment\n    A description from an older package.\n  aliases: # alias header\n    # alias note\n    - Wharf # alias comment\n  retired: false # retirement comment\n${yamlBody}`;
const markdownBody =
  "\nFirst paragraph before the heading.\n\n~~~markdown\n# A decoy inside a fence\n~~~\n  # Guild Gates ##  \n\n## Hours\n\nThe doors close at dusk.  \n\n";
const markdownSource = `---\n$document: {id: rules.gates, ref: guild-gates, title: Guild Gates, summary: A short description, aliases: []} # header note\n---\n${markdownBody}`;
const packageNote = "# Package notes\n";

for (const locale of ["zh-CN", "en"] as const) {
  test(`edits package and revision metadata through the real file workbench (${locale})`, async ({
    page,
  }) => {
    const chinese = locale === "zh-CN";
    const label = (zh: string, en: string) => (chinese ? zh : en);
    const titleName = label("文档标题", "Document title");
    const refName = label("公开短引用", "Public short reference");
    const aliasesName = label("添加别名", "Add alias");
    const newTitle = label("新港", "New Harbor");
    const revisedTitle = label("公会新门 #", "New guild gate #");
    const summary = "A new summary.\nSecond line: still text.";
    const bodyAddition = "harborMaster: Lena\n";
    const packageId = await seedPackage(page, locale);
    await page.goto(`/#/content/${packageId}`);
    const packageEditor = await openFilePanel(page, "content", chinese);
    const open = async (path: string) => {
      await page
        .getByRole("button", {
          name: `${label("打开", "Open")} ${path}`,
          exact: true,
        })
        .click();
      return page.getByRole("textbox", {
        name: `${label("编辑", "Edit")} ${path}`,
        exact: true,
      });
    };
    const metadata = page.getByRole("group", {
      name: label("文档元数据", "Document metadata"),
      exact: true,
    });
    const title = metadata.getByRole("textbox", {
      name: titleName,
      exact: true,
    });
    const ref = metadata.getByRole("textbox", { name: refName, exact: true });

    const harbor = await open(`world/${yamlPath}`);
    await expect(harbor).toHaveValue(yamlSource);
    await expect(title).toHaveValue("Old Harbor");
    await expect(
      metadata.getByRole("textbox", {
        name: label("别名 1", "Alias 1"),
        exact: true,
      }),
    ).toHaveValue("Wharf");
    await ref.fill("current-situation");
    await ref.blur();
    await expect(ref).toHaveAttribute("aria-invalid", "true");
    await expect(
      metadata.getByText(
        label(
          "此短引用已用于 world/current-situation.yaml。",
          "This short reference is already used in world/current-situation.yaml.",
        ),
      ),
    ).toBeVisible();
    await ref.fill("lantern-harbor");
    await title.fill(newTitle);
    await metadata
      .getByRole("textbox", { name: label("文档摘要", "Document summary") })
      .fill(summary);
    await metadata.getByRole("button", { name: aliasesName }).click();
    await metadata
      .getByRole("textbox", { name: label("别名 2", "Alias 2"), exact: true })
      .fill("Lantern Wharf");
    await metadata
      .getByRole("button", { name: label("移除别名 1", "Remove alias 1") })
      .click();
    await metadata
      .getByRole("button", {
        name: label("继续写正文", "Continue writing the body"),
      })
      .click();
    await expect(harbor).toBeFocused();
    expect(
      await harbor.evaluate(
        (element: HTMLTextAreaElement) => element.selectionStart,
      ),
    ).toBe((await harbor.inputValue()).length);
    await page.keyboard.insertText(bodyAddition);
    const savedYaml = await harbor.inputValue();
    expect(savedYaml).toContain("id: location.harbor\n");
    for (const comment of [
      "# file comment",
      "# title comment",
      "# summary comment",
      "# alias header",
      "# alias note",
      "# alias comment",
      "# retirement comment",
    ])
      expect(savedYaml).toContain(comment);
    expect(savedYaml).toContain(yamlBody + bodyAddition);

    const gates = await open(`world/${markdownPath}`);
    await metadata.getByRole("button", { name: aliasesName }).click();
    await metadata
      .getByRole("textbox", { name: label("别名 1", "Alias 1"), exact: true })
      .fill("Dusk gate");
    expect((await gates.inputValue()).split("\n---\n")[1]).toBe(markdownBody);
    await expect(await open(`world/${yamlPath}`)).toHaveValue(savedYaml);
    const asset = await open("notes.md");
    await expect(metadata).toHaveCount(0);
    await expect(asset).toHaveValue(packageNote);
    await packageEditor
      .getByRole("button", { name: label("整批保存", "Save all changes") })
      .click();
    await expect(
      packageEditor.getByText(label("当前树已保存", "Current tree saved"), {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await openFilePanel(page, "content", chinese);
    await expect(await open(`world/${yamlPath}`)).toHaveValue(savedYaml);
    await expect(title).toHaveValue(newTitle);

    const { world } = await runtime<{ world: { worldId: string } }>(page, {
      type: "world.create",
      operationId: `metadata-${packageId}`,
      packageId,
    });
    await page.goto(`/#/world/${world.worldId}`);
    await openRevision(page, chinese);
    const revisionEditor = await openFilePanel(page, "revision", chinese);
    const revisionGates = await open(`state/${markdownPath}`);
    const original = await revisionGates.inputValue();
    await expect(ref).toHaveAttribute("readonly", "");
    await expect(ref).toHaveValue("guild-gates");
    const malformed = original.replace("# Guild Gates", "# Wrong heading");
    await revisionGates.fill(malformed);
    await expect(metadata).toHaveCount(0);
    await expect(revisionGates).toHaveValue(malformed);
    await expect(
      revisionEditor.getByText(
        label(
          "无法读取文档元数据。请在下方编辑源码修复。",
          "This document's metadata could not be read. Repair it in the source editor below.",
        ),
      ),
    ).toBeVisible();
    await revisionGates.fill(original);
    await expect(title).toHaveValue("Guild Gates");
    await title.fill("");
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await title.fill(revisedTitle);
    const revisedGates = await revisionGates.inputValue();
    expect(revisedGates.split("\n---\n")[1]).toBe(
      markdownBody.replace("# Guild Gates ##", `# ${revisedTitle} ##`),
    );
    expect(revisedGates).toContain("id: rules.gates");
    expect(revisedGates).toContain("# header note");

    const newPath = "state/locations/custom-pier.yaml";
    await revisionEditor
      .getByText(label("新建文件", "Create file"), { exact: true })
      .click();
    await revisionEditor
      .getByRole("textbox", { name: label("新文件路径", "New file path") })
      .fill(newPath);
    await revisionEditor
      .getByRole("button", { name: label("加入草稿", "Add to draft") })
      .click();
    await expect(ref).not.toHaveAttribute("readonly", "");
    await ref.fill("first-pier");
    await revisionEditor
      .getByRole("button", { name: label("保存到修订", "Save to revision") })
      .click();
    await expect(
      revisionEditor.getByText(
        label("修订工作树已保存", "Revision worktree saved"),
        { exact: true },
      ),
    ).toBeVisible();
    await page.reload();
    await openRevision(page, chinese);
    await openFilePanel(page, "revision", chinese);
    await expect(await open(`state/${markdownPath}`)).toHaveValue(revisedGates);
    await expect(ref).toHaveAttribute("readonly", "");
    const pier = await open(newPath);
    await expect(ref).not.toHaveAttribute("readonly", "");
    await expect(ref).toHaveValue("first-pier");
    await ref.fill("final-pier");
    const finalPier = await pier.inputValue();
    await ref.press("Control+s");
    await expect(
      revisionEditor.getByText(
        label("修订工作树已保存", "Revision worktree saved"),
        { exact: true },
      ),
    ).toBeVisible();
    await revisionEditor
      .getByRole("button", { name: label("收起文件面板", "Close file panel") })
      .click();
    await page
      .getByRole("button", {
        name: label("应用并解锁", "Apply and unlock"),
        exact: true,
      })
      .click();
    await expect(page.locator(".world-feedback.status")).toContainText(
      label(
        "世界修订已应用并解锁",
        "The world revision was applied and unlocked",
      ),
    );
    const settled = await runtime<ContentTreeFile[]>(page, {
      type: "world.surface.read",
      worldId: world.worldId,
      surface: "revision",
    });
    expect(
      settled.find(({ path }) => path === `state/${markdownPath}`)?.contents,
    ).toBe(revisedGates);
    expect(settled.find(({ path }) => path === newPath)?.contents).toBe(
      finalPier,
    );
  });
}

async function openFilePanel(
  page: Page,
  kind: "content" | "revision",
  chinese: boolean,
) {
  const packageFiles = kind === "content";
  const tools = packageFiles
    ? chinese
      ? "设定完善工具"
      : "Setting-improvement tools"
    : chinese
      ? "世界修订工具"
      : "World-revision tools";
  const rail = packageFiles
    ? chinese
      ? "内容包文件编辑"
      : "Content-package file editing"
    : chinese
      ? "世界修订文件编辑"
      : "Edit world-revision files";
  await page
    .getByRole("navigation", { name: tools })
    .getByRole("button", { name: chinese ? "编辑" : "Edit", exact: true })
    .click();
  return page.getByRole("complementary", { name: rail });
}

async function openRevision(page: Page, chinese: boolean): Promise<void> {
  await page
    .getByRole("button", { name: chinese ? "世界" : "Worlds", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: chinese ? "修订当前世界" : "Revise current world",
      exact: true,
    })
    .click();
}

async function seedPackage(
  page: Page,
  locale: "zh-CN" | "en",
): Promise<string> {
  await runtime(page, { type: "preferences.save", locale });
  await runtime(page, {
    type: "model.save",
    connection: {
      name: "Metadata test",
      presetId: "custom",
      provider: "chat_completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "metadata-fixture",
      modelId: "metadata-model",
      contextWindowTokens: 64000,
      maxOutputTokens: 8192,
    },
  });
  const { localId } = await runtime<{ localId: string }>(page, {
    type: "content.create",
  });
  const { files, treeRevision } = await runtime<{
    files: ContentTreeFile[];
    treeRevision: string;
  }>(page, { type: "content.read", packageId: localId });
  const { status } = await runtime<{ status: string }>(page, {
    type: "content.replace",
    packageId: localId,
    baseTreeRevision: treeRevision,
    files: [
      ...files,
      { path: `world/${yamlPath}`, contents: yamlSource },
      { path: `world/${markdownPath}`, contents: markdownSource },
      { path: "notes.md", contents: packageNote },
    ],
  });
  expect(status).toBe("usable");
  return localId;
}

async function runtime<T = unknown>(
  page: Page,
  request: V1Request,
): Promise<T> {
  const response = await page.request.post("/api/runtime/v1", {
    data: { protocol: "narraeon.runtime/v1", request },
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  return body.result;
}
