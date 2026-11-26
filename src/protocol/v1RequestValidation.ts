import { Ajv, type SchemaObject, type ValidateFunction } from "ajv";

import { appLocales, isAppReadingPreferences } from "./appPreferences.ts";
import { maxPortableContentArchiveBase64Characters } from "./contentTree.ts";
import { sampleContentPackageIds } from "./sampleContentPackages.ts";
import { parseGameplay, resolutionSchemes } from "./gameplay.ts";
import type { V1Request } from "./v1.ts";

type Command = V1Request["type"];
type Request = Record<string, unknown>;
type Fields = Record<string, SchemaObject | boolean>;

export interface V1RequestFieldFailure {
  message: string;
  cause?: unknown;
}

type Check = (
  request: Request,
  command: Command,
) => V1RequestFieldFailure | undefined;

const string = { type: "string" };
const text = { type: "string", minLength: 1 };
const number = { type: "number" };
const boolean = { type: "boolean" };
const object = { type: "object" };
const array = { type: "array" };

const requiredFields = {
  "workspace.read": {},
  "preferences.read": {},
  "protagonist-templates.read": {},
  "model.read": {},
  "content.create": {},
  "play.read": {},
  "preferences.save": {},
  "protagonist-templates.save": { name: text, body: text },
  "protagonist-templates.copy": { id: text },
  "protagonist-templates.delete": { id: text },
  "model.save": { connection: object },
  "model.copy": { connectionId: text, name: text },
  "model.select": { connectionId: text },
  "model.delete": { connectionId: text },
  "model.models": { provider: text, baseUrl: text },
  "model.test": { connection: object },
  "content.create-sample": { locale: text },
  "content.scripts.read": { packageId: text },
  "content.scripts.set": { packageId: text, enabled: boolean },
  "world.package-scripts.read": { worldId: text },
  "world.package-scripts.set": { worldId: text, enabled: boolean },
  "content.gameplay.set": { packageId: text, scheme: text },
  "content.read": { packageId: text },
  "content.replace": {
    packageId: text,
    files: array,
    baseTreeRevision: text,
  },
  "content.copy": { packageId: text },
  "content.delete": { packageId: text },
  "content.rename": { packageId: text, name: text },
  "content.import": { archiveBase64: text },
  "content.export": { packageId: text },
  "setting-improvement.read": { packageId: text },
  "setting-improvement.preview": { packageId: text },
  "setting-improvement.call.context": {
    packageId: text,
    sessionId: text,
    callId: text,
  },
  "setting-improvement.request.preview": {
    packageId: text,
    sessionId: text,
    requestId: text,
  },
  "setting-improvement.status": { packageId: text },
  "setting-improvement.overview": { packageId: text },
  "setting-improvement.session.read": {
    packageId: text,
    sessionId: text,
  },
  "setting-improvement.session.delete": {
    packageId: text,
    sessionId: text,
  },
  "setting-improvement.rollback": {
    packageId: text,
    sessionId: text,
    changeSetId: text,
    path: text,
  },
  "setting-improvement.message": {
    packageId: text,
    requestId: text,
    message: text,
    continuation: object,
  },
  "setting-improvement.message.edit": {
    packageId: text,
    sessionId: text,
    requestId: text,
    messageId: text,
    message: text,
    filePolicy: text,
  },
  "setting-improvement.cancel": { sessionId: text },
  "setting-improvement.resume": {
    packageId: text,
    sessionId: text,
    requestId: text,
  },
  "orchestration.overview": { presetId: text },
  "orchestration.session.read": { presetId: text, sessionId: text },
  "orchestration.session.delete": { presetId: text, sessionId: text },
  "orchestration.message": {
    presetId: text,
    requestId: text,
    message: text,
    expectedRevision: text,
    surface: { enum: ["playPrompts", "authorPrompts"] },
    continuation: object,
  },
  "orchestration.resume": { presetId: text, sessionId: text, requestId: text },
  "orchestration.cancel": { presetId: text, sessionId: text },
  "orchestration.undo": {
    presetId: text,
    sessionId: text,
    changeSetId: text,
    expectedRevision: text,
  },
  "orchestration.call.context": {
    presetId: text,
    sessionId: text,
    callId: text,
  },
  "orchestration.request.preview": {
    presetId: text,
    sessionId: text,
    requestId: text,
  },
  "play.create": { name: text },
  "play.copy": { presetId: text },
  "play.save": { presetId: text, name: text, files: object },
  "play.draft.discard": { presetId: text, expectedRevision: text },
  "play.rename": { presetId: text, name: text },
  "play.delete": { presetId: text },
  "play.enable": { presetId: text, enabled: boolean },
  "play.scripts": { presetId: text, enabled: boolean },
  "play.select": { presetId: text },
  "play.export": { presetId: text },
  "play.import": { name: text, files: array },
  "content.sillytavern.inspect": { source: text },
  "content.sillytavern.preview": {
    source: text,
    name: text,
    selection: object,
  },
  "content.sillytavern.import": {
    source: text,
    name: text,
    selection: object,
  },
  "play.sillytavern.inspect": { source: text },
  "play.sillytavern.preview": {
    source: text,
    selected: array,
    name: text,
  },
  "play.sillytavern.import": {
    source: text,
    selected: array,
    name: text,
  },
  "play.sillytavern.source.read": { presetId: text },
  "play.sillytavern.source.associate": { presetId: text, source: text },
  "play.workbench.read": {},
  "play.orchestration.provenance.read": {
    presetId: text,
    revision: text,
    surface: text,
    entryId: text,
  },
  "play.orchestration.preview": {
    presetId: text,
    revision: text,
    surface: text,
    gameplay: object,
  },
  "prompt.preview": {
    packageId: text,
    playerInput: text,
    model: object,
  },
  "world.create": {
    operationId: text,
    packageId: text,
  },
  "world.archive.export": { worldId: text, operationId: text },
  "world.archive.import": { operationId: text, uploadId: text },
  "world.read": { worldId: text },
  "world.rename": { worldId: text, name: text },
  "world.story.export": { worldId: text, format: text },
  "world.delete": { worldId: text },
  "artifacts.read": { worldId: text },
  "artifacts.debug": { worldId: text },
  "world.creation-outcome": { operationId: text },
  "world.control-draft.save": { worldId: text, files: array },
  "world.control-draft.preview": { worldId: text },
  "world.control-draft.apply": { worldId: text },
  "world.revision.open": { worldId: text },
  "world.revision.overview": { worldId: text },
  "world.revision.preview": { worldId: text },
  "world.revision.call.context": {
    worldId: text,
    sessionId: text,
    callId: text,
  },
  "world.revision.request.preview": {
    worldId: text,
    sessionId: text,
    requestId: text,
  },
  "world.revision.status": { worldId: text },
  "world.revision.session.read": {
    worldId: text,
    sessionId: text,
  },
  "world.revision.session.delete": {
    worldId: text,
    sessionId: text,
  },
  "world.revision.message": {
    worldId: text,
    requestId: text,
    message: text,
    continuation: object,
  },
  "world.revision.message.edit": {
    worldId: text,
    sessionId: text,
    requestId: text,
    messageId: text,
    message: text,
    filePolicy: text,
  },
  "world.revision.cancel": { sessionId: text },
  "world.revision.resume": {
    worldId: text,
    sessionId: text,
    requestId: text,
  },
  "world.revision.files.replace": {
    worldId: text,
    epochId: text,
    expectedRevision: text,
    files: array,
  },
  "world.revision.rollback": {
    worldId: text,
    epochId: text,
    changeSetId: text,
    path: text,
  },
  "world.revision.apply": {
    worldId: text,
    epochId: text,
    expectedRevision: text,
  },
  "world.revision.discard": { worldId: text, epochId: text },
  "world.derive": {
    operationId: text,
    sourceWorldId: text,
    sourceHead: text,
  },
  "play.chain.revise-player": {
    operationId: text,
    worldId: text,
    chainId: text,
    eventId: number,
    replacementExchangeId: text,
    replacementText: text,
    continuation: text,
  },
  "play.chain.regenerate-narrative": {
    operationId: text,
    worldId: text,
    chainId: text,
    eventId: number,
  },
  "play.chain.start": {
    worldId: text,
    chainId: text,
    exchangeId: text,
    playerText: text,
  },
  "play.chain.append": {
    worldId: text,
    chainId: text,
    exchangeId: text,
    playerText: string,
  },
  "play.chain.cancel": {
    worldId: text,
    chainId: text,
    exchangeId: text,
  },
  "play.chain.inspect": { worldId: text },
  "play.timeline.page": { worldId: text, limit: number },
  "play.timeline.detail": {
    worldId: text,
    chainId: text,
    eventId: number,
  },
  "play.timeline.context": {
    worldId: text,
    chainId: text,
    eventId: number,
  },
  "world.play-context.read": { worldId: text },
  "world.surface.read": { worldId: text, surface: text },
  "world.extensions.read": { worldId: text },
  "world.extensions.set": { worldId: text, key: text, value: text },
  "world.play-decorations.read": { worldId: text },
} satisfies Record<Command, Fields>;

export function isV1RequestType(type: string): type is Command {
  return Object.hasOwn(requiredFields, type);
}

interface RequiredFieldsValidator {
  fields: string[];
  validate: ValidateFunction;
}

const requiredValidators = new Map<Command, RequiredFieldsValidator | null>();

// These schemas allow the V1 fields as provided, with no defaults or coercion.
let ajv: Ajv | undefined;

function compile(schema: SchemaObject): ValidateFunction {
  ajv ??= new Ajv({
    strict: true,
    // Conditional subschemas can require fields declared by their parent.
    strictRequired: false,
    strictNumbers: false,
    ownProperties: true,
  });
  return ajv.compile(schema);
}

function check(
  schema: SchemaObject,
  message: string | ((request: Request, command: Command) => string),
): Check {
  let validate: ValidateFunction | undefined;
  return (request, command) => {
    validate ??= compile(schema);
    if (!validate(request))
      return {
        message:
          typeof message === "string" ? message : message(request, command),
      };
  };
}

function field(
  name: string,
  schema: SchemaObject | boolean,
  message?: string,
): Check {
  return check(
    { type: "object", properties: { [name]: schema } },
    message ?? ((_request, command) => `${command}.${name} is invalid`),
  );
}

function exactFields(properties: Fields): SchemaObject {
  return {
    type: "object",
    properties: { type: string, ...properties },
    additionalProperties: false,
  };
}

function dependency(
  applies: (request: Request) => boolean,
  message: string,
): Check {
  return (request) => (applies(request) ? { message } : undefined);
}

const recoveryMode = field(
  "recovery",
  { const: "continue_partial" },
  "Invalid interrupted-response recovery mode",
);
const beforeRequired: Partial<Record<Command, readonly Check[]>> = {
  "world.revision.discard": [field("expectedRevision", text)],
  "orchestration.resume": [recoveryMode],
  "setting-improvement.resume": [recoveryMode],
  "world.revision.resume": [recoveryMode],
  "play.chain.append": [
    recoveryMode,
    dependency(
      (request) =>
        request.recovery === "continue_partial" && request.playerText !== "",
      "Continuing a partial response cannot add player input",
    ),
  ],
};

const configChecks: Partial<Record<Command, readonly Check[]>> = {
  "preferences.save": [
    check(
      {
        ...exactFields({ locale: {}, reading: {} }),
        anyOf: [{ required: ["locale"] }, { required: ["reading"] }],
      },
      "preferences.save must update locale or reading preferences",
    ),
    field(
      "locale",
      { enum: appLocales },
      "preferences.save.locale must be en or zh-CN",
    ),
    dependency(
      (request) =>
        request.reading !== undefined &&
        !isAppReadingPreferences(request.reading),
      "preferences.save.reading is invalid",
    ),
  ],
};

const contentSelection = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    character: boolean,
    scenario: boolean,
    opening: string,
    example: boolean,
    systemPrompt: boolean,
    attachments: { type: "array", items: string },
    entries: {
      type: "object",
      additionalProperties: { enum: ["world", "attachment"] },
    },
  },
};
const contentSillyTavernSelection = [
  check(
    exactFields({ source: string, name: text, selection: object }),
    "Invalid SillyTavern content fields",
  ),
  field("selection", contentSelection, "Invalid SillyTavern content selection"),
];

const invalidContentArchive =
  "content.import.archiveBase64 is not a supported content-package ZIP";

const contentChecks: Partial<Record<Command, readonly Check[]>> = {
  "content.copy": [
    field("operationId", {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$",
    }),
  ],
  "content.create-sample": [
    check(
      exactFields({
        locale: { enum: appLocales },
        sampleId: { enum: sampleContentPackageIds },
      }),
      "content.create-sample requires a supported locale and an optional built-in story ID",
    ),
  ],
  "content.create": [
    (request) => {
      if (request.gameplay === undefined) return;
      try {
        parseGameplay(request.gameplay);
      } catch (cause) {
        return { message: "content.create.gameplay is invalid", cause };
      }
    },
  ],
  "content.gameplay.set": [field("scheme", { enum: resolutionSchemes })],
  "content.replace": [
    field("files", {
      type: "array",
      items: {
        type: "object",
        required: ["path", "contents"],
        properties: {
          path: text,
          contents: string,
          encoding: { const: "base64" },
        },
      },
    }),
  ],
  "content.import": [
    field(
      "archiveBase64",
      {
        type: "string",
        maxLength: maxPortableContentArchiveBase64Characters,
        // Check groups of four by length so the regex can scan long archives.
        pattern: "^[A-Za-z0-9+/]*={0,2}$",
      },
      invalidContentArchive,
    ),
    dependency(
      ({ archiveBase64 }) =>
        typeof archiveBase64 === "string" && archiveBase64.length % 4 !== 0,
      invalidContentArchive,
    ),
    field("title", string),
    dependency(
      (request) =>
        typeof request.title === "string" &&
        !/^[^\r\n]{1,160}$/u.test(request.title.trim()),
      "content.import.title is invalid",
    ),
    field(
      "receipt",
      { const: "summary" },
      "content.import.receipt must be summary",
    ),
    check(
      exactFields({ archiveBase64: string, title: string, receipt: string }),
      (request) => {
        const extra = Object.keys(request).filter(
          (key) => !["type", "archiveBase64", "title", "receipt"].includes(key),
        );
        return `content.import contains unsupported fields: ${extra.join(", ")}`;
      },
    ),
  ],
  "content.sillytavern.inspect": [
    check(
      exactFields({ source: string }),
      "Invalid SillyTavern content fields",
    ),
  ],
  "content.sillytavern.preview": contentSillyTavernSelection,
  "content.sillytavern.import": contentSillyTavernSelection,
};

const textFiles = { type: "object", additionalProperties: string };
const playSillyTavernFields = {
  source: string,
  groupId: text,
  selected: { type: "array", items: text },
  name: text,
};
const playSillyTavernSelection = [
  check(
    exactFields(playSillyTavernFields),
    (_request, command) => `${command} has invalid fields`,
  ),
];
const safeEventId = field("eventId", {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

const playChecks: Partial<Record<Command, readonly Check[]>> = {
  "workspace.read": [field("scope", { const: "orchestration" })],
  "play.orchestration.preview": [
    check(
      exactFields({
        presetId: text,
        revision: text,
        surface: { enum: ["play", "author"] },
        gameplay: object,
        authorTarget: { enum: ["setting", "world-revision"] },
        connection: { enum: ["active", "none"] },
        candidate: {
          type: "object",
          required: ["files"],
          additionalProperties: false,
          properties: { files: textFiles, structure: object },
        },
      }),
      "play.orchestration.preview has invalid fields",
    ),
    (request) => {
      try {
        parseGameplay(request.gameplay);
      } catch (cause) {
        return {
          message: "play.orchestration.preview.gameplay is invalid",
          cause,
        };
      }
    },
    dependency(
      (request) =>
        request.surface === "play" && request.authorTarget !== undefined,
      "play.orchestration.preview.authorTarget requires the author surface",
    ),
  ],
  "prompt.preview": [
    field("playPresetId", text),
    field("playPresetRevision", text),
    dependency(
      (request) =>
        request.playPresetRevision !== undefined &&
        request.playPresetId === undefined,
      "prompt.preview.playPresetRevision must be provided with playPresetId",
    ),
  ],
  "play.create": [
    field(
      "files",
      textFiles,
      "play.create.files must be Record<string,string>",
    ),
  ],
  "play.save": [
    field("files", textFiles, "play.save.files must be Record<string,string>"),
    field("structure", object, "play.save.structure must be a structured map"),
    field("expectedRevision", text),
  ],
  "play.workbench.read": [
    check(
      {
        type: "object",
        properties: {
          draft: {
            type: "object",
            required: ["files"],
            properties: { files: textFiles, structure: object },
          },
        },
        dependencies: { draft: ["presetId"] },
      },
      "play.workbench.read.draft requires presetId, text files and an optional structured map",
    ),
    field("worldId", text),
    field("presetId", text),
    field("revision", text),
    dependency(
      (request) =>
        request.revision !== undefined && request.presetId === undefined,
      "play.workbench.read.revision must be provided with presetId",
    ),
  ],
  "play.sillytavern.inspect": [
    check(
      exactFields({ source: string, groupId: text }),
      "play.sillytavern.inspect has invalid fields",
    ),
  ],
  "play.sillytavern.preview": playSillyTavernSelection,
  "play.sillytavern.import": [
    check(
      exactFields({
        ...playSillyTavernFields,
        operationId: { ...text, maxLength: 160 },
      }),
      "play.sillytavern.import has invalid fields",
    ),
  ],
  "play.sillytavern.source.read": [
    check(
      exactFields({ presetId: text }),
      "play.sillytavern.source.read has invalid fields",
    ),
  ],
  "play.sillytavern.source.associate": [
    check(
      exactFields({ presetId: text, source: string }),
      "play.sillytavern.source.associate has invalid fields",
    ),
  ],
  "play.orchestration.provenance.read": [
    check(
      exactFields({
        presetId: text,
        revision: { type: "string", pattern: "^rev-[a-f0-9]{64}$" },
        surface: { enum: ["playPrompts", "authorPrompts"] },
        entryId: text,
        target: { enum: ["current", "draft"] },
      }),
      "play.orchestration.provenance.read has invalid fields",
    ),
  ],
  "play.import": [
    field("files", {
      type: "array",
      items: {
        type: "object",
        required: ["path", "contents"],
        properties: { path: string, contents: string, encoding: false },
      },
    }),
  ],
  "play.timeline.page": [
    check(
      {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: text,
        },
      },
      "play.timeline.page pagination is invalid",
    ),
  ],
  "play.chain.revise-player": [safeEventId],
  "play.chain.regenerate-narrative": [safeEventId],
  "play.timeline.detail": [safeEventId],
  "play.timeline.context": [safeEventId],
};

const controlDraftFingerprint = field("expectedFingerprint", {
  type: "string",
  pattern: "^sha256:[0-9a-f]{64}$",
});

const worldChecks: Partial<Record<Command, readonly Check[]>> = {
  "world.create": [field("model", object)],
  "world.control-draft.preview": [controlDraftFingerprint],
  "world.control-draft.apply": [controlDraftFingerprint],
  "world.story.export": [
    field(
      "format",
      { enum: ["markdown", "text"] },
      "world.story.export.format must be markdown or text",
    ),
  ],
  "world.extensions.set": [
    field(
      "value",
      { enum: ["on", "off", "default"] },
      "Invalid world extension choice",
    ),
  ],
  "artifacts.read": [field("channel", text)],
  "artifacts.debug": [field("operationId", text)],
};

const workbenchPreview = field(
  "sessionId",
  text,
  "Authoring preview sessionId is invalid",
);
const sessionId = field("sessionId", text);
const filePolicy = field("filePolicy", { enum: ["keep", "revert"] });
const continuation = field("continuation", {
  type: "object",
  properties: {
    kind: { enum: ["fresh_context", "continue_context"] },
    sessionId: text,
  },
  required: ["kind"],
  if: { properties: { kind: { const: "continue_context" } } },
  then: { required: ["sessionId"] },
  else: { not: { required: ["sessionId"] } },
});
const freshSessionId = (request: Request, command: Command) => {
  // Preserve presence semantics for direct JavaScript calls with an undefined field.
  const selected = request.continuation as { kind: string };
  if (selected.kind === "fresh_context" && "sessionId" in selected)
    return { message: `${command}.continuation is invalid` };
};
const revisionId =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const epochId = field("epochId", {
  type: "string",
  pattern: `^revision-${revisionId}$`,
});

const authoringChecks: Partial<Record<Command, readonly Check[]>> = {
  "setting-improvement.message.edit": [filePolicy],
  "world.revision.message.edit": [filePolicy],
};

const turnNote = field("turnNote", string, "turnNote is invalid");

// The shared turnNote check came after basic fields and before these refinements.
const afterTurnNote: Partial<Record<Command, readonly Check[]>> = {
  "play.chain.revise-player": [
    field("sendAfterRevision", boolean),
    field("requireCompatible", boolean),
    field("continuation", {
      enum: ["auto", "continue_context", "fresh_context"],
    }),
  ],
  "world.surface.read": [
    field("surface", {
      enum: ["state", "control", "history", "runtime", "revision"],
    }),
    field("head", {
      type: "string",
      pattern: "^(?:genesis|commit:[1-9][0-9]*)$",
    }),
  ],
  "setting-improvement.preview": [workbenchPreview],
  "world.revision.preview": [workbenchPreview],
  "setting-improvement.status": [sessionId],
  "world.revision.status": [sessionId],
  "orchestration.message": [
    continuation,
    freshSessionId,
    field("focusedEntryId", text),
  ],
  "setting-improvement.message": [continuation, freshSessionId],
  "world.revision.message": [continuation, freshSessionId],
  "setting-improvement.rollback": [
    field("changeSetId", {
      type: "string",
      pattern: "^change-set:(0|[1-9][0-9]*)$",
    }),
  ],
  "world.revision.files.replace": [epochId],
  "world.revision.rollback": [
    epochId,
    field(
      "changeSetId",
      { type: "string", pattern: `^change-set:${revisionId}$` },
      "world.revision.rollback target is invalid",
    ),
  ],
  "world.revision.apply": [epochId],
  "world.revision.discard": [epochId],
};

const afterRequired: Partial<Record<Command, readonly Check[]>> = {
  ...configChecks,
  ...contentChecks,
  ...playChecks,
  ...worldChecks,
  ...authoringChecks,
};

function requiredValidator(command: Command): RequiredFieldsValidator | null {
  const cached = requiredValidators.get(command);
  if (cached !== undefined) return cached;
  const properties = Object.entries(requiredFields[command]);
  // Each field occupies one clause so a bad field still takes precedence over
  // a later missing field, as it did in the original parser.
  const validator =
    properties.length === 0
      ? null
      : {
          fields: properties.map(([field]) => field),
          validate: compile({
            type: "object",
            allOf: properties.map(([field, property]) => ({
              required: [field],
              properties: { [field]: property },
            })),
          }),
        };
  requiredValidators.set(command, validator);
  return validator;
}

function validateRequired(
  command: Command,
  request: Request,
): V1RequestFieldFailure | undefined {
  const validator = requiredValidator(command);
  if (validator === null || validator.validate(request)) return;
  const clause = Number(
    validator.validate.errors?.[0]?.schemaPath.split("/")[2],
  );
  return { message: `${command}.${validator.fields[clause]!} is invalid` };
}

export function validateV1Request(
  command: Command,
  request: Request,
): V1RequestFieldFailure | undefined {
  for (const check of beforeRequired[command] ?? []) {
    const failure = check(request, command);
    if (failure !== undefined) return failure;
  }
  const missing = validateRequired(command, request);
  if (missing !== undefined) return missing;
  for (const check of afterRequired[command] ?? []) {
    const failure = check(request, command);
    if (failure !== undefined) return failure;
  }
  // content.import is closed and has already reported any unexpected fields.
  if (command === "content.import") return;
  const noteFailure = turnNote(request, command);
  if (noteFailure !== undefined) return noteFailure;
  for (const check of afterTurnNote[command] ?? []) {
    const failure = check(request, command);
    if (failure !== undefined) return failure;
  }
}
