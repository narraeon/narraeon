import { useMemo, useState } from "react";
import { parse, stringify } from "yaml";

import type { ContentTreeFile } from "../protocol/v1.ts";

const worldFrameFormat = "narraeon.world-frame/v1";

type FrameRecord = Record<string, unknown>;
type FrameSlot = Record<string, unknown> & { kind: string };

interface FrameInstruction {
  markdown: string;
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
 * Every edit restringifies the whole frame anyway, so leaving untouched fields
 * as ids buys nothing and costs plenty: a runtime-assigned id reads as
 * `doc.<uuid>`, and no tool the setting author has reports ids, so a later AI
 * edit cannot tell which document such a slot points at. Handles that resolve
 * to nothing are left exactly as written — they are the author's to fix.
 */
function normalizeDocumentHandles(
  draft: FrameRecord,
  documents: readonly DocumentOption[],
): void {
  const normalize = (handle: unknown): string | undefined => {
    if (typeof handle !== "string" || handle.length === 0) return undefined;
    const document = findDocument(documents, handle);
    return document === undefined ? undefined : documentHandle(document);
  };
  if (isRecord(draft.bindings)) {
    const bound = normalize(draft.bindings.currentSituation);
    if (bound !== undefined) draft.bindings.currentSituation = bound;
  }
  if (!Array.isArray(draft.context)) return;
  for (const entry of draft.context) {
    if (!isRecord(entry) || !isRecord(entry.slot)) continue;
    const slotDocument = normalize(entry.slot.document);
    if (slotDocument !== undefined) entry.slot.document = slotDocument;
    if (!isRecord(entry.slot.from)) continue;
    const fromDocument = normalize(entry.slot.from.document);
    if (fromDocument !== undefined) entry.slot.from.document = fromDocument;
  }
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

interface ParsedFrame {
  value: FrameRecord | null;
  error: string | null;
}

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
  dirty,
  onChange,
  onSave,
}: {
  contents: string;
  files: readonly ContentTreeFile[];
  dirty: boolean;
  onChange: (contents: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  const parsed = useMemo(() => readWorldFrame(contents), [contents]);
  const documents = useMemo(() => contentDocumentOptions(files), [files]);
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
  );

  const updateFrame = (update: (draft: FrameRecord) => void): void => {
    if (frame === null) return;
    const draft = structuredClone(frame);
    update(draft);
    normalizeDocumentHandles(draft, documents);
    onChange(stringify(draft, { lineWidth: 0 }));
  };

  const updateInstructions = (next: FrameInstruction[]): void => {
    updateFrame((draft) => {
      draft.instructions = next;
    });
  };

  const updateContext = (next: FrameContextEntry[]): void => {
    updateFrame((draft) => {
      draft.context = next;
    });
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
          <span className="content-editor-kicker">可视化编排</span>
          <h5 id="world-frame-editor-title">世界提示框架</h5>
          <p>
            安排世界专属指令与确定性材料位置；这里不保存人物、地点或当前事实。
          </p>
        </div>
        <div className="world-frame-status" aria-label="世界提示框架草稿状态">
          <span
            className={frame?.format === worldFrameFormat ? "valid" : "invalid"}
          >
            {frame?.format === worldFrameFormat ? "V1 格式" : "格式待修复"}
          </span>
          <span className={visualReady ? "valid" : "invalid"}>
            {visualReady ? "可视化已同步" : "仅可编辑 YAML"}
          </span>
        </div>
      </header>

      {frame === null ? (
        <div className="world-frame-parse-error" role="alert">
          <strong>当前 YAML 暂时无法可视化</strong>
          <p>{parsed.error}</p>
          <span>
            下面的高级编辑器会原样保留草稿；修复后可视化页面会自动恢复。
          </span>
        </div>
      ) : (
        <>
          {frame.format !== worldFrameFormat && (
            <div className="world-frame-repair-callout" role="note">
              <div>
                <strong>format 不是当前世界框架版本</strong>
                <span>Runtime 只接受 {worldFrameFormat}。</span>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  updateFrame((draft) => {
                    draft.format = worldFrameFormat;
                  })
                }
              >
                修复为 V1 格式
              </button>
            </div>
          )}

          <div className="world-frame-flow" aria-label="世界提示框架流程">
            <div>
              <span>Markdown 提示块</span>
              <strong>{instructions?.length ?? "?"} 份世界指令</strong>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <span>进入逻辑 role</span>
              <strong>author_instruction</strong>
            </div>
            <div>
              <span>精确文档与目录</span>
              <strong>{contextEntries?.length ?? "?"} 个材料插槽</strong>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <span>进入逻辑 role</span>
              <strong>world_context</strong>
            </div>
          </div>

          <section
            className="world-frame-section world-frame-binding"
            aria-labelledby="world-frame-binding-title"
          >
            <header>
              <div>
                <span>01 · 权威绑定</span>
                <h6 id="world-frame-binding-title">当前情境绑定</h6>
              </div>
              <span
                className={
                  currentSituationDocument === undefined
                    ? "world-frame-section-state invalid"
                    : "world-frame-section-state valid"
                }
              >
                {currentSituationDocument === undefined ? "未解析" : "已解析"}
              </span>
            </header>
            <p>
              `current_situation`
              插槽会从这里读取唯一当前情境文档，不按文件名或标题猜测。
            </p>
            <label>
              当前情境文档
              <select
                value={
                  currentSituationDocument === undefined
                    ? currentSituation
                    : documentHandle(currentSituationDocument)
                }
                onChange={(event) => {
                  const handle = event.currentTarget.value;
                  updateFrame((draft) => {
                    draft.bindings = { currentSituation: handle };
                  });
                }}
              >
                <option value="">选择一份世界文档</option>
                {currentSituation.length > 0 &&
                  findDocument(documents, currentSituation) === undefined && (
                    <option value={currentSituation}>
                      {currentSituation}（当前未解析）
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
                <span>02 · 世界专属指令</span>
                <h6 id="world-frame-instructions-title">提示块顺序</h6>
              </div>
              <span className="world-frame-section-state">
                {instructions?.length ?? 0} 个块
              </span>
            </header>
            <p>
              这些 Markdown
              块按顺序进入主持预设预留的世界指令位置；正文仍在独立文件中编辑。
            </p>
            {instructions === null ? (
              <MalformedFrameSection
                name="instructions"
                onReset={() =>
                  updateFrame((draft) => {
                    draft.instructions = [];
                  })
                }
              />
            ) : (
              <>
                <ol
                  className="world-frame-order-list"
                  aria-label="世界指令顺序"
                >
                  {instructions.map((instruction, index) => {
                    const block = markdownBlocks.find(
                      ({ path }) => path === instruction.markdown,
                    );
                    const title = block?.title ?? instruction.markdown;
                    return (
                      <li key={`${instruction.markdown}-${index}`}>
                        <span className="world-frame-order-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <strong>{title}</strong>
                          <code>{instruction.markdown}</code>
                          {block === undefined && <span>引用的文件不存在</span>}
                        </div>
                        <div className="world-frame-order-actions">
                          <span>调整顺序</span>
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={`上移 ${title}`}
                            disabled={index === 0}
                            onClick={() =>
                              updateInstructions(
                                moveItem(instructions, index, index - 1),
                              )
                            }
                          >
                            <span aria-hidden="true">↑</span> 上移
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={`下移 ${title}`}
                            disabled={index === instructions.length - 1}
                            onClick={() =>
                              updateInstructions(
                                moveItem(instructions, index, index + 1),
                              )
                            }
                          >
                            <span aria-hidden="true">↓</span> 下移
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            aria-label={`移除指令 ${title}`}
                            onClick={() =>
                              updateInstructions(
                                instructions.filter(
                                  (_, candidate) => candidate !== index,
                                ),
                              )
                            }
                          >
                            移除
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {instructions.length === 0 && (
                  <p className="world-frame-empty">尚未加入世界提示块。</p>
                )}
                <div className="world-frame-add-row">
                  <label>
                    要加入的 Markdown 块
                    <select
                      value={instructionToAdd}
                      onChange={(event) =>
                        setNewInstructionPath(event.currentTarget.value)
                      }
                    >
                      {unlinkedBlocks.length === 0 ? (
                        <option value="">没有可加入的未引用块</option>
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
                    加入指令顺序
                  </button>
                </div>
              </>
            )}
          </section>

          <section
            className="world-frame-section"
            aria-labelledby="world-frame-context-title"
          >
            <header>
              <div>
                <span>03 · 确定性材料</span>
                <h6 id="world-frame-context-title">上下文材料顺序</h6>
              </div>
              <span className="world-frame-section-state">
                {contextEntries?.length ?? 0} 个插槽
              </span>
            </header>
            <p>
              Runtime 只按这些精确位置取材。顺序会进入真实
              prompt，但不会推断“相关人物”或“重要历史”。
            </p>
            <div className="world-frame-reorder-guide" role="note">
              <span aria-hidden="true">↕</span>
              <div>
                <strong>从上到下就是实际注入顺序</strong>
                <span>
                  每张卡片右上角都有“上移 / 下移”；移动后序号会立即更新。
                </span>
              </div>
            </div>
            {contextEntries === null ? (
              <MalformedFrameSection
                name="context"
                onReset={() =>
                  updateFrame((draft) => {
                    draft.context = [];
                  })
                }
              />
            ) : (
              <>
                {(currentSituationSlots !== 1 ||
                  additionalMaterialSlots !== 1) && (
                  <div className="world-frame-required-slots" role="note">
                    <div>
                      <strong>必需插槽还未成对</strong>
                      <span>
                        当前情境 {currentSituationSlots} 个 · 附加材料{" "}
                        {additionalMaterialSlots} 个
                      </span>
                    </div>
                    <div>
                      {currentSituationSlots === 0 && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => addRequiredSlot("current_situation")}
                        >
                          补上当前情境
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
                          补上附加材料
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <ol
                  className="world-frame-slot-list"
                  aria-label="上下文材料顺序"
                >
                  {contextEntries.map((entry, index) => (
                    <li key={`${entry.slot.kind}-${index}`}>
                      <FrameSlotCard
                        slot={entry.slot}
                        ordinal={index + 1}
                        documents={documents}
                        directories={directories}
                        canRemove={
                          !isRequiredSlot(entry.slot.kind) ||
                          countSlot(contextEntries, entry.slot.kind) > 1
                        }
                        onChange={(slot) => {
                          const next = [...contextEntries];
                          next[index] = { slot };
                          updateContext(next);
                        }}
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
                    新增材料类型
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
                          {item.label} — {item.detail}
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
                    新增材料插槽
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      )}

      <details className="world-frame-source" open={frame === null}>
        <summary>高级：直接编辑 frame.yaml</summary>
        <p>
          可视化修改会把 YAML
          重新整理为稳定格式；需要修复未知字段或保留当前原文时可在这里编辑。
        </p>
        <textarea
          rows={18}
          spellCheck={false}
          aria-label="直接编辑 control/frame.yaml"
          value={contents}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {parsed.error !== null && <p role="alert">{parsed.error}</p>}
      </details>
    </section>
  );
}

function FrameSlotCard({
  slot,
  ordinal,
  documents,
  directories,
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
  canRemove: boolean;
  first: boolean;
  last: boolean;
  onChange: (slot: FrameSlot) => void;
  onMove: (target: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const definition = slotDefinition(slot.kind);
  const documentHandleValue = stringValue(slot.document);
  const selectedDocument = findDocument(documents, documentHandleValue);
  const locator = readLocator(slot.locator, selectedDocument?.codec ?? "yaml");
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
          <strong>{definition.title}</strong>
          <code>{slot.kind}</code>
          <p>{definition.detail}</p>
        </div>
        <div className="world-frame-order-actions">
          <span>调整注入顺序</span>
          <button
            type="button"
            className="secondary-button"
            aria-label={`上移材料 ${ordinal}`}
            disabled={first}
            onClick={() => onMove(ordinal - 2)}
          >
            <span aria-hidden="true">↑</span> 上移
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-label={`下移材料 ${ordinal}`}
            disabled={last}
            onClick={() => onMove(ordinal)}
          >
            <span aria-hidden="true">↓</span> 下移
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!canRemove}
            aria-label={`移除材料 ${ordinal}`}
            onClick={onRemove}
          >
            移除
          </button>
        </div>
      </header>

      {slot.kind === "document" && (
        <div className="world-frame-slot-fields">
          <DocumentField
            label={`文档 ${ordinal}`}
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
            label={`文档 ${ordinal}`}
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
          <LocatorField
            label={`${locator.kind === "yaml" ? "YAML 路径" : "Markdown 标题路径"} ${ordinal}`}
            locator={locator}
            onChange={(next) => onChange({ ...slot, locator: next })}
          />
          <RequiredField slot={slot} ordinal={ordinal} onChange={onChange} />
        </div>
      )}

      {slot.kind === "reference_targets" && (
        <div className="world-frame-slot-fields">
          <DocumentField
            label={`来源 YAML 文件 ${ordinal}`}
            value={fromDocument}
            documents={documents.filter(({ codec }) => codec === "yaml")}
            emptyLabel="选择实际 YAML 文件"
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
            label={`从 YAML 哪个字段读取 $ref（插槽 ${ordinal}）`}
            manualLabel={`手动 YAML 字段路径（插槽 ${ordinal}）`}
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
            label={`最多目标数 ${ordinal}`}
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
            label={`目录 ${ordinal}`}
            value={stringValue(slot.directory)}
            directories={directories}
            onChange={(directory) => onChange({ ...slot, directory })}
          />
          <NumberField
            label={`最多目录项 ${ordinal}`}
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
            label={`带上最近几条 ${ordinal}`}
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
            历史消息句柄 {ordinal}
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
    </article>
  );
}

function DocumentField({
  label,
  value,
  documents,
  emptyLabel = "选择实际文档文件",
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
          <option value={value}>{value}（当前未解析）</option>
        )}
        {documents.map((document) => (
          <option key={document.path} value={documentHandle(document)}>
            {document.path} — {document.title} · {documentHandle(document)}
          </option>
        ))}
      </select>
      <small className="world-frame-association-note">
        {selected === undefined
          ? "只列出内容包中带可识别 $document 技术头的实际文件。"
          : `实际关联 ${selected.path}；frame.yaml 保存 @短引用：${documentHandle(selected)}`}
      </small>
    </label>
  );
}

function DirectoryField({
  label,
  value,
  directories,
  onChange,
}: {
  label: string;
  value: string;
  directories: readonly DirectoryOption[];
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
        <option value="">选择实际世界目录</option>
        {value.length > 0 && selected === undefined && (
          <option value={value}>{value}（当前没有可关联文档）</option>
        )}
        {directories.map((directory) => (
          <option key={directory.directory} value={directory.directory}>
            world/{directory.directory}/ — {directory.documentCount} 份文档
          </option>
        ))}
      </select>
      <small className="world-frame-association-note">
        {selected === undefined
          ? "只列出当前内容包内确实包含可识别文档的目录。"
          : `实际关联 world/${selected.directory}/；创建世界后对应 state/${selected.directory}/。`}
      </small>
    </label>
  );
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
  onChange: (locator: Record<string, string[]>) => void;
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
            <option value={currentKey}>先选择来源 YAML 文件</option>
          ) : (
            <>
              {!currentIsResolved && (
                <option value={currentKey}>
                  当前手动路径：{formatYamlPath(locator.path)}（未解析）
                </option>
              )}
              {options.map((option) => (
                <option
                  key={yamlLocatorKey(option.path)}
                  value={yamlLocatorKey(option.path)}
                >
                  {formatYamlPath(option.path)} —{" "}
                  {option.nodeKind === "list" ? "列表" : "对象"} ·{" "}
                  {option.referenceCount > 0
                    ? option.referenceCount + " 个 $ref"
                    : "当前无 $ref"}
                </option>
              ))}
            </>
          )}
        </select>
        <small className="world-frame-association-note">
          {document === undefined
            ? "选择 YAML 文件后，这里会解析其中可持久定位的对象和列表。"
            : document.path +
              " 已解析 " +
              options.length +
              " 个可选节点，其中 " +
              referencedNodes +
              " 个当前包含 $ref。"}
        </small>
      </label>
      <details className="world-frame-locator-advanced">
        <summary>高级：手动填写字段路径</summary>
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
  onChange: (locator: Record<string, string[]>) => void;
}): React.JSX.Element {
  return (
    <label>
      {label}
      <textarea
        rows={3}
        value={locator.path.join("\n")}
        placeholder="每行一个层级；留空表示文档根"
        onChange={(event) =>
          onChange({
            [locator.kind]: event.currentTarget.value
              .split("\n")
              .map((part) => part.trim())
              .filter(Boolean),
          })
        }
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
        aria-label={`缺失时阻止请求 ${ordinal}`}
        checked={slot.required !== false}
        onChange={(event) => {
          const next = { ...slot };
          if (event.currentTarget.checked) delete next.required;
          else next.required = false;
          onChange(next);
        }}
      />
      <span>
        <strong>缺失时阻止请求</strong>
        <small>关闭后，目标暂时不存在时会明确略过。</small>
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
        <strong>{name} 不是可视化编辑器支持的列表形状</strong>
        <span>可在高级 YAML 中修复，或明确重置为空列表后重新编排。</span>
      </div>
      <button type="button" className="secondary-button" onClick={onReset}>
        重置 {name}
      </button>
    </div>
  );
}

function readWorldFrame(source: string): ParsedFrame {
  try {
    const value: unknown = parse(source);
    if (!isRecord(value))
      return { value: null, error: "frame.yaml 顶层必须是 YAML map。" };
    return { value, error: null };
  } catch (error: unknown) {
    return {
      value: null,
      error:
        error instanceof Error
          ? `YAML 无法解析：${error.message}`
          : "YAML 无法解析。",
    };
  }
}

function frameInstructions(frame: FrameRecord): FrameInstruction[] | null {
  if (!Array.isArray(frame.instructions)) return null;
  if (
    !frame.instructions.every(
      (entry) => isRecord(entry) && typeof entry.markdown === "string",
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

function contentDocumentOptions(
  files: readonly ContentTreeFile[],
): DocumentOption[] {
  const options: DocumentOption[] = [];
  for (const file of files) {
    if (file.encoding !== undefined || !file.path.startsWith("world/"))
      continue;
    const codec = /\.md$/iu.test(file.path)
      ? "markdown"
      : /\.ya?ml$/iu.test(file.path)
        ? "yaml"
        : null;
    if (codec === null) continue;
    try {
      const source =
        codec === "markdown"
          ? markdownFrontMatter(file.contents)
          : file.contents;
      const value: unknown = parse(source);
      if (!isRecord(value) || !isRecord(value.$document)) continue;
      const id = stringValue(value.$document.id);
      const ref = stringValue(value.$document.ref);
      const title = stringValue(value.$document.title);
      if (id.length === 0 || ref.length === 0) continue;
      options.push({
        id,
        ref,
        title: title.length > 0 ? title : ref,
        path: file.path,
        codec,
        yamlLocators: codec === "yaml" ? yamlLocatorOptions(value) : [],
      });
    } catch {
      // Runtime diagnostics remain the authoritative parser result.
    }
  }
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
    const match = /^world\/(.+)\/[^/]+$/u.exec(document.path);
    if (match === null) continue;
    const directory = match[1]!;
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

function markdownFrontMatter(source: string): string {
  if (!source.startsWith("---\n")) return "";
  const end = source.indexOf("\n---\n", 4);
  return end < 0 ? "" : source.slice(4, end);
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
  return path.length === 0 ? "整份 YAML" : path.join(" › ");
}

function optionalSlotUnavailableReason(
  kind: (typeof optionalSlotKinds)[number]["kind"],
  documents: readonly DocumentOption[],
  directories: readonly DirectoryOption[],
): string | null {
  if (kind === "catalog" && directories.length === 0)
    return "先在 world/ 的子目录中创建带 $document 技术头的文档。";
  if (
    kind === "reference_targets" &&
    !documents.some(({ codec }) => codec === "yaml")
  )
    return "先创建一份带 $document 技术头的 YAML 世界文档。";
  if ((kind === "document" || kind === "node") && documents.length === 0)
    return "先创建一份带 $document 技术头的世界文档。";
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
      title: "当前情境",
      detail: "从上方绑定读取紧接着的叙事不能忘记的短期局面。",
    },
    additional_materials: {
      title: "附加材料",
      detail: "展开当前端点为全新上下文保存的完整精确材料清单。",
    },
    document: {
      title: "整份文档",
      detail: "精确加入一份世界文档。",
    },
    node: {
      title: "文档局部节点",
      detail: "精确加入 YAML 路径或 Markdown 标题子树。",
    },
    catalog: {
      title: "有界目录",
      detail: "列出一级目录中的标题、简介和短引用，不展开正文。",
    },
    reference_targets: {
      title: "显式引用目标",
      detail: "读取 YAML 节点中的 $ref，并加入一层目标文档。",
    },
    history: {
      title: "最近叙事",
      detail:
        "带上最近几条已提交玩家／主持原文；没有此前叙事时会明确标为空，调用链据此延续未写入文档的细节。",
    },
    history_message: {
      title: "精确历史消息",
      detail: "按 Runtime 句柄加入一条已提交叙事。",
    },
  };
  return (
    definitions[kind] ?? {
      title: "未知插槽",
      detail: "当前可视化编辑器不识别此类型；可移动、移除或在 YAML 中修复。",
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
