import { FileEditorMode, FileSourceEditor } from "./FileSourceEditor.tsx";
import { browserUUID } from "./browser-uuid.ts";
import { getWebLocale, uiText } from "./i18n.ts";
import { useId, useMemo, useState } from "react";
import { isMap, isNode, isSeq, stringify } from "yaml";

import type { ContentTreeFile } from "../protocol/v1.ts";
import {
  exceedsRestrictedYamlShape,
  parseRestrictedYamlDocument,
} from "../shared/restricted-yaml.ts";
import {
  validMarkdownLocator,
  validYamlLocator,
} from "../shared/world-documents/WorldDocumentSource.ts";
import {
  buildWorldDocumentDraft,
  type WorldDocumentDraftLayout,
  type WorldDocumentDraftLocator,
} from "./world-document-draft-index.ts";

const worldFrameFormat = "narraeon.world-frame/v1";
type WorldDocumentDraft = ReturnType<typeof buildWorldDocumentDraft>;
type NodeLocator = NonNullable<WorldDocumentDraftLocator>;
type EditableLocator = { yaml: string[] } | { markdown: string[] };

type FrameRecord = Record<string, unknown>;
type FrameSlot = Record<string, unknown> & { kind: string };

/** `{ markdown }`, `{ markdown, turnGuide }` or a bare `{ turnGuide }` tail line. */
interface FrameInstruction {
  markdown?: string;
  turnGuide?: string;
  [key: string]: unknown;
}

interface FrameContextEntry {
  slot: FrameSlot;
}

interface DocumentOption {
  id: string;
  ref: string;
  title: string;
  path: string;
  codec: "yaml" | "markdown";
  retired: boolean;
  yamlLocators: readonly YamlLocatorOption[];
}

/**
 * Control files address documents by the handle the author can actually see.
 *
 * Document ids are runtime-assigned and often a random `doc.<uuid>`, so the
 * editor writes `@shortRef` the way the setting author and the prompt compiler
 * both do. Ids stay readable because frames written before this, and any the
 * author typed by hand, still resolve.
 */
function documentHandle(document: DocumentOption): string {
  return `@${document.ref}`;
}

function findDocument(
  documents: readonly DocumentOption[],
  handle: string,
): DocumentOption | undefined {
  return handle.startsWith("@")
    ? documents.find(({ ref }) => ref === handle.slice(1))
    : documents.find(({ id }) => id === handle);
}

/**
 * Rewrites resolvable ids to short refs on the way out.
 *
 * The author tools report short refs. Normalizing only resolvable ids keeps
 * their associations readable to the author and leaves broken handles intact
 * for repair.
 */
function normalizeDocumentHandles(
  draft: FrameYaml,
  documents: readonly DocumentOption[],
): void {
  const normalize = (path: YamlPath): void => {
    const handle: unknown = draft.getIn(path);
    if (typeof handle !== "string" || handle === "" || handle.startsWith("@"))
      return;
    const document = findDocument(documents, handle);
    if (document !== undefined) draft.setIn(path, documentHandle(document));
  };
  normalize(["bindings", "currentSituation"]);
  const context: unknown = draft.get("context", true);
  if (!isSeq(context)) return;
  context.items.forEach((_, index) => {
    normalize(["context", index, "slot", "document"]);
    normalize(["context", index, "slot", "from", "document"]);
  });
}

interface YamlLocatorOption {
  path: string[];
  nodeKind: "object" | "list";
  referenceCount: number;
}

interface DirectoryOption {
  directory: string;
  documentCount: number;
}

interface MarkdownBlockOption {
  path: string;
  title: string;
}

type FrameYaml = NonNullable<
  ReturnType<typeof parseRestrictedYamlDocument>["document"]
>;
type YamlPath = readonly (string | number)[];
type ParsedFrame =
  | { value: FrameRecord; document: FrameYaml; error: null }
  | { value: null; document?: never; error: string };

const optionalSlotKinds = [
  {
    kind: "document",
    label: "整份文档",
    detail: "始终提供一份指定世界文档。",
  },
  {
    kind: "node",
    label: "文档局部节点",
    detail: "只提供一份 YAML 路径或 Markdown 标题下的内容。",
  },
  {
    kind: "reference_targets",
    label: "显式引用目标",
    detail: "从一个 YAML 节点读取 $ref，并提供一层目标文档。",
  },
  {
    kind: "catalog",
    label: "有界目录",
    detail: "提供指定一级目录的标题、简介和短引用目录。",
  },
  {
    kind: "history",
    label: "最近叙事",
    detail: "带上最近几条已提交叙事，让全新上下文读得到此前写出的细节。",
  },
] as const;

export function WorldFrameEditor({
  contents,
  files,
  layout = "content_package",
  dirty,
  onChange,
  onSave,
}: {
  contents: string;
  files: readonly ContentTreeFile[];
  layout?: WorldDocumentDraftLayout;
  dirty: boolean;
  onChange: (contents: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  const parsed = useMemo(() => readWorldFrame(contents), [contents]);
  const [sourceRequested, setSourceRequested] = useState(false);
  const showSource = sourceRequested || parsed.value === null;
  const worldDraft = useMemo(
    () => buildWorldDocumentDraft(files, layout),
    [files, layout],
  );
  const documents = useMemo(
    () => frameDocumentOptions(worldDraft),
    [worldDraft],
  );
  const { logicalRoot } = worldDraft.snapshot;
  const markdownBlocks = useMemo(() => controlMarkdownBlocks(files), [files]);
  const directories = useMemo(() => worldDirectories(documents), [documents]);
  const [newInstructionPath, setNewInstructionPath] = useState("");
  const [newSlotKind, setNewSlotKind] =
    useState<(typeof optionalSlotKinds)[number]["kind"]>("document");

  const frame = parsed.value;
  const instructions = frame === null ? null : frameInstructions(frame);
  const contextEntries = frame === null ? null : frameContext(frame);
  const currentSituation =
    frame !== null && isRecord(frame.bindings)
      ? stringValue(frame.bindings.currentSituation)
      : "";
  const currentSituationDocument = findDocument(documents, currentSituation);
  const unlinkedBlocks = markdownBlocks.filter(
    ({ path }) =>
      !instructions?.some((instruction) => instruction.markdown === path),
  );
  const instructionToAdd = unlinkedBlocks.some(
    ({ path }) => path === newInstructionPath,
  )
    ? newInstructionPath
    : (unlinkedBlocks[0]?.path ?? "");
  const currentSituationSlots = countSlot(contextEntries, "current_situation");
  const additionalMaterialSlots = countSlot(
    contextEntries,
    "additional_materials",
  );
  const visualReady =
    frame !== null && instructions !== null && contextEntries !== null;
  const newSlotUnavailableReason = optionalSlotUnavailableReason(
    newSlotKind,
    documents,
    directories,
    logicalRoot,
  );

  const updateFrame = (update: (draft: FrameYaml) => void): void => {
    if (parsed.document === undefined) return;
    const draft = parsed.document.clone();
    update(draft);
    normalizeDocumentHandles(draft, documents);
    onChange(draft.toString({ lineWidth: 0 }));
  };

  const updateInstructions = (next: FrameInstruction[]): void => {
    if (instructions === null) return;
    updateFrame((draft) =>
      updateFrameOrder(draft, "instructions", instructions, next),
    );
  };

  const updateContext = (next: FrameContextEntry[]): void => {
    if (contextEntries === null) return;
    updateFrame((draft) =>
      updateFrameOrder(draft, "context", contextEntries, next),
    );
  };

  const addRequiredSlot = (
    kind: "current_situation" | "additional_materials",
  ): void => {
    if (contextEntries === null) return;
    const entry: FrameContextEntry = { slot: { kind } };
    if (kind === "current_situation") updateContext([entry, ...contextEntries]);
    else updateContext([...contextEntries, entry]);
  };

  const addOptionalSlot = (): void => {
    if (contextEntries === null) return;
    const entry: FrameContextEntry = {
      slot: defaultSlot(newSlotKind, documents, directories),
    };
    const next = [...contextEntries];
    const additionalIndex = next.findIndex(
      ({ slot }) => slot.kind === "additional_materials",
    );
    next.splice(additionalIndex < 0 ? next.length : additionalIndex, 0, entry);
    updateContext(next);
  };

  return (
    <section
      className="world-frame-editor"
      aria-labelledby="world-frame-editor-title"
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLocaleLowerCase("en-US") === "s"
        ) {
          event.preventDefault();
          if (dirty) onSave();
        }
      }}
    >
      <header className="world-frame-editor-header">
        <div>
          <span className="content-editor-kicker">{uiText("可视化编排")}</span>
          <h5 id="world-frame-editor-title">{uiText("世界提示框架")}</h5>
          <p>
            {uiText(
              "安排世界专属指令与确定性材料位置；这里不保存人物、地点或当前事实。",
            )}
          </p>
        </div>
        <div
          className="world-frame-status"
          aria-label={uiText("世界提示框架草稿状态")}
        >
          <span
            className={frame?.format === worldFrameFormat ? "valid" : "invalid"}
          >
            {frame?.format === worldFrameFormat
              ? uiText("V1 格式")
              : uiText("格式待修复")}
          </span>
          <span className={visualReady ? "valid" : "invalid"}>
            {visualReady ? uiText("可视化已同步") : uiText("仅可编辑 YAML")}
          </span>
        </div>
        <FileEditorMode
          showSource={showSource}
          onSource={() => setSourceRequested(true)}
          form={{
            disabled: frame === null,
            show: () => setSourceRequested(false),
          }}
        />
      </header>

      {showSource && (
        <>
          {frame === null && (
            <div className="world-frame-parse-error" role="alert">
              <strong>{uiText("当前 YAML 暂时无法可视化")}</strong>
              <p>{parsed.error}</p>
              <span>{uiText("修复源码后可切回表单。")}</span>
            </div>
          )}
          <FileSourceEditor
            path="control/frame.yaml"
            contents={contents}
            onChange={(source) => {
              setSourceRequested(true);
              onChange(source);
            }}
          />
        </>
      )}
      {!showSource && frame !== null && (
        <>
          {frame.format !== worldFrameFormat && (
            <div className="world-frame-repair-callout" role="note">
              <div>
                <strong>{uiText("format 不是当前世界框架版本")}</strong>
                <span>
                  {uiText("Runtime 只接受 {format}。", {
                    format: worldFrameFormat,
                  })}
                </span>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  updateFrame((draft) =>
                    replaceFrameValue(
                      draft,
                      ["format"],
                      frame.format,
                      worldFrameFormat,
                    ),
                  )
                }
              >
                {uiText("修复为 V1 格式")}
              </button>
            </div>
          )}

          <details className="world-frame-compile-help">
            <summary>{uiText("编译角色与排序")}</summary>
            <dl>
              <dt>
                <code>author_instruction</code>
              </dt>
              <dd>
                {uiText(
                  "Markdown 提示块按列表顺序进入世界指令位置。在独立文件中编辑正文。",
                )}
              </dd>
              <dt>
                <code>world_context</code>
              </dt>
              <dd>{uiText("Runtime 按列表顺序读取精确选定的材料。")}</dd>
            </dl>
            <p>
              {uiText(
                "上移或下移条目可更改注入顺序。尾部提示按指令列表顺序进入本轮提示。",
              )}
            </p>
          </details>

          <section
            className="world-frame-section world-frame-binding"
            aria-labelledby="world-frame-binding-title"
          >
            <header>
              <div>
                <span>{uiText("当前场景与常驻视图")}</span>
                <h6 id="world-frame-binding-title">{uiText("当前情境绑定")}</h6>
              </div>
              <span
                className={
                  currentSituationDocument === undefined
                    ? "world-frame-section-state invalid"
                    : "world-frame-section-state valid"
                }
              >
                {currentSituationDocument === undefined
                  ? uiText("未解析")
                  : uiText("已解析")}
              </span>
            </header>
            <p>{uiText("当前场景文档将从这里读取")}</p>
            <p>{uiText("常驻视图在 control/player-views.yaml 中配置。")}</p>
            <label>
              {uiText("当前情境文档")}
              <select
                value={
                  currentSituationDocument === undefined
                    ? currentSituation
                    : documentHandle(currentSituationDocument)
                }
                onChange={(event) => {
                  const handle = event.currentTarget.value;
                  const bindings = isRecord(frame.bindings)
                    ? { ...frame.bindings, currentSituation: handle }
                    : { currentSituation: handle };
                  updateFrame((draft) =>
                    replaceFrameValue(
                      draft,
                      ["bindings"],
                      frame.bindings,
                      bindings,
                    ),
                  );
                }}
              >
                <option value="">{uiText("选择一份世界文档")}</option>
                {currentSituation.length > 0 &&
                  findDocument(documents, currentSituation) === undefined && (
                    <option value={currentSituation}>
                      {currentSituation}
                      {uiText("（当前未解析）")}
                    </option>
                  )}
                {documents.map((document) => (
                  <option key={document.path} value={documentHandle(document)}>
                    {document.title} · {documentHandle(document)} ·{" "}
                    {document.path}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section
            className="world-frame-section"
            aria-labelledby="world-frame-instructions-title"
          >
            <header>
              <div>
                <h6 id="world-frame-instructions-title">
                  {uiText("提示块顺序")}
                </h6>
              </div>
              <span className="world-frame-section-state">
                {uiText("提示块：{count} 个", {
                  count: instructions?.length ?? "—",
                })}
              </span>
            </header>
            {instructions === null ? (
              <MalformedFrameSection
                name="instructions"
                onReset={() =>
                  updateFrame((draft) =>
                    replaceFrameValue(
                      draft,
                      ["instructions"],
                      frame.instructions,
                      [],
                    ),
                  )
                }
              />
            ) : (
              <>
                <ol
                  className="world-frame-order-list"
                  aria-label={uiText("世界指令顺序")}
                >
                  {instructions.map((instruction, index) => {
                    const block =
                      instruction.markdown === undefined
                        ? undefined
                        : markdownBlocks.find(
                            ({ path }) => path === instruction.markdown,
                          );
                    const title =
                      block?.title ??
                      instruction.markdown ??
                      uiText("独立尾部行");
                    const updateLine = (value: string) =>
                      updateFrame((draft) => {
                        const path = ["instructions", index, "turnGuide"];
                        // A tail-only row keeps its line until removed.
                        if (value === "" && instruction.markdown !== undefined)
                          draft.deleteIn(path);
                        else draft.setIn(path, value);
                      });
                    return (
                      <li key={`${instruction.markdown ?? "tail"}-${index}`}>
                        <span className="world-frame-order-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <strong>{title}</strong>
                          {instruction.markdown === undefined ? null : (
                            <code>{instruction.markdown}</code>
                          )}
                          {instruction.markdown !== undefined &&
                            block === undefined && (
                              <span>{uiText("引用的文件不存在")}</span>
                            )}
                          <label className="world-frame-turn-guide">
                            {uiText("尾部提示")}
                            <input
                              aria-label={uiText("尾部提示 {title}", { title })}
                              value={instruction.turnGuide ?? ""}
                              placeholder={uiText("留空则本项不进入本轮提示")}
                              onChange={(event) =>
                                updateLine(event.currentTarget.value)
                              }
                            />
                          </label>
                        </div>
                        <div className="world-frame-order-actions">
                          <span>{uiText("调整顺序")}</span>
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={uiText("上移 {title}", { title })}
                            disabled={index === 0}
                            onClick={() =>
                              updateInstructions(
                                moveItem(instructions, index, index - 1),
                              )
                            }
                          >
                            <span aria-hidden="true">↑</span> {uiText("上移")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={uiText("下移 {title}", { title })}
                            disabled={index === instructions.length - 1}
                            onClick={() =>
                              updateInstructions(
                                moveItem(instructions, index, index + 1),
                              )
                            }
                          >
                            <span aria-hidden="true">↓</span> {uiText("下移")}
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={uiText("移除指令 {title}", { title })}
                            onClick={() =>
                              updateInstructions(
                                instructions.filter(
                                  (_, candidate) => candidate !== index,
                                ),
                              )
                            }
                          >
                            {uiText("移除")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {instructions.length === 0 && (
                  <p className="world-frame-empty">
                    {uiText("尚未加入世界提示块。")}
                  </p>
                )}
                <div className="world-frame-add-row">
                  <label>
                    {uiText("要加入的 Markdown 块")}
                    <select
                      value={instructionToAdd}
                      onChange={(event) =>
                        setNewInstructionPath(event.currentTarget.value)
                      }
                    >
                      {unlinkedBlocks.length === 0 ? (
                        <option value="">
                          {uiText("没有可加入的未引用块")}
                        </option>
                      ) : (
                        unlinkedBlocks.map((block) => (
                          <option key={block.path} value={block.path}>
                            {block.title} · {block.path}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={instructionToAdd.length === 0}
                    onClick={() => {
                      updateInstructions([
                        ...instructions,
                        { markdown: instructionToAdd },
                      ]);
                      setNewInstructionPath("");
                    }}
                  >
                    {uiText("加入指令顺序")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      updateInstructions([...instructions, { turnGuide: "" }])
                    }
                  >
                    {uiText("加入独立尾部行")}
                  </button>
                </div>
              </>
            )}
          </section>

          <MaintenanceEditor
            frame={frame}
            documents={documents}
            onChange={(maintenance) =>
              updateFrame((draft) =>
                replaceFrameValue(
                  draft,
                  ["maintenance"],
                  frame.maintenance,
                  maintenance,
                ),
              )
            }
          />

          <section
            className="world-frame-section"
            aria-labelledby="world-frame-context-title"
          >
            <header>
              <div>
                <h6 id="world-frame-context-title">
                  {uiText("上下文材料顺序")}
                </h6>
              </div>
              <span className="world-frame-section-state">
                {uiText("插槽：{count} 个", {
                  count: contextEntries?.length ?? "—",
                })}
              </span>
            </header>
            {contextEntries === null ? (
              <MalformedFrameSection
                name="context"
                onReset={() =>
                  updateFrame((draft) =>
                    replaceFrameValue(draft, ["context"], frame.context, []),
                  )
                }
              />
            ) : (
              <>
                {(currentSituationSlots !== 1 ||
                  additionalMaterialSlots !== 1) && (
                  <div className="world-frame-required-slots" role="note">
                    <div>
                      <strong>{uiText("必需插槽还未成对")}</strong>
                      <span>
                        {uiText(
                          "当前情境插槽 {current} 个，附加材料插槽 {additional} 个。",
                          {
                            current: currentSituationSlots,
                            additional: additionalMaterialSlots,
                          },
                        )}
                      </span>
                    </div>
                    <div>
                      {currentSituationSlots === 0 && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => addRequiredSlot("current_situation")}
                        >
                          {uiText("补上当前情境")}
                        </button>
                      )}
                      {additionalMaterialSlots === 0 && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            addRequiredSlot("additional_materials")
                          }
                        >
                          {uiText("补上附加材料")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <ol
                  className="world-frame-slot-list"
                  aria-label={uiText("上下文材料顺序")}
                >
                  {contextEntries.map((entry, index) => (
                    <li key={`${entry.slot.kind}-${index}`}>
                      <FrameSlotCard
                        slot={entry.slot}
                        ordinal={index + 1}
                        documents={documents}
                        directories={directories}
                        worldDraft={worldDraft}
                        canRemove={
                          !isRequiredSlot(entry.slot.kind) ||
                          countSlot(contextEntries, entry.slot.kind) > 1
                        }
                        onChange={(slot) =>
                          updateFrame((draft) =>
                            replaceFrameValue(
                              draft,
                              ["context", index, "slot"],
                              entry.slot,
                              slot,
                            ),
                          )
                        }
                        onMove={(target) =>
                          updateContext(moveItem(contextEntries, index, target))
                        }
                        onRemove={() =>
                          updateContext(
                            contextEntries.filter(
                              (_, candidate) => candidate !== index,
                            ),
                          )
                        }
                        first={index === 0}
                        last={index === contextEntries.length - 1}
                      />
                    </li>
                  ))}
                </ol>
                <div className="world-frame-add-slot">
                  <label>
                    {uiText("新增材料类型")}
                    <select
                      value={newSlotKind}
                      onChange={(event) =>
                        setNewSlotKind(
                          event.currentTarget.value as typeof newSlotKind,
                        )
                      }
                    >
                      {optionalSlotKinds.map((item) => (
                        <option key={item.kind} value={item.kind}>
                          {uiText(item.label)} — {uiText(item.detail)}
                        </option>
                      ))}
                    </select>
                    {newSlotUnavailableReason !== null && (
                      <small className="world-frame-association-note">
                        {newSlotUnavailableReason}
                      </small>
                    )}
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={newSlotUnavailableReason !== null}
                    onClick={addOptionalSlot}
                  >
                    {uiText("新增材料插槽")}
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function FrameSlotCard({
  slot,
  ordinal,
  documents,
  directories,
  worldDraft,
  canRemove,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  slot: FrameSlot;
  ordinal: number;
  documents: readonly DocumentOption[];
  directories: readonly DirectoryOption[];
  worldDraft: WorldDocumentDraft;
  canRemove: boolean;
  first: boolean;
  last: boolean;
  onChange: (slot: FrameSlot) => void;
  onMove: (target: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const definition = slotDefinition(slot.kind);
  const documentHandleValue = stringValue(slot.document);
  const from = isRecord(slot.from) ? slot.from : {};
  const fromDocument = stringValue(from.document);
  const selectedFromDocumentCandidate = findDocument(documents, fromDocument);
  const selectedFromDocument =
    selectedFromDocumentCandidate?.codec === "yaml"
      ? selectedFromDocumentCandidate
      : undefined;
  const fromLocator = readLocator(from.locator, "yaml");

  return (
    <article className="world-frame-slot-card">
      <header>
        <span className="world-frame-order-number">
          {String(ordinal).padStart(2, "0")}
        </span>
        <div>
          <strong>{uiText(definition.title)}</strong>
          <code>{slot.kind}</code>
          <p>{uiText(definition.detail)}</p>
        </div>
        <div className="world-frame-order-actions">
          <span>{uiText("调整注入顺序")}</span>
          <button
            type="button"
            className="secondary-button"
            aria-label={uiText("上移材料 {index}", { index: ordinal })}
            disabled={first}
            onClick={() => onMove(ordinal - 2)}
          >
            <span aria-hidden="true">↑</span> {uiText("上移")}
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-label={uiText("下移材料 {index}", { index: ordinal })}
            disabled={last}
            onClick={() => onMove(ordinal)}
          >
            <span aria-hidden="true">↓</span> {uiText("下移")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!canRemove}
            aria-label={uiText("移除材料 {index}", { index: ordinal })}
            onClick={onRemove}
          >
            {uiText("移除")}
          </button>
        </div>
      </header>

      {slot.kind === "document" && (
        <div className="world-frame-slot-fields">
          <DocumentField
            label={uiText("文档 {index}", { index: ordinal })}
            value={documentHandleValue}
            documents={documents}
            onChange={(document) => onChange({ ...slot, document })}
          />
          <RequiredField slot={slot} ordinal={ordinal} onChange={onChange} />
        </div>
      )}

      {slot.kind === "node" && (
        <div className="world-frame-slot-fields">
          <DocumentField
            label={uiText("文档 {index}", { index: ordinal })}
            value={documentHandleValue}
            documents={documents}
            onChange={(document) => {
              const codec = findDocument(documents, document)?.codec ?? "yaml";
              onChange({
                ...slot,
                document,
                locator: { [codec]: [] },
              });
            }}
          />
          <NodeLocatorField
            ordinal={ordinal}
            worldDraft={worldDraft}
            handle={documentHandleValue}
            value={slot.locator}
            onChange={(locator) => onChange({ ...slot, locator })}
          />
          <RequiredField slot={slot} ordinal={ordinal} onChange={onChange} />
        </div>
      )}

      {slot.kind === "reference_targets" && (
        <div className="world-frame-slot-fields">
          <DocumentField
            label={uiText("来源 YAML 文件 {index}", { index: ordinal })}
            value={fromDocument}
            documents={documents.filter(({ codec }) => codec === "yaml")}
            emptyLabel={uiText("选择实际 YAML 文件")}
            onChange={(document) => {
              const resolved = findDocument(documents, document);
              const selected =
                resolved?.codec === "yaml" ? resolved : undefined;
              onChange({
                ...slot,
                from: {
                  document,
                  locator: { yaml: preferredReferencePath(selected) },
                },
              });
            }}
          />
          <ReferenceLocatorField
            label={uiText("从 YAML 哪个字段读取 $ref（插槽 {index}）", {
              index: ordinal,
            })}
            manualLabel={uiText("手动 YAML 字段路径（插槽 {index}）", {
              index: ordinal,
            })}
            document={selectedFromDocument}
            locator={fromLocator}
            onChange={(locatorValue) =>
              onChange({
                ...slot,
                from: { document: fromDocument, locator: locatorValue },
              })
            }
          />
          <NumberField
            label={uiText("最多目标数 {index}", { index: ordinal })}
            value={slot.maxEntries}
            minimum={1}
            maximum={64}
            onChange={(maxEntries) => onChange({ ...slot, maxEntries })}
          />
          <RequiredField slot={slot} ordinal={ordinal} onChange={onChange} />
        </div>
      )}

      {slot.kind === "catalog" && (
        <div className="world-frame-slot-fields">
          <DirectoryField
            label={uiText("目录 {index}", { index: ordinal })}
            value={stringValue(slot.directory)}
            directories={directories}
            root={worldDraft.snapshot.logicalRoot}
            onChange={(directory) => onChange({ ...slot, directory })}
          />
          <NumberField
            label={uiText("最多目录项 {index}", { index: ordinal })}
            value={slot.maxEntries}
            minimum={1}
            maximum={100}
            onChange={(maxEntries) => onChange({ ...slot, maxEntries })}
          />
        </div>
      )}

      {slot.kind === "history" && (
        <div className="world-frame-slot-fields">
          <NumberField
            label={uiText("带上最近几条 {index}", { index: ordinal })}
            value={slot.recent ?? 2}
            minimum={1}
            maximum={32}
            onChange={(recent) => onChange({ ...slot, recent })}
          />
        </div>
      )}

      {slot.kind === "history_message" && (
        <div className="world-frame-slot-fields">
          <label>
            {uiText("历史消息句柄（插槽 {index}）", { index: ordinal })}
            <input
              value={stringValue(slot.message)}
              onChange={(event) =>
                onChange({ ...slot, message: event.currentTarget.value })
              }
            />
          </label>
          <RequiredField slot={slot} ordinal={ordinal} onChange={onChange} />
        </div>
      )}

      {!isKnownSlot(slot.kind) && (
        <pre className="world-frame-unknown-slot">
          {stringify(slot, { lineWidth: 0 })}
        </pre>
      )}
      <details className="world-frame-slot-size">
        <summary>
          {typeof slot.advisoryBytes === "number"
            ? uiText("建议体积 · {bytes} 字节", {
                bytes: slot.advisoryBytes.toLocaleString(getWebLocale()),
              })
            : uiText("设置建议体积")}
        </summary>
        <label>
          {uiText("建议体积（UTF-8 字节，可留空）")}
          <input
            type="number"
            min={1}
            step={1}
            value={
              typeof slot.advisoryBytes === "number" ? slot.advisoryBytes : ""
            }
            onChange={(event) => {
              const next = { ...slot };
              if (event.currentTarget.value === "") delete next.advisoryBytes;
              else {
                next.advisoryBytes = Number(event.currentTarget.value);
                next.id ??= `slot-${browserUUID()}`;
              }
              onChange(next);
            }}
          />
        </label>
      </details>
    </article>
  );
}

function DocumentField({
  label,
  value,
  documents,
  emptyLabel = uiText("选择实际文档文件"),
  onChange,
}: {
  label: string;
  value: string;
  documents: readonly DocumentOption[];
  emptyLabel?: string;
  onChange: (document: string) => void;
}): React.JSX.Element {
  const selected = findDocument(documents, value);
  return (
    <label>
      {label}
      <select
        aria-label={label}
        // A frame written before short refs stores an id. Showing the document
        // it resolves to keeps the select from reading as "nothing chosen",
        // which would drop the binding on the next save.
        value={selected === undefined ? value : documentHandle(selected)}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">{emptyLabel}</option>
        {value.length > 0 && findDocument(documents, value) === undefined && (
          <option value={value}>
            {value}
            {uiText("（当前未解析）")}
          </option>
        )}
        {documents.map((document) => (
          <option key={document.path} value={documentHandle(document)}>
            {document.path} — {document.title} · {documentHandle(document)}
          </option>
        ))}
      </select>
      <small className="world-frame-association-note">
        {selected === undefined
          ? uiText("只列出当前草稿中可读取的世界文档。")
          : uiText("实际关联 {path}；frame.yaml 保存 @短引用：{handle}", {
              path: selected.path,
              handle: documentHandle(selected),
            })}
      </small>
    </label>
  );
}

function DirectoryField({
  label,
  value,
  directories,
  root,
  onChange,
}: {
  label: string;
  value: string;
  directories: readonly DirectoryOption[];
  root: "world" | "state";
  onChange: (directory: string) => void;
}): React.JSX.Element {
  const selected = directories.find(({ directory }) => directory === value);
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">{uiText("选择实际世界目录")}</option>
        {value.length > 0 && selected === undefined && (
          <option value={value}>
            {value}
            {uiText("（当前没有可关联文档）")}
          </option>
        )}
        {directories.map((directory) => (
          <option key={directory.directory} value={directory.directory}>
            {root}/{directory.directory}/ — {directory.documentCount}{" "}
            {uiText("份文档")}
          </option>
        ))}
      </select>
      <small className="world-frame-association-note">
        {selected === undefined
          ? uiText("只列出当前草稿中含可识别文档的目录。")
          : root === "world"
            ? uiText(
                "实际关联 world/{directory}/；创建世界后对应 state/{directory}/。",
                { directory: selected.directory },
              )
            : uiText("实际关联 state/{directory}/。", {
                directory: selected.directory,
              })}
      </small>
    </label>
  );
}

function NodeLocatorField({
  ordinal,
  worldDraft,
  handle,
  value,
  onChange,
}: {
  ordinal: number;
  worldDraft: WorldDocumentDraft;
  handle: string;
  value: unknown;
  onChange: (locator: NodeLocator) => void;
}): React.JSX.Element {
  const statusId = useId();
  const [active, setActive] = useState(false);
  const document = worldDraft.resolve(handle);
  const options = useMemo(() => {
    const result = new Map<string, NodeLocator>();
    const codec = worldDraft.resolve(handle)?.codec;
    for (const choice of worldDraft.choices(handle)) {
      // The shared picker uses null for a whole document. Only the YAML
      // root has an exact node locator that the frame compiler can read.
      const exact = choice ?? (codec === "yaml" ? { yaml: [] } : null);
      if (exact !== null) result.set(JSON.stringify(exact), exact);
    }
    return result;
  }, [worldDraft, handle]);
  const locator = readLocator(value, document?.codec ?? "yaml");
  const kind = document?.codec ?? locator.kind;
  const currentKey = frameNodeLocatorKey(value);
  const selected =
    currentKey === undefined ? undefined : options.get(currentKey);
  const unresolved = value !== undefined && selected === undefined;
  // Keep large lists out of inactive cards while still showing their selection.
  const visible =
    active || options.size <= 100
      ? [...options]
      : selected === undefined
        ? []
        : [[JSON.stringify(selected), selected] as const];
  const hints =
    visible.length === 0 ? undefined : worldDraft.choiceHints(handle);
  const label =
    kind === "yaml"
      ? uiText("选择 YAML 节点（插槽 {index}）", { index: ordinal })
      : uiText("选择 Markdown 标题（插槽 {index}）", { index: ordinal });

  return (
    <div className="world-frame-reference-locator">
      <label>
        {label}
        <select
          aria-label={label}
          aria-describedby={unresolved ? statusId : undefined}
          aria-invalid={unresolved || undefined}
          value={
            selected === undefined
              ? unresolved
                ? "unresolved"
                : ""
              : currentKey
          }
          disabled={document === undefined}
          onFocus={() => setActive(true)}
          onPointerDown={() => setActive(true)}
          onBlur={() => setActive(false)}
          onChange={(event) => {
            const next = options.get(event.currentTarget.value);
            if (next !== undefined) onChange(next);
          }}
        >
          <option value="" disabled>
            {document === undefined
              ? uiText("先选择来源文件")
              : uiText("选择一个节点")}
          </option>
          {unresolved && (
            <option value="unresolved" disabled>
              {storedNodePath(value, locator)}
            </option>
          )}
          {visible.map(([key, choice]) => {
            const path = "yaml" in choice ? choice.yaml : choice.markdown;
            const name =
              path.length === 0
                ? uiText("YAML 正文根节点")
                : formatFrameNodePath(path);
            const hint = hints?.get(key);
            return (
              <option key={key} value={key}>
                {hint === undefined ? name : `${name} · ${hint}`}
              </option>
            );
          })}
        </select>
      </label>
      {unresolved && (
        <small id={statusId} className="world-frame-association-note">
          {uiText("当前路径无法解析或不唯一。请选择其他节点，或手动修正路径。")}
        </small>
      )}
      <details className="world-frame-locator-advanced">
        <summary>{uiText("高级：手动填写节点路径")}</summary>
        <LocatorField
          label={`${kind === "yaml" ? uiText("YAML 路径") : uiText("Markdown 标题路径")} ${ordinal}`}
          locator={{ kind, path: locator.path }}
          onChange={onChange}
        />
      </details>
    </div>
  );
}

function frameNodeLocatorKey(value: unknown): string | undefined {
  if (
    validYamlLocator(value) &&
    value.yaml.every((part) => typeof part === "string")
  )
    return JSON.stringify({ yaml: value.yaml });
  if (validMarkdownLocator(value))
    return JSON.stringify({
      markdown: value.markdown.map((part) => part.normalize("NFKC")),
    });
  return undefined;
}

function storedNodePath(
  value: unknown,
  locator: ReturnType<typeof readLocator>,
): string {
  if (validYamlLocator(value)) {
    return value.yaml.length === 0
      ? uiText("YAML 正文根节点")
      : formatFrameNodePath(value.yaml.map(String));
  }
  return locator.path.length === 0
    ? uiText("当前路径不可用")
    : formatFrameNodePath(locator.path);
}

function formatFrameNodePath(path: readonly string[]): string {
  return path
    .map((part) =>
      part === "" || part.trim() !== part || /[›·"\\\r\n\t]/u.test(part)
        ? JSON.stringify(part)
        : part,
    )
    .join(" › ");
}

function ReferenceLocatorField({
  label,
  manualLabel,
  document,
  locator,
  onChange,
}: {
  label: string;
  manualLabel: string;
  document: DocumentOption | undefined;
  locator: { kind: "yaml" | "markdown"; path: string[] };
  onChange: (locator: EditableLocator) => void;
}): React.JSX.Element {
  const options = document?.yamlLocators ?? [];
  const currentKey = yamlLocatorKey(locator.path);
  const currentIsResolved = options.some(
    ({ path }) => yamlLocatorKey(path) === currentKey,
  );
  const referencedNodes = options.filter(
    ({ referenceCount }) => referenceCount > 0,
  ).length;

  return (
    <div className="world-frame-reference-locator">
      <label>
        {label}
        <select
          aria-label={label}
          value={currentKey}
          disabled={document === undefined}
          onChange={(event) => {
            const selected = options.find(
              ({ path }) => yamlLocatorKey(path) === event.currentTarget.value,
            );
            if (selected !== undefined) onChange({ yaml: [...selected.path] });
          }}
        >
          {document === undefined ? (
            <option value={currentKey}>{uiText("先选择来源 YAML 文件")}</option>
          ) : (
            <>
              {!currentIsResolved && (
                <option value={currentKey}>
                  {uiText("当前手动路径：")}
                  {formatYamlPath(locator.path)}
                  {uiText("（未解析）")}
                </option>
              )}
              {options.map((option) => (
                <option
                  key={yamlLocatorKey(option.path)}
                  value={yamlLocatorKey(option.path)}
                >
                  {formatYamlPath(option.path)} —{" "}
                  {option.nodeKind === "list" ? uiText("列表") : uiText("对象")}{" "}
                  ·{" "}
                  {option.referenceCount > 0
                    ? option.referenceCount + uiText(" 个 $ref")
                    : uiText("当前无 $ref")}
                </option>
              ))}
            </>
          )}
        </select>
        <small className="world-frame-association-note">
          {document === undefined
            ? uiText("选择 YAML 文件后，这里会解析其中可持久定位的对象和列表。")
            : document.path +
              uiText(" 已解析 ") +
              options.length +
              uiText(" 个可选节点，其中 ") +
              referencedNodes +
              uiText(" 个当前包含 $ref。")}
        </small>
      </label>
      <details className="world-frame-locator-advanced">
        <summary>{uiText("高级：手动填写字段路径")}</summary>
        <LocatorField
          label={manualLabel}
          locator={{ kind: "yaml", path: locator.path }}
          onChange={onChange}
        />
      </details>
    </div>
  );
}

function LocatorField({
  label,
  locator,
  onChange,
}: {
  label: string;
  locator: { kind: "yaml" | "markdown"; path: string[] };
  onChange: (locator: EditableLocator) => void;
}): React.JSX.Element {
  const [edit, setEdit] = useState<{ raw: string; key: string }>();
  const savedKey = JSON.stringify(locator);
  return (
    <label>
      {label}
      <textarea
        rows={3}
        value={edit?.key === savedKey ? edit.raw : locator.path.join("\n")}
        placeholder={
          locator.kind === "yaml"
            ? uiText("每行一个层级；留空表示文档根")
            : uiText("每行填写一个标题层级")
        }
        onBlur={() => setEdit(undefined)}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          const parts = raw
            .split("\n")
            .map((part) => part.trim())
            .filter(Boolean);
          setEdit({
            raw,
            key: JSON.stringify({ kind: locator.kind, path: parts }),
          });
          onChange(
            locator.kind === "yaml" ? { yaml: parts } : { markdown: parts },
          );
        }}
      />
    </label>
  );
}

function RequiredField({
  slot,
  ordinal,
  onChange,
}: {
  slot: FrameSlot;
  ordinal: number;
  onChange: (slot: FrameSlot) => void;
}): React.JSX.Element {
  return (
    <label className="world-frame-required-field">
      <input
        type="checkbox"
        aria-label={uiText("缺失时阻止请求 {index}", { index: ordinal })}
        checked={slot.required !== false}
        onChange={(event) => {
          const next = { ...slot };
          if (event.currentTarget.checked) delete next.required;
          else next.required = false;
          onChange(next);
        }}
      />
      <span>
        <strong>{uiText("缺失时阻止请求")}</strong>
        <small>{uiText("关闭后，目标暂时不存在时会明确略过。")}</small>
      </span>
    </label>
  );
}

function NumberField({
  label,
  value,
  minimum,
  maximum,
  onChange,
}: {
  label: string;
  value: unknown;
  minimum: number;
  maximum: number;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label>
      {label}
      <input
        type="number"
        min={minimum}
        max={maximum}
        value={typeof value === "number" ? value : ""}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function MalformedFrameSection({
  name,
  onReset,
}: {
  name: "instructions" | "context";
  onReset: () => void;
}): React.JSX.Element {
  return (
    <div className="world-frame-malformed" role="alert">
      <div>
        <strong>
          {uiText("{name} 需要是可视化编辑器支持的列表。", { name })}
        </strong>
        <span>
          {uiText("可在高级 YAML 中修复，或明确重置为空列表后重新编排。")}
        </span>
      </div>
      <button type="button" className="secondary-button" onClick={onReset}>
        {uiText("重置 {name}", { name })}
      </button>
    </div>
  );
}

function readWorldFrame(source: string): ParsedFrame {
  try {
    const { document, problems } = parseRestrictedYamlDocument(source, {
      rejectRawControlCharacters: false,
    });
    if (document === undefined)
      return {
        value: null,
        error: uiText("YAML 无法解析：{message}", {
          message: problems[0]?.detail ?? problems[0]?.message ?? "",
        }),
      };
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isMap(document.contents) || !isRecord(value))
      return { value: null, error: uiText("frame.yaml 顶层必须是 YAML map。") };
    if (exceedsRestrictedYamlShape(value))
      return { value: null, error: uiText("YAML 无法解析。") };
    return { value, document, error: null };
  } catch (error: unknown) {
    return {
      value: null,
      error:
        error instanceof Error
          ? uiText("YAML 无法解析：{message}", { message: error.message })
          : uiText("YAML 无法解析。"),
    };
  }
}

function updateFrameOrder<T>(
  draft: FrameYaml,
  key: "instructions" | "context",
  previous: readonly T[],
  next: readonly T[],
): void {
  const sequence: unknown = draft.get(key, true);
  if (!isSeq(sequence)) return;
  const nodes = new Map(
    previous.map((value, index) => [value, sequence.items[index]]),
  );
  sequence.items = next.map(
    (value) => nodes.get(value) ?? draft.createNode(value),
  );
}

function replaceFrameValue(
  draft: FrameYaml,
  path: YamlPath,
  previous: unknown,
  next: unknown,
): void {
  if (Object.is(previous, next)) return;
  const node: unknown = draft.getIn(path, true);
  if (isMap(node) && isRecord(previous) && isRecord(next)) {
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(next, key)) draft.deleteIn([...path, key]);
    }
    for (const [key, value] of Object.entries(next)) {
      replaceFrameValue(draft, [...path, key], previous[key], value);
    }
    return;
  }
  if (isSeq(node) && Array.isArray(previous) && Array.isArray(next)) {
    next.forEach((value, index) =>
      replaceFrameValue(draft, [...path, index], previous[index], value),
    );
    node.items.length = next.length;
    return;
  }
  if (
    isNode(node) &&
    (isMap(node) || isSeq(node) || typeof next === "object")
  ) {
    const replacement = draft.createNode(next);
    replacement.comment = node.comment ?? null;
    replacement.commentBefore = node.commentBefore ?? null;
    replacement.spaceBefore = node.spaceBefore ?? false;
    draft.setIn(path, replacement);
    return;
  }
  draft.setIn(path, next);
}

function frameInstructions(frame: FrameRecord): FrameInstruction[] | null {
  if (!Array.isArray(frame.instructions)) return null;
  if (
    !frame.instructions.every(
      (entry) =>
        isRecord(entry) &&
        (typeof entry.markdown === "string" ||
          typeof entry.turnGuide === "string") &&
        (entry.markdown === undefined || typeof entry.markdown === "string") &&
        (entry.turnGuide === undefined || typeof entry.turnGuide === "string"),
    )
  )
    return null;
  return frame.instructions as FrameInstruction[];
}

function frameContext(frame: FrameRecord): FrameContextEntry[] | null {
  if (!Array.isArray(frame.context)) return null;
  if (
    !frame.context.every(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.slot) &&
        typeof entry.slot.kind === "string",
    )
  )
    return null;
  return frame.context as FrameContextEntry[];
}

function frameDocumentOptions(draft: WorldDocumentDraft): DocumentOption[] {
  const options = draft.documents.map((document) => {
    let yamlLocators: readonly YamlLocatorOption[] | undefined;
    return {
      ...document,
      ref: document.ref.slice(1),
      get yamlLocators() {
        return (yamlLocators ??= yamlLocatorOptions(
          draft.yamlBody(document.ref),
        ));
      },
    };
  });
  // The current situation is the binding an author reaches for first. Its id
  // is only "situation.current" in hand-written packages; anything the runtime
  // created carries a random one, so the short ref has to count too.
  const first = (option: DocumentOption): number =>
    option.id === "situation.current" || option.ref === "current-situation"
      ? -1
      : 0;
  return options.sort(
    (left, right) =>
      first(left) - first(right) || left.path.localeCompare(right.path),
  );
}

function controlMarkdownBlocks(
  files: readonly ContentTreeFile[],
): MarkdownBlockOption[] {
  return files
    .filter(
      ({ path, encoding }) =>
        encoding === undefined &&
        path.startsWith("control/blocks/") &&
        path.endsWith(".md"),
    )
    .map((file) => ({
      path: file.path.slice("control/".length),
      title:
        /^#\s+(.+?)\s*$/mu.exec(file.contents)?.[1]?.trim() ??
        file.path.split("/").at(-1) ??
        file.path,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function worldDirectories(
  documents: readonly DocumentOption[],
): DirectoryOption[] {
  const documentCounts = new Map<string, number>();
  for (const document of documents) {
    if (document.retired) continue;
    const directory = document.path.split("/").slice(1, -1).join("/");
    if (directory === "") continue;
    documentCounts.set(directory, (documentCounts.get(directory) ?? 0) + 1);
  }
  return [...documentCounts]
    .map(([directory, documentCount]) => ({ directory, documentCount }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function yamlLocatorOptions(value: unknown): YamlLocatorOption[] {
  const options: YamlLocatorOption[] = [];
  const visited = new WeakSet<object>();

  const visit = (node: unknown, path: string[]): number => {
    if (Array.isArray(node)) {
      if (visited.has(node)) return 0;
      visited.add(node);
      const referenceCount = countExplicitReferences(node);
      options.push({ path, nodeKind: "list", referenceCount });
      return referenceCount;
    }
    if (!isRecord(node)) return 0;
    if (visited.has(node)) return 0;
    visited.add(node);

    let referenceCount = typeof node.$ref === "string" ? 1 : 0;
    for (const [key, child] of Object.entries(node)) {
      if (key === "$document" || key === "$ref") continue;
      if (Array.isArray(child) || isRecord(child))
        referenceCount += visit(child, [...path, key]);
    }
    options.push({ path, nodeKind: "object", referenceCount });
    return referenceCount;
  };

  visit(value, []);
  return options.sort(
    (left, right) => yamlLocatorRank(left) - yamlLocatorRank(right),
  );
}

function yamlLocatorRank(option: YamlLocatorOption): number {
  if (option.path.length === 0) return 2;
  return option.referenceCount > 0 ? 0 : 1;
}

function countExplicitReferences(
  value: unknown,
  visited = new WeakSet<object>(),
): number {
  if (Array.isArray(value)) {
    if (visited.has(value)) return 0;
    visited.add(value);
    let total = 0;
    for (const child of value as unknown[])
      total += countExplicitReferences(child, visited);
    return total;
  }
  if (!isRecord(value)) return 0;
  if (visited.has(value)) return 0;
  visited.add(value);
  return (
    (typeof value.$ref === "string" ? 1 : 0) +
    Object.entries(value).reduce(
      (total, [key, child]) =>
        key === "$document" || key === "$ref"
          ? total
          : total + countExplicitReferences(child, visited),
      0,
    )
  );
}

function defaultSlot(
  kind: (typeof optionalSlotKinds)[number]["kind"],
  documents: readonly DocumentOption[],
  directories: readonly DirectoryOption[],
): FrameSlot {
  const firstDocument = documents[0];
  if (kind === "document")
    return {
      kind,
      document:
        firstDocument === undefined ? "" : documentHandle(firstDocument),
    };
  if (kind === "node")
    return {
      kind,
      document:
        firstDocument === undefined ? "" : documentHandle(firstDocument),
      locator: { [firstDocument?.codec ?? "yaml"]: [] },
    };
  if (kind === "reference_targets") {
    const yamlDocument = documents.find(({ codec }) => codec === "yaml");
    return {
      kind,
      from: {
        document:
          yamlDocument === undefined ? "" : documentHandle(yamlDocument),
        locator: { yaml: preferredReferencePath(yamlDocument) },
      },
      maxEntries: 12,
    };
  }
  if (kind === "history") return { kind, recent: 2 };
  return {
    kind,
    directory: directories[0]?.directory ?? "",
    maxEntries: 24,
  };
}

function preferredReferencePath(
  document: DocumentOption | undefined,
): string[] {
  const preferred = document?.yamlLocators.find(
    ({ path, referenceCount }) => path.length > 0 && referenceCount > 0,
  );
  if (preferred !== undefined) return [...preferred.path];
  const root = document?.yamlLocators.find(({ path }) => path.length === 0);
  return root === undefined ? [] : [...root.path];
}

function yamlLocatorKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function formatYamlPath(path: readonly string[]): string {
  return path.length === 0 ? uiText("整份 YAML") : path.join(" › ");
}

function optionalSlotUnavailableReason(
  kind: (typeof optionalSlotKinds)[number]["kind"],
  documents: readonly DocumentOption[],
  directories: readonly DirectoryOption[],
  root: "world" | "state",
): string | null {
  if (kind === "catalog" && directories.length === 0)
    return uiText("先在 {root}/ 的子目录中创建带 $document 技术头的文档。", {
      root,
    });
  if (
    kind === "reference_targets" &&
    !documents.some(({ codec }) => codec === "yaml")
  )
    return uiText("先创建一份带 $document 技术头的 YAML 世界文档。");
  if ((kind === "document" || kind === "node") && documents.length === 0)
    return uiText("先创建一份带 $document 技术头的世界文档。");
  return null;
}

function readLocator(
  value: unknown,
  fallback: "yaml" | "markdown",
): { kind: "yaml" | "markdown"; path: string[] } {
  if (isRecord(value) && Array.isArray(value.yaml))
    return {
      kind: "yaml",
      path: value.yaml.filter(
        (part): part is string => typeof part === "string",
      ),
    };
  if (isRecord(value) && Array.isArray(value.markdown))
    return {
      kind: "markdown",
      path: value.markdown.filter(
        (part): part is string => typeof part === "string",
      ),
    };
  return { kind: fallback, path: [] };
}

function slotDefinition(kind: string): { title: string; detail: string } {
  const definitions: Record<string, { title: string; detail: string }> = {
    current_situation: {
      title: uiText("当前情境"),
      detail: uiText("从上方绑定读取紧接着的叙事不能忘记的短期局面。"),
    },
    additional_materials: {
      title: uiText("附加材料"),
      detail: uiText("展开当前端点为全新上下文保存的完整精确材料清单。"),
    },
    document: {
      title: uiText("整份文档"),
      detail: uiText("精确加入一份世界文档。"),
    },
    node: {
      title: uiText("文档局部节点"),
      detail: uiText("精确加入 YAML 路径或 Markdown 标题子树。"),
    },
    catalog: {
      title: uiText("有界目录"),
      detail: uiText("列出一级目录中的标题、简介和短引用，不展开正文。"),
    },
    reference_targets: {
      title: uiText("显式引用目标"),
      detail: uiText("读取 YAML 节点中的 $ref，并加入一层目标文档。"),
    },
    history: {
      title: uiText("最近叙事"),
      detail: uiText(
        "带上最近几条已提交玩家／主持原文；没有此前叙事时会明确标为空，调用链据此延续未写入文档的细节。",
      ),
    },
    history_message: {
      title: uiText("精确历史消息"),
      detail: uiText("按 Runtime 句柄加入一条已提交叙事。"),
    },
  };
  return (
    definitions[kind] ?? {
      title: uiText("未知插槽"),
      detail: uiText(
        "当前可视化编辑器不识别此类型；可移动、移除或在 YAML 中修复。",
      ),
    }
  );
}

function countSlot(
  entries: readonly FrameContextEntry[] | null,
  kind: string,
): number {
  return entries?.filter(({ slot }) => slot.kind === kind).length ?? 0;
}

function isRequiredSlot(kind: string): boolean {
  return kind === "current_situation" || kind === "additional_materials";
}

function isKnownSlot(kind: string): boolean {
  return [
    "current_situation",
    "additional_materials",
    "document",
    "node",
    "catalog",
    "reference_targets",
    "history",
    "history_message",
  ].includes(kind);
}

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function MaintenanceEditor({
  frame,
  documents,
  onChange,
}: {
  frame: FrameRecord;
  documents: readonly DocumentOption[];
  onChange: (settings: FrameRecord) => void;
}): React.JSX.Element {
  const zh = getWebLocale() === "zh-CN";
  const settings = isRecord(frame.maintenance) ? frame.maintenance : {};
  const limits = isRecord(settings.documents) ? settings.documents : {};
  const clock = isRecord(settings.clock) ? settings.clock : {};
  const clockDocument = findDocument(documents, stringValue(clock.document));
  return (
    <details className="world-frame-section">
      <summary>
        {zh
          ? "文档整理提示与世界时间记录"
          : "Document advice and world-time recording"}
      </summary>
      <p>
        {zh
          ? "超出建议体积只会提示整理。世界时间仅在明确选择节点后，随真实写入记录；不会自动推进时间。"
          : "Exceeding advisory sizes only produces advice. World time is recorded with actual writes only when you select an exact node; it never advances automatically."}
      </p>
      {documents.map((document) => (
        <label key={document.ref}>
          {document.title} · @{document.ref} —{" "}
          {zh ? "建议字节数" : "Advisory bytes"}
          <input
            type="number"
            min={1}
            step={1}
            value={
              typeof limits[`@${document.ref}`] === "number"
                ? (limits[`@${document.ref}`] as number)
                : ""
            }
            onChange={(event) => {
              const next = { ...limits };
              if (event.currentTarget.value === "")
                delete next[`@${document.ref}`];
              else next[`@${document.ref}`] = Number(event.currentTarget.value);
              onChange({ ...settings, documents: next });
            }}
          />
        </label>
      ))}
      <DocumentField
        label={
          zh
            ? "记录写入时世界时间的文档"
            : "Document containing world time at write"
        }
        emptyLabel={zh ? "不记录世界时间" : "Do not record world time"}
        value={stringValue(clock.document)}
        documents={documents}
        onChange={(document) => {
          const next = { ...settings };
          if (document === "") delete next.clock;
          else
            next.clock = {
              document,
              locator: {
                [findDocument(documents, document)?.codec ?? "yaml"]: [],
              },
            };
          onChange(next);
        }}
      />
      {clockDocument !== undefined && (
        <LocatorField
          label={zh ? "世界时间的精确字段路径" : "Exact world-time field path"}
          locator={readLocator(clock.locator, clockDocument.codec)}
          onChange={(locator) =>
            onChange({ ...settings, clock: { ...clock, locator } })
          }
        />
      )}
    </details>
  );
}
