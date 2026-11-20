import type {
  V1PlayCallChainEvent,
  V1PlayTimelineEventSummary,
} from "../protocol/v1.ts";
import type { ModelRetryEvidence } from "../protocol/modelRetry.ts";

/** Recovery keeps immutable identities; public reads expose only live attempt evidence. */
export function currentRetryEvidence(
  retries: ModelRetryEvidence[] | undefined,
  active: boolean,
): ModelRetryEvidence[] | undefined {
  const current = retries?.at(-1);
  return active && current?.status === "waiting"
    ? [structuredClone(current)]
    : undefined;
}

export function publicAttempt<T extends object>(value: T): T {
  const { retries, retryOf, ...rest } = value as T & {
    retries?: ModelRetryEvidence[];
    retryOf?: unknown;
    status?: string;
  };
  void retryOf;
  const current = currentRetryEvidence(
    retries,
    "status" in value && value.status === "streaming",
  );
  return {
    ...rest,
    ...(current === undefined ? {} : { retries: current }),
  } as T;
}

export function supersededPlayEvents(
  events: readonly (V1PlayCallChainEvent | V1PlayTimelineEventSummary)[],
): number[] {
  const hidden = new Set<number>();
  const calls = new Map<
    number,
    {
      event: Extract<
        V1PlayCallChainEvent | V1PlayTimelineEventSummary,
        { kind: "assistant" }
      >;
      endings: number[];
      settled: boolean;
    }
  >();
  let previous: ReturnType<typeof calls.get>;
  for (const event of events) {
    if (event.kind === "player" || event.kind === "followup") {
      previous = undefined;
      calls.clear();
    }
    if (event.kind === "assistant") {
      const parent =
        event.retryOf === undefined
          ? event.attempt > 1
            ? previous
            : undefined
          : calls.get(event.retryOf);
      if (parent?.event.status === "interrupted" && !parent.settled) {
        hidden.add(parent.event.id);
        parent.endings.forEach((id) => hidden.add(id));
      }
      previous = { event, endings: [], settled: false };
      calls.set(event.id, previous);
    } else if (
      previous !== undefined &&
      (event.kind === "failure" || event.kind === "cancellation")
    )
      previous.endings.push(event.id);
    else if (
      previous !== undefined &&
      (event.kind === "tool_call" || event.kind === "tool_result")
    )
      previous.settled = true;
  }
  return [...hidden].sort((a, b) => a - b);
}

export function latestAuthoringCalls<
  T extends {
    id: string;
    retryOf?: string;
    status?: string;
    assistantItemIndex?: number;
  },
>(calls: readonly T[]): T[] {
  const hidden = new Set<string>();
  const known = new Map<string, T>();
  for (const call of calls) {
    const prior =
      call.retryOf === undefined ? undefined : known.get(call.retryOf);
    if (
      prior !== undefined &&
      prior.status !== "completed" &&
      prior.assistantItemIndex === undefined
    )
      hidden.add(prior.id);
    known.set(call.id, call);
  }
  return calls.filter(({ id }) => !hidden.has(id));
}
