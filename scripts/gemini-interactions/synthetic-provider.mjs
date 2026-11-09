// Offline test double; these responses are invented, not provider evidence.
const thought = {
  type: "thought",
  signature: "SYNTHETIC-NOT-A-VALID-SIGNATURE",
  summary: [],
  future_field: { nested: [1, "unknown", { keep: true }] },
};
const steps = [
  [
    thought,
    {
      type: "function_call",
      id: "test-call",
      name: "read_document",
      arguments: { ref: "@scene" },
    },
  ],
  [{ type: "model_output", content: [{ type: "text", text: "blue" }] }],
  [{ type: "model_output", content: [{ type: "text", text: "blue" }] }],
  [{ type: "model_output", content: [{ type: "text", text: "amber" }] }],
  [{ type: "model_output", content: [{ type: "text", text: "PINE" }] }],
];
let index = 0;
let progress = 0;
globalThis.fetch = async () => {
  const mode = process.env.SYNTHETIC_CONTINUATION;
  if (mode && index === 0) {
    progress++;
    if (mode === "transport" && progress === 2)
      throw new Error("synthetic disconnect");
    if (mode !== "complete" || progress <= 2)
      return Response.json({
        status: "requires_continuation",
        ...(mode === "missing"
          ? {}
          : {
              continuation_token:
                mode === "repeat"
                  ? "synthetic-token"
                  : `synthetic-token-${progress}`,
            }),
        ...(progress === 1 ? {} : { steps: [{ ...thought, hop: progress }] }),
        usage: { total_tokens: progress },
      });
  }
  const current = index++;
  if (process.env.SYNTHETIC_UNSAFE_NUMBER) {
    return new Response(
      '{"status":"requires_action","steps":[{"type":"thought","future_number":9007199254740993}]}',
    );
  }
  if (!steps[current]) throw new Error("unexpected synthetic request");
  return new Response(
    JSON.stringify({
      status: current === 0 ? "requires_action" : "completed",
      steps: steps[current],
      usage: { total_tokens: 12 },
    }),
  );
};
