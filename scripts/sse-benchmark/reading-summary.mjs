import { normalizeStory, readingArms } from "./reading-fixture.mjs";
import { quantities, stats } from "./summary.mjs";

const sum = (values) => values.reduce((total, value) => total + value, 0);

function runtimeMetrics({ runtime, provider }) {
  const { receivedAt, endAt, sends } = provider;
  return {
    cpuMs: (runtime.replyCpu.user + runtime.replyCpu.system) / 1000,
    cpuWithTailMs: (runtime.tailCpu.user + runtime.tailCpu.system) / 1000,
    elapsedMs: runtime.repliedAt - runtime.startedAt,
    dispatchMs: receivedAt - runtime.startedAt,
    providerFirstWaitMs: sends[0].at - receivedAt,
    providerStreamMs: endAt - sends[0].at,
    providerMaxScheduleErrorMs: Math.max(
      ...sends.map(({ at, dueAt }) => Math.abs(at - dueAt)),
    ),
    settlementMs: runtime.repliedAt - endAt,
    ...(runtime.snapshotReads
      ? {
          projectionReads: runtime.snapshotReads.length,
          projectionReadWallMs: sum(runtime.snapshotReads.map(({ ms }) => ms)),
          extensionRevisionReads: runtime.extensionReads.length,
          extensionRevisionReadWallMs: sum(
            runtime.extensionReads.map(({ ms }) => ms),
          ),
          observationFrames: runtime.frames.filter(({ text }) =>
            text.includes("\nevent: observation\n"),
          ).length,
          wireBytes: sum(
            runtime.frames.map(({ text }) => Buffer.byteLength(text)),
          ),
        }
      : {}),
  };
}

function browserMetrics(trace, { provider, browsers }) {
  const {
    frames,
    rafTimes,
    longTasks,
    longTaskSupported,
    finalAt,
    userHistory,
  } = trace;
  const clickedAt = browsers[0].clickedAt;
  const firstWrite = provider.sends[0].at;
  const firstVisible = frames.find(({ inViewport }) => inViewport);
  const measuredFrames = rafTimes.filter(
    (at) => at >= clickedAt && at <= finalAt,
  );
  const gaps = measuredFrames
    .slice(1)
    .map((at, index) => at - measuredFrames[index]);
  const tasks = longTasks.filter(
    ({ at, duration }) => at < finalAt && at + duration > clickedAt,
  );
  const afterWheel = userHistory
    ? frames.filter(({ frameAt }) => frameAt > userHistory.at)
    : [];
  const scrollStates = userHistory
    ? [...afterWheel.map(({ scroll }) => scroll), trace.finalScroll]
    : [];
  return {
    clickToFirstDomFrameMs: frames[0].frameAt - clickedAt,
    clickToFirstInViewMs: firstVisible.frameAt - clickedAt,
    providerToFirstInViewMs: firstVisible.frameAt - firstWrite,
    clickToFinalDomMs: finalAt - clickedAt,
    rendererTaskMs: trace.rendererTaskMs,
    recordedProbeMs: trace.mutationProbeMs + trace.frameProbeMs,
    pendingFrames: frames.length,
    inViewFrames: frames.filter(({ inViewport }) => inViewport).length,
    finalTailInView: Number(trace.finalTailInViewport),
    revealedTailInView: Number(trace.revealedTailInViewport),
    maxFrameGapMs: Math.max(...gaps),
    frameGapP95Ms: stats(gaps)?.p95,
    gapsOver33Ms: gaps.filter((gap) => gap > 33.34).length,
    gapsOver50Ms: gaps.filter((gap) => gap > 50).length,
    longTasks: longTaskSupported ? tasks.length : undefined,
    longTaskTotalMs: longTaskSupported
      ? sum(tasks.map(({ duration }) => duration))
      : undefined,
    ...(userHistory
      ? {
          updatesAfterWheel: afterWheel.length,
          maxAnchorDriftPx: Math.max(
            ...scrollStates.map(({ anchorTop }) =>
              Math.abs(anchorTop - userHistory.anchorTop),
            ),
          ),
          maxScrollDriftPx: Math.max(
            ...scrollStates.map(({ scrollTop }) =>
              Math.abs(scrollTop - userHistory.scrollTop),
            ),
          ),
        }
      : {}),
  };
}

function laterChunks(trace, { provider, final }) {
  const { sends } = provider;
  const text = final.text;
  const rows = [];
  let expected = 0;
  for (const [index, { at, chars }] of sends.entries()) {
    if (index === 0) continue;
    const content = normalizeStory(text.slice(sends[index - 1].chars, chars));
    // A chunk containing only formatting or whitespace has no glyph to wait for.
    if (!content) continue;
    expected++;
    const shownChars = normalizeStory(text.slice(0, chars)).length;
    const received = trace.arrivals.find((arrival) => arrival.chars >= chars);
    const shown = trace.frames.find((frame) => frame.chars >= shownChars);
    if (received && shown) {
      rows.push({
        providerToBrowserEventMs: received.at - at,
        providerToDomFrameMs: shown.frameAt - at,
      });
    }
  }
  return { rows, expected };
}

function summarizeBrowser(samples, index) {
  const individual = samples.map((sample) =>
    laterChunks(sample.browsers[index], sample),
  );
  const rows = individual.flatMap(({ rows }) => rows);
  return {
    ...quantities(
      samples.map((sample) => browserMetrics(sample.browsers[index], sample)),
    ),
    laterChunksExpected: sum(individual.map(({ expected }) => expected)),
    laterChunksMapped: rows.length,
    laterChunks: rows.length ? quantities(rows) : null,
    laterChunkFrameP95ByTrialMs: stats(
      individual.flatMap(({ rows }) =>
        rows.length
          ? [
              stats(
                rows.map(({ providerToDomFrameMs }) => providerToDomFrameMs),
              ).p95,
            ]
          : [],
      ),
    ),
  };
}

export function summarizeReading(samples) {
  return Object.fromEntries(
    ["clean", "diagnostic"].map((mode) => [
      mode,
      Object.fromEntries(
        readingArms.map((arm) => {
          const group = samples.filter(
            (sample) =>
              sample.mode === mode && sample.arm === arm && sample.round >= 0,
          );
          return [
            arm,
            {
              trials: group.length,
              runtime: quantities(group.map(runtimeMetrics)),
              sender: summarizeBrowser(group, 0),
              ...(arm === "dual"
                ? { observer: summarizeBrowser(group, 1) }
                : {}),
            },
          ];
        }),
      ),
    ]),
  );
}
