import { describe, expect, it } from "vitest";
import { scanVariables } from "../../src/web/sillytavern-variable-preview.ts";

describe("static SillyTavern variable reading", () => {
  it("preserves literal empty and multiline values and offsets", () => {
    const input =
      "x {{ SETVAR :: __proto__ ::}} {{setvar::x::a}\nb}} {{getvar x}}";
    const result = scanVariables(input);
    expect(result.tokens.map((t) => input.slice(t.start, t.end))).toEqual(
      result.tokens.map((t) => t.raw),
    );
    expect(result.tokens[0]?.value).toBe("");
    expect(result.tokens[1]?.value).toBe("a}\nb");
    expect(result.tokens[2]?.name).toBe("x");
  });
  it("marks nested, blocks, comments, escapes and mutation as uncertain", () => {
    for (const input of [
      "{{setvar::x::{{getvar::y}}}}",
      "{{#setvar::x}}x{{/setvar}}",
      "{{if::x}} {{setvar::x::v}} {{/if}}",
      "{{// comment}} {{setvar::x::v}}",
      "\\{{setvar::x::v}}",
      "{{incvar::x}}",
      "{{setvar::x::a::b}}",
      "{{setvar::x::broken",
    ]) {
      const result = scanVariables(input);
      expect(result.uncertain || result.tokens.some((t) => t.uncertain)).toBe(
        true,
      );
    }
  });
  it("marks scoped declarations as unparsed openings without inventing block boundaries", () => {
    const input =
      "{{setvar::x}}a{{/setvar}}{{getvar::x}}{{#setvar y}}b\\{{/setvar}}c{{/setvar}}";
    const result = scanVariables(input);
    expect(
      result.tokens.map((token) => [
        token.name,
        token.raw,
        token.start,
        token.end,
      ]),
    ).toEqual([
      ["x", "{{setvar::x}}", 0, 13],
      ["x", "{{getvar::x}}", 25, 38],
      ["y", "{{#setvar y}}", 38, 51],
    ]);
    expect(
      result.tokens
        .filter((token) => token.kind === "set")
        .every((token) => token.scoped && token.uncertain),
    ).toBe(true);
    expect(scanVariables("{{setvar::x}}unclosed").tokens[0]).toMatchObject({
      name: "x",
      raw: "{{setvar::x}}",
      scoped: true,
      uncertain: true,
    });
  });
  it("bounds large inputs and preserves repeated declarations", () => {
    expect(
      scanVariables("{{setvar::x::1}}{{setvar::x::2}}").tokens,
    ).toHaveLength(2);
    expect(scanVariables("a".repeat(500_001)).uncertain).toBe(true);
  });
});
