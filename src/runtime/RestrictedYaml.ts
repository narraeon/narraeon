import { isAlias, isScalar, parseDocument, visit } from "yaml";

interface YamlProblem {
  pos: [number, number];
  message: string;
  detail?: string;
}

export function parseRestrictedYamlDocument(
  source: string,
  options: { rejectRawControlCharacters: boolean },
):
  | { document: ReturnType<typeof parseDocument>; problems?: never }
  | {
      document?: never;
      problems: YamlProblem[];
    } {
  if (options.rejectRawControlCharacters) {
    const offset = source.search(/[\0\r]/u);
    if (offset >= 0)
      return {
        problems: [
          {
            pos: [offset, offset + 1],
            message: "YAML contains a NUL or carriage return",
          },
        ],
      };
  }
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  const problems: YamlProblem[] = [
    ...document.errors,
    ...document.warnings,
  ].map(({ pos, message }) => ({
    pos,
    message: "YAML is not a safe single-document YAML 1.2 core map",
    detail: message,
  }));
  if (problems.length > 0) return { problems };

  visit(document, {
    Node(key, node) {
      let message: string;
      if (isAlias(node)) message = "YAML aliases are not supported";
      else if (node.anchor !== undefined)
        message = "YAML anchors are not supported";
      else if (node.tag !== undefined)
        message = "Explicit YAML tags are not supported";
      else if (key === "key" && isScalar(node) && node.value === "<<")
        message = "YAML merge keys are not supported";
      else return;
      problems.push({
        pos: [node.range![0], node.range![1]],
        message,
      });
      return visit.BREAK;
    },
  });
  if (problems.length > 0) return { problems };
  return { document };
}
