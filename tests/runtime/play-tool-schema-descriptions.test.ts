import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";

import type { ModelProviderKind } from "../../src/protocol/modelConnections.ts";
import { FileNativeModelHost } from "../../src/runtime/model/FileNativeModelAdapters.ts";
import { ModelHostFailureError } from "../../src/runtime/model/ModelHost.ts";
import { builtinDefaultPlayPresetBinding } from "../../src/runtime/play/FileNativePlayPresetStore.ts";
import {
  createMinimalFileNativePreviewInput,
  FileNativePromptCompiler,
} from "../../src/runtime/prompt/FileNativePromptCompiler.ts";

const providers = [
  "chat_completions",
  "openai_responses",
  "anthropic_messages",
  "google_interactions",
] as const;
const locales = ["en", "zh-CN"] as const;
const toolNames = [
  "history_list",
  "history_search",
  "history_read",
  "context_search",
  "world_patch",
  "world_create",
  "world_retire",
] as const;

interface Schema {
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
}

type FieldDescription = [path: string, description: string | undefined];

function fieldDescriptions(schema: Schema, path: string): FieldDescription[] {
  return [
    ...Object.entries(schema.properties ?? {}).flatMap<FieldDescription>(
      ([name, field]) => {
        const fieldPath = `${path}.${name}`;
        return [
          [fieldPath, field.description],
          ...fieldDescriptions(field, fieldPath),
        ];
      },
    ),
    ...(schema.items === undefined
      ? []
      : fieldDescriptions(schema.items, `${path}[]`)),
    ...(schema.oneOf ?? []).flatMap<FieldDescription>((branch, index) => {
      const branchPath = `${path}.oneOf[${index}]`;
      return [
        [branchPath, branch.description],
        ...fieldDescriptions(branch, branchPath),
      ];
    }),
  ];
}

interface WireTool {
  name: string;
  description: string;
  parameters?: Schema;
  input_schema?: Schema;
}

function wireTools(body: string, provider: ModelProviderKind) {
  const { tools } = JSON.parse(body) as {
    tools: (WireTool & { function?: WireTool })[];
  };
  return tools.map((tool) => {
    const definition = provider === "chat_completions" ? tool.function! : tool;
    return {
      name: definition.name,
      description: definition.description,
      inputSchema:
        provider === "anthropic_messages"
          ? definition.input_schema!
          : definition.parameters!,
    };
  });
}

function withoutDescriptions(schema: object): Schema {
  return JSON.parse(
    JSON.stringify(schema, (key, value: unknown) =>
      key === "description" ? undefined : value,
    ),
  ) as Schema;
}

test.each(
  providers.flatMap((provider) =>
    locales.map((locale) => [provider, locale] as const),
  ),
)(
  "%s sends %s play tool field descriptions and preserves frozen definitions",
  async (provider, locale) => {
    const fetch_ = vi.fn<typeof fetch>().mockImplementation(() => {
      // The test transport stops after recording the request body.
      return Promise.resolve(
        new Response("synthetic response", { status: 400 }),
      );
    });
    const connection = {
      provider,
      baseUrl: "https://provider.invalid/v1",
      apiKey: "synthetic-key",
      modelId: "synthetic-model",
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_048,
    };
    const host = new FileNativeModelHost(connection, fetch_);
    const playerInput = "I look around.";
    const { bootstrap } = new FileNativePromptCompiler({
      locale,
    }).compilePlayCallChain(
      createMinimalFileNativePreviewInput({
        ...connection,
        playerInput,
        playerInputPlacement: "append",
        locale,
      }),
      builtinDefaultPlayPresetBinding(locale),
    );
    const request = host.freezeRequest({
      bootstrap,
      tools: bootstrap.tools,
      toolUniverse: bootstrap.toolUniverse,
      allowedTools: bootstrap.tools.map(({ name }) => name),
      toolStrategy: bootstrap.toolStrategy,
      appended: [{ kind: "player", text: playerInput }],
      maxOutputTokens: connection.maxOutputTokens,
    });
    await expect(host.exchange(request)).rejects.toBeInstanceOf(
      ModelHostFailureError,
    );
    expect(fetch_).toHaveBeenCalledTimes(1);
    const sent = wireTools(fetch_.mock.calls[0]![1]!.body as string, provider);
    expect(sent).toEqual(bootstrap.toolUniverse);

    const tools = toolNames.map((name) =>
      sent.find((tool) => tool.name === name)!,
    );
    const shapes = tools.map(({ name, inputSchema }) => ({
      name,
      inputSchema: withoutDescriptions(inputSchema),
    }));
    const shapeHash = createHash("sha256")
      .update(JSON.stringify(shapes))
      .digest("hex");
    // Actual wire schemas at 80821ca, with descriptions omitted at every depth.
    expect(shapeHash).toBe(
      "53a967a5f403c450e12726a1198bd3e22e3174f59004fb1cba0216fe80b43398",
    );

    const missing = tools.flatMap(({ name, inputSchema }) =>
      fieldDescriptions(inputSchema, name)
        .filter(
          ([, description]) =>
            typeof description !== "string" ||
            !description.trim() ||
            /\p{Script=Han}/u.test(description) !== (locale === "zh-CN"),
        )
        .map(([path]) => path),
    );
    expect(missing).toEqual([]);
    for (const { name, description } of tools) {
      const sentences = description.match(/[.!?](?:\s|$)|[。！？]/gu) ?? [];
      expect(sentences.length, name).toBeGreaterThanOrEqual(2);
      expect(sentences.length, name).toBeLessThanOrEqual(3);
    }

    // Simulate persisted definitions from before field annotations existed.
    const oldTools = sent.map((tool) => {
      const shape = shapes.find(({ name }) => name === tool.name);
      return shape === undefined
        ? tool
        : { ...shape, description: `Frozen description for ${tool.name}` };
    });
    const oldAllowedTools = oldTools.filter(({ name }) =>
      request.allowedTools?.includes(name),
    );
    const frozen = JSON.stringify({
      ...request,
      bootstrap: {
        ...bootstrap,
        tools: oldAllowedTools,
        toolUniverse: oldTools,
      },
      tools: oldAllowedTools,
      toolUniverse: oldTools,
    });
    const saved = JSON.parse(frozen) as typeof request;
    await expect(host.exchange(saved)).rejects.toBeInstanceOf(
      ModelHostFailureError,
    );
    expect(fetch_).toHaveBeenCalledTimes(2);
    expect(
      wireTools(fetch_.mock.calls[1]![1]!.body as string, provider),
    ).toEqual(oldTools);
    expect(JSON.stringify(saved)).toBe(frozen);
  },
);
