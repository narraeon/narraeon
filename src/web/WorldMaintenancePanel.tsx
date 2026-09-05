import type { WorldPromptMaintenance } from "../protocol/worldMaintenance.ts";
import { worldWritePositionText } from "../protocol/worldMaintenance.ts";
import { getWebLocale } from "./i18n.ts";

export function WorldMaintenancePanel({
  report,
}: {
  report: WorldPromptMaintenance | undefined;
}): React.JSX.Element | null {
  if (report === undefined) return null;
  const locale = getWebLocale();
  const zh = locale === "zh-CN";
  return (
    <section className="panel-card prompt-preview-detail">
      {report.unavailableReason !== undefined && (
        <p role="status">
          {zh
            ? "历史维护诊断暂时不可用"
            : "Historical maintenance diagnostics unavailable"}
          : {report.unavailableReason}
        </p>
      )}
      <h3>{zh ? "文档体积与维护" : "Document size and maintenance"}</h3>
      <p>
        {zh
          ? "单位为 UTF-8 字节。建议上限只用于整理提示；不会阻止写入或截断历史。注入贡献按实际选取统计，包含选取的标题和标记，不是 token 用量。"
          : "Values are UTF-8 bytes. Advisory limits never block writes or truncate history. Injection contributions include selected headings and annotations; these are not token usage."}
      </p>
      <dl className="prompt-diagnostic-grid">
        {[
          [zh ? "世界材料" : "World materials", report.worldMaterialsBytes],
          [
            zh ? "其中检查点历史" : "Checkpoint history subset",
            report.checkpointHistoryBytes,
          ],
          [
            zh ? "作者提示" : "Author instructions",
            report.authorInstructionBytes,
          ],
          [
            zh ? "Runtime 提示" : "Runtime instructions",
            report.runtimeInstructionBytes,
          ],
          [
            zh ? "工具定义（逻辑 JSON）" : "Tool definitions (logical JSON)",
            report.toolDefinitionBytes,
          ],
        ].map(([title, value]) => (
          <div key={title}>
            <dt>{title}</dt>
            <dd>{value?.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {Math.max(
        0,
        ...report.documents.map((document) => document.observedContexts ?? 0),
      ) === 0 && (
        <p>
          {zh
            ? "尚无带上下文标记的历史样本；旧提交不会被猜测归入某个上下文。"
            : "No history samples with recorded context identities yet; legacy commits are not assigned guessed contexts."}
        </p>
      )}
      <div className="maintenance-table-scroll">
        <table>
          <thead>
            <tr>
              {(zh
                ? [
                    "文档",
                    "正文",
                    "注入贡献",
                    "建议上限",
                    "增长基准",
                    "相对基准变化",
                    "正文 / 元信息变更上下文数",
                  ]
                : [
                    "Document",
                    "Body",
                    "Injection contribution",
                    "Advisory limit",
                    "Growth baseline",
                    "Change from baseline",
                    "Contexts with body / metadata changes",
                  ]
              ).map((title) => (
                <th key={title}>{title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.documents.map((document) => (
              <tr key={document.shortRef}>
                <th scope="row">
                  {document.title}
                  <small> @{document.shortRef}</small>
                </th>
                <td>{document.bodyBytes.toLocaleString()}</td>
                <td>{document.injectedBytes.toLocaleString()}</td>
                <td>
                  {document.advisoryBytes?.toLocaleString() ?? "—"}
                  {document.overAdvisory
                    ? zh
                      ? " · 超出建议"
                      : " · Over advisory"
                    : ""}
                </td>
                <td>
                  {document.baselineKind === "unavailable"
                    ? zh
                      ? "无世界基准"
                      : "No world baseline"
                    : `${document.baselineKind === "world_origin" ? (zh ? "世界创建" : "World creation") : zh ? "创建后新增" : "Added later"}: ${document.baselineBytes}`}
                </td>
                <td>
                  {document.growthBytes === null
                    ? "—"
                    : `${document.growthBytes >= 0 ? "+" : ""}${document.growthBytes}`}
                  {document.growthRatio === null
                    ? ""
                    : ` (${document.growthRatio.toFixed(2)}×)`}
                </td>
                <td>
                  {document.bodyChangedContexts} /{" "}
                  {document.metadataChangedContexts}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.slots.length > 0 && (
        <ul>
          {report.slots.map((slot) => (
            <li key={slot.id}>
              {zh ? "材料槽" : "Slot"} {slot.id}: {slot.bytes.toLocaleString()}{" "}
              / {slot.advisoryBytes?.toLocaleString() ?? "—"}
              {slot.overAdvisory
                ? zh
                  ? " · 超出建议"
                  : " · Over advisory"
                : ""}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>
          {zh
            ? "最近已提交的正文和元信息写入"
            : "Last committed body and metadata writes"}
        </summary>
        {report.documents.map((document) => (
          <div key={document.shortRef}>
            <h4>
              {document.title} · @{document.shortRef}
            </h4>
            <p>
              {zh ? "正文" : "Body"}:{" "}
              {worldWritePositionText(document.lastBodyWrite, locale)}
            </p>
            <p>
              {zh ? "元信息" : "Metadata"}:{" "}
              {worldWritePositionText(document.lastMetadataWrite, locale)}
            </p>
          </div>
        ))}
      </details>
    </section>
  );
}
