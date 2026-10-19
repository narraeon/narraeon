export interface ProtagonistTemplate {
  id: string;
  name: string;
  body: string;
  updatedAt: number;
}

export interface ProtagonistTemplatesView {
  templates: ProtagonistTemplate[];
}

export interface SaveProtagonistTemplateInput {
  id?: string;
  name: string;
  body: string;
}

export function isProtagonistTemplateId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^template-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

export function isProtagonistTemplateContent(
  name: unknown,
  body: unknown,
): boolean {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    [...name].length <= 80 &&
    !/[\r\n\u0085\u2028\u2029]/u.test(name) &&
    typeof body === "string" &&
    body.trim().length > 0 &&
    new TextEncoder().encode(body).byteLength <= 16 * 1024
  );
}
