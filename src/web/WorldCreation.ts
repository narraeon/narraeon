import type { V1Request } from "../protocol/v1.ts";
import { createClientId } from "./ClientId.ts";
import type { HomeWorld } from "./HomeScreen.tsx";
import type { RuntimeClient } from "./runtimeClient.ts";
import { ReadTarget } from "./ReadTarget.ts";

type CreateWorld = Omit<
  Extract<V1Request, { type: "world.create" }>,
  "type" | "operationId"
>;
type CreationOutcome =
  | { outcome: "created"; world: HomeWorld }
  | { outcome: "in_progress" | "not_created" };

/** Owns one page's creation intent across explicit retries and lost receipts. */
export class WorldCreation {
  private attempt: { key: string; operationId: string } | null = null;
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

  async recover(): Promise<HomeWorld | null> {
    const receipt = await this.outcome?.recover();
    if (receipt?.outcome !== "created") return null;
    this.clear();
    return receipt.world;
  }

  async create(
    client: Pick<RuntimeClient, "request">,
    input: CreateWorld,
    treeRevision?: string,
  ): Promise<HomeWorld> {
    const key = JSON.stringify([input.packageId, treeRevision]);
    if (this.attempt?.key !== key) {
      this.clear();
      this.attempt = { key, operationId: createClientId("create") };
    }
    const { operationId } = this.attempt;
    let world: HomeWorld;
    try {
      ({ world } = await client.request<{ world: HomeWorld }>({
        type: "world.create",
        ...input,
        operationId,
      }));
    } catch (error) {
      this.outcome ??= new ReadTarget({
        load: () =>
          client.request<CreationOutcome>({
            type: "world.creation-outcome",
            operationId,
          }),
        apply: () => undefined,
        onSyncFailure: this.onSyncFailure,
      });
      const receipt = await this.outcome.read();
      if (receipt?.outcome !== "created") throw error;
      world = receipt.world;
    }
    this.clear();
    return world;
  }
}
