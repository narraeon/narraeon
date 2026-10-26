import type { PromptCompilation } from "./FileNativePromptCompiler.ts";

/** Body scopes and catalog summaries are independent kinds of exposure. */
export function worldMaterialCoverage(coverage: PromptCompilation["coverage"]) {
  const fullInjected = new Set<string>();
  const nodeInjected = new Set<string>();
  const catalogSummary = new Set<string>();
  const injectedSelections = coverage.flatMap((entry) => {
    for (const ref of entry.catalogEntries ?? []) catalogSummary.add(ref);
    const scope = entry.readAuthorization;
    if (scope === undefined) return [];
    (scope.locator === null ? fullInjected : nodeInjected).add(scope.shortRef);
    return [scope];
  });
  return { fullInjected, nodeInjected, catalogSummary, injectedSelections };
}
