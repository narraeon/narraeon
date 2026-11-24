import type { GenerationActivity } from "../runtime/GenerationActivity.ts";
import { V1Runtime } from "../runtime/V1Runtime.ts";

export async function createRuntime(
  input: { dataRoot: string; configRoot: string; logRoot: string },
  generationActivity?: GenerationActivity,
): Promise<V1Runtime> {
  const runtime = new V1Runtime({
    ...input,
    ...(generationActivity === undefined ? {} : { generationActivity }),
  });
  await runtime.initialize();
  return runtime;
}
