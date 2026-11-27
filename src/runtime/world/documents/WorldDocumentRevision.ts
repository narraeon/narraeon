import { createHash, randomUUID } from "node:crypto";
import {
  Document,
  type Range,
  type YAMLMap,
  isMap,
  isSeq,
  parseDocument,
  stringify,
  visit,
} from "yaml";
import {
  documentCodec,
  nextAvailableShortRef,
} from "../../../shared/world-document-format.ts";
import type { WorldDocumentStore } from "../WorldDocumentStore.ts";
import {
  type InternalDocumentEntry,
  parseRestrictedYaml,
  scanMarkdownHeadings,
} from "../../../shared/world-documents/WorldDocumentCodec.ts";
import { WorldDocumentIndex } from "./WorldDocumentIndex.ts";
import {
  copyLocator,
  diagnostic,
  documentIdPattern,
  freeze,
  hasOnlyKeys,
  isRecord,
  shortRefPattern,
  trimTrailingWhitespaceOffset,
  validMarkdownLocator,
  validRelativePath,
  validYamlLocator,
} from "../../../shared/world-documents/WorldDocumentSource.ts";
import type {
  WorldDocumentCodec,
  WorldDocumentDescriptor,
  WorldDocumentDiagnostic,
  WorldDocumentEditOutcome,
  WorldDocumentFile,
  WorldDocumentLocator,
  WorldDocumentMetadataInput,
  WorldDocumentRevisionDiagnostic,
  WorldDocumentRevisionFailure,
  WorldDocumentRevisionRequest,
  WorldDocumentRevisionResult,
} from "./WorldDocumentTypes.ts";

/** Expands ordered edits in memory and exposes only a fully validated candidate. */
export class WorldDocumentRevision {
  readonly #source: WorldDocumentIndex;
  readonly #wrapSnapshot: (index: WorldDocumentIndex) => WorldDocumentStore;

  constructor(
    source: WorldDocumentIndex,
    wrapSnapshot: (index: WorldDocumentIndex) => WorldDocumentStore,
  ) {
    this.#source = source;
    this.#wrapSnapshot = wrapSnapshot;
  }

  revise(request: WorldDocumentRevisionRequest): WorldDocumentRevisionResult {
    let activeCommandIndex: number | null = null;
    try {
      if (
        !isRecord(request) ||
        !hasOnlyKeys(request, ["commands"]) ||
        !Array.isArray(request.commands) ||
        request.commands.length === 0 ||
        request.commands.length > 64
      )
        return this.#revisionFailure(null, {
          code: "query_invalid",
          message:
            "revise requires a closed candidate batch of 1 to 64 commands",
        });

      const working: RevisionWorkingFile[] = this.#source.files.map((file) => ({
        file: { ...file },
        original: file,
        lastCommandIndex: null,
      }));
      const editOutcomes: WorldDocumentEditOutcome[] = [];
      for (const [commandIndex, command] of request.commands.entries()) {
        activeCommandIndex = commandIndex;
        if (!isRecord(command) || typeof command.kind !== "string")
          return this.#revisionFailure(commandIndex, {
            code: "query_invalid",
            message: "A revise command must be a closed object with kind",
          });
        const current = new WorldDocumentIndex(
          this.#source.layout,
          working.map(({ file }) => file),
        );
        let touchedPath: string;
        if (command.kind === "create") {
          if (
            !hasOnlyKeys(command, [
              "kind",
              "temporaryName",
              "logicalPath",
              "codec",
              "refHint",
              "title",
              "summary",
              "aliases",
              "body",
            ]) ||
            typeof command.temporaryName !== "string" ||
            !/^[a-z][a-z0-9_-]{0,63}$/u.test(command.temporaryName) ||
            working.some(
              ({ temporaryName }) => temporaryName === command.temporaryName,
            ) ||
            typeof command.logicalPath !== "string" ||
            (command.codec !== "yaml" && command.codec !== "markdown") ||
            !validRevisionLogicalPath(
              command.logicalPath,
              command.codec,
              this.#source.logicalRoot,
            ) ||
            typeof command.refHint !== "string" ||
            command.refHint.length < 2 ||
            command.refHint.length > 32 ||
            !shortRefPattern.test(command.refHint) ||
            !validDocumentMetadata(command) ||
            (command.codec === "yaml"
              ? (typeof command.body !== "string" && !isRecord(command.body)) ||
                (isRecord(command.body) &&
                  Object.hasOwn(command.body, "$document"))
              : typeof command.body !== "string")
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "Create-command arguments, temporary name, logical path, codec, or document metadata are invalid",
            });
          if (working.some(({ file }) => file.path === command.logicalPath))
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_duplicate",
              logicalPath: command.logicalPath,
              message: "Create target logical path already exists",
            });
          const createLogicalPath = command.logicalPath;
          const occupiedRefs = new Set(
            current.entries.flatMap(({ descriptor }) =>
              descriptor === undefined ? [] : [descriptor.shortRef],
            ),
          );
          const shortRef = nextAvailableShortRef(command.refHint, occupiedRefs);
          const documentId = `doc.${randomUUID().replace(/-/gu, "")}`;
          const header = {
            $document: {
              id: documentId,
              ref: shortRef,
              title: command.title,
              summary: command.summary,
              aliases: [...command.aliases],
            },
          };
          let contents: string;
          if (command.codec === "yaml") {
            const revisionBody =
              typeof command.body === "string"
                ? parseRevisionYamlBodySource(command.logicalPath, command.body)
                : { value: command.body };
            if ("diagnostics" in revisionBody)
              return this.#revisionFailure(
                commandIndex,
                revisionBody.diagnostics,
              );
            const body = this.#resolveRevisionYamlValue(
              revisionBody.value,
              current,
              working,
              {
                referenceInput:
                  typeof command.body === "string"
                    ? "explicit_short_ref_only"
                    : "persistent_or_explicit",
              },
            );
            if ("diagnostics" in body)
              return this.#revisionFailure(
                commandIndex,
                body.diagnostics.map((problem) => ({
                  ...problem,
                  logicalPath: createLogicalPath,
                  documentId,
                })),
              );
            if (!isRecord(body.value) || Object.hasOwn(body.value, "$document"))
              return this.#revisionFailure(commandIndex, {
                code: "yaml_invalid",
                logicalPath: command.logicalPath,
                message:
                  "Create YAML body must be a safe map without $document",
              });
            contents = stringify(
              { ...header, ...body.value },
              { indent: 2, lineWidth: 0 },
            );
          } else
            contents = `---\n${stringify(header, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${(command.body as string).trimEnd()}\n`;
          working.push({
            file: { path: command.logicalPath, contents },
            original: null,
            temporaryName: command.temporaryName,
            lastCommandIndex: commandIndex,
          });
          touchedPath = command.logicalPath;
        } else if (command.kind === "move") {
          if (this.#source.layout === "world_state")
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message: "World state revision does not support move",
            });
          if (
            !hasOnlyKeys(command, ["kind", "document", "toLogicalPath"]) ||
            typeof command.toLogicalPath !== "string"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message: "A move command requires a target and new logical path",
            });
          const target = this.#resolveRevisionTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          if (
            !validRevisionLogicalPath(
              command.toLogicalPath,
              target.entry.descriptor.codec,
              this.#source.logicalRoot,
            )
          )
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_invalid",
              logicalPath: command.toLogicalPath,
              documentId: target.entry.descriptor.documentId,
              message: `Move target must be a safe logical path under ${this.#source.logicalRoot}/ with the original codec`,
            });
          if (
            working.some(
              ({ file }) =>
                file !== target.working.file &&
                file.path === command.toLogicalPath,
            )
          )
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_duplicate",
              logicalPath: command.toLogicalPath,
              documentId: target.entry.descriptor.documentId,
              message: "Move target logical path already exists",
            });
          target.working.file.path = command.toLogicalPath;
          target.working.lastCommandIndex = commandIndex;
          touchedPath = command.toLogicalPath;
        } else if (command.kind === "replace") {
          if (
            !hasOnlyKeys(command, ["kind", "document", "contents"]) ||
            typeof command.contents !== "string"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A replace command requires a target and complete UTF-8 document source",
            });
          const target = this.#resolveRevisionReplaceTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          const previousDescriptor = target.entry.descriptor;
          target.working.file.contents = command.contents;
          delete target.working.file.encoding;
          target.working.lastCommandIndex = commandIndex;
          touchedPath = target.working.file.path;
          const candidate = new WorldDocumentIndex(
            this.#source.layout,
            working.map(({ file }) => file),
          );
          const localProblems = this.#localRevisionDiagnostics(
            candidate,
            touchedPath,
          );
          if (localProblems.length > 0)
            return this.#revisionFailure(commandIndex, localProblems);
          const nextDescriptor = candidate.entries.find(
            ({ file }) => file.path === touchedPath,
          )?.descriptor;
          if (nextDescriptor === undefined)
            return this.#revisionFailure(commandIndex, {
              code: "document_header_invalid",
              logicalPath: touchedPath,
              message:
                "Replace must produce a world document with a usable identity",
            });
          const identityProblems: WorldDocumentDiagnostic[] = [];
          if (
            previousDescriptor !== undefined &&
            previousDescriptor.documentId !== nextDescriptor.documentId
          )
            identityProblems.push({
              code: "document_identity_invalid",
              logicalPath: touchedPath,
              documentId: nextDescriptor.documentId,
              message: "Replacing a valid document cannot change its identity",
            });
          if (
            previousDescriptor !== undefined &&
            previousDescriptor.shortRef !== nextDescriptor.shortRef
          )
            identityProblems.push({
              code: "document_short_ref_invalid",
              logicalPath: touchedPath,
              documentId: nextDescriptor.documentId,
              message:
                "Replacing a valid document cannot change its short reference",
            });
          if (identityProblems.length > 0)
            return this.#revisionFailure(commandIndex, identityProblems);
        } else if (command.kind === "write") {
          if (
            !hasOnlyKeys(command, ["kind", "logicalPath", "contents"]) ||
            typeof command.logicalPath !== "string" ||
            typeof command.contents !== "string"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A write command requires a logical path and complete UTF-8 document source",
            });
          const writePath = command.logicalPath;
          const codec = documentCodec(writePath);
          if (
            codec === null ||
            !validRevisionLogicalPath(
              writePath,
              codec,
              this.#source.logicalRoot,
            )
          )
            return this.#revisionFailure(commandIndex, {
              code: "logical_path_invalid",
              logicalPath: writePath,
              message: `Write target must be a safe logical path under ${this.#source.logicalRoot}/ ending in .yaml or .md`,
            });
          const existing = working.find(({ file }) => file.path === writePath);
          const previous = current.entries.find(
            ({ file }) => file.path === writePath,
          )?.descriptor;
          const source = parseWriteDocumentSource(
            writePath,
            codec,
            command.contents,
            previous,
          );
          if ("diagnostics" in source)
            return this.#revisionFailure(commandIndex, source.diagnostics);
          // A damaged document has no usable identity to preserve, yet other
          // documents may still reference the identity it used to carry. Only
          // there is the authored id honoured; conflicts surface as diagnostics.
          const repairing = existing !== undefined && previous === undefined;
          const documentId =
            previous?.documentId ??
            (repairing ? source.authoredId : null) ??
            `doc.${randomUUID().replace(/-/gu, "")}`;
          const shortRef =
            previous?.shortRef ??
            (repairing
              ? source.refHint
              : nextAvailableShortRef(
                  source.refHint,
                  new Set(
                    current.entries.flatMap(({ descriptor }) =>
                      descriptor === undefined ? [] : [descriptor.shortRef],
                    ),
                  ),
                ));
          const header = {
            $document: {
              id: documentId,
              ref: shortRef,
              title: source.metadata.title,
              summary: source.metadata.summary,
              aliases: [...source.metadata.aliases],
              ...(previous?.retired === true ? { retired: true } : {}),
            },
          };
          let contents: string;
          if (codec === "yaml") {
            // Unlike create, write also overwrites existing documents, whose
            // own source already spells references as document ids. Rejecting
            // that form would break read-edit-write on any referencing file.
            const body = this.#resolveRevisionYamlValue(
              source.body,
              current,
              working,
              { referenceInput: "persistent_or_explicit" },
            );
            if ("diagnostics" in body)
              return this.#revisionFailure(
                commandIndex,
                body.diagnostics.map((problem) => ({
                  ...problem,
                  logicalPath: writePath,
                  documentId,
                })),
              );
            if (!isRecord(body.value))
              return this.#revisionFailure(commandIndex, {
                code: "yaml_invalid",
                logicalPath: writePath,
                documentId,
                message: "Write YAML body must be a safe map without $document",
              });
            contents = stringify(
              { ...header, ...body.value },
              { indent: 2, lineWidth: 0 },
            );
          } else
            contents = `---\n${stringify(header, { indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${(source.body as string).trimEnd()}\n`;
          if (existing === undefined)
            working.push({
              file: { path: writePath, contents },
              original: null,
              lastCommandIndex: commandIndex,
            });
          else {
            existing.file.contents = contents;
            delete existing.file.encoding;
            existing.lastCommandIndex = commandIndex;
          }
          touchedPath = writePath;
        } else if (command.kind === "retire") {
          if (
            this.#source.layout !== "world_state" ||
            !hasOnlyKeys(command, ["kind", "document", "retired"]) ||
            typeof command.retired !== "boolean"
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A retire command requires a world-state target and boolean retired value",
            });
          const target = this.#resolveRevisionTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          if (target.entry.descriptor.retired !== command.retired)
            target.working.file.contents = setDocumentRetired(
              target.working.file.contents,
              target.entry.descriptor.codec,
              command.retired,
            );
          delete target.working.file.encoding;
          target.working.lastCommandIndex = commandIndex;
          touchedPath = target.working.file.path;
        } else if (command.kind === "patch") {
          if (
            !hasOnlyKeys(command, ["kind", "document", "edits"]) ||
            !Array.isArray(command.edits) ||
            command.edits.length < 1 ||
            command.edits.length > 32
          )
            return this.#revisionFailure(commandIndex, {
              code: "query_invalid",
              message:
                "A patch command requires a target and 1 to 32 closed edits",
            });
          const target = this.#resolveRevisionTarget(
            current,
            working,
            command.document,
          );
          if ("diagnostics" in target)
            return this.#revisionFailure(commandIndex, target.diagnostics);
          const logicalPath = target.working.file.path;
          const probe = (contents: string) =>
            this.#localRevisionDiagnostics(
              new WorldDocumentIndex(
                this.#source.layout,
                working.map(({ file }) =>
                  file.path === logicalPath
                    ? { path: logicalPath, contents }
                    : file,
                ),
              ),
              logicalPath,
            );
          const resolveValue: WorldDocumentYamlValueResolver = (
            value,
            locator,
          ) =>
            this.#resolveRevisionYamlValue(
              value,
              current,
              working,
              { referenceInput: "persistent_or_explicit" },
              locator,
            );
          // Each edit settles on its own: it is applied to the text left by the
          // edits before it, validated alone, and skipped if it cannot apply.
          let contents = target.working.file.contents;
          let metadata: WorldDocumentMetadataInput = {
            title: target.entry.descriptor.title,
            summary: target.entry.descriptor.summary,
            aliases: [...target.entry.descriptor.aliases],
          };
          const outcomes: WorldDocumentEditOutcome[] = [];
          for (const [editIndex, edit] of command.edits.entries()) {
            let settled: RevisionEditResult =
              target.entry.codec === "markdown"
                ? applyMarkdownRevisionEdit(contents, metadata, edit)
                : applyYamlRevisionEdit(contents, metadata, edit, resolveValue);
            if (settled.kind === "applied") {
              const problems = probe(settled.contents);
              if (problems.length > 0)
                settled = { kind: "failed", diagnostic: problems[0]! };
            }
            if (settled.kind === "applied") {
              contents = settled.contents;
              metadata = settled.metadata;
            }
            outcomes.push(
              revisionEditOutcome(commandIndex, editIndex, settled, {
                logicalPath,
                documentId: target.entry.descriptor.documentId,
              }),
            );
          }
          if (outcomes.some(({ status }) => status === "applied")) {
            target.working.file.contents = contents;
            delete target.working.file.encoding;
          }
          target.working.lastCommandIndex = commandIndex;
          touchedPath = logicalPath;
          editOutcomes.push(...outcomes);
          if (outcomes.every(({ status }) => status === "failed"))
            return this.#revisionFailure(
              commandIndex,
              outcomes.flatMap(({ diagnostic }) =>
                diagnostic === undefined ? [] : [diagnostic],
              ),
              outcomes,
            );
        } else
          return this.#revisionFailure(commandIndex, {
            code: "query_invalid",
            message:
              "World-document candidate batch does not support this command kind",
          });

        const candidate = new WorldDocumentIndex(
          this.#source.layout,
          working.map(({ file }) => file),
        );
        const localProblems = this.#localRevisionDiagnostics(
          candidate,
          touchedPath,
        );
        if (localProblems.length > 0)
          return this.#revisionFailure(commandIndex, localProblems);
      }

      const snapshot = new WorldDocumentIndex(
        this.#source.layout,
        working.map(({ file }) => file),
      );
      if (snapshot.status !== "usable")
        return freeze({
          kind: "error" as const,
          ok: false as const,
          sourceSnapshotId: this.#source.id,
          snapshotStatus: this.#source.status,
          diagnostics: freeze(
            snapshot.diagnostics.map((problem) => {
              const commandIndex = working.find(
                ({ file }) => file.path === problem.logicalPath,
              )?.lastCommandIndex;
              return revisionDiagnostic(commandIndex ?? null, problem);
            }),
          ),
          editOutcomes: freeze([...editOutcomes]),
        });
      const changes = working
        .filter(
          ({ file, original }) =>
            file.path !== original?.path ||
            file.contents !== original?.contents ||
            file.encoding !== original?.encoding,
        )
        .map(({ file, original, lastCommandIndex }) => {
          const descriptor = snapshot.entries.find(
            ({ file: candidate }) => candidate.path === file.path,
          )?.descriptor;
          if (descriptor === undefined)
            throw new Error(
              "Usable candidate is missing its final world-document identity",
            );
          return freeze({
            documentId: descriptor.documentId,
            shortRef: descriptor.shortRef,
            codec: descriptor.codec,
            commandIndex: lastCommandIndex,
            before:
              original === null
                ? null
                : freeze({
                    logicalPath: original.path,
                    contents: original.contents,
                    mechanicalHash: mechanicalHash(original.contents),
                  }),
            after: freeze({
              logicalPath: file.path,
              contents: file.contents,
              mechanicalHash: mechanicalHash(file.contents),
            }),
          });
        })
        .sort((left, right) =>
          left.after.logicalPath.localeCompare(right.after.logicalPath),
        );
      return freeze({
        kind: "revision" as const,
        ok: true as const,
        sourceSnapshotId: this.#source.id,
        snapshot: this.#wrapSnapshot(snapshot),
        snapshotStatus: snapshot.status,
        files: snapshot.files,
        diagnostics: freeze([]),
        changes: freeze(changes),
        editOutcomes: freeze(editOutcomes),
      });
    } catch {
      return this.#revisionFailure(activeCommandIndex, {
        code: "query_invalid",
        message: "Revise command cannot be interpreted as safe closed input",
      });
    }
  }

  #revisionFailure(
    commandIndex: number | null,
    problem: WorldDocumentDiagnostic | readonly WorldDocumentDiagnostic[],
    editOutcomes: readonly WorldDocumentEditOutcome[] = [],
  ): WorldDocumentRevisionFailure {
    const diagnostics: readonly WorldDocumentDiagnostic[] = Array.isArray(
      problem,
    )
      ? (problem as readonly WorldDocumentDiagnostic[])
      : [problem as WorldDocumentDiagnostic];
    return freeze({
      kind: "error" as const,
      ok: false as const,
      sourceSnapshotId: this.#source.id,
      snapshotStatus: this.#source.status,
      diagnostics: freeze(
        diagnostics.map((candidate) =>
          revisionDiagnostic(commandIndex, candidate),
        ),
      ),
      editOutcomes: freeze([...editOutcomes]),
    });
  }

  #resolveRevisionTarget(
    snapshot: WorldDocumentIndex,
    working: readonly RevisionWorkingFile[],
    target: unknown,
  ):
    | {
        readonly entry: InternalDocumentEntry & {
          descriptor: WorldDocumentDescriptor;
        };
        readonly working: RevisionWorkingFile;
      }
    | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
    let resolved:
      | { readonly entry: InternalDocumentEntry }
      | { readonly diagnostics: readonly WorldDocumentDiagnostic[] };
    if (
      isRecord(target) &&
      Object.keys(target).length === 1 &&
      typeof target.temporaryName === "string"
    ) {
      const temporary = working.filter(
        ({ temporaryName }) => temporaryName === target.temporaryName,
      );
      if (temporary.length !== 1)
        return {
          diagnostics: freeze([
            diagnostic({
              code:
                temporary.length === 0
                  ? "document_not_found"
                  : "document_ambiguous",
              message:
                "Candidate-batch temporary name does not uniquely identify a document created in the batch",
            }),
          ]),
        };
      resolved = snapshot.resolveSelector({
        logicalPath: temporary[0]!.file.path,
      });
    } else resolved = snapshot.resolveSelector(target);
    if ("diagnostics" in resolved) return resolved;
    if (resolved.entry.descriptor === undefined)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "document_header_invalid",
            logicalPath: resolved.entry.file.path,
            message: "Candidate-batch target has no usable document identity",
          }),
        ]),
      };
    const matches = working.filter(
      ({ file }) => file.path === resolved.entry.file.path,
    );
    if (matches.length !== 1)
      return {
        diagnostics: freeze([
          diagnostic({
            code: "document_ambiguous",
            logicalPath: resolved.entry.file.path,
            documentId: resolved.entry.descriptor.documentId,
            message: "Target is not unique in the complete candidate file set",
          }),
        ]),
      };
    return {
      entry: resolved.entry as InternalDocumentEntry & {
        descriptor: WorldDocumentDescriptor;
      },
      working: matches[0]!,
    };
  }

  #resolveRevisionReplaceTarget(
    snapshot: WorldDocumentIndex,
    working: readonly RevisionWorkingFile[],
    target: unknown,
  ):
    | {
        readonly entry: InternalDocumentEntry;
        readonly working: RevisionWorkingFile;
      }
    | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
    if (
      !isRecord(target) ||
      Object.keys(target).length !== 1 ||
      typeof target.logicalPath !== "string"
    )
      return this.#resolveRevisionTarget(snapshot, working, target);
    const entries = snapshot.entries.filter(
      ({ file }) => file.path === target.logicalPath,
    );
    const files = working.filter(
      ({ file }) => file.path === target.logicalPath,
    );
    if (entries.length !== 1 || files.length !== 1)
      return {
        diagnostics: freeze([
          diagnostic({
            code:
              entries.length === 0 || files.length === 0
                ? "document_not_found"
                : "document_ambiguous",
            logicalPath: target.logicalPath,
            message:
              "Replace logical path does not uniquely identify a candidate world document",
          }),
        ]),
      };
    return { entry: entries[0]!, working: files[0]! };
  }

  #resolveRevisionYamlValue(
    value: unknown,
    snapshot: WorldDocumentIndex,
    working: readonly RevisionWorkingFile[],
    options: {
      readonly referenceInput:
        "persistent_or_explicit" | "explicit_short_ref_only";
    } = { referenceInput: "persistent_or_explicit" },
    locator: readonly (string | number)[] = [],
    seen = new WeakSet<object>(),
  ):
    | { readonly value: unknown }
    | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    )
      return { value };
    if (typeof value !== "object" || value === null || seen.has(value))
      return {
        diagnostics: freeze([
          diagnostic({
            code: "yaml_invalid",
            locator: { yaml: [...locator] },
            message:
              "Candidate YAML value must be an acyclic JSON-shaped safe value",
          }),
        ]),
      };
    seen.add(value);
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const [index, item] of value.entries()) {
        const resolved = this.#resolveRevisionYamlValue(
          item,
          snapshot,
          working,
          options,
          [...locator, index],
          seen,
        );
        if ("diagnostics" in resolved) return resolved;
        result.push(resolved.value);
      }
      seen.delete(value);
      return { value: result };
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !isRecord(value) ||
      (prototype !== Object.prototype && prototype !== null)
    )
      return {
        diagnostics: freeze([
          diagnostic({
            code: "yaml_invalid",
            locator: { yaml: [...locator] },
            message: "Candidate YAML map must be a plain object",
          }),
        ]),
      };
    if (Object.hasOwn(value, "$ref")) {
      if (
        Object.keys(value).length !== 1 ||
        (options.referenceInput === "explicit_short_ref_only" &&
          (typeof value.$ref !== "string" || !value.$ref.startsWith("@")))
      )
        return {
          diagnostics: freeze([
            diagnostic({
              code: "document_reference_invalid",
              locator: { yaml: [...locator] },
              message:
                options.referenceInput === "explicit_short_ref_only"
                  ? "$ref must use an @short-ref returned by Runtime, and the reference object cannot contain other fields"
                  : "A $ref object cannot contain other fields",
            }),
          ]),
        };
      if (typeof value.$ref === "string") {
        if (!value.$ref.startsWith("@")) {
          if (!documentIdPattern.test(value.$ref))
            return {
              diagnostics: freeze([
                diagnostic({
                  code: "document_reference_invalid",
                  locator: { yaml: [...locator] },
                  message:
                    "$ref must be a document identity or explicit document selector",
                }),
              ]),
            };
          seen.delete(value);
          return { value: { $ref: value.$ref } };
        }
        const target = this.#resolveRevisionTarget(snapshot, working, {
          shortRef: value.$ref.slice(1),
        });
        if ("diagnostics" in target)
          return {
            diagnostics: freeze(
              target.diagnostics.map((problem) =>
                diagnostic({
                  ...problem,
                  locator: { yaml: [...locator] },
                }),
              ),
            ),
          };
        seen.delete(value);
        return { value: { $ref: target.entry.descriptor.documentId } };
      }
      const target = this.#resolveRevisionTarget(snapshot, working, value.$ref);
      if ("diagnostics" in target)
        return {
          diagnostics: freeze(
            target.diagnostics.map((problem) =>
              diagnostic({
                ...problem,
                locator: { yaml: [...locator] },
              }),
            ),
          ),
        };
      seen.delete(value);
      return { value: { $ref: target.entry.descriptor.documentId } };
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      const resolved = this.#resolveRevisionYamlValue(
        item,
        snapshot,
        working,
        options,
        [...locator, key],
        seen,
      );
      if ("diagnostics" in resolved) return resolved;
      result[key] = resolved.value;
    }
    seen.delete(value);
    return { value: result };
  }

  #localRevisionDiagnostics(
    snapshot: WorldDocumentIndex,
    logicalPath: string,
  ): readonly WorldDocumentDiagnostic[] {
    const entries = snapshot.entries.filter(
      ({ file }) => file.path === logicalPath,
    );
    if (entries.length !== 1)
      return freeze([
        diagnostic({
          code:
            entries.length === 0
              ? "document_not_found"
              : "logical_path_duplicate",
          logicalPath,
          message: "Command must produce one unique target world document",
        }),
      ]);
    const entry = entries[0]!;
    const malformedReference = entry.references.some(
      ({ targetId }) => targetId === null,
    );
    return freeze(
      entry.diagnostics.filter(
        ({ code }) =>
          code !== "document_identity_duplicate" &&
          code !== "document_short_ref_duplicate" &&
          (code !== "document_reference_invalid" || malformedReference),
      ),
    );
  }
}

interface RevisionWorkingFile {
  file: {
    path: string;
    contents: string;
    encoding?: "base64";
  };
  readonly original: WorldDocumentFile | null;
  temporaryName?: string;
  lastCommandIndex: number | null;
}

function parseRevisionYamlBodySource(
  logicalPath: string,
  source: string,
):
  | { readonly value: Record<string, unknown> }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  const entry: InternalDocumentEntry = {
    file: { path: logicalPath, contents: source },
    relativePath: logicalPath,
    codec: "yaml",
    references: [],
    diagnostics: [],
  };
  const parsed = parseRestrictedYaml(entry, source, 0);
  if (parsed === null || entry.diagnostics.length > 0)
    return { diagnostics: freeze([...entry.diagnostics]) };
  if (Object.hasOwn(parsed.value, "$document"))
    return {
      diagnostics: freeze([
        diagnostic({
          code: "yaml_invalid",
          logicalPath,
          message:
            "Create YAML body cannot include a $document technical header",
        }),
      ]),
    };
  return { value: parsed.value };
}

// Splits one complete document source into the metadata the author owns and
// the body it wrote. `id` is deliberately not read back: the store assigns it.
// A source with no `$document` at all is what read_document hands back, so
// overwriting an existing document may omit it and inherit that document's
// metadata; only a new document has nothing to inherit and must supply one.
function parseWriteDocumentSource(
  logicalPath: string,
  codec: WorldDocumentCodec,
  source: string,
  existing: WorldDocumentDescriptor | undefined,
):
  | {
      readonly metadata: WorldDocumentMetadataInput;
      readonly refHint: string;
      readonly authoredId: string | null;
      readonly body: Record<string, unknown> | string;
    }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  let header: unknown;
  let body: Record<string, unknown> | string;
  if (codec === "yaml") {
    const entry: InternalDocumentEntry = {
      file: { path: logicalPath, contents: source },
      relativePath: logicalPath,
      codec: "yaml",
      references: [],
      diagnostics: [],
    };
    const parsed = parseRestrictedYaml(entry, source, 0);
    if (parsed === null || entry.diagnostics.length > 0)
      return { diagnostics: freeze([...entry.diagnostics]) };
    const { $document, ...rest } = parsed.value;
    header = $document;
    body = rest;
  } else if (source.startsWith("---\n")) {
    const envelope = markdownEnvelope(source);
    if ("diagnostics" in envelope)
      return {
        diagnostics: freeze(
          envelope.diagnostics.map((problem) => ({ ...problem, logicalPath })),
        ),
      };
    const parsedHeader = envelope.header.toJSON() as unknown;
    header = isRecord(parsedHeader) ? parsedHeader.$document : undefined;
    body = source.slice(envelope.bodyStart);
  } else {
    header = undefined;
    body = source;
  }
  if (header === undefined && existing !== undefined)
    return {
      metadata: {
        title: existing.title,
        summary: existing.summary,
        aliases: [...existing.aliases],
      },
      refHint: existing.shortRef,
      authoredId: existing.documentId,
      body,
    };
  if (!isRecord(header))
    return {
      diagnostics: freeze([
        diagnostic({
          code: "document_header_invalid",
          logicalPath,
          message:
            "Write source for a new document must begin with a $document technical header; replacing an existing document may omit it to preserve title, summary, and aliases",
        }),
      ]),
    };
  const normalized = { ...header, aliases: normalizeAliases(header.aliases) };
  if (!validDocumentMetadata(normalized))
    return {
      diagnostics: freeze([
        diagnostic({
          code: "document_header_invalid",
          logicalPath,
          message: `$document technical header is invalid: ${documentMetadataProblems(normalized).join("; ")}`,
        }),
      ]),
    };
  const { ref } = header;
  if (
    typeof ref !== "string" ||
    ref.length < 2 ||
    ref.length > 32 ||
    !shortRefPattern.test(ref)
  )
    return {
      diagnostics: freeze([
        diagnostic({
          code: "document_short_ref_invalid",
          logicalPath,
          message: `$document.ref must be a 2-to-32-character short reference containing only lowercase letters, digits, and hyphens; received ${describeValue(ref)}`,
        }),
      ]),
    };
  const { id } = header;
  return {
    metadata: {
      title: normalized.title,
      summary: normalized.summary,
      aliases: normalized.aliases,
    },
    refHint: ref,
    authoredId: typeof id === "string" && id.length > 0 ? id : null,
    body,
  };
}

type WorldDocumentYamlValueResolver = (
  value: unknown,
  locator: readonly (string | number)[],
) =>
  | { readonly value: unknown }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] };

/** Result of applying one edit to the text it is given; never partially applied. */
type RevisionEditResult =
  | {
      readonly kind: "applied";
      readonly contents: string;
      readonly metadata: WorldDocumentMetadataInput;
    }
  | { readonly kind: "no_op"; readonly diagnostic: WorldDocumentDiagnostic }
  | { readonly kind: "failed"; readonly diagnostic: WorldDocumentDiagnostic };

function revisionEditOutcome(
  commandIndex: number,
  editIndex: number,
  result: RevisionEditResult,
  document: { readonly logicalPath: string; readonly documentId: string },
): WorldDocumentEditOutcome {
  return freeze(
    result.kind === "applied"
      ? { commandIndex, editIndex, status: "applied" as const }
      : {
          commandIndex,
          editIndex,
          status: result.kind,
          diagnostic: freeze({ ...result.diagnostic, ...document }),
        },
  );
}

function editFailed(problem: WorldDocumentDiagnostic): RevisionEditResult {
  return { kind: "failed", diagnostic: problem };
}

function editTargetAbsent(locator: WorldDocumentLocator): RevisionEditResult {
  return {
    kind: "no_op",
    diagnostic: diagnostic({
      code: "locator_not_found",
      locator,
      message: "target absent",
    }),
  };
}

function applyYamlRevisionEdit(
  contents: string,
  metadata: WorldDocumentMetadataInput,
  edit: unknown,
  resolveValue: WorldDocumentYamlValueResolver,
): RevisionEditResult {
  if (!isRecord(edit) || typeof edit.op !== "string")
    return editFailed(
      diagnostic({
        code: "query_invalid",
        message: "A patch edit must be a closed object with op",
      }),
    );
  const document = parseDocument(contents, {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  const serialized = (nextMetadata: WorldDocumentMetadataInput) => ({
    kind: "applied" as const,
    contents: document.toString({ indent: 2, lineWidth: 0 }),
    metadata: nextMetadata,
  });
  if (edit.op === "set_metadata") {
    if (!hasOnlyKeys(edit, ["op", "title", "summary", "aliases"]))
      return editFailed(
        diagnostic({
          code: "document_header_invalid",
          message: "set_metadata accepts only op, title, summary, and aliases",
        }),
      );
    const resolved = resolveDocumentMetadataRevision(metadata, edit);
    if ("problems" in resolved)
      return editFailed(
        diagnostic({
          code: "document_header_invalid",
          message: `set_metadata arguments are invalid: ${resolved.problems.join("; ")}`,
        }),
      );
    document.setIn(["$document", "title"], resolved.metadata.title);
    document.setIn(["$document", "summary"], resolved.metadata.summary);
    document.setIn(["$document", "aliases"], [...resolved.metadata.aliases]);
    return serialized(resolved.metadata);
  }
  if (
    !["add", "replace", "append", "remove"].includes(edit.op) ||
    !validYamlLocator(edit.locator) ||
    edit.locator.yaml[0] === "$document"
  )
    return editFailed(
      diagnostic({
        code: "locator_invalid",
        ...(isRecord(edit.locator)
          ? {
              locator: copyLocator(
                edit.locator as unknown as WorldDocumentLocator,
              ),
            }
          : {}),
        message:
          "A YAML edit requires an exact locator outside the technical header",
      }),
    );
  const locator = [...edit.locator.yaml];
  if (locator.length === 0) {
    if (
      (edit.op !== "add" && edit.op !== "replace") ||
      !hasOnlyKeys(edit, ["op", "locator", "value"])
    )
      return editFailed(
        diagnostic({
          code: "locator_invalid",
          locator: { yaml: [] },
          message: "A whole YAML body supports only add or replace",
        }),
      );
    const value = resolveValue(edit.value, []);
    if ("diagnostics" in value) return editFailed(value.diagnostics[0]!);
    if (!isRecord(value.value) || Object.hasOwn(value.value, "$document"))
      return editFailed(
        diagnostic({
          code: "yaml_invalid",
          locator: { yaml: [] },
          message: "A whole YAML body must be a map without $document",
        }),
      );
    const currentValue: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(currentValue) || !isRecord(currentValue.$document))
      return editFailed(
        diagnostic({
          code: "document_header_invalid",
          message: "YAML technical header could not be preserved",
        }),
      );
    const body = parseDocument(
      stringify(
        { $document: currentValue.$document, ...value.value },
        { indent: 2, lineWidth: 0 },
      ),
      { schema: "core", uniqueKeys: true, strict: true },
    );
    return {
      kind: "applied",
      contents: body.toString({ indent: 2, lineWidth: 0 }),
      metadata,
    };
  }
  if (edit.op === "remove") {
    if (!hasOnlyKeys(edit, ["op", "locator"]))
      return editFailed(
        diagnostic({
          code: "query_invalid",
          locator: { yaml: locator },
          message: "YAML remove accepts only op and locator",
        }),
      );
    if (!document.hasIn(locator)) return editTargetAbsent({ yaml: locator });
    document.deleteIn(locator);
    return serialized(metadata);
  }
  if (!hasOnlyKeys(edit, ["op", "locator", "value"]))
    return editFailed(
      diagnostic({
        code: "query_invalid",
        locator: { yaml: locator },
        message: "YAML value-edit arguments are invalid",
      }),
    );
  if (edit.op === "append") {
    const sequence = document.getIn(locator, true);
    if (!isSeq(sequence))
      return editFailed(
        diagnostic({
          code: "locator_invalid",
          locator: { yaml: locator },
          message: "YAML append target must be a sequence",
        }),
      );
    const value = resolveValue(edit.value, [...locator, sequence.items.length]);
    if ("diagnostics" in value) return editFailed(value.diagnostics[0]!);
    sequence.add(createYamlPatchNode(document, value.value));
    return serialized(metadata);
  }
  const value = resolveValue(edit.value, locator);
  if ("diagnostics" in value) return editFailed(value.diagnostics[0]!);
  const emptyFlowMap = findEmptyYamlFlowMap(document, locator);
  if (!upsertYamlValue(document, locator, value.value))
    return editFailed(
      diagnostic({
        code: "locator_invalid",
        locator: { yaml: locator },
        message: "YAML add or replace parent must be a map or sequence",
      }),
    );
  if (emptyFlowMap !== undefined) {
    const filledMap = document.getIn(emptyFlowMap.locator, true);
    if (
      isMap(filledMap) &&
      filledMap.items.length > 0 &&
      !isYamlReference(filledMap)
    )
      return {
        kind: "applied",
        contents: expandYamlFlowMap(contents, emptyFlowMap, filledMap),
        metadata,
      };
  }
  return serialized(metadata);
}

interface EmptyYamlFlowMap {
  locator: readonly (string | number)[];
  range: Range;
  parentStart: number;
}

function findEmptyYamlFlowMap(
  document: Document,
  locator: readonly (string | number)[],
): EmptyYamlFlowMap | undefined {
  let parent: unknown = document.contents;
  for (const [index, segment] of locator.entries()) {
    // A block collection cannot be expressed inside an existing flow collection.
    if ((!isMap(parent) && !isSeq(parent)) || parent.flow || !parent.range)
      return undefined;
    const child: unknown = parent.get(segment, true);
    if (isMap(child) && child.flow && child.items.length === 0 && child.range)
      return {
        locator: locator.slice(0, index + 1),
        range: child.range,
        parentStart: parent.range[0],
      };
    parent = child;
  }
  return undefined;
}

function expandYamlFlowMap(
  source: string,
  empty: EmptyYamlFlowMap,
  filled: YAMLMap,
): string {
  const [start, end] = empty.range;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const followingNewline = source.indexOf("\n", end);
  const lineEnd = followingNewline === -1 ? source.length : followingNewline;
  const beforeBraces = source.slice(lineStart, start);
  const introducer = beforeBraces.trimEnd();
  const parentLine = source.lastIndexOf("\n", empty.parentStart - 1) + 1;
  const indentation = " ".repeat(
    introducer === ""
      ? beforeBraces.length
      : empty.parentStart - parentLine + 2,
  );

  // Keep comments from between the braces and after the closing brace. The
  // common trailing comment stays on the line with its original key or dash.
  const innerComments = source
    .slice(start + 1, end - 1)
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("#"));
  const trailing = source.slice(end, lineEnd);
  let header = introducer === "" ? "" : `${introducer}\n`;
  if (trailing.includes("#")) {
    if (introducer !== "" && innerComments.length === 0)
      header = `${introducer}${trailing}\n`;
    else innerComments.push(trailing.trimStart());
  }
  const comments = innerComments
    .map((comment) => `${indentation}${comment}\n`)
    .join("");

  filled.flow = false;
  filled.comment = null;
  filled.commentBefore = null;
  // Quoting multiline scalars keeps the following source out of their values.
  const body = new Document(filled)
    .toString({ indent: 2, lineWidth: 0, blockQuote: false })
    .replace(/^(?=.)/gmu, indentation);
  return (
    source.slice(0, lineStart) +
    header +
    comments +
    body +
    source.slice(lineEnd + 1)
  );
}

function isYamlReference(map: YAMLMap): boolean {
  return map.items.length === 1 && typeof map.get("$ref") === "string";
}

function createYamlPatchNode(document: Document, value: unknown) {
  const subtree = document.createNode(value);
  visit(subtree, {
    Map(_key, node) {
      if (isYamlReference(node)) node.flow = true;
    },
  });
  return subtree;
}

/**
 * Writes value at locator, creating what is missing: absent map keys and
 * parent maps are created, and a sequence index at or past the end appends.
 * Returns false when an existing parent is neither a map nor a sequence.
 */
function upsertYamlValue(
  document: Document,
  locator: readonly (string | number)[],
  value: unknown,
): boolean {
  let node: unknown = document.contents;
  for (const [depth, segment] of locator.entries()) {
    const rest = locator.slice(depth + 1);
    if (isMap(node) && typeof segment === "string") {
      if (rest.length === 0) {
        node.set(segment, createYamlPatchNode(document, value));
        return true;
      }
      const child: unknown = node.get(segment, true);
      if (child === undefined) {
        node.set(
          segment,
          createYamlPatchNode(document, yamlTailValue(rest, value)),
        );
        return true;
      }
      if (!isMap(child) && !isSeq(child)) return false;
      node = child;
    } else if (isSeq(node) && typeof segment === "number") {
      if (segment >= node.items.length) {
        node.items.push(
          createYamlPatchNode(document, yamlTailValue(rest, value)),
        );
        return true;
      }
      if (rest.length === 0) {
        node.items[segment] = createYamlPatchNode(document, value);
        return true;
      }
      const child: unknown = node.items[segment];
      if (!isMap(child) && !isSeq(child)) return false;
      node = child;
    } else return false;
  }
  return false;
}

/** The value a missing path creates: maps for keys, a one-item list for indexes. */
function yamlTailValue(
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  return path.reduceRight<unknown>(
    (child, segment) =>
      typeof segment === "number" ? [child] : { [segment]: child },
    value,
  );
}

function applyMarkdownRevisionEdit(
  source: string,
  metadata: WorldDocumentMetadataInput,
  edit: unknown,
): RevisionEditResult {
  if (!isRecord(edit) || typeof edit.op !== "string")
    return editFailed(
      diagnostic({
        code: "query_invalid",
        message: "A Markdown patch edit must be a closed object with op",
      }),
    );
  // Whole-body, preamble and metadata writes keep a single trailing newline.
  const applied = (
    contents: string,
    nextMetadata: WorldDocumentMetadataInput,
  ): RevisionEditResult => ({
    kind: "applied",
    contents: `${contents.trimEnd()}\n`,
    metadata: nextMetadata,
  });
  if (edit.op === "set_metadata") {
    if (!hasOnlyKeys(edit, ["op", "title", "summary", "aliases"]))
      return editFailed(
        diagnostic({
          code: "document_header_invalid",
          message: "set_metadata accepts only op, title, summary, and aliases",
        }),
      );
    const resolved = resolveDocumentMetadataRevision(metadata, edit);
    if ("problems" in resolved)
      return editFailed(
        diagnostic({
          code: "document_header_invalid",
          message: `set_metadata arguments are invalid: ${resolved.problems.join("; ")}`,
        }),
      );
    const envelope = markdownEnvelope(source);
    if ("diagnostics" in envelope) return editFailed(envelope.diagnostics[0]!);
    envelope.header.setIn(["$document", "title"], resolved.metadata.title);
    envelope.header.setIn(["$document", "summary"], resolved.metadata.summary);
    envelope.header.setIn(
      ["$document", "aliases"],
      [...resolved.metadata.aliases],
    );
    const body = source.slice(envelope.bodyStart);
    const firstHeading = scanMarkdownHeadings(body, 0).headings[0];
    if (firstHeading?.level !== 1)
      return editFailed(
        diagnostic({
          code: "markdown_invalid",
          message: "Markdown body is missing an updateable h1",
        }),
      );
    const nextBody = `${body.slice(0, firstHeading.range.start.offset)}# ${resolved.metadata.title}${body.slice(firstHeading.range.end.offset)}`;
    return applied(
      `---\n${envelope.header.toString({ indent: 2, lineWidth: 0 }).trimEnd()}\n---\n${nextBody}`,
      resolved.metadata,
    );
  }
  if (edit.op === "replace_body" || edit.op === "replace_preamble") {
    if (
      !hasOnlyKeys(edit, ["op", "markdown"]) ||
      typeof edit.markdown !== "string"
    )
      return editFailed(
        diagnostic({
          code: "query_invalid",
          message: "A Markdown body edit requires markdown source",
        }),
      );
    const envelope = markdownEnvelope(source);
    if ("diagnostics" in envelope) return editFailed(envelope.diagnostics[0]!);
    if (edit.op === "replace_body")
      return applied(
        `${source.slice(0, envelope.bodyStart)}${edit.markdown.trimEnd()}\n`,
        metadata,
      );
    const headings = scanMarkdownHeadings(source, envelope.bodyStart).headings;
    const h1 = headings.find(({ level }) => level === 1);
    if (h1 === undefined)
      return editFailed(
        diagnostic({
          code: "markdown_invalid",
          message: "Markdown body is missing an updateable h1",
        }),
      );
    const nextH2 = headings.find(
      ({ level, range }) =>
        level === 2 && range.start.offset > h1.range.start.offset,
    );
    const end = nextH2?.range.start.offset ?? source.length;
    return applied(
      `${source.slice(0, h1.range.end.offset)}\n\n${edit.markdown.trim()}\n\n${source.slice(end)}`,
      metadata,
    );
  }
  if (
    ![
      "replace_section",
      "add_section",
      "rename_section",
      "remove_section",
    ].includes(edit.op) ||
    !validMarkdownLocator(edit.locator, edit.op === "add_section")
  )
    return editFailed(
      diagnostic({
        code: "locator_invalid",
        ...(isRecord(edit.locator)
          ? {
              locator: copyLocator(
                edit.locator as unknown as WorldDocumentLocator,
              ),
            }
          : {}),
        message: "A Markdown patch requires an exact heading locator",
      }),
    );
  const locator = { markdown: [...edit.locator.markdown] } as const;
  // A section splice preserves the exact source outside its selected region,
  // including the end of the document when a different section is edited.
  const appliedSection = (contents: string): RevisionEditResult => ({
    kind: "applied",
    contents,
    metadata,
  });
  if (edit.op === "remove_section") {
    if (!hasOnlyKeys(edit, ["op", "locator"]))
      return editFailed(
        diagnostic({
          code: "query_invalid",
          locator,
          message: "remove_section contains undeclared arguments",
        }),
      );
    const section = markdownRevisionSection(source, locator.markdown);
    if ("diagnostics" in section) {
      const [problem] = section.diagnostics;
      return problem?.code === "locator_not_found"
        ? editTargetAbsent(locator)
        : editFailed(problem!);
    }
    return appliedSection(
      `${source.slice(0, section.start)}${source.slice(section.rawEnd)}`,
    );
  }
  if (edit.op === "rename_section") {
    if (
      !hasOnlyKeys(edit, ["op", "locator", "title"]) ||
      !validMarkdownHeadingTitle(edit.title)
    )
      return editFailed(
        diagnostic({
          code: "query_invalid",
          locator,
          message: "rename_section requires a valid new heading",
        }),
      );
    const section = markdownRevisionSection(source, locator.markdown);
    if ("diagnostics" in section) return editFailed(section.diagnostics[0]!);
    return appliedSection(
      `${source.slice(0, section.start)}${"#".repeat(section.level)} ${edit.title}${source.slice(section.headingEnd)}`,
    );
  }
  if (
    !hasOnlyKeys(edit, ["op", "locator", "markdown"]) ||
    typeof edit.markdown !== "string"
  )
    return editFailed(
      diagnostic({
        code: "query_invalid",
        locator,
        message: "A Markdown section edit requires a complete Markdown block",
      }),
    );
  const block = edit.markdown.trim();
  const { headings, hasUnclosedFence } = scanMarkdownHeadings(block, 0);
  const first = headings[0];
  const escapesSectionSubtree = headings
    .slice(1)
    .some(({ level }) => first !== undefined && level <= first.level);
  const blockIsSubtree =
    first?.range.start.offset === 0 &&
    !escapesSectionSubtree &&
    !hasUnclosedFence;
  const requestedTitle = locator.markdown.at(-1)?.normalize("NFKC");
  if (edit.op === "replace_section") {
    const section = markdownRevisionSection(source, locator.markdown);
    if ("diagnostics" in section) {
      if (section.diagnostics[0]?.code !== "locator_not_found")
        return editFailed(section.diagnostics[0]!);
      // A heading that does not exist yet is added at the end of its parent.
      const parent = markdownRevisionSection(
        source,
        locator.markdown.slice(0, -1),
      );
      if ("diagnostics" in parent) return editFailed(parent.diagnostics[0]!);
      if (
        !blockIsSubtree ||
        first.level !== parent.level + 1 ||
        first.title.normalize("NFKC") !== requestedTitle
      )
        return editFailed(
          diagnostic({
            code: "locator_invalid",
            locator,
            message:
              "replace_section new heading must keep the requested title and sit one level below its parent",
          }),
        );
      return appliedSection(insertMarkdownBlock(source, parent.rawEnd, block));
    }
    if (
      !blockIsSubtree ||
      first.level !== section.level ||
      first.title.normalize("NFKC") !== requestedTitle
    )
      return editFailed(
        diagnostic({
          code: "locator_invalid",
          locator,
          message:
            "replace_section first heading must preserve the exact original heading path",
        }),
      );
    const contents = `${source.slice(0, section.start)}${block}${source.slice(section.trimmedEnd)}`;
    return section.rawEnd === source.length
      ? applied(contents, metadata)
      : appliedSection(contents);
  }
  const parent = markdownRevisionSection(source, locator.markdown);
  if ("diagnostics" in parent) return editFailed(parent.diagnostics[0]!);
  if (!blockIsSubtree || first.level !== parent.level + 1)
    return editFailed(
      diagnostic({
        code: "locator_invalid",
        locator,
        message:
          "add_section must add a complete block with a heading one level lower",
      }),
    );
  return appliedSection(insertMarkdownBlock(source, parent.rawEnd, block));
}

function insertMarkdownBlock(
  source: string,
  offset: number,
  block: string,
): string {
  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const leading = before.endsWith("\n\n")
    ? ""
    : before.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${before}${leading}${block}${after === "" ? "\n" : "\n\n"}${after}`;
}

function markdownEnvelope(source: string):
  | {
      readonly header: ReturnType<typeof parseDocument>;
      readonly bodyStart: number;
    }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  if (!source.startsWith("---\n"))
    return {
      diagnostics: [
        diagnostic({
          code: "markdown_invalid",
          message: "Markdown must begin with technical front matter",
        }),
      ],
    };
  const end = source.indexOf("\n---\n", 4);
  if (end < 0)
    return {
      diagnostics: [
        diagnostic({
          code: "markdown_invalid",
          message: "Markdown technical front matter is not closed",
        }),
      ],
    };
  const header = parseDocument(source.slice(4, end), {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (header.errors.length > 0 || header.warnings.length > 0)
    return {
      diagnostics: [
        diagnostic({
          code: "yaml_invalid",
          message: "Markdown technical front matter could not be parsed safely",
        }),
      ],
    };
  return { header, bodyStart: end + 5 };
}

function setDocumentRetired(
  source: string,
  codec: WorldDocumentCodec,
  retired: boolean,
): string {
  if (codec === "yaml") {
    const document = parseDocument(source, {
      schema: "core",
      uniqueKeys: true,
      strict: true,
    });
    if (retired) document.setIn(["$document", "retired"], true);
    else document.deleteIn(["$document", "retired"]);
    return document.toString({ indent: 2, lineWidth: 0 });
  }

  const headerEnd = source.indexOf("\n---\n", 4);
  const header = parseDocument(source.slice(4, headerEnd), {
    schema: "core",
    uniqueKeys: true,
    strict: true,
  });
  if (retired) header.setIn(["$document", "retired"], true);
  else header.deleteIn(["$document", "retired"]);
  return `---\n${header.toString({ indent: 2, lineWidth: 0 }).trimEnd()}${source.slice(headerEnd)}`;
}

function markdownRevisionSection(
  source: string,
  locator: readonly string[],
):
  | {
      readonly start: number;
      readonly headingEnd: number;
      readonly trimmedEnd: number;
      readonly rawEnd: number;
      readonly level: number;
    }
  | { readonly diagnostics: readonly WorldDocumentDiagnostic[] } {
  const envelope = markdownEnvelope(source);
  if ("diagnostics" in envelope) return envelope;
  const headings = scanMarkdownHeadings(source, envelope.bodyStart).headings;
  if (locator.length === 0) {
    // The empty locator names the document body, whose sections are the h2s.
    const h1 = headings.find(({ level }) => level === 1);
    if (h1 === undefined)
      return {
        diagnostics: [
          diagnostic({
            code: "markdown_invalid",
            message: "Markdown body is missing an updateable h1",
          }),
        ],
      };
    return {
      start: h1.range.start.offset,
      headingEnd: h1.range.end.offset,
      trimmedEnd: trimTrailingWhitespaceOffset(
        source,
        h1.range.start.offset,
        source.length,
      ),
      rawEnd: source.length,
      level: 1,
    };
  }
  const stack: string[] = [];
  const matches: { readonly index: number; readonly level: number }[] = [];
  for (const [index, heading] of headings.entries()) {
    if (heading.level === 1) {
      stack.length = 0;
      continue;
    }
    stack.length = heading.level - 2;
    stack[heading.level - 2] = heading.title.normalize("NFKC");
    if (
      stack.length === locator.length &&
      locator.every(
        (part, locatorIndex) => stack[locatorIndex] === part.normalize("NFKC"),
      )
    )
      matches.push({ index, level: heading.level });
  }
  const publicLocator = { markdown: [...locator] } as const;
  if (matches.length === 0)
    return {
      diagnostics: [
        diagnostic({
          code: "locator_not_found",
          locator: publicLocator,
          message: "Markdown heading path was not found",
        }),
      ],
    };
  if (matches.length > 1)
    return {
      diagnostics: [
        diagnostic({
          code: "locator_ambiguous",
          locator: publicLocator,
          message: "Markdown heading path matches more than one section",
        }),
      ],
    };
  const match = matches[0]!;
  const heading = headings[match.index]!;
  const next = headings
    .slice(match.index + 1)
    .find(({ level }) => level <= match.level);
  const rawEnd = next?.range.start.offset ?? source.length;
  return {
    start: heading.range.start.offset,
    headingEnd: heading.range.end.offset,
    trimmedEnd: trimTrailingWhitespaceOffset(
      source,
      heading.range.start.offset,
      rawEnd,
    ),
    rawEnd,
    level: match.level,
  };
}

function revisionDiagnostic(
  commandIndex: number | null,
  value: WorldDocumentDiagnostic,
): WorldDocumentRevisionDiagnostic {
  return freeze({ ...value, commandIndex });
}

function mechanicalHash(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function validDocumentMetadata<
  T extends {
    readonly title?: unknown;
    readonly summary?: unknown;
    readonly aliases?: unknown;
  },
>(value: T): value is T & WorldDocumentMetadataInput {
  return documentMetadataProblems(value).length === 0;
}

function resolveDocumentMetadataRevision(
  current: WorldDocumentMetadataInput,
  edit: {
    readonly title?: unknown;
    readonly summary?: unknown;
    readonly aliases?: unknown;
  },
):
  | { readonly metadata: WorldDocumentMetadataInput }
  | { readonly problems: readonly string[] } {
  if (
    !Object.hasOwn(edit, "title") &&
    !Object.hasOwn(edit, "summary") &&
    !Object.hasOwn(edit, "aliases")
  )
    return {
      problems: ["at least one of title, summary, or aliases must be provided"],
    };
  const metadata = {
    title: Object.hasOwn(edit, "title") ? edit.title : current.title,
    summary: Object.hasOwn(edit, "summary") ? edit.summary : current.summary,
    aliases: Object.hasOwn(edit, "aliases") ? edit.aliases : current.aliases,
  };
  const problems = documentMetadataProblems(metadata);
  return problems.length === 0
    ? { metadata: metadata as WorldDocumentMetadataInput }
    : { problems };
}

/**
 * Says which of the three fields is wrong and what arrived instead.
 *
 * One shared sentence covering title, summary and aliases left the author
 * guessing among six failure modes, and guessing costs a whole exchange.
 */
function documentMetadataProblems(value: {
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly aliases?: unknown;
}): string[] {
  const problems: string[] = [];
  problems.push(...boundedTextProblems("title", value.title, 120));
  problems.push(...boundedTextProblems("summary", value.summary, 240));
  if (!Array.isArray(value.aliases))
    problems.push(
      `aliases must be an array; received ${describeValue(value.aliases)}`,
    );
  else if (value.aliases.length > 16)
    problems.push(
      `aliases may contain at most 16 items; received ${value.aliases.length}`,
    );
  else
    for (const [index, alias] of value.aliases.entries()) {
      if (typeof alias !== "string")
        problems.push(
          `aliases item ${index + 1} must be a string; received ${describeValue(alias)}`,
        );
      else if ([...alias].length < 1 || [...alias].length > 64)
        problems.push(
          `aliases item ${index + 1} must contain 1 to 64 characters; received ${[...alias].length}`,
        );
    }
  return problems;
}

function boundedTextProblems(
  field: string,
  value: unknown,
  limit: number,
): string[] {
  if (typeof value !== "string")
    return [`${field} must be a string; received ${describeValue(value)}`];
  const length = [...value].length;
  if (length < 1) return [`${field} cannot be empty`];
  return length > limit
    ? [`${field} may contain at most ${limit} characters; received ${length}`]
    : [];
}

// aliases feeds the literal search index, so entries must end up as strings.
// A numeric alias such as a room number is still worth searching for, so it is
// coerced rather than used as grounds to reject the whole document.
function normalizeAliases(value: unknown): unknown {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return value;
  return value.map((alias: unknown) =>
    typeof alias === "number" || typeof alias === "boolean"
      ? String(alias)
      : alias,
  );
}

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array (${value.length} items)`;
  if (typeof value === "object") return "object";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function validRevisionLogicalPath(
  logicalPath: string,
  codec: WorldDocumentCodec,
  logicalRoot: "world" | "state",
): boolean {
  const prefix = `${logicalRoot}/`;
  return (
    logicalPath.startsWith(prefix) &&
    validRelativePath(logicalPath.slice(prefix.length)) &&
    documentCodec(logicalPath) === codec
  );
}

function validMarkdownHeadingTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    !/[\r\n]/u.test(value) &&
    [...value].length >= 1 &&
    [...value].length <= 120
  );
}
