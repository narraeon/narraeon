import type { V1Request } from "../protocol/v1.ts";
import { createClientId } from "./ClientId.ts";
import type { HomeWorld } from "./HomeScreen.tsx";
import type { RuntimeClient } from "./runtimeClient.ts";

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

  clear(): void {
    this.attempt = null;
  }

  async create(
    client: Pick<RuntimeClient, "request">,
    input: CreateWorld,
    treeRevision?: string,
  ): Promise<HomeWorld> {
    const key = JSON.stringify([input.packageId, input.model, treeRevision]);
    if (this.attempt?.key !== key)
      this.attempt = { key, operationId: createClientId("create") };
    const { operationId } = this.attempt;
    let world: HomeWorld;
    try {
      ({ world } = await client.request<{ world: HomeWorld }>({
        type: "world.create",
        ...input,
        operationId,
      }));
    } catch (error) {
      const receipt = await client
        .request<CreationOutcome>({
          type: "world.creation-outcome",
          operationId,
        })
        .catch(() => null);
      if (receipt?.outcome !== "created") throw error;
      world = receipt.world;
    }
    this.clear();
    return world;
  }
}
