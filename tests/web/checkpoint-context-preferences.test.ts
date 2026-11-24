// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  hasHandledCheckpoint,
  loadCheckpointPreferences,
  rememberHandledCheckpoint,
} from "../../src/web/CheckpointContextPreferences.ts";

beforeEach(() => {
  // Node's native localStorage can shadow the browser storage in jsdom.
  const browser = globalThis as unknown as {
    jsdom: { window: { localStorage: Storage } };
  };
  vi.stubGlobal("localStorage", browser.jsdom.window.localStorage);
  window.localStorage.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await loadCheckpointPreferences();
});

test("checkpoint UI choices persist independently by world and immutable endpoint", () => {
  rememberHandledCheckpoint("world-one", "commit:3");
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(true);
  expect(hasHandledCheckpoint("world-one", "commit:4")).toBe(false);
  expect(hasHandledCheckpoint("fork-world", "commit:3")).toBe(false);
  expect(window.localStorage.length).toBe(1);
  expect(window.localStorage.getItem(window.localStorage.key(0)!)).toBe(
    "handled",
  );
});

test("clearing browser site data resets checkpoint UI choices", () => {
  rememberHandledCheckpoint("world-one", "commit:3");
  window.localStorage.clear();
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(false);
});

test("Android message bridge carries migrated and new choices across two port changes", async () => {
  const prefix = "narraeon.checkpoint-context.v1:";
  const nativeKeys = new Set([prefix + "world-one:commit%3A2"]);
  const siteStorage = new Map<string, Map<string, string>>();
  async function launch(port: number) {
    const origin = `http://127.0.0.1:${port}`;
    const items = new Map<string, string>();
    siteStorage.set(origin, items);
    let receive: ((event: { data: unknown }) => void) | undefined;
    // Each launch has its own site storage and only the message bridge.
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => items.get(key),
        setItem: (key: string, value: string) => items.set(key, value),
      },
      NarraeonAndroid: {
        addEventListener: (_type: string, listener: typeof receive) => {
          receive = listener;
        },
        removeEventListener: () => {
          receive = undefined;
        },
        postMessage: (message: string) => {
          if (message === "read-checkpoint-preferences") {
            queueMicrotask(() =>
              receive?.({
                data: `checkpoint-preferences:${JSON.stringify([...nativeKeys])}`,
              }),
            );
          } else if (message.startsWith("remember-checkpoint:")) {
            nativeKeys.add(message.slice("remember-checkpoint:".length));
          }
        },
      },
    });
    await loadCheckpointPreferences();
    expect(receive).toBeUndefined();
  }

  await launch(33_001);
  expect(hasHandledCheckpoint("world-one", "commit:2")).toBe(true);
  rememberHandledCheckpoint("world-one", "commit:3");
  await launch(33_002);
  expect(hasHandledCheckpoint("world-one", "commit:2")).toBe(true);
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(true);
  rememberHandledCheckpoint("world-one", "commit:4");
  await launch(33_003);
  expect(hasHandledCheckpoint("world-one", "commit:2")).toBe(true);
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(true);
  expect(hasHandledCheckpoint("world-one", "commit:4")).toBe(true);
  expect(hasHandledCheckpoint("fork-world", "commit:3")).toBe(false);
  expect([...siteStorage.values()].map((items) => items.size)).toEqual([
    0, 0, 0,
  ]);
});

test("Android can still save choices if its initial read times out", async () => {
  vi.useFakeTimers();
  try {
    const postMessage = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("NarraeonAndroid", {
      addEventListener: vi.fn(),
      removeEventListener,
      postMessage,
    });
    const loaded = loadCheckpointPreferences();
    await vi.advanceTimersByTimeAsync(2_000);
    await loaded;
    expect(removeEventListener).toHaveBeenCalledOnce();
    rememberHandledCheckpoint("world-one", "commit:3");
    expect(postMessage).toHaveBeenLastCalledWith(
      "remember-checkpoint:narraeon.checkpoint-context.v1:world-one:commit%3A3",
    );
    expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("unavailable browser storage does not prevent playing", () => {
  vi.spyOn(window.Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Browser storage unavailable");
  });
  vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Browser storage unavailable");
  });
  expect(hasHandledCheckpoint("world-one", "commit:3")).toBe(false);
  expect(() =>
    rememberHandledCheckpoint("world-one", "commit:3"),
  ).not.toThrow();
});
