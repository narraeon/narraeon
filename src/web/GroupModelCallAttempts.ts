export function groupCallAttempts<T>(
  items: readonly T[],
  identity: (item: T) => string,
  retryOf: (item: T) => string | undefined,
): T[][] {
  const groups: T[][] = [];
  const byId = new Map<string, T[]>();
  for (const item of items) {
    const prior = retryOf(item);
    const group = prior === undefined ? undefined : byId.get(prior);
    const attempts = group ?? [];
    if (group === undefined) groups.push(attempts);
    attempts.push(item);
    byId.set(identity(item), attempts);
  }
  return groups;
}
