# Released artifact-store fixture (v0.6.0)

`data/` is the on-disk state a v0.6.0 Runtime leaves for artifacts: the
`artifact-store/` layout (records, projection events and operation files
outside the world directory) for `world-1`, plus an unexpanded fork snapshot at
`worlds-file-native/world-fork/runtime/artifact-fork.json`. `expected.json`
holds what the v0.6.0 reader returns for each world. The migration test
(`tests/runtime/artifact-store-v060-migration.test.ts`) must reproduce those
values exactly after migrating a copy of `data/`.

- Source commit: `34b97c0` (`chore: release v0.6.0`). Its
  `src/runtime/artifact/FileNativeArtifactStore.ts` has SHA-256
  `963040a6cf09971d72e5ed2a7d183497aa511ed9d5987f3d450e9a87d1987939`.
- Generator: `scripts/generate-artifact-store-v060-fixture.mjs`. Export the
  source with `git worktree add --detach <dir> 34b97c0`, link the current
  `node_modules` into it, then run:

```sh
node scripts/generate-artifact-store-v060-fixture.mjs <dir> <empty-output-dir>
```

The generator refuses any tree whose three historical sources do not match
their SHA-256 values. It drives only the released store's public API, and it
reads each world from a copy so the released reader's own restores never reach
the fixture. The fixture is deterministic: IDs are literal or content-derived.

Checked-in files:

- `expected.json`: `c2f326792c4f0b72a85b4906504d4802a6b899f6c1246e7ae8e4d0dd1c52052b`
- `SHA256SUMS`: every file under `data/` and `expected.json`, listed as
  `<sha256>  <path>`. Its own SHA-256 is `5d778f98dc16722353c133a2399711ee4b457eef85b53e3126fbced5d9141e2e`.

Do not regenerate the fixture to match current output. A new fixture is needed
only when the released layout itself changes.
