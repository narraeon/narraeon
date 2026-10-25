import { expect, test } from "vitest";
import {
  coerceToolArguments,
  renderCoercionNote,
} from "../../src/runtime/model/ToolArgumentCoercion.ts";

const arraySchema = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: { type: "object", properties: { op: { type: "string" } } },
    },
  },
};

test("a string at an array position parses and is recorded by path", () => {
  const args = { edits: '[{"op":"replace"}]' };
  const result = coerceToolArguments(arraySchema, args);
  expect(result.arguments).toEqual({ edits: [{ op: "replace" }] });
  expect(result.coerced).toEqual(["edits"]);
  expect(args.edits).toBe('[{"op":"replace"}]');
});

test("a string at an object position parses; array elements are repaired one level in", () => {
  const schema = {
    type: "object",
    properties: {
      locator: { type: "object", properties: { yaml: { type: "array" } } },
    },
  };
  expect(coerceToolArguments(schema, { locator: '{"yaml":["mood"]}' })).toEqual(
    {
      arguments: { locator: { yaml: ["mood"] } },
      coerced: ["locator"],
    },
  );
  expect(
    coerceToolArguments(arraySchema, { edits: ['{"op":"append"}'] }),
  ).toEqual({
    arguments: { edits: [{ op: "append" }] },
    coerced: ["edits[0]"],
  });
});

test("a string whose parsed type does not match stays as the model sent it", () => {
  expect(coerceToolArguments(arraySchema, { edits: '{"op":"x"}' })).toEqual({
    arguments: { edits: '{"op":"x"}' },
    coerced: [],
  });
  expect(coerceToolArguments(arraySchema, { edits: "not json" })).toEqual({
    arguments: { edits: "not json" },
    coerced: [],
  });
});

test("an untyped schema such as {} never parses a string", () => {
  const schema = {
    type: "object",
    properties: { value: {} },
  };
  expect(coerceToolArguments(schema, { value: "[1,2]" })).toEqual({
    arguments: { value: "[1,2]" },
    coerced: [],
  });
});

test("a union including string never parses", () => {
  const schema = {
    type: "object",
    properties: { cursor: { type: ["string", "null"] } },
  };
  expect(coerceToolArguments(schema, { cursor: "null" })).toEqual({
    arguments: { cursor: "null" },
    coerced: [],
  });
  const integerOrArray = {
    type: "object",
    properties: { locator: { type: ["array", "string"] } },
  };
  expect(
    coerceToolArguments(integerOrArray, { locator: '["a"]' }).coerced,
  ).toEqual([]);
});

test("a oneOf parses only when every branch states the same definite type", () => {
  const agreeing = {
    type: "object",
    properties: {
      edits: {
        type: "array",
        items: {
          oneOf: [
            { type: "object", properties: { op: { const: "remove" } } },
            { type: "object", properties: { op: { const: "append" } } },
          ],
        },
      },
    },
  };
  expect(
    coerceToolArguments(agreeing, { edits: ['{"op":"remove"}'] }).arguments,
  ).toEqual({ edits: [{ op: "remove" }] });

  const disagreeing = {
    type: "object",
    properties: {
      value: { oneOf: [{ type: "object" }, { type: "string" }] },
    },
  };
  expect(coerceToolArguments(disagreeing, { value: '{"a":1}' })).toEqual({
    arguments: { value: '{"a":1}' },
    coerced: [],
  });
});

test("nesting stops after two levels", () => {
  const deep = {
    type: "object",
    properties: {
      a: {
        type: "array",
        items: {
          type: "object",
          properties: {
            b: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  };
  // a (level 1) and a[0] (level 2) are repaired; a[0].b (level 3) is not.
  expect(
    coerceToolArguments(deep, { a: [{ b: '[{"x":1}]' }] }).arguments,
  ).toEqual({ a: [{ b: '[{"x":1}]' }] });
  expect(
    coerceToolArguments(deep, { a: '[{"b":[{"x":1}]}]' }).arguments,
  ).toEqual({ a: [{ b: [{ x: 1 }] }] });
});

test("unchanged positions keep their identity and no copy is made", () => {
  const args = { edits: [{ op: "replace" }] };
  const result = coerceToolArguments(arraySchema, args);
  expect(result.arguments).toBe(args);
  expect(result.coerced).toEqual([]);
});

test("the Runtime note names the repaired fields in the requested locale", () => {
  expect(renderCoercionNote(["edits"], "en")).toContain('"edits"');
  expect(renderCoercionNote(["edits"], "zh-CN")).toContain("JSON 字符串");
});
