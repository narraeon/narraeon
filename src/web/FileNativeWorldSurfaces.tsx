export interface FileNativeSurfaceFile {
  path: string;
  contents: string;
}

export interface FileNativeRuntimeDiagnostics {
  operationId: string;
  parentEndpoint: "genesis";
  historyEntries: number;
}

export function FileNativeWorldSurfaces({
  state,
  control,
  history,
  runtime,
}: {
  state: readonly FileNativeSurfaceFile[];
  control: readonly FileNativeSurfaceFile[];
  history: readonly FileNativeSurfaceFile[];
  runtime: FileNativeRuntimeDiagnostics;
}): React.JSX.Element {
  return (
    <main>
      <h1>世界文件</h1>
      <Surface title="当前 state 文档" files={state} />
      <Surface title="control" files={control} />
      <Surface title="history" files={history} empty="尚无已提交叙事" />
      <section aria-labelledby="runtime-surface">
        <h2 id="runtime-surface">Runtime 诊断</h2>
        <dl>
          <dt>父端点</dt>
          <dd>{runtime.parentEndpoint}</dd>
          <dt>创建 operation</dt>
          <dd>{runtime.operationId}</dd>
          <dt>历史条目</dt>
          <dd>{runtime.historyEntries}</dd>
        </dl>
      </section>
    </main>
  );
}

function Surface({
  title,
  files,
  empty = "没有文件",
}: {
  title: string;
  files: readonly FileNativeSurfaceFile[];
  empty?: string;
}): React.JSX.Element {
  const id = `surface-${title.replace(/\s+/gu, "-")}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {files.length === 0 ? (
        <p>{empty}</p>
      ) : (
        files.map((file) => (
          <details key={file.path}>
            <summary>{file.path}</summary>
            <pre>{file.contents}</pre>
          </details>
        ))
      )}
    </section>
  );
}
