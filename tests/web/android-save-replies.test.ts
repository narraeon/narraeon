// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { saveFile } from "../../src/web/androidBridge.ts";

test("Android save waits for a matching, well-formed native receipt", async () => {
  let receive!: (event: { data: unknown }) => void;
  let id = "";
  const bridge = {
    addEventListener: (_name: string, callback: typeof receive) => {
      receive = callback;
    },
    postMessage: vi.fn((message: string) => {
      id = (JSON.parse(message) as { id: string }).id;
    }),
  };
  vi.stubGlobal("NarraeonAndroid", bridge);
  try {
    const save = () => saveFile("story.txt", { path: "/archive" });
    const first = save();
    for (const data of [
      "null",
      "[]",
      "invalid",
      JSON.stringify({ id, outcome: "other" }),
      JSON.stringify({ id: "unrelated", outcome: "failed" }),
    ])
      receive({ data });
    receive({ data: JSON.stringify({ id, outcome: "saved" }) });
    await expect(first).resolves.toBe("saved");
    bridge.postMessage.mockImplementationOnce(() => {
      throw new Error("Bridge disconnected");
    });
    await expect(save()).rejects.toThrow("Bridge disconnected");
    const cancelled = save();
    receive({ data: JSON.stringify({ id, outcome: "cancelled" }) });
    await expect(cancelled).resolves.toBe("cancelled");
    const failed = save();
    receive({
      data: JSON.stringify({ id, outcome: "failed", error: "Disk full" }),
    });
    await expect(failed).rejects.toThrow("Disk full");
  } finally {
    vi.unstubAllGlobals();
  }
});
