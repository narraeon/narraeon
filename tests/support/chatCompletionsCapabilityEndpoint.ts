import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedChatCompletionsRequest {
  authorization: string | undefined;
  body: unknown;
  url: string;
}

export interface ChatCompletionsCapabilityEndpoint {
  origin: string;
  requests: CapturedChatCompletionsRequest[];
  close(): Promise<void>;
}

export async function startChatCompletionsCapabilityEndpoint(): Promise<ChatCompletionsCapabilityEndpoint> {
  const requests: CapturedChatCompletionsRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        authorization: request.headers.authorization,
        body,
        url: request.url ?? "",
      });

      if (isOptionalProbe(body)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "optional enhancement unavailable" },
          }),
        );
        return;
      }

      const call = hasToolResult(body)
        ? {
            id: "probe-finish",
            name: "finish_turn",
            arguments: { probe: "ok" },
          }
        : {
            id: "probe-echo",
            name: "probe_echo",
            arguments: { probe: "narraeon-capability-probe" },
          };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `response-${call.id}`,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: call.id,
                    type: "function",
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.arguments),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => close(server),
  };
}

function hasToolResult(body: unknown): boolean {
  return (
    isRecord(body) &&
    Array.isArray(body.messages) &&
    body.messages.some(
      (message) => isRecord(message) && message.role === "tool",
    )
  );
}

function isOptionalProbe(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (
    body.response_format !== undefined ||
    body.stream === true ||
    body.parallel_tool_calls === true
  ) {
    return true;
  }
  return (
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool) =>
        isRecord(tool) &&
        isRecord(tool.function) &&
        tool.function.strict === true,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
