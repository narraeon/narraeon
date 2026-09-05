/** Observation failure never participates in a Runtime mutation. */
export class ConversationChanges {
  readonly #listeners = new Map<string, Set<(durable: boolean) => void>>();

  subscribe(scope: string, listener: (durable: boolean) => void): () => void {
    const listeners =
      this.#listeners.get(scope) ?? new Set<(durable: boolean) => void>();
    listeners.add(listener);
    this.#listeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(scope);
    };
  }

  publish(scope: string, durable = true): void {
    for (const listener of this.#listeners.get(scope) ?? []) {
      try {
        listener(durable);
      } catch {
        /* Observers cannot affect settlement. */
      }
    }
  }
}
