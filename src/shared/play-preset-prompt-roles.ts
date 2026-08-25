export const playPresetPromptRoles = ["author_instruction"] as const;

export type PlayPresetPromptRole = (typeof playPresetPromptRoles)[number];

export function isPlayPresetPromptRole(
  value: unknown,
): value is PlayPresetPromptRole {
  return playPresetPromptRoles.some((role) => role === value);
}
