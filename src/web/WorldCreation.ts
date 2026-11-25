import type { ProtagonistTemplate } from "../protocol/protagonistTemplates.ts";
import type { V1Request } from "../protocol/v1.ts";
import { createClientId } from "./ClientId.ts";
import type { HomeWorld } from "./HomeScreen.tsx";
import {
  prepareProtagonistCustomization,
  type ProtagonistCustomization,
} from "./ProtagonistCustomization.ts";
import type { RuntimeClient } from "./runtimeClient.ts";
import { ReadTarget } from "./ReadTarget.ts";

type CreateWorld = Omit<
  Extract<V1Request, { type: "world.create" }>,
  "type" | "operationId"
>;
type CreationOutcome =
  | { outcome: "created"; world: HomeWorld }
  | { outcome: "in_progress" | "not_created" };
export interface CreatedWorldReceipt {
  world: HomeWorld;
  customization: ProtagonistCustomization | null;
}
interface CreationAttempt {
  key: string;
  operationId: string;
  customization: ProtagonistCustomization | null;
}

const attemptStateKey = "narraeonWorldCreation";

function readCreationAttempt(): CreationAttempt | null {
  const historyState: unknown = window.history.state;
  const state =
    typeof historyState === "object" &&
    historyState !== null &&
    attemptStateKey in historyState
      ? historyState[attemptStateKey]
      : undefined;
  if (
    typeof state !== "object" ||
    state === null ||
    !("key" in state) ||
    typeof state.key !== "string" ||
    !("operationId" in state) ||
    typeof state.operationId !== "string" ||
    !("customization" in state)
  )
    return null;
  return state as CreationAttempt;
}

function recordCreationAttempt(attempt: CreationAttempt | null): void {
  try {
    const state: unknown = window.history.state;
    window.history.replaceState(
      {
        ...(typeof state === "object" ? state : {}),
        [attemptStateKey]: attempt,
      },
      "",
    );
  } catch {
    // Keep the current attempt in memory if history state is unavailable.
  }
}

/** Owns one page's creation intent across explicit retries, reloads and lost receipts. */
export class WorldCreation {
  private attempt: CreationAttempt | null = null;
  private outcome: ReadTarget<CreationOutcome> | null = null;
  private readonly onSyncFailure: (failed: boolean, reason?: unknown) => void;

  constructor(
    onSyncFailure: (failed: boolean, reason?: unknown) => void = () =>
      undefined,
  ) {
    this.onSyncFailure = onSyncFailure;
  }

  clear(): void {
    this.outcome?.dispose();
    this.outcome = null;
    this.attempt = null;
    this.onSyncFailure(false);
  }

  private readOutcome(
    client: Pick<RuntimeClient, "request">,
    operationId: string,
  ): ReadTarget<CreationOutcome> {
    return (this.outcome ??= new ReadTarget({
      load: () =>
        client.request<CreationOutcome>({
          type: "world.creation-outcome",
          operationId,
        }),
      apply: () => undefined,
      onSyncFailure: this.onSyncFailure,
    }));
  }

  private accept(
    world: HomeWorld,
    attempt: CreationAttempt,
  ): CreatedWorldReceipt {
    recordCreationAttempt(null);
    this.clear();
    return { world, customization: attempt.customization };
  }

  async restore(
    client: Pick<RuntimeClient, "request">,
  ): Promise<CreatedWorldReceipt | null> {
    if (this.attempt !== null) return null;
    const attempt = readCreationAttempt();
    if (attempt === null) return null;
    this.attempt = attempt;
    return this.recover(client);
  }

  async recover(
    client?: Pick<RuntimeClient, "request">,
  ): Promise<CreatedWorldReceipt | null> {
    const attempt = this.attempt;
    if (attempt === null) return null;
    const outcome =
      client === undefined
        ? this.outcome
        : this.readOutcome(client, attempt.operationId);
    const receipt = await outcome?.recover();
    if (this.attempt !== attempt || receipt?.outcome !== "created") return null;
    return this.accept(receipt.world, attempt);
  }

  async create(
    client: Pick<RuntimeClient, "request">,
    input: CreateWorld,
    treeRevision?: string,
    template?: ProtagonistTemplate,
  ): Promise<CreatedWorldReceipt> {
    const key = JSON.stringify([input, treeRevision, template?.id]);
    if (this.attempt?.key !== key) {
      this.clear();
      this.attempt = {
        key,
        operationId: createClientId("create"),
        customization:
          template === undefined
            ? null
            : prepareProtagonistCustomization(template),
      };
      recordCreationAttempt(this.attempt);
    }
    const attempt = this.attempt;
    const { operationId } = attempt;
    let world: HomeWorld;
    try {
      ({ world } = await client.request<{ world: HomeWorld }>({
        type: "world.create",
        ...input,
        operationId,
      }));
    } catch (error) {
      const receipt = await this.readOutcome(client, operationId).read();
      if (receipt?.outcome !== "created") throw error;
      world = receipt.world;
    }
    return this.accept(world, attempt);
  }
}
