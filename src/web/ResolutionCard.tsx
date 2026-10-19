import type { ResolutionReceipt } from "../protocol/resolution.ts";
import { uiText } from "./i18n.ts";
import { presentResolution } from "./resolutionPresentation.ts";

export function ResolutionCard({
  receipt,
}: {
  receipt: ResolutionReceipt;
}): React.JSX.Element {
  const presentation = presentResolution(receipt);
  return (
    <article
      className={`resolution-card is-${presentation.tone}`}
      aria-label={uiText("判定结果")}
    >
      <details>
        <summary>
          <span className="resolution-headline">
            {presentation.summary}
            {presentation.outcome === null ? null : (
              <>
                {" · "}
                <strong className="resolution-outcome">
                  {presentation.outcome}
                </strong>
              </>
            )}
          </span>
        </summary>
        <dl className="resolution-facts">
          {presentation.facts.map((fact, index) => (
            <div key={`${index}:${fact.label}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {presentation.tokens === null ? null : (
          <table className="resolution-tokens">
            <caption>{uiText("本次使用的混乱袋")}</caption>
            <thead>
              <tr>
                <th scope="col">{uiText("标记")}</th>
                <th scope="col">{uiText("数量")}</th>
                <th scope="col">{uiText("效果")}</th>
              </tr>
            </thead>
            <tbody>
              {presentation.tokens.map((token, index) => (
                <tr key={`${index}:${token.label}`}>
                  <td>{token.label}</td>
                  <td>{token.count}</td>
                  <td>{token.effect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>
    </article>
  );
}
