import { useEffect, useState } from "react";
import type { V1Request } from "../protocol/v1.ts";
import { uiText } from "./i18n.ts";

export function PackageScriptPermissionControl({
  client,
  kind,
  id,
  dirty = false,
  onChange,
}: {
  client: { request(request: V1Request): Promise<unknown> };
  kind: "content" | "world";
  id: string;
  dirty?: boolean;
  onChange?: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .request(
        kind === "content"
          ? { type: "content.scripts.read", packageId: id }
          : { type: "world.package-scripts.read", worldId: id },
      )
      .then((result) => {
        if (active) setStatus(permissionStatus(result));
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [client, kind, id, dirty]);
  async function change(enabled: boolean): Promise<void> {
    setPending(true);
    setError("");
    try {
      const result = await client.request(
        kind === "content"
          ? { type: "content.scripts.set", packageId: id, enabled }
          : { type: "world.package-scripts.set", worldId: id, enabled },
      );
      setStatus(permissionStatus(result));
      onChange?.();
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="package-script-permission">
      <h4 className="visually-hidden">{uiText("内容包脚本权限")}</h4>
      <p>
        {uiText(
          "仅授权此处已保存的资源代码。导入不会授权，资源修改后需要重新授权；关闭立即停止此来源脚本，HTML 和样式仍可显示。",
        )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={status?.enabled ?? false}
          disabled={dirty || pending || status === null}
          onChange={(event) => void change(event.target.checked)}
        />
        {uiText("允许运行内容包脚本")}
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={pending}
        onClick={() => void change(false)}
      >
        {uiText("撤销全部包脚本授权")}
      </button>
      {dirty ? <p>{uiText("请先保存修改，再授权资源代码。")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
function permissionStatus(value: unknown): { enabled: boolean } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("Invalid package permission response");
  return { enabled: value.enabled };
}
