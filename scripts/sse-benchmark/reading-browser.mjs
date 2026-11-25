import assert from "node:assert/strict";
import { devices } from "@playwright/test";

import { viewport } from "./browser.mjs";
import { normalizeStory } from "./reading-fixture.mjs";

const observerPath = "/api/runtime/v1/events?kind=play&";
const narrative = ".call-chain-assistant.is-narrative > article";
export const readingPageOptions = (mobile) =>
  mobile ? devices["Pixel 7"] : { viewport, locale: "en-US" };

function installReadingProbe(normalize, observerPath, narrative) {
  const {
    document,
    EventSource,
    MutationObserver,
    NodeFilter,
    PerformanceObserver,
    performance,
    requestAnimationFrame,
    getComputedStyle,
  } = globalThis;
  const now = () => performance.timeOrigin + performance.now();
  const setup = [];
  const events = [];
  const faults = [];
  let connections = 0;
  let startAt;
  globalThis.EventSource = class extends EventSource {
    constructor(url, options) {
      super(url, options);
      if (!this.url.includes(observerPath)) return;
      this.addEventListener("open", () => connections++);
      for (const type of ["error", "failure"]) {
        this.addEventListener(type, () => faults.push({ type, at: now() }));
      }
      this.addEventListener("observation", (event) => {
        (startAt === undefined ? setup : events).push({
          at: now(),
          id: event.lastEventId,
          data: event.data,
        });
      });
    }
  };

  const body = (article) =>
    article
      ? [...article.children].filter((el) => !el.matches("header, small"))
      : [];
  const text = (nodes) => nodes.map((node) => node.textContent).join("");
  const shape = (nodes) => {
    function count(selector) {
      return nodes.reduce(
        (sum, node) =>
          sum +
          Number(node.matches(selector)) +
          node.querySelectorAll(selector).length,
        0,
      );
    }
    return {
      headings: count("h2"),
      emphasis: count("strong"),
      lists: count("ul"),
      items: count("li"),
    };
  };

  const frames = [];
  const rafTimes = [];
  const longTasks = [];
  const longTaskSupported =
    PerformanceObserver.supportedEntryTypes.includes("longtask");
  let reader;
  let mutations;
  let longObserver;
  let userHistory;
  let followingAt;
  let active = false;
  let expected;
  let domAt;
  let domChars = 0;
  let frameChars = 0;
  let pendingMarkdown = false;
  let mutationProbeMs = 0;
  let frameProbeMs = 0;
  let clickedAt;
  let mismatches = 0;
  let finalAt;
  let previousFinal;
  const pending = () =>
    reader.querySelector(".call-chain-assistant.is-streaming > article");
  const lastStory = () => [...reader.querySelectorAll(narrative)].at(-1);
  function bounds() {
    const outer = reader.getBoundingClientRect();
    const composer = document
      .querySelector(".world-composer-dock")
      .getBoundingClientRect();
    const page = reader.closest(".world-reader-page");
    return {
      top:
        outer.top +
        Number.parseFloat(
          getComputedStyle(page).getPropertyValue("--world-header-height"),
        ),
      bottom: composer.top,
    };
  }
  function glyphPosition(node, glyph, index, { top, bottom }) {
    const range = document.createRange();
    range.setStart(glyph, index);
    range.setEnd(glyph, index + 1);
    const rect = range.getBoundingClientRect();
    const y = rect.y + rect.height / 2;
    return {
      top: rect.top,
      visible:
        rect.width > 0 &&
        y >= top &&
        y < bottom &&
        node.contains(document.elementFromPoint(rect.x + rect.width / 2, y)),
    };
  }
  function lastVisible(nodes, viewportBounds) {
    for (const node of nodes.toReversed()) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let last;
      while (walker.nextNode()) {
        const candidate = walker.currentNode;
        if (normalize(candidate.textContent)) last = candidate;
      }
      if (!last) continue;
      const index = last.textContent.search(/[^#*\s-][#*\s-]*$/);
      return glyphPosition(node, last, index, viewportBounds).visible;
    }
    return false;
  }
  function historyGlyph(article, viewportBounds) {
    const [node] = body(article);
    const glyph =
      node && document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
    return glyph && glyphPosition(node, glyph, 0, viewportBounds);
  }
  function scrollState() {
    const { top, bottom } = bounds();
    const anchor =
      userHistory &&
      [...reader.querySelectorAll(narrative)].find((article) =>
        text(body(article)).startsWith(userHistory.key),
      );
    const glyph = historyGlyph(anchor, { top, bottom });
    return {
      scrollTop: reader.scrollTop,
      distanceToBottom:
        reader.scrollHeight - reader.clientHeight - reader.scrollTop,
      anchorTop: glyph?.top,
      anchorInViewport: Boolean(glyph?.visible),
      viewportTop: top,
      viewportBottom: bottom,
    };
  }
  function recordFrame() {
    if (!active) return;
    requestAnimationFrame(recordFrame);
    const frameAt = now();
    rafTimes.push(frameAt);
    if (domChars > frameChars) {
      const article = pending();
      const nodes = body(article);
      const shown = normalize(text(nodes));
      if (shown.length > frameChars && expected.startsWith(shown)) {
        if (!pendingMarkdown && article.querySelector("h2")) {
          const { emphasis, items } = shape(nodes);
          pendingMarkdown = emphasis > 0 && items > 0;
        }
        frames.push({
          domAt,
          frameAt,
          chars: shown.length,
          inViewport: lastVisible(nodes, bounds()),
          pending: article.parentElement.classList.contains("is-pending"),
          ...(userHistory ? { scroll: scrollState() } : {}),
        });
        frameChars = shown.length;
      }
    }
    frameProbeMs += now() - frameAt;
  }
  function begin() {
    startAt = now();
    active = true;
    previousFinal = text(body(lastStory()));
    mutations = new MutationObserver(() => {
      const at = now();
      const article = pending();
      const shown = normalize(text(body(article)));
      if (shown && expected.startsWith(shown)) {
        if (followingAt === undefined) {
          // Model a reader moving to the incoming reply once. No probe follows later updates.
          reader.scrollTop = reader.scrollHeight;
          followingAt = now();
        }
        if (shown.length > domChars) {
          domAt = at;
          domChars = shown.length;
        }
      } else if (
        article &&
        frameChars > 0 &&
        shown &&
        !expected.startsWith(shown)
      ) {
        mismatches++;
      }
      // See the commit in this window, even when it did not send the command.
      if (!article && finalAt === undefined) {
        const committed = text(body(lastStory()));
        if (committed !== previousFinal && normalize(committed) === expected)
          finalAt = at;
      }
      mutationProbeMs += now() - at;
    });
    mutations.observe(reader, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
    if (longTaskSupported) {
      longObserver = new PerformanceObserver((list) =>
        longTasks.push(
          ...list.getEntries().map(({ startTime, duration }) => ({
            at: performance.timeOrigin + startTime,
            duration,
          })),
        ),
      );
      longObserver.observe({ type: "longtask" });
    }
    requestAnimationFrame(recordFrame);
  }
  globalThis.readingBenchmark = {
    ready: () => setup.length > 0,
    arm(button, expectedText) {
      reader = document.querySelector(".world-reader-scroll");
      reader.scrollTop = reader.scrollHeight;
      expected = expectedText;
      if (!button) begin();
      else
        button.addEventListener(
          "click",
          () => {
            clickedAt = now();
            begin();
          },
          { once: true, capture: true },
        );
    },
    scrolledToReply: () => frames.some(({ inViewport }) => inViewport),
    recordHistory() {
      const { top, bottom } = bounds();
      const oldStory = [...reader.querySelectorAll(narrative)].find(
        (article) => {
          const y = article.getBoundingClientRect().top;
          return (
            y >= top &&
            y < bottom &&
            text(body(article)).startsWith("Harbor journal ") &&
            historyGlyph(article, { top, bottom })?.visible
          );
        },
      );
      const key = text(body(oldStory)).match(/^Harbor journal \d+\./)?.[0];
      if (!key) return null;
      userHistory = { at: now(), key };
      Object.assign(userHistory, scrollState());
      return userHistory;
    },
    committed: () => finalAt !== undefined,
    collect() {
      active = false;
      mutations.disconnect();
      longObserver?.disconnect();
      const nodes = body(lastStory());
      const finalScroll = scrollState();
      const finalTailInViewport = lastVisible(nodes, bounds());
      reader.scrollTop = reader.scrollHeight;
      const revealedTailInViewport = lastVisible(nodes, bounds());
      return {
        clickedAt,
        startAt,
        followingAt,
        finalAt,
        setup,
        events,
        faults,
        connections,
        frames,
        pendingMarkdown,
        rafTimes,
        longTaskSupported,
        longTasks,
        mutationProbeMs,
        frameProbeMs,
        mismatches,
        userHistory,
        finalScroll,
        finalTailInViewport,
        revealedTailInViewport,
        finalText: text(nodes),
        finalShape: shape(nodes),
      };
    },
  };
}

export async function prepareReadingPage(
  browser,
  url,
  worldId,
  playerText,
  mobile,
) {
  const page = await browser.newPage(readingPageOptions(mobile));
  page.setDefaultTimeout(15_000);
  try {
    await page.addInitScript({
      content: `(${installReadingProbe})(${normalizeStory}, ${JSON.stringify(observerPath)}, ${JSON.stringify(narrative)});`,
    });
    await page.goto(`${url}/#/world/${worldId}`);
    if (playerText !== undefined) {
      await page
        .getByRole("textbox", { name: "Your action", exact: true })
        .fill(playerText);
    }
    await page.locator(narrative).last().waitFor();
    await page.waitForFunction(() => globalThis.readingBenchmark.ready());
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    return { page, cdp, mobile };
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function taskMs({ cdp }) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find(({ name }) => name === "TaskDuration").value * 1000;
}

async function scrollIntoHistory({ page, cdp, mobile }) {
  await page.waitForFunction(() =>
    globalThis.readingBenchmark.scrolledToReply(),
  );
  const reader = page.locator(".world-reader-scroll");
  const box = await reader.boundingBox();
  const bottomPosition = await reader.evaluate((el) => el.scrollTop);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (mobile) {
    await cdp.send("Input.synthesizeScrollGesture", {
      x,
      y,
      yDistance: Math.round(box.height * 2),
      speed: 2500,
      gestureSourceType: "touch",
    });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -box.height * 2);
  }
  await page.waitForFunction(
    (position) =>
      globalThis.document.querySelector(".world-reader-scroll").scrollTop <
      position - 100,
    bottomPosition,
  );
  assert(
    await page.evaluate(() => globalThis.readingBenchmark.recordHistory()),
    "Scroll gesture did not reveal an older narrative anchor",
  );
}

export async function submitReading(sessions, expectedText, arm) {
  const [sender, second] = sessions;
  const { page, mobile } = sender;
  const priorTasks = await Promise.all(sessions.map(taskMs));
  const button = page.getByRole("button", {
    name: "Append action",
    exact: true,
  });
  const normalized = normalizeStory(expectedText);
  await button.evaluate(
    (el, value) => globalThis.readingBenchmark.arm(el, value),
    normalized,
  );
  await second?.page.evaluate(
    (value) => globalThis.readingBenchmark.arm(null, value),
    normalized,
  );
  const [receipt] = await Promise.all([
    page.waitForResponse(
      (item) =>
        item.url().endsWith("/api/runtime/v1") &&
        item.request().postDataJSON()?.request?.type === "play.chain.append",
    ),
    (async () => {
      await (mobile ? button.tap() : button.click());
      if (arm === "history") await scrollIntoHistory(sender);
    })(),
  ]);
  const result = (await receipt.json()).result;
  const browsers = await Promise.all(
    sessions.map(async (session, index) => {
      await session.page.waitForFunction(() =>
        globalThis.readingBenchmark.committed(),
      );
      const rendererTaskMs = (await taskMs(session)) - priorTasks[index];
      const trace = await session.page.evaluate(() =>
        globalThis.readingBenchmark.collect(),
      );
      return { ...trace, rendererTaskMs };
    }),
  );
  return { result, browsers };
}

export function verifyReading(trace, expectedText, expectMarkdown, repliedAt) {
  assert.equal(trace.connections, 1);
  assert.deepEqual(trace.faults, []);
  assert.equal(
    trace.mismatches,
    0,
    "Pending content did not match the expected display prefix",
  );
  assert.equal(normalizeStory(trace.finalText), normalizeStory(expectedText));
  assert(
    trace.frames.length > 1 && trace.frames.every(({ pending }) => pending),
    "Expected several explicitly pending frames",
  );
  assert(
    trace.frames.find(({ inViewport }) => inViewport)?.frameAt < repliedAt,
    "No pending story reached the viewport before command completion",
  );
  assert.equal(
    trace.revealedTailInViewport,
    true,
    "The final character was unreachable by scrolling to the bottom",
  );
  if (
    expectedText.startsWith("## ") &&
    (expectMarkdown || trace.finalShape.headings > 0)
  ) {
    const sections = expectedText.match(/^## /gm).length;
    assert.deepEqual(trace.finalShape, {
      headings: sections,
      emphasis: sections,
      lists: sections,
      items: sections * 2,
    });
    assert(
      trace.pendingMarkdown,
      "No Markdown heading, emphasis and list were rendered before commit",
    );
  } else {
    assert.equal(trace.finalText, expectedText);
  }
  if (trace.userHistory) {
    const { at, scrollTop, anchorTop } = trace.userHistory;
    const later = trace.frames.filter(({ frameAt }) => frameAt > at);
    assert(
      later.length >= 5,
      "Expected several in-flight frames after the wheel gesture",
    );
    for (const scroll of [
      ...later.map((item) => item.scroll),
      trace.finalScroll,
    ]) {
      assert(scroll.anchorInViewport, "Older story anchor left the viewport");
      assert(
        Math.abs(scroll.anchorTop - anchorTop) <= 2,
        "Older story anchor moved after the wheel gesture",
      );
      assert(
        Math.abs(scroll.scrollTop - scrollTop) <= 2,
        "Reader scroll position drifted after the wheel gesture",
      );
    }
    assert(
      later.every(({ inViewport }) => !inViewport),
      "Pending tail re-entered the viewport after scrolling up",
    );
  }
}
