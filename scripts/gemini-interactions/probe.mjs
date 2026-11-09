// Research probe for #132. This is not a production provider adapter.
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const endpoint =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const model = process.env.GEMINI_PROBE_MODEL || "gemini-3.8-flash";
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey?.trim()) {
  console.error(
    "GEMINI_API_KEY or GOOGLE_API_KEY is required; no request was sent.",
  );
  process.exit(1);
}

// Resolve symlinks before ruling out a temporary directory inside the worktree.
const worktree = await realpath(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
);
const tempRoot = await realpath(tmpdir());
const fromWorktree = relative(worktree, tempRoot);
if (
  fromWorktree === "" ||
  (fromWorktree !== ".." &&
    !fromWorktree.startsWith(`..${sep}`) &&
    !isAbsolute(fromWorktree))
) {
  console.error(
    "Temporary directory is inside the worktree; no request was sent.",
  );
  process.exit(1);
}
const archive = await mkdtemp(join(tempRoot, "narraeon-gemini-132-"));
console.log(`Private evidence directory: ${archive}`);
const text = (value) => [{ type: "text", text: value }];
const user = (value) => ({ type: "user_input", content: text(value) });
const tool = {
  type: "function",
  name: "read_document",
  description: "Read the supplied test document by reference.",
  parameters: {
    type: "object",
    properties: { ref: { type: "string" } },
    required: ["ref"],
  },
};
const config = { thinking_level: "low", thinking_summaries: "none" };
let sequence = 0;
async function request(label, input, options = {}) {
  const body = {
    model,
    store: false,
    system_instruction:
      "You are a protocol test assistant. Follow the supplied instructions.",
    tools: [tool],
    generation_config: config,
    input,
    ...options,
  };
  const seenTokens = new Set();
  const steps = [];
  let hopBody = body;
  for (let hop = 1; ; hop++) {
    const interaction = await requestHop(label, hopBody);
    steps.push(...interaction.steps);
    if (interaction.status !== "requires_continuation")
      return { ...interaction, steps };

    const token = interaction.continuation_token;
    if (typeof token !== "string" || !token)
      throw new Error(`${label}: missing or invalid continuation token`);
    if (seenTokens.has(token))
      throw new Error(`${label}: repeated continuation token`);
    if (hop >= 16) throw new Error(`${label}: exceeded 16-hop limit`);
    seenTokens.add(token);
    hopBody = { ...body, continuation_token: token };
  }
}

async function requestHop(label, body) {
  const prefix = `${String(++sequence).padStart(2, "0")}-${label}`;
  // Headers are deliberately excluded. Raw bodies may still contain sensitive provider data.
  await writeFile(
    join(archive, `${prefix}-request.json`),
    JSON.stringify(body, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  let response;
  let raw;
  const meta = {
    timestamp: new Date().toISOString(),
    endpoint,
    model,
    apiRevision: "omitted",
  };
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    raw = await response.text();
  } catch {
    await writeFile(
      join(archive, `${prefix}-meta.json`),
      JSON.stringify(
        {
          ...meta,
          httpStatus: response?.status ?? null,
          outcome: "transport_failure",
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    throw new Error(
      `${label}: transport failed or timed out; outcome unknown, do not replay automatically`,
    );
  }
  await writeFile(join(archive, `${prefix}-response.json`), raw, {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(
    join(archive, `${prefix}-meta.json`),
    JSON.stringify(
      {
        ...meta,
        httpStatus: response.status,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  if (!response.ok)
    throw new Error(
      `${label}: HTTP ${response.status}; inspect private evidence`,
    );
  let interaction;
  try {
    interaction = JSON.parse(raw, (_key, value, context) => {
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          JSON.stringify(value) !== context.source)
      ) {
        throw new Error("number cannot be faithfully replayed");
      }
      return value;
    });
  } catch {
    throw new Error(
      `${label}: invalid JSON or non-roundtrippable number; inspect private evidence`,
    );
  }
  if (
    interaction?.status === "requires_continuation" &&
    interaction.steps === undefined
  )
    interaction.steps = [];
  if (!Array.isArray(interaction?.steps))
    throw new Error(`${label}: missing steps; inspect private evidence`);
  const statuses = [
    "requires_action",
    "completed",
    "failed",
    "cancelled",
    "incomplete",
    "requires_continuation",
    "in_progress",
  ];
  const status = statuses.includes(interaction.status)
    ? interaction.status
    : "unknown";
  console.log(
    `${label}: HTTP ${response.status}, status=${status}, steps=${interaction.steps.length}`,
  );
  return interaction;
}
function expectStatus(response, expected, label) {
  if (response.status !== expected)
    throw new Error(`${label}: expected ${expected}; inspect private evidence`);
}
function finalText(response, label) {
  expectStatus(response, "completed", label);
  if (response.steps.some((step) => step.type === "function_call"))
    throw new Error(`${label}: unexpected function call`);
  const result = response.steps
    .flatMap((step) =>
      step.type === "model_output" && Array.isArray(step.content)
        ? step.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
        : [],
    )
    .join("");
  if (!result.trim()) throw new Error(`${label}: no final text`);
  return result;
}

try {
  const initial = user(
    "Call read_document with ref @scene before answering. Then state its color.",
  );
  const first = await request("tool-call", [initial], {
    generation_config: { ...config, tool_choice: "any" },
  });
  expectStatus(first, "requires_action", "tool-call");
  const calls = first.steps.filter((step) => step.type === "function_call");
  if (
    calls.length !== 1 ||
    calls[0].name !== "read_document" ||
    calls[0].arguments?.ref !== "@scene" ||
    typeof calls[0].id !== "string"
  )
    throw new Error("tool-call: unexpected calls; inspect private evidence");
  const result = {
    type: "function_result",
    name: "read_document",
    call_id: calls[0].id,
    result: text('{"ref":"@scene","body":"The lantern is blue."}'),
  };
  // Append the entire provider steps unchanged, including unknown properties.
  const history = [initial, ...first.steps, result];
  const second = await request("tool-result", history);
  const answer = finalText(second, "tool-result");
  if (!/blue/i.test(answer))
    throw new Error(
      "tool-result: answer did not contain expected color; inspect private evidence",
    );
  const third = await request("next-turn", [
    ...history,
    ...second.steps,
    user("What color was the lantern? Answer in one word."),
  ]);
  if (!/blue/i.test(finalText(third, "next-turn")))
    throw new Error("next-turn: answer did not contain expected color");

  // Synthetic Runtime-origin bootstrap: no model signature or provider output is invented.
  const bootstrap = [
    {
      type: "function_call",
      id: "runtime_bootstrap_1",
      name: "runtime_load_context",
      arguments: { ref: "@scene" },
    },
    {
      type: "function_result",
      call_id: "runtime_bootstrap_1",
      name: "runtime_load_context",
      result: text('{"ref":"@scene","body":"The key is amber."}'),
    },
    user("What color is the key in the loaded scene? Answer in one word."),
  ];
  const boot = await request("runtime-bootstrap", bootstrap, { tools: [] });
  if (!/amber/i.test(finalText(boot, "runtime-bootstrap")))
    throw new Error(
      "runtime-bootstrap: expected color missing; inspect private evidence",
    );

  const ordered = await request(
    "prompt-order",
    [
      user("Remember the code OAK."),
      { type: "model_output", content: text("I remember OAK.") },
      user("Change the code to PINE."),
      user("This is the request suffix: answer with the current code only."),
    ],
    {
      system_instruction:
        "First system instruction: answer concisely.\n\nSecond system instruction: retain the latest code.",
      tools: [],
    },
  );
  if (!/pine/i.test(finalText(ordered, "prompt-order")))
    throw new Error(
      "prompt-order: expected code missing; inspect private evidence",
    );
  console.log(
    "Probe scenarios finished. Manual evidence review remains required; this is not acceptance.",
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Probe failed; inspect private evidence.",
  );
  process.exitCode = 1;
}
