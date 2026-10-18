import { useId, useState } from "react";

import {
  gameplayLabel,
  type Gameplay,
  type ResolutionScheme,
} from "../protocol/gameplay.ts";
import { resolutionSchemeChoices } from "./gameplayChoices.ts";
import { getWebLocale, uiText } from "./i18n.ts";

/**
 * The package's gameplay identity. The mode is shown read-only; the resolution
 * scheme of a tabletop package can be changed while authoring is idle.
 */
export function PackageGameplaySection({
  gameplay,
  disabled,
  onChangeScheme,
}: {
  gameplay: Gameplay;
  disabled: boolean;
  onChangeScheme: (scheme: ResolutionScheme) => Promise<void>;
}): React.JSX.Element {
  const id = useId();
  // The chosen scheme shows while it is saved, and reverts to the saved one if the save fails.
  const [pendingScheme, setPendingScheme] = useState<ResolutionScheme | null>(
    null,
  );
  const locked = disabled || pendingScheme !== null;

  async function change(scheme: ResolutionScheme): Promise<void> {
    if (locked || gameplay.mode !== "tabletop" || gameplay.scheme === scheme)
      return;
    setPendingScheme(scheme);
    try {
      await onChangeScheme(scheme);
    } finally {
      setPendingScheme(null);
    }
  }

  return (
    <section className="package-gameplay" aria-labelledby={`${id}-title`}>
      <header>
        <h3 id={`${id}-title`}>{uiText("玩法")}</h3>
        <strong className="package-gameplay-mode">
          {gameplayLabel(gameplay, getWebLocale())}
        </strong>
      </header>
      <p className="field-note">
        {uiText("玩法模式在创建时固定，不能在互动式小说与跑团之间切换。")}
      </p>
      {gameplay.mode === "tabletop" ? (
        <fieldset className="package-gameplay-scheme" disabled={locked}>
          <legend>{uiText("判定方案")}</legend>
          {resolutionSchemeChoices().map((choice) => (
            <div className="package-gameplay-choice" key={choice.scheme}>
              <label>
                <input
                  type="radio"
                  name={`${id}-scheme`}
                  value={choice.scheme}
                  checked={(pendingScheme ?? gameplay.scheme) === choice.scheme}
                  aria-describedby={`${id}-${choice.scheme}-description`}
                  onChange={() => void change(choice.scheme)}
                />
                <span>{choice.label}</span>
              </label>
              <p
                className="field-note"
                id={`${id}-${choice.scheme}-description`}
              >
                {choice.description}
              </p>
            </div>
          ))}
          <p className="field-note">
            {uiText(
              "已有世界保持创建时的判定方案；修改只影响之后从这份内容包新建的世界。",
            )}
          </p>
        </fieldset>
      ) : null}
    </section>
  );
}
