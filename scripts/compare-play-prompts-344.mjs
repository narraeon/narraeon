import { comparePlayPrompts } from "./lib/compare-play-prompts.mjs";
import {
  packageFiles,
  scenes,
} from "./fixtures/prompt-comparison-344-scenes.mjs";

await comparePlayPrompts({
  issue: 344,
  scenes,
  packageFiles,
  stylePath: new URL(
    "./fixtures/prompt-comparison-344-style.md",
    import.meta.url,
  ),
  minRepeats: 2,
  removedTailLines: [
    "play.person-second",
    "play.ending",
    "play.facts",
    "play.stop-beat",
    "play.output",
  ],
});
