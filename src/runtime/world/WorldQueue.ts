import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

/**
 * Serializes world-changing operations inside one service process.
 *
 * One data directory is served by one process (ADR-0044), so ordering is
 * enforced with promise chains instead of cross-process lock files. Re-entry
 * is recognized through AsyncLocalStorage: an action already running for a
 * world runs its nested world operations directly instead of waiting on
 * itself.
 */
export class WorldQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, number>();
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();

  run<Value>(worldId: string, action: () => Promise<Value>): Promise<Value> {
    const held = this.#held.getStore();
    if (held?.has(worldId)) return action();
    const previous = this.#tails.get(worldId) ?? Promise.resolve();
    const nextHeld = new Set(held ?? []);
    nextHeld.add(worldId);
    this.#pending.set(worldId, this.pendingCount(worldId) + 1);
    const result = previous.then(() => this.#held.run(nextHeld, action));
    const tail = result.then(
      () => this.#finish(worldId),
      () => this.#finish(worldId),
    );
    this.#tails.set(worldId, tail);
    void tail.then(() => {
      if (this.#tails.get(worldId) === tail) this.#tails.delete(worldId);
    });
    return result;
  }

  /** Operations for worldId that are running or waiting for their turn. */
  pendingCount(worldId: string): number {
    return this.#pending.get(worldId) ?? 0;
  }

  /** True while the current async context is inside an operation for worldId. */
  isHeld(worldId: string): boolean {
    return this.#held.getStore()?.has(worldId) ?? false;
  }

  #finish(worldId: string): void {
    const remaining = this.pendingCount(worldId) - 1;
    if (remaining > 0) this.#pending.set(worldId, remaining);
    else this.#pending.delete(worldId);
  }
}

const queuesByDataRoot = new Map<string, WorldQueue>();

/** The queue shared by every store that changes a world under one data root. */
export function worldQueueFor(dataRoot: string): WorldQueue {
  const key = resolve(dataRoot);
  let queue = queuesByDataRoot.get(key);
  if (queue === undefined) {
    queue = new WorldQueue();
    queuesByDataRoot.set(key, queue);
  }
  return queue;
}
