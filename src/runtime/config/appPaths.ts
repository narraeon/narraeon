import { resolve } from "node:path";

import envPaths from "env-paths";

export interface AppPaths {
  configRoot: string;
  dataRoot: string;
  logRoot: string;
}

export function resolveAppPaths(environment: NodeJS.ProcessEnv): AppPaths {
  const defaults = envPaths("narraeon", { suffix: "" });
  const configuredDataRoot = environment.NARRAEON_DATA_ROOT?.trim();
  const configuredConfigRoot = environment.NARRAEON_CONFIG_ROOT?.trim();
  const configuredLogRoot = environment.NARRAEON_LOG_ROOT?.trim();

  return {
    configRoot:
      configuredConfigRoot !== undefined && configuredConfigRoot.length > 0
        ? resolve(configuredConfigRoot)
        : defaults.config,
    dataRoot:
      configuredDataRoot !== undefined && configuredDataRoot.length > 0
        ? resolve(configuredDataRoot)
        : defaults.data,
    logRoot:
      configuredLogRoot !== undefined && configuredLogRoot.length > 0
        ? resolve(configuredLogRoot)
        : defaults.log,
  };
}
