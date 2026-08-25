import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export type NonEmptyPath = [string, ...string[]];

export type MaterialSelection =
  | { kind: "document"; document: string }
  | {
      kind: "node";
      document: string;
      locator:
        | { yaml: NonEmptyPath; markdown?: never }
        | { markdown: NonEmptyPath; yaml?: never };
    }
  | { kind: "history_message"; message: string }
  | { kind: "history_commit"; commit: string };

const nonEmptyString = { type: "string", minLength: 1 } as const;
const nonEmptyStringPath = {
  type: "array",
  minItems: 1,
  items: nonEmptyString,
} as const;

const documentMaterialSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "document"],
  properties: {
    kind: { const: "document" },
    document: nonEmptyString,
  },
} as const;

const nodeMaterialSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "document", "locator"],
  properties: {
    kind: { const: "node" },
    document: nonEmptyString,
    locator: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["yaml"],
          properties: { yaml: nonEmptyStringPath },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["markdown"],
          properties: { markdown: nonEmptyStringPath },
        },
      ],
    },
  },
} as const;

const historyMessageMaterialSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "message"],
  properties: {
    kind: { const: "history_message" },
    message: nonEmptyString,
  },
} as const;

const historyCommitMaterialSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "commit"],
  properties: {
    kind: { const: "history_commit" },
    commit: nonEmptyString,
  },
} as const;

export const materialListSchema = {
  type: "array",
  maxItems: 32,
  items: {
    oneOf: [
      documentMaterialSchema,
      nodeMaterialSchema,
      historyMessageMaterialSchema,
      historyCommitMaterialSchema,
    ],
  },
} as const;

export class MaterialSelectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialSelectionValidationError";
  }
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateListSchema = ajv.compile(materialListSchema);

export function validateMaterialList(value: unknown): MaterialSelection[] {
  assertSchema(validateListSchema, value, "附加材料清单 schema");
  return structuredClone(value) as MaterialSelection[];
}

function assertSchema(
  validate: ValidateFunction,
  value: unknown,
  contract: string,
): void {
  if (validate(value)) return;
  throw new MaterialSelectionValidationError(
    `${contract} 不接受该输入：${renderErrors(validate.errors)}`,
  );
}

function renderErrors(errors: ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0)
    return "形状无效";
  return errors
    .map(
      ({ instancePath, message }) =>
        `${instancePath || "/"} ${message ?? "无效"}`,
    )
    .join("；");
}
