export type UnifiedDiffRow =
  | {
      kind: "context" | "remove" | "add";
      marker: " " | "-" | "+";
      oldLine: number | null;
      newLine: number | null;
      text: string;
    }
  | { kind: "skip"; count: number };

interface RawDiffLine {
  kind: "context" | "remove" | "add";
  text: string;
}

const lcsCellLimit = 80_000;
const maximumMyersEditDistance = 1_024;

export function buildUnifiedDiffRows(
  before: string | null,
  after: string | null,
  contextLines = 3,
): UnifiedDiffRow[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const raw: RawDiffLine[] = [];
  diffRegion(
    beforeLines,
    0,
    beforeLines.length,
    afterLines,
    0,
    afterLines.length,
    raw,
  );
  let oldLine = 1;
  let newLine = 1;
  const numbered = raw.map(
    (line): Exclude<UnifiedDiffRow, { kind: "skip" }> => {
      if (line.kind === "context")
        return {
          ...line,
          marker: " ",
          oldLine: oldLine++,
          newLine: newLine++,
        };
      if (line.kind === "remove")
        return {
          ...line,
          marker: "-",
          oldLine: oldLine++,
          newLine: null,
        };
      return {
        ...line,
        marker: "+",
        oldLine: null,
        newLine: newLine++,
      };
    },
  );
  return collapseContext(numbered, Math.max(0, Math.floor(contextLines)));
}

function splitLines(text: string | null): string[] {
  return text === null ? [] : text.split("\n");
}

function diffRegion(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
  output: RawDiffLine[],
): void {
  while (
    beforeStart < beforeEnd &&
    afterStart < afterEnd &&
    before[beforeStart] === after[afterStart]
  ) {
    output.push({ kind: "context", text: before[beforeStart]! });
    beforeStart += 1;
    afterStart += 1;
  }

  let commonSuffix = 0;
  while (
    beforeStart < beforeEnd - commonSuffix &&
    afterStart < afterEnd - commonSuffix &&
    before[beforeEnd - commonSuffix - 1] === after[afterEnd - commonSuffix - 1]
  )
    commonSuffix += 1;

  const coreBeforeEnd = beforeEnd - commonSuffix;
  const coreAfterEnd = afterEnd - commonSuffix;
  if (beforeStart === coreBeforeEnd) {
    for (let index = afterStart; index < coreAfterEnd; index += 1)
      output.push({ kind: "add", text: after[index]! });
  } else if (afterStart === coreAfterEnd) {
    for (let index = beforeStart; index < coreBeforeEnd; index += 1)
      output.push({ kind: "remove", text: before[index]! });
  } else if (
    (coreBeforeEnd - beforeStart) * (coreAfterEnd - afterStart) <=
    lcsCellLimit
  ) {
    lcsDiff(
      before,
      beforeStart,
      coreBeforeEnd,
      after,
      afterStart,
      coreAfterEnd,
      output,
    );
  } else {
    const anchors = patienceAnchors(
      before,
      beforeStart,
      coreBeforeEnd,
      after,
      afterStart,
      coreAfterEnd,
    );
    if (anchors.length === 0) {
      if (
        !boundedMyersDiff(
          before,
          beforeStart,
          coreBeforeEnd,
          after,
          afterStart,
          coreAfterEnd,
          output,
        )
      ) {
        for (let index = beforeStart; index < coreBeforeEnd; index += 1)
          output.push({ kind: "remove", text: before[index]! });
        for (let index = afterStart; index < coreAfterEnd; index += 1)
          output.push({ kind: "add", text: after[index]! });
      }
    } else {
      let nextBefore = beforeStart;
      let nextAfter = afterStart;
      for (const anchor of anchors) {
        diffRegion(
          before,
          nextBefore,
          anchor.before,
          after,
          nextAfter,
          anchor.after,
          output,
        );
        output.push({ kind: "context", text: before[anchor.before]! });
        nextBefore = anchor.before + 1;
        nextAfter = anchor.after + 1;
      }
      diffRegion(
        before,
        nextBefore,
        coreBeforeEnd,
        after,
        nextAfter,
        coreAfterEnd,
        output,
      );
    }
  }

  for (let offset = commonSuffix; offset > 0; offset -= 1)
    output.push({ kind: "context", text: before[beforeEnd - offset]! });
}

function boundedMyersDiff(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
  output: RawDiffLine[],
): boolean {
  const beforeLength = beforeEnd - beforeStart;
  const afterLength = afterEnd - afterStart;
  const limit = Math.min(beforeLength + afterLength, maximumMyersEditDistance);
  const width = limit * 2 + 3;
  const offset = limit + 1;
  const frontier = new Int32Array(width);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let distance = 0; distance <= limit; distance += 1) {
    trace.push(frontier.slice());
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let left =
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1]! < frontier[index + 1]!)
          ? frontier[index + 1]!
          : frontier[index - 1]! + 1;
      if (left < 0) continue;
      let right = left - diagonal;
      while (
        left < beforeLength &&
        right < afterLength &&
        before[beforeStart + left] === after[afterStart + right]
      ) {
        left += 1;
        right += 1;
      }
      frontier[index] = left;
      if (left >= beforeLength && right >= afterLength) {
        appendMyersTrace(
          before,
          beforeStart,
          after,
          afterStart,
          beforeLength,
          afterLength,
          trace,
          offset,
          output,
        );
        return true;
      }
    }
  }
  return false;
}

function appendMyersTrace(
  before: readonly string[],
  beforeStart: number,
  after: readonly string[],
  afterStart: number,
  beforeLength: number,
  afterLength: number,
  trace: readonly Int32Array[],
  offset: number,
  output: RawDiffLine[],
): void {
  let left = beforeLength;
  let right = afterLength;
  const reversed: RawDiffLine[] = [];
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance]!;
    const diagonal = left - right;
    const index = offset + diagonal;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance && frontier[index - 1]! < frontier[index + 1]!)
        ? diagonal + 1
        : diagonal - 1;
    const previousLeft = frontier[offset + previousDiagonal]!;
    const previousRight = previousLeft - previousDiagonal;
    while (left > previousLeft && right > previousRight) {
      reversed.push({
        kind: "context",
        text: before[beforeStart + left - 1]!,
      });
      left -= 1;
      right -= 1;
    }
    if (distance === 0) break;
    if (left === previousLeft) {
      reversed.push({ kind: "add", text: after[afterStart + right - 1]! });
      right -= 1;
    } else {
      reversed.push({
        kind: "remove",
        text: before[beforeStart + left - 1]!,
      });
      left -= 1;
    }
  }
  output.push(...reversed.reverse());
}

function lcsDiff(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
  output: RawDiffLine[],
): void {
  const beforeLength = beforeEnd - beforeStart;
  const afterLength = afterEnd - afterStart;
  const columns = afterLength + 1;
  const table = new Uint32Array((beforeLength + 1) * columns);
  for (let left = beforeLength - 1; left >= 0; left -= 1) {
    for (let right = afterLength - 1; right >= 0; right -= 1) {
      const cell = left * columns + right;
      table[cell] =
        before[beforeStart + left] === after[afterStart + right]
          ? table[(left + 1) * columns + right + 1]! + 1
          : Math.max(
              table[(left + 1) * columns + right]!,
              table[left * columns + right + 1]!,
            );
    }
  }
  let left = 0;
  let right = 0;
  while (left < beforeLength || right < afterLength) {
    if (
      left < beforeLength &&
      right < afterLength &&
      before[beforeStart + left] === after[afterStart + right]
    ) {
      output.push({ kind: "context", text: before[beforeStart + left]! });
      left += 1;
      right += 1;
    } else if (
      left < beforeLength &&
      (right === afterLength ||
        table[(left + 1) * columns + right]! >=
          table[left * columns + right + 1]!)
    ) {
      output.push({ kind: "remove", text: before[beforeStart + left]! });
      left += 1;
    } else {
      output.push({ kind: "add", text: after[afterStart + right]! });
      right += 1;
    }
  }
}

function patienceAnchors(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
): { before: number; after: number }[] {
  const beforeOccurrences = uniqueOccurrences(before, beforeStart, beforeEnd);
  const afterOccurrences = uniqueOccurrences(after, afterStart, afterEnd);
  const pairs = [...beforeOccurrences]
    .filter(
      (entry): entry is [string, number] =>
        entry[1] >= 0 && (afterOccurrences.get(entry[0]) ?? -1) >= 0,
    )
    .map(([text, index]) => ({
      before: index,
      after: afterOccurrences.get(text)!,
    }))
    .sort((left, right) => left.before - right.before);
  if (pairs.length < 2) return pairs;

  const tails: number[] = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (pairs[tails[middle]!]!.after < pairs[index]!.after) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const result: { before: number; after: number }[] = [];
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    result.push(pairs[cursor]!);
    cursor = previous[cursor]!;
  }
  return result.reverse();
}

function uniqueOccurrences(
  lines: readonly string[],
  start: number,
  end: number,
): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (let index = start; index < end; index += 1) {
    const line = lines[index]!;
    occurrences.set(line, occurrences.has(line) ? -1 : index);
  }
  return occurrences;
}

function collapseContext(
  rows: readonly Exclude<UnifiedDiffRow, { kind: "skip" }>[],
  contextLines: number,
): UnifiedDiffRow[] {
  if (rows.every(({ kind }) => kind === "context")) return [...rows];
  const collapsed: UnifiedDiffRow[] = [];
  for (let start = 0; start < rows.length;) {
    if (rows[start]!.kind !== "context") {
      collapsed.push(rows[start]!);
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < rows.length && rows[end]!.kind === "context") end += 1;
    const leading = start === 0;
    const trailing = end === rows.length;
    const keepBefore = leading ? 0 : Math.min(contextLines, end - start);
    const keepAfter = trailing
      ? 0
      : Math.min(contextLines, end - start - keepBefore);
    const omitted = end - start - keepBefore - keepAfter;
    for (let index = start; index < start + keepBefore; index += 1)
      collapsed.push(rows[index]!);
    if (omitted > 0) collapsed.push({ kind: "skip", count: omitted });
    for (let index = end - keepAfter; index < end; index += 1)
      collapsed.push(rows[index]!);
    start = end;
  }
  return collapsed;
}
