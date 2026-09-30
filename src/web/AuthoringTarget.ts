import type {
  ContentTreeFile,
  V1Request,
  V1SettingImprovementOverview,
  V1SettingImprovementView,
  V1SettingImprovementRollbackResult,
  V1SettingPromptPreview,
  V1WorldRevisionOverview,
  V1WorldRevisionView,
} from "../protocol/v1.ts";
import { createClientId } from "./ClientId.ts";
import { uiText } from "./i18n.ts";

export interface AuthoringClient {
  request(request: V1Request): Promise<unknown>;
}
export interface AuthoringPackageDetail {
  localId: string;
  title: string;
  status: "usable" | "needs_repair";
  files: ContentTreeFile[];
  issues: { code: string; path: string; message: string }[];
}
export interface AuthoringTargetSnapshot extends V1SettingImprovementOverview {
  files: ContentTreeFile[];
  packageDetail?: AuthoringPackageDetail;
  revision?: V1WorldRevisionOverview;
}
export interface AuthoringTargetMessages {
  opened: string;
  locked: string;
  deleted: string;
  saved: string;
  reset: string | null;
  rolledBack: string;
  alreadyRolledBack: string;
  rollbackReadFailure: string;
}
const contentPackageMessages: AuthoringTargetMessages = {
  opened: "",
  locked: "",
  deleted: "对话历史已删除；内容包当前树没有回滚。",
  saved: "内容包当前树已整批保存。",
  reset: "已放弃未保存修改；内容包当前树未改变。",
  rolledBack: "已回滚这个文件；对话历史仍然保留。",
  alreadyRolledBack: "当前文件已是修改前版本。",
  rollbackReadFailure:
    "Runtime 已确认回滚结果，但重新读取内容包失败：{message}",
};
const worldRevisionMessages: AuthoringTargetMessages = {
  opened: "浏览不会锁定世界；首次编辑或发送消息后才会锁定。",
  locked: "世界已锁定到这份修订；关闭页面也会保留工作树。",
  deleted: "对话历史已删除；修订工作树中的改动没有回滚。",
  saved: "手动修改已保存到修订工作树，可以继续编辑或回滚。",
  reset: null,
  rolledBack: "已回滚所选文件；其他修订保持不变。",
  alreadyRolledBack: "这个文件已经是该次修改前的版本。",
  rollbackReadFailure:
    "Runtime 已确认回滚结果，但重新读取修订工作树失败：{message}",
};
export interface AuthoringTarget {
  messages: AuthoringTargetMessages;
  kind: "setting" | "revision";
  id: string;
  read(): Promise<AuthoringTargetSnapshot>;
  readSession(sessionId: string): Promise<V1SettingImprovementView>;
  send(
    message: string,
    sessionId: string | null,
  ): Promise<V1SettingImprovementView>;
  cancel(sessionId: string): Promise<V1SettingImprovementView>;
  deleteSession(sessionId: string): Promise<AuthoringTargetSnapshot>;
  beginEdit(
    snapshot: AuthoringTargetSnapshot,
  ): Promise<AuthoringTargetSnapshot> | null;
  save(
    files: ContentTreeFile[],
    baseline: ContentTreeFile[],
    snapshot: AuthoringTargetSnapshot,
  ): Promise<AuthoringTargetSnapshot>;
  rollback(
    sessionId: string,
    changeSetId: string,
    path: string,
    snapshot: AuthoringTargetSnapshot,
  ): Promise<V1SettingImprovementRollbackResult>;
  preview(
    sessionId: string | null,
  ): Promise<V1SettingPromptPreview["compilation"]>;
  finish?(
    action: "apply" | "discard",
    snapshot: AuthoringTargetSnapshot,
  ): Promise<void>;
}

async function request<T>(
  client: AuthoringClient,
  input: V1Request,
): Promise<T> {
  return (await client.request(input)) as T;
}
export function sameAuthoringFiles(
  left: readonly ContentTreeFile[],
  right: readonly ContentTreeFile[],
): boolean {
  const byPath = new Map(right.map((file) => [file.path, file]));
  return (
    left.length === right.length &&
    left.every((file) => {
      const other = byPath.get(file.path);
      return (
        other?.contents === file.contents && other?.encoding === file.encoding
      );
    })
  );
}

export function contentPackageTarget(
  client: AuthoringClient,
  id: string,
): AuthoringTarget {
  const read = async (): Promise<AuthoringTargetSnapshot> => {
    const [overview, detail] = await Promise.all([
      request<V1SettingImprovementOverview>(client, {
        type: "setting-improvement.overview",
        packageId: id,
      }),
      request<AuthoringPackageDetail>(client, {
        type: "content.read",
        packageId: id,
      }),
    ]);
    return { ...overview, files: detail.files, packageDetail: detail };
  };
  return {
    kind: "setting",
    messages: contentPackageMessages,
    id,
    read,
    readSession: (sessionId) =>
      request(client, {
        type: "setting-improvement.session.read",
        packageId: id,
        sessionId,
      }),
    send: (message, sessionId) =>
      request(client, {
        type: "setting-improvement.message",
        packageId: id,
        message,
        requestId: createClientId("setting-message"),
        continuation: continuation(sessionId),
      }),
    cancel: (sessionId) =>
      request(client, { type: "setting-improvement.cancel", sessionId }),
    deleteSession: async (sessionId) => {
      const overview = await request<V1SettingImprovementOverview>(client, {
        type: "setting-improvement.session.delete",
        packageId: id,
        sessionId,
      });
      const detail = await request<AuthoringPackageDetail>(client, {
        type: "content.read",
        packageId: id,
      });
      return { ...overview, files: detail.files, packageDetail: detail };
    },
    beginEdit: () => null,
    save: async (files, _baseline, snapshot) => {
      const detail = await request<AuthoringPackageDetail>(client, {
        type: "content.replace",
        packageId: id,
        files,
      });
      return { ...snapshot, files: detail.files, packageDetail: detail };
    },
    rollback: (sessionId, changeSetId, path) =>
      request(client, {
        type: "setting-improvement.rollback",
        packageId: id,
        sessionId,
        changeSetId,
        path,
      }),
    preview: (sessionId) =>
      request(client, {
        type: "setting-improvement.preview",
        packageId: id,
        ...(sessionId === null ? {} : { sessionId }),
      }),
  };
}

export function worldRevisionTarget(
  client: AuthoringClient,
  id: string,
): AuthoringTarget {
  const normalizeView = (
    view: V1WorldRevisionView,
  ): V1SettingImprovementView => ({
    ...view,
    packageId: id,
    legacyDraft: null,
  });
  const snapshot = async (
    overview: V1WorldRevisionOverview,
  ): Promise<AuthoringTargetSnapshot> => {
    let files = overview.epoch?.locked ? overview.epoch.files : null;
    if (files === null) {
      const [state, control] = await Promise.all([
        request<ContentTreeFile[]>(client, {
          type: "world.surface.read",
          worldId: id,
          surface: "state",
        }),
        request<ContentTreeFile[]>(client, {
          type: "world.surface.read",
          worldId: id,
          surface: "control",
        }),
      ]);
      files = [
        ...state.map((file) => ({ ...file, path: `state/${file.path}` })),
        ...control.map((file) => ({ ...file, path: `control/${file.path}` })),
      ];
    }
    return {
      files,
      latest: overview.latest === null ? null : normalizeView(overview.latest),
      history: overview.history,
      revision: overview,
    };
  };
  const activeEpoch = (current: AuthoringTargetSnapshot) => {
    const epoch = current.revision?.epoch;
    if (!epoch?.locked)
      throw new Error("The world-revision epoch is no longer active");
    return epoch;
  };
  return {
    kind: "revision",
    messages: worldRevisionMessages,
    id,
    read: async () =>
      snapshot(
        await request(client, { type: "world.revision.overview", worldId: id }),
      ),
    readSession: async (sessionId) =>
      normalizeView(
        await request(client, {
          type: "world.revision.session.read",
          worldId: id,
          sessionId,
        }),
      ),
    send: async (message, sessionId) =>
      normalizeView(
        await request(client, {
          type: "world.revision.message",
          worldId: id,
          message,
          requestId: createClientId("world-revision-message"),
          continuation: continuation(sessionId),
        }),
      ),
    cancel: async (sessionId) =>
      normalizeView(
        await request(client, { type: "world.revision.cancel", sessionId }),
      ),
    deleteSession: async (sessionId) =>
      snapshot(
        await request(client, {
          type: "world.revision.session.delete",
          worldId: id,
          sessionId,
        }),
      ),
    beginEdit: (current) =>
      current.revision?.epoch?.locked
        ? null
        : request<V1WorldRevisionOverview>(client, {
            type: "world.revision.open",
            worldId: id,
          }).then(snapshot),
    save: async (files, baseline, current) => {
      const epoch = activeEpoch(current);
      if (!sameAuthoringFiles(baseline, epoch.files))
        throw new Error(
          uiText("世界已在浏览期间发生变化；请重置草稿并重新编辑。"),
        );
      return snapshot(
        await request(client, {
          type: "world.revision.files.replace",
          worldId: id,
          epochId: epoch.epochId,
          expectedRevision: epoch.revision,
          files,
        }),
      );
    },
    rollback: (_sessionId, changeSetId, path, current) =>
      request(client, {
        type: "world.revision.rollback",
        worldId: id,
        epochId: activeEpoch(current).epochId,
        changeSetId,
        path,
      }),
    preview: (sessionId) =>
      request(client, {
        type: "world.revision.preview",
        worldId: id,
        ...(sessionId === null ? {} : { sessionId }),
      }),
    finish: async (action, current) => {
      const epoch = activeEpoch(current);
      await client.request(
        action === "apply"
          ? {
              type: "world.revision.apply",
              worldId: id,
              epochId: epoch.epochId,
              expectedRevision: epoch.revision,
            }
          : {
              type: "world.revision.discard",
              worldId: id,
              epochId: epoch.epochId,
            },
      );
    },
  };
}
function continuation(sessionId: string | null) {
  return sessionId === null
    ? { kind: "fresh_context" as const }
    : { kind: "continue_context" as const, sessionId };
}
