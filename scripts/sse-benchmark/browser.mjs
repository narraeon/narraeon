export const viewport = { width: 1440, height: 1080 };

export async function preparePage(browser, url, worldId, playerText) {
  const page = await browser.newPage({ viewport, locale: "en-US" });
  page.setDefaultTimeout(15_000);
  try {
    await page.addInitScript(() => {
      const { EventSource, MutationObserver, document, performance } =
        globalThis;
      const now = () => performance.timeOrigin + performance.now();
      const observations = [];
      const rows = [];
      const faults = [];
      let connections = 0;
      const setupObservations = [];
      let sseProbeMs = 0;
      let domProbeMs = 0;
      let frameProbeMs = 0;
      let clickedAt;
      let scrolledToPendingAt;
      let observer;
      globalThis.EventSource = class extends EventSource {
        constructor(url, options) {
          super(url, options);
          if (!this.url.includes("/api/runtime/v1/events?kind=play&")) return;
          this.addEventListener("open", () => connections++);
          for (const type of ["error", "failure"])
            this.addEventListener(type, () => faults.push({ type, at: now() }));
          this.addEventListener("observation", (event) => {
            const at = now();
            const entry = { at, id: event.lastEventId, data: event.data };
            if (clickedAt === undefined) {
              setupObservations.push(entry);
              return;
            }
            // Leave JSON parsing and chunk matching to the driver.
            observations.push(entry);
            sseProbeMs += now() - at;
          });
        }
      };

      globalThis.sseBenchmark = {
        ready: () => setupObservations.length > 0,
        arm(button, prefix) {
          const reader = document.querySelector(".world-reader-scroll");
          reader.scrollTop = reader.scrollHeight;
          let lastDomChars = 0;
          let lastDomAt;
          let lastFrameChars = 0;
          let framePending = false;
          const pending = () =>
            reader.querySelector(
              ".call-chain-assistant.is-streaming > article p",
            );
          observer = new MutationObserver(() => {
            const start = now();
            const paragraph = pending();
            if (paragraph && scrolledToPendingAt === undefined) {
              // The page deliberately preserves scroll position during generation.
              // Follow the pending reply once, as a reader watching it would.
              reader.scrollTop = reader.scrollHeight;
              scrolledToPendingAt = now();
            }
            const body = paragraph?.textContent;
            if (!body?.startsWith(prefix) || body.length <= lastDomChars) {
              domProbeMs += now() - start;
              return;
            }
            lastDomChars = body.length;
            lastDomAt = start;
            if (!framePending) {
              framePending = true;
              globalThis.requestAnimationFrame(() => {
                const frameAt = now();
                framePending = false;
                const paragraph = pending();
                const chars = paragraph?.textContent.length ?? 0;
                if (
                  chars > lastFrameChars &&
                  paragraph.textContent.startsWith(prefix)
                ) {
                  // Check whether the newest rendered character is in view.
                  // elementFromPoint also excludes text behind the composer.
                  const range = document.createRange();
                  range.setStart(paragraph.firstChild, chars - 1);
                  range.setEnd(paragraph.firstChild, chars);
                  const { x, y, width, height } = range.getBoundingClientRect();
                  const hit = document.elementFromPoint(
                    x + width / 2,
                    y + height / 2,
                  );
                  rows.push({
                    domAt: lastDomAt,
                    frameAt,
                    chars,
                    inViewport: width > 0 && paragraph.contains(hit),
                  });
                  lastFrameChars = chars;
                }
                frameProbeMs += now() - frameAt;
              });
            }
            domProbeMs += now() - start;
          });
          button.addEventListener(
            "click",
            () => {
              clickedAt = now();
              observer.observe(reader, {
                childList: true,
                characterData: true,
                subtree: true,
              });
            },
            { once: true, capture: true },
          );
        },
        collect() {
          observer.disconnect();
          return {
            clickedAt,
            scrolledToPendingAt,
            connections,
            faults,
            setupObservations,
            observations,
            rows,
            sseProbeMs,
            domProbeMs,
            frameProbeMs,
          };
        },
      };
    });
    await page.goto(`${url}/#/world/${worldId}`);
    const input = page.getByRole("textbox", {
      name: "Your action",
      exact: true,
    });
    const button = page.getByRole("button", {
      name: "Append action",
      exact: true,
    });
    await input.fill(playerText);
    await page.waitForFunction(() => globalThis.sseBenchmark.ready());
    return { page, button };
  } catch (error) {
    await page.close();
    throw error;
  }
}

export async function submitFromPage({ page, button }, expected) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const readTaskSeconds = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find(({ name }) => name === "TaskDuration").value;
  };
  await button.evaluate(
    (element, prefix) => globalThis.sseBenchmark.arm(element, prefix),
    expected.slice(0, 3),
  );
  const cpuBefore = await readTaskSeconds();
  const response = page.waitForResponse(
    (item) =>
      item.url().endsWith("/api/runtime/v1") &&
      item.request().postDataJSON()?.request?.type === "play.chain.append",
  );
  await button.click();
  const receipt = await response;
  const result = (await receipt.json()).result;
  const narrative = page
    .locator(".call-chain-assistant.is-narrative > article p")
    .last();
  await narrative.filter({ hasText: expected }).waitFor({ state: "attached" });
  const finalText = await narrative.textContent();
  const rendererTaskMs = ((await readTaskSeconds()) - cpuBefore) * 1000;
  const observations = await page.evaluate(() =>
    globalThis.sseBenchmark.collect(),
  );
  return { result, browser: { ...observations, finalText, rendererTaskMs } };
}
