import { V1Runtime } from "../runtime/V1Runtime.ts";

export async function createRuntime(input: {
  dataRoot: string;
  configRoot: string;
  logRoot: string;
}): Promise<V1Runtime> {
  const runtime = new V1Runtime(input);
  await runtime.initialize();
  return runtime;
}
