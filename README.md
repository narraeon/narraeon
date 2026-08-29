# Narraeon

[English](README.md) | [简体中文](README.zh-CN.md)

Narraeon is a local-first workspace for open-ended role-playing with an AI host. You build a world from readable YAML and Markdown files, connect the model provider you want to use, and then play through a browser connected to a Runtime on the same machine.

The model handles the meaning of the story: it portrays characters, responds to the player's actions, reads world material when needed, and proposes durable changes. The Runtime handles the parts that should not depend on model memory: validated file operations, exact committed narrative, immutable history, recovery, and independent world forks.

## What Narraeon provides

- **File-native worlds.** Characters, locations, rules, the current situation, the opening, and world-specific instructions remain ordinary YAML and Markdown files.
- **Durable continuity.** Important changes are written back to the document that naturally owns them. Exact player and host prose is committed as narrative history.
- **Model-directed play.** The model can narrate, read additional material, and update world documents through Runtime tools in one continuous call chain.
- **Inspectable prompts.** Prompt Preview shows the real logical roles, selected material, tool definitions, provider mapping, and cache boundary without calling the model.
- **Non-destructive history.** Editing an earlier player action changes the current timeline without deleting old Authority records. Creating a fork produces a separate world that can evolve on its own.
- **Local ownership.** Worlds, configuration, credentials, prompts, history, and recovery data are stored on your machine. Model requests go only to the provider endpoint you explicitly configure.

## Requirements

- Node.js **24.12.0 or newer**
- A modern browser
- For AI play or setting improvement, a model endpoint and API credential compatible with one of the supported adapters:
  - OpenAI Responses API
  - OpenAI-compatible Chat Completions
  - Anthropic Messages

Narraeon includes connection presets for several providers and also accepts a custom endpoint. A model with reliable tool-calling support is recommended.

## Quick start

Run the packaged web app without installing it globally:

```bash
npx narraeon web
```

Narraeon starts on <http://127.0.0.1:4317> and opens the default browser. Keep the terminal process running while you use the app; press `Ctrl+C` to stop it.

Useful options:

```bash
npx narraeon web --port 4318
npx narraeon web --no-open
npx narraeon --help
```

The server listens only on `127.0.0.1`. If the chosen port already hosts a compatible Narraeon instance, the CLI reuses it. If another program owns the port, startup fails instead of attaching to an unknown service.

## Run from source

```bash
git clone https://github.com/narraeon/narraeon.git
cd narraeon
npm ci
npm run build
npm start
```

Then open <http://127.0.0.1:4317>. To run the built CLI instead of the source server:

```bash
node dist/node/cli/main.js web
```

## First-time setup

1. **Choose the interface language.** Use the language selector in the header. The choice is saved locally. It changes the interface and Runtime-owned default prompts, but it does not rewrite content or custom prompts you have already saved.
2. **Configure a model connection.** Open **Model connection**, choose a provider profile or custom endpoint, enter the API key and model ID, and set the model's real context-window and maximum-output limits. Saving a connection also makes it the active connection.
3. **Prepare a content package.** Create a blank package or import a ZIP. A content package is a world template, not a live save. Its main surfaces are:

   ```text
   opening.md                 first prose the player reads
   world/                     initial characters, places, rules, and situation
   control/frame.yaml         deterministic prompt-material arrangement
   control/blocks/*.md        instructions unique to this world
   control/player-views.yaml  persistent information shown beside the story
   ```

4. **Edit or improve the setting.** You can edit files directly, or ask the model to create a visible plan and an isolated candidate. AI changes are not applied until you review and accept the complete file diff.
5. **Review the play preset.** The built-in preset is ready to use and follows the selected language. Presets hold reusable host guidance, narrative prompts, follow-up requests, and optional interface extensions.
6. **Create a world.** A usable content package can be copied into a new independent world. Later edits to the source package do not alter worlds that already exist.

## How play works

Opening a world shows the committed story as the primary surface, with persistent player views beside it. Write what your character attempts, says, or decides, then choose how to send it:

| Action                         | What it does                                                                                                                                                   | What it does not do                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **New context**                | Rebuilds model context from the world's current endpoint, current prompts, selected material, and recent narrative, then appends the new player text.          | It does not clear the world, visible story, or saved call-chain history.            |
| **Append context**             | Continues the current model transcript and appends the new player text. With no existing context, it starts a new one automatically.                           | It does not recompile the world bootstrap while the current context remains active. |
| **Append with an empty input** | After an interrupted request, resends the saved provider request unchanged. After a complete response, asks the model to continue from the current transcript. | It does not invent a hidden player instruction or commit an empty player message.   |

The response streams into the page. The model may narrate immediately, read a precise document or history item, update a world document, create a document, or combine narration and tools. Tool calls only modify an uncommitted candidate; the Runtime validates and commits accepted results. A later provider failure does not erase earlier results that were already committed.

### Continuity across contexts

Narraeon does not depend on one indefinitely growing chat. A new context is compiled from the current world, while committed narrative and important document changes remain available as durable continuity. Short-lived scene details can remain in recent narrative; facts that would cause a contradiction if forgotten belong in the relevant character, location, item, rule, or current-situation document.

The call-chain panel keeps the actual request history for inspection: player messages, model prose, Runtime tool calls and results, usage, failures, and only the reasoning content the provider really returned. Internal processing is not presented as story text.

### Edit, correct, or fork

| Action                              | Result                                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Edit a committed player message** | Stays in the current world. Narraeon appends a timeline revision from that message's logical parent and continues from the replacement text. Old Authority records remain recoverable. |
| **Create a fork**                   | Copies the selected Authority prefix into a new independent world. The source world is unchanged, and both worlds can continue separately.                                             |
| **Continuity correction**           | Applies an explicit out-of-story correction to current documents as a new commit without pretending the correction happened inside the narrative.                                      |

## Content packages and setting improvement

A content package is editable before play. You can keep several packages, copy them, export them as ZIP files, or import packages without overwriting an existing local identity.

AI setting improvement operates only on a package candidate. In the plan-first path, the model reads the selected material and proposes a visible creation plan before writing. You can also explicitly skip the plan. In both cases, the result must pass file, reference, control, player-view, and real Prompt Preview checks before it can be applied as one atomic package update. Existing worlds are never changed by package improvement.

For a detailed Chinese authoring guide, see [docs/content-package-setting-authoring.md](docs/content-package-setting-authoring.md).

## Language behavior

English is the default interface language. Switching to Simplified Chinese updates:

- the web interface;
- Runtime-owned default host and narrative prompts;
- Runtime tool descriptions and tool-use contracts;
- the scaffold used for newly created blank content packages.

Existing content packages, worlds, imported presets, copied presets, and user-edited prompt files are not translated or rewritten automatically.

## Local data and privacy

Narraeon uses the operating system's standard per-user application directories. To isolate an instance or choose explicit locations, set these variables before startup:

| Variable               | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `NARRAEON_DATA_ROOT`   | Content packages, worlds, Authority history, and artifacts |
| `NARRAEON_CONFIG_ROOT` | Model connections, app preferences, and play presets       |
| `NARRAEON_LOG_ROOT`    | Runtime logs and AI failure diagnostics                    |
| `NARRAEON_PORT`        | Local web port, default `4317`                             |

The browser talks only to the same-machine Runtime. Local-first does not mean that remote model inference is offline: prompts, selected world material, tool exchanges, and generated text are sent to the provider you configure. API keys are stored in the local configuration and are not returned to the browser after saving.

When a provider, response-format, Runtime-tool, or candidate-check error occurs, Narraeon creates a JSONL incident under `NARRAEON_LOG_ROOT/ai-failures`. It preserves the raw provider exchange and later recovery attempts, including reasoning or thinking actually returned by the provider. It does not invent hidden reasoning or record API keys and request headers. The files can still contain private prompts, world content, tool arguments, and provider-returned reasoning, so treat the log directory as sensitive.

## Development

```bash
npm ci
npm run build
npm run check
npx playwright install chromium
TMPDIR=/tmp npm run test
TMPDIR=/tmp npm run test:package
```

`npm run test:package` creates a real npm tarball, installs it in a temporary directory outside the repository, and verifies the packaged CLI, health endpoint, home page, and repeated-start behavior.

Project contracts and architecture:

- [CONTEXT.md](CONTEXT.md) — domain vocabulary
- [docs/product-foundation.md](docs/product-foundation.md) — current V1 product contract
- [docs/adr/](docs/adr/) — architectural decisions

## License

Apache-2.0
