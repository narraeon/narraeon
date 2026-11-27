import type { GenerationActivity } from "../runtime/GenerationActivity.ts";
import { V1Runtime } from "../runtime/V1Runtime.ts";

export async function createRuntime(
  input: Pick<
    ConstructorParameters<typeof V1Runtime>[0],
    "dataRoot" | "configRoot" | "logRoot" | "chatGptAuth"
  >,
  generationActivity?: GenerationActivity,
): Promise<V1Runtime> {
  const runtime = new V1Runtime({
    ...input,
    ...(generationActivity === undefined ? {} : { generationActivity }),
  });
  await runtime.initialize();
  return runtime;
}
