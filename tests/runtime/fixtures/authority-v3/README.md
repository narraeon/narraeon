# Authority V3 world fixture

`storage.json.gz` holds two worlds written by the Authority V3 implementation
at commit `daadc9a` (before the current-files-plus-turn-ledger layout, #79):

- `plain`: genesis plus four commits, one of which edits a state document.
- `revised`: the same chain followed by a timeline revision of commit 1, which
  becomes commit 5 and restores genesis.

Each world stores every file of its directory and the endpoints V3 recovered
for each head. `generator.ts.txt` is the script that produced it; it ran
unchanged against the `daadc9a` tree. Do not regenerate this fixture from the
current implementation: it would no longer exercise the V3 migration path.
