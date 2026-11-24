import { WorldDocumentIndex } from "./documents/WorldDocumentIndex.ts";
import { WorldDocumentRevision } from "./documents/WorldDocumentRevision.ts";
import type {
  WorldDocumentDiagnostic,
  WorldDocumentFile,
  WorldDocumentLayout,
  WorldDocumentQuery,
  WorldDocumentQueryResult,
  WorldDocumentRevisionRequest,
  WorldDocumentRevisionResult,
  WorldDocumentSnapshotStatus,
} from "./documents/WorldDocumentTypes.ts";

export type * from "./documents/WorldDocumentTypes.ts";
export { formatWorldDocumentLocator } from "./documents/WorldDocumentSource.ts";

export class WorldDocumentStore {
  static open(input: {
    readonly layout: WorldDocumentLayout;
    readonly files: readonly WorldDocumentFile[];
  }): WorldDocumentStore {
    return new WorldDocumentStore(
      new WorldDocumentIndex(input.layout, input.files),
    );
  }

  readonly id: string;
  readonly layout: WorldDocumentLayout;
  readonly logicalRoot: "world" | "state";
  readonly files: readonly WorldDocumentFile[];
  readonly diagnostics: readonly WorldDocumentDiagnostic[];
  readonly status: WorldDocumentSnapshotStatus;
  readonly #index: WorldDocumentIndex;

  private constructor(index: WorldDocumentIndex) {
    this.#index = index;
    this.id = index.id;
    this.layout = index.layout;
    this.logicalRoot = index.logicalRoot;
    this.files = index.files;
    this.diagnostics = index.diagnostics;
    this.status = index.status;
    Object.freeze(this);
  }

  revise(request: WorldDocumentRevisionRequest): WorldDocumentRevisionResult {
    return new WorldDocumentRevision(
      this.#index,
      (index) => new WorldDocumentStore(index),
    ).revise(request);
  }

  query(request: WorldDocumentQuery): WorldDocumentQueryResult {
    return this.#index.query(request);
  }
}
