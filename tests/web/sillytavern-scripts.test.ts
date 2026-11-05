import { describe, expect, it } from "vitest";
import { readScripts } from "../../src/web/sillytavern-scripts.ts";

describe("embedded script inspection", () => {
  it("projects only recognized script fields including folders, absent source and regex", () => {
    const scripts = readScripts(
      JSON.stringify({
        extensions: {
          secret: "do not reveal",
          tavern_helper: {
            scripts: [
              {
                type: "folder",
                name: "Folder",
                scripts: [
                  {
                    type: "script",
                    name: "HTML",
                    enabled: false,
                    content: "<script>alert(1)</script>",
                    secret: "private",
                  },
                  {
                    type: "script",
                    name: "Remote",
                    url: "https://example.test/file.js",
                  },
                  { type: "script", name: "Empty", content: "" },
                ],
              },
            ],
          },
          regex_scripts: [
            {
              scriptName: "Replace",
              findRegex: "/x/g",
              replaceString: "y",
              disabled: true,
              placement: [1],
              secret: "private",
            },
          ],
        },
      }),
    );
    expect(scripts.map((item) => item.name)).toEqual([
      "Folder / HTML",
      "Folder / Remote",
      "Folder / Empty",
      "Replace",
    ]);
    expect(scripts[0]?.content).toBe("<script>alert(1)</script>");
    expect(scripts[1]?.content).toBeUndefined();
    expect(scripts[1]?.reference).toBe("https://example.test/file.js");
    expect(scripts[2]?.content).toBe("");
    expect(scripts[3]).toMatchObject({
      kind: "regex",
      findRegex: "/x/g",
      replaceString: "y",
      enabled: false,
      rules: ["placement: [1]", "disabled: true"],
    });
    expect(JSON.stringify(scripts)).not.toContain("private");
  });
  it("includes large and deeply nested script collections", () => {
    let node: unknown = { type: "script", name: "Deep", content: "deep" };
    for (let i = 0; i < 20; i++)
      node = { type: "folder", name: "f", scripts: [node] };
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      type: "script",
      name: `s${index}`,
      content: "",
    }));
    const result = readScripts(
      JSON.stringify({
        extensions: { tavern_helper: { scripts: [...entries, node] } },
      }),
    );
    expect(result).toHaveLength(1002);
    expect(result.at(-1)?.content).toBe("deep");
  });
});
