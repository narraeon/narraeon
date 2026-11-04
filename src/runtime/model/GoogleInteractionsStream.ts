import {
  ModelHostOutcomeUnknownError,
  type ModelHostDelta,
  type ModelHostResponse,
} from "./ModelHost.ts";
import { providerStreamEvents } from "./ProviderStream.ts";
import { validGoogleInteractionsSteps } from "./ProviderExchangeState.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw new ModelHostOutcomeUnknownError(
    "Google Interactions stream is incomplete or cannot be preserved losslessly",
  );
}

function parseLossless(source: string): unknown {
  return JSON.parse(
    source,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          context?.source !== JSON.stringify(value))
      )
        invalid();
      return value;
    },
  ) as unknown;
}

/** Assemble only documented deltas; unknown shapes fail closed rather than lose native data. */
export async function aggregateGoogleInteractions(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: ModelHostDelta) => void,
  onUsage?: (usage: unknown) => void,
): Promise<{
  steps: Record<string, unknown>[];
  status: string;
  usage: unknown;
  continuationToken: unknown;
  completeLifecycle: boolean;
}> {
  const steps = new Map<
    number,
    { step: Record<string, unknown>; stopped: boolean; args: string | null }
  >();
  let terminal: Record<string, unknown> | undefined;
  let latestUsage: unknown;
  let created = false;
  let lifecycleValid = true;
  let sawStep = false;
  let done = false;
  for await (const event of providerStreamEvents(body, { fatalUtf8: true })) {
    if (event.data === "[DONE]") {
      if (terminal === undefined || done) lifecycleValid = false;
      done = true;
      continue;
    }
    if (done || terminal !== undefined) lifecycleValid = false;
    let value: unknown;
    try {
      value = parseLossless(event.data);
    } catch {
      invalid();
    }
    if (!record(value) || typeof value.event_type !== "string") invalid();
    if (!created && value.event_type !== "interaction.created")
      lifecycleValid = false;
    if (value.event_type === "interaction.created") {
      if (created || sawStep || terminal !== undefined || done)
        lifecycleValid = false;
      created = true;
      continue;
    }
    if (value.event_type === "interaction.status_update") {
      if (terminal !== undefined) invalid();
      if (value.usage !== undefined) {
        latestUsage = value.usage;
        onUsage?.(value.usage);
      }
      continue;
    }
    if (value.event_type === "interaction.completed") {
      if (terminal !== undefined || !record(value.interaction)) invalid();
      terminal = value.interaction;
      if (terminal.usage !== undefined) {
        latestUsage = terminal.usage;
        onUsage?.(terminal.usage);
      }
      continue;
    }
    if (
      terminal !== undefined ||
      typeof value.index !== "number" ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0
    )
      invalid();
    const index = value.index;
    sawStep = true;
    if (value.event_type === "step.start") {
      if (
        steps.has(index) ||
        !record(value.step) ||
        typeof value.step.type !== "string"
      )
        invalid();
      steps.set(index, {
        step: structuredClone(value.step),
        stopped: false,
        args: null,
      });
      continue;
    }
    const current = steps.get(index);
    if (current === undefined || current.stopped) invalid();
    if (value.event_type === "step.stop") {
      if (current.args !== null) {
        try {
          current.step.arguments = parseLossless(current.args);
        } catch {
          invalid();
        }
      }
      current.stopped = true;
      continue;
    }
    if (value.event_type !== "step.delta" || !record(value.delta)) invalid();
    const delta = value.delta;
    if (
      delta.type === "thought_signature" &&
      current.step.type === "thought" &&
      typeof delta.signature === "string" &&
      Object.keys(delta).length === 2 &&
      (current.step.signature === undefined || current.step.signature === "") &&
      delta.signature.length > 0
    ) {
      current.step.signature = delta.signature;
    } else if (
      (delta.type === "arguments_delta" || delta.type === "arguments") &&
      current.step.type === "function_call"
    ) {
      const fragment =
        delta.type === "arguments_delta"
          ? delta.arguments
          : delta.partial_arguments;
      if (typeof fragment !== "string" || Object.keys(delta).length !== 2)
        invalid();
      if (
        current.args === null &&
        current.step.arguments !== undefined &&
        (!record(current.step.arguments) ||
          Object.keys(current.step.arguments).length !== 0)
      )
        invalid();
      current.args = (current.args ?? "") + fragment;
    } else if (
      delta.type === "text" &&
      current.step.type === "model_output" &&
      typeof delta.text === "string" &&
      Object.keys(delta).length === 2
    ) {
      if (current.step.content === undefined) current.step.content = [];
      if (!Array.isArray(current.step.content)) invalid();
      const last: unknown = current.step.content.at(-1);
      if (
        record(last) &&
        last.type === "text" &&
        typeof last.text === "string" &&
        Object.keys(last).length === 2
      )
        last.text += delta.text;
      else current.step.content.push({ type: "text", text: delta.text });
      onDelta?.({ kind: "text", text: delta.text });
    } else if (
      delta.type === "thought_summary" &&
      current.step.type === "thought" &&
      record(delta.content) &&
      delta.content.type === "text" &&
      typeof delta.content.text === "string" &&
      Object.keys(delta).length === 2 &&
      Object.keys(delta.content).length === 2
    ) {
      if (current.step.summary === undefined) current.step.summary = [];
      if (!Array.isArray(current.step.summary)) invalid();
      const last: unknown = current.step.summary.at(-1);
      if (
        record(last) &&
        last.type === "text" &&
        typeof last.text === "string" &&
        Object.keys(last).length === 2
      )
        last.text += delta.content.text;
      else current.step.summary.push(structuredClone(delta.content));
      onDelta?.({ kind: "reasoning", text: delta.content.text });
    } else invalid();
  }
  if (
    terminal === undefined ||
    typeof terminal.status !== "string" ||
    [...steps.values()].some((entry) => !entry.stopped)
  )
    invalid();
  const ordered = [...steps.entries()].sort(([a], [b]) => a - b);
  if (ordered.some(([index], position) => index !== position)) invalid();
  return {
    steps: ordered.map(([, entry]) => entry.step),
    status: terminal.status,
    usage: latestUsage,
    continuationToken: terminal.continuation_token,
    completeLifecycle: created && lifecycleValid,
  };
}

export function projectGoogleInteractions(payload: {
  steps: Record<string, unknown>[];
  status: string;
  usage: unknown;
}): Omit<ModelHostResponse, "usage"> {
  if (payload.status !== "completed" && payload.status !== "requires_action")
    throw new ModelHostOutcomeUnknownError(
      `Google Interactions returned unsupported terminal status: ${payload.status}`,
    );
  if (!validGoogleInteractionsSteps(payload.steps)) invalid();
  const calls: NonNullable<ModelHostResponse["toolCalls"]> = [];
  let text = "";
  let reasoning = "";
  for (const step of payload.steps) {
    if (step.type === "function_call") {
      if (
        typeof step.id !== "string" ||
        !step.id ||
        typeof step.name !== "string" ||
        !step.name ||
        !record(step.arguments) ||
        calls.some((call) => call.id === step.id)
      )
        invalid();
      calls.push({
        id: step.id,
        name: step.name,
        arguments: structuredClone(step.arguments),
      });
    } else if (step.type === "model_output") {
      if (!Array.isArray(step.content)) invalid();
      for (const part of step.content)
        if (
          record(part) &&
          part.type === "text" &&
          typeof part.text === "string"
        )
          text += part.text;
    } else if (step.type === "thought" && Array.isArray(step.summary)) {
      for (const part of step.summary)
        if (
          record(part) &&
          part.type === "text" &&
          typeof part.text === "string"
        )
          reasoning += part.text;
    }
  }
  if ((payload.status === "requires_action") !== calls.length > 0) invalid();
  return {
    ...(text === "" ? {} : { text }),
    ...(reasoning === "" ? {} : { reasoningContent: reasoning }),
    toolCalls: calls,
    stopReason: payload.status,
    providerState: {
      protocol: "google_interactions",
      steps: structuredClone(payload.steps),
    },
  };
}
