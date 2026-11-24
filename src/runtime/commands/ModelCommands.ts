import type { ModelConnectionStore } from "../model/ModelConnectionStore.ts";
import type { CommandFor } from "./Command.ts";

export function handleModelCommand(
  request: CommandFor<"model">,
  models: ModelConnectionStore,
): unknown {
  switch (request.type) {
    case "model.read":
      return models.view();
    case "model.save":
      return models.save(request.connection);
    case "model.copy":
      return models.copy(request.connectionId, request.name);
    case "model.select":
      return models.select(request.connectionId);
    case "model.delete":
      return models.delete(request.connectionId);
    case "model.models":
      return models.listModels(request);
  }
}
