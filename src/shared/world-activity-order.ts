interface WorldActivity {
  worldId: string;
  title: string;
  lastActivityAt: number | null;
}

export function compareWorldActivity(
  left: WorldActivity,
  right: WorldActivity,
): number {
  return (
    (right.lastActivityAt ?? -1) - (left.lastActivityAt ?? -1) ||
    left.title.localeCompare(right.title) ||
    left.worldId.localeCompare(right.worldId)
  );
}
