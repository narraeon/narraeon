import type { V1Request } from "../../protocol/v1.ts";

export type CommandFor<Prefix extends string> = Extract<
  V1Request,
  { type: `${Prefix}.${string}` }
>;

export function hasCommandPrefix<Prefix extends string>(
  request: V1Request,
  prefix: Prefix,
): request is CommandFor<Prefix> {
  return request.type.startsWith(`${prefix}.`);
}
