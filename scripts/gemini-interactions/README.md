# Gemini Interactions evidence probe (#132)

Research-only workbench, not a Narraeon adapter. The scenarios below do not by themselves establish product support. `synthetic-steps.json` is invented test data, not a redacted provider response. Never send its fake signature to Google. The issue is the source of acceptance status.

## Run

Use Node 24 or later and an already authorized Gemini API key with access to the selected model. Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in the process environment through your normal secret manager; do not put it in a command, file in the repo, issue, or terminal transcript. Optionally set `GEMINI_PROBE_MODEL`; the candidate default is `gemini-3.8-flash`, **not an approved model**. Then run:

```sh
node scripts/gemini-interactions/validate-fixture.mjs
node --test scripts/gemini-interactions/probe.test.mjs
node scripts/gemini-interactions/probe.mjs
```

The probe performs up to five sequential, billable POSTs to `https://generativelanguage.googleapis.com/v1beta/interactions` with `store:false`, no revision header, fixed synthetic content and no live world data. It stops at the first failure or `requires_continuation`; it does not automatically retry uncertain outcomes. It archives request and response bodies and a timestamp, endpoint, model, revision setting and HTTP status in a newly created private temporary directory printed at startup. Headers and keys are not intentionally written, but provider bodies can contain sensitive identifiers, signatures, prompts, or echoed secrets: **treat the entire directory as sensitive**. Review it privately and redact before sharing; never commit raw traces. The script avoids printing response bodies. A missing key exits before creating a directory or sending a request. The probe rejects a temporary root inside the worktree after resolving symlinks. It also rejects responses containing non-roundtrippable numeric literals or unsafe integers before replay; raw evidence remains available for inspection. This conservative limitation applies to the entire response, including usage, and can reject otherwise valid responses.

The candidate wire shape and checks are provisional. A successful script run alone is not acceptance: inspect and compare each request/response and preserve independent evidence of real execution. It exercises:

1. One forced `read_document` call; the complete returned `steps` are appended unchanged before a matching Runtime result. It then asks for final text and sends a subsequent user turn with the accumulated steps.
2. A Runtime-origin bootstrap call/result pair with no invented signature and a question whose answer is present only in the supplied material. Acceptance by the service and the answer do not, by themselves, prove Runtime's actual read-authorization implementation.
3. A candidate merged leading system instruction, interleaved user/model messages and a final user suffix. Check the recorded wire order and response; this is not an exhaustive ordering test.

A failed earlier scenario prevents later scenarios from running. Save the failure and run the remaining cases separately only after inspecting the wire and explicitly documenting any changed request. The probe stops on unexpected status, missing tool call, or mismatched answer; these are observations to investigate, not automatic proof of a protocol rule. A timeout or connection failure has unknown outcome.

## Evidence review checklist

- Capture the exact model, account capability, response status, request shape, API version, revision behavior and date for a real run. Verify actual signed thought steps including an empty/missing summary. Compare the recorded response steps structurally and in order with the next request; note that JSON serialization may change whitespace and object key ordering. Any actual unknown fields must be preserved and replayed. A separate controlled unknown-field injection can test service acceptance but is not evidence that Google returned that field. The synthetic fixture only checks that the fixture and ordinary JSON round-trip contain the intended edge cases.
- Inspect whether the bootstrap is accepted without a signature and whether the response correctly uses its content; independently establish the Runtime material/authorization mapping. If rejected, decide an alternative and its contract impact before downstream implementation. Do not convert initial material into a fake signed model response.
- Independently test supported User/Assistant adjacency, leading System merge, suffix ordering and invalid mid-transcript System. Conservative proposed encoding: preserve order, merge only consecutive leading System texts, reject any later System; do not silently reorder or change role. This is **not yet an accepted or tested contract**.
- If `requires_continuation` occurs, retain the token privately. The [reference](https://aistudio.google.com/api-reference/interactions-api) says to pass the latest token unchanged, but does not establish the full stateless replay shape, step overlap or usage aggregation. Compare every hop before deciding how to aggregate or deduplicate. The [long-decode guide](https://aistudio.google.com/docs/long-decode) currently describes server-managed background hops requiring `store:true` and says client-side Interactions continuation is forthcoming; this does not establish a `store:false` path. Do not treat `incomplete`, a transport failure, or a simulated token as successful continuation. Do not enable this path for production until resolved.
- Record all actual `usage` fields and absence separately; do not assume total equals input plus output. For background long decode the guide describes cumulative usage and repeated input counting, but this is not evidence for client continuation or a stateless tool loop. Check cache and token behavior from live evidence.
- Record actual model access and supported settings, including the Provider default for an unknown model, and produce carefully redacted real fixtures only after reviewing their contents. Replacing opaque signatures may invalidate replay; label sanitized fixtures as structural rather than replayable.

For current findings, unresolved acceptance criteria, and official evidence links, see [#132](https://github.com/narraeon/narraeon/issues/132). No automatic fallback to `generateContent` or an OpenAI-compatible endpoint is authorized.
