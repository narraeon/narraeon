const add = (values) => values.reduce((sum, value) => sum + value, 0);
const cpuMs = ({ user, system }) => (user + system) / 1000;

function stats(values) {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const round = (value) => Number(value.toFixed(3));
  return {
    n: values.length,
    p50: round(median),
    p95: round(sorted[Math.ceil(0.95 * sorted.length) - 1]),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

function quantities(rows) {
  const keys = Object.keys(rows[0]);
  return Object.fromEntries(
    keys.map((key) => [
      key,
      stats(rows.map((row) => row[key]).filter(Number.isFinite)),
    ]),
  );
}

function metrics({
  provider,
  runtime,
  browser,
  clientStartedAt,
  clientFinishedAt,
  observedBytes,
}) {
  const { sends, receivedAt, endAt } = provider;
  const firstAt = sends[0].at;
  return {
    cpuMs: cpuMs(runtime.replyCpu),
    cpuWithTailMs: cpuMs(runtime.tailCpu),
    elapsedMs: runtime.repliedAt - runtime.startedAt,
    clientElapsedMs: clientFinishedAt - clientStartedAt,
    dispatchMs: receivedAt - runtime.startedAt,
    providerFirstWaitMs: firstAt - receivedAt,
    providerStreamMs: endAt - firstAt,
    providerMaxScheduleErrorMs: Math.max(
      ...sends.map(({ at, dueAt }) => Math.abs(at - dueAt)),
    ),
    settlementMs: runtime.repliedAt - endAt,
    tailWindowMs: runtime.tailAt - runtime.repliedAt,
    requestsDuringWindow: add(Object.values(runtime.requests)),
    ...(observedBytes !== undefined ? { drainedBytes: observedBytes } : {}),
    ...(browser
      ? {
          rendererTaskMs: browser.rendererTaskMs,
          clickToDispatchMs: receivedAt - browser.clickedAt,
          clickToReplyMs: runtime.repliedAt - browser.clickedAt,
          clickToFirstDomFrameMs: browser.rows[0].frameAt - browser.clickedAt,
          clickToFirstInViewMs:
            browser.rows.find(({ inViewport }) => inViewport).frameAt -
            browser.clickedAt,
          providerToFirstFrameMs: browser.rows[0].frameAt - firstAt,
          providerToFirstBrowserEventMs: browser.arrivals[0].at - firstAt,
          firstBrowserEventToFrameMs:
            browser.rows[0].frameAt - browser.arrivals[0].at,
          pageFrames: browser.rows.length,
          viewportFrames: browser.rows.filter(({ inViewport }) => inViewport)
            .length,
          recordedBrowserProbeMs:
            browser.sseProbeMs + browser.domProbeMs + browser.frameProbeMs,
        }
      : {}),
    ...(runtime.frames ? observationMetrics(runtime) : {}),
  };
}

function observationMetrics({
  frames,
  snapshotReads,
  extensionReads,
  serialization,
  updateMs,
}) {
  const observations = frames.filter(({ text }) =>
    text.includes("\nevent: observation\n"),
  );
  const events = observations.map(
    ({ text }) => JSON.parse(text.split("\ndata: ")[1]).update.kind,
  );
  const sumMs = (items) => add(items.map(({ ms }) => ms));
  return {
    snapshotReads: snapshotReads.length,
    readsGivenPrevious: snapshotReads.filter(
      ({ reusedPrevious }) => reusedPrevious,
    ).length,
    snapshotReadWallMs: sumMs(snapshotReads),
    extensionReads: extensionReads.length,
    extensionReadWallMs: sumMs(extensionReads),
    serializationCalls: serialization.length,
    serializationMs: sumMs(serialization),
    equalityJsonMs: sumMs(
      serialization.filter(({ site }) => site !== "wire_frame"),
    ),
    wireJsonMs: sumMs(
      serialization.filter(({ site }) => site === "wire_frame"),
    ),
    updateMs: add(updateMs),
    events: events.length,
    snapshotEvents: events.filter((kind) => kind === "snapshot").length,
    framesBytes: add(frames.map(({ text }) => Buffer.byteLength(text))),
  };
}

function chunkDelay({ provider, browser, runtime }) {
  return provider.sends.slice(1).flatMap(({ at, chars }) => {
    const received = browser.arrivals.find((arrival) => arrival.chars >= chars);
    const shown = browser.rows.find((row) => row.chars >= chars);
    const sent = runtime.arrivals?.find((arrival) => arrival.chars >= chars);
    const shownInView = browser.rows.find(
      (row) => row.inViewport && row.chars >= chars,
    );
    // A base/status snapshot or coalesced delta may advance over several chunks.
    // Attribute each chunk to the first event/frame that contains its prefix.
    if (!received || !shown) return [];
    return [
      {
        providerToFrameMs: shown.frameAt - at,
        providerToBrowserEventMs: received.at - at,
        browserEventToFrameMs: shown.frameAt - received.at,
        providerToInViewFrameMs:
          shownInView === undefined ? undefined : shownInView.frameAt - at,
        ...(sent
          ? {
              providerToServerWriteMs: sent.at - at,
              serverWriteToBrowserEventMs: received.at - sent.at,
            }
          : {}),
      },
    ];
  });
}

export function summarize(samples) {
  const result = {};
  for (const mode of ["clean", "diagnostic"]) {
    const measured = samples.filter(
      (sample) => sample.round >= 0 && sample.mode === mode,
    );
    const arms = Object.fromEntries(
      ["none", "wire", "page"].map((arm) => [
        arm,
        measured.filter((sample) => sample.arm === arm),
      ]),
    );
    const pairs = (arm) =>
      arms[arm].map((sample) => {
        const baseline = metrics(
          arms.none.find(({ round }) => round === sample.round),
        );
        const observed = metrics(sample);
        const keys = [
          "cpuMs",
          "cpuWithTailMs",
          "elapsedMs",
          "dispatchMs",
          "providerFirstWaitMs",
          "providerStreamMs",
          "settlementMs",
        ];
        return Object.fromEntries(
          keys.map((key) => [key, observed[key] - baseline[key]]),
        );
      });
    const later = arms.page.flatMap(chunkDelay);
    result[mode] = {
      ...Object.fromEntries(
        Object.entries(arms).map(([arm, rows]) => [
          arm,
          quantities(rows.map(metrics)),
        ]),
      ),
      pairedWireMinusNone: quantities(pairs("wire")),
      pairedPageMinusNone: quantities(pairs("page")),
      laterChunks: later.length === 0 ? null : quantities(later),
      laterChunksExpected: add(
        arms.page.map(({ provider }) => provider.sends.length - 1),
      ),
      laterChunksMapped: later.length,
    };
  }
  return result;
}
