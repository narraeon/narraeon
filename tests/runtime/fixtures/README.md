# Historical preset fixtures

These gzip files contain JSON envelopes with a `files` map of exact UTF-8
storage bytes. Tests restore those bytes before invoking the current stores.
They are fixed historical inputs, not current objects with legacy fields added.
Generated IDs and timestamps intentionally remain in the samples.

| Fixture | Source | Scope |
| --- | --- | --- |
| `released-v040/storage.json.gz` | published `v0.4.0`, `e0b776bbb8a1a1a74e2ff6d137e063272e7aa146` | preset library, disabled authored block, renderer resource, world, native tool exchange, exact saved request, two post-commit artifacts |
| `pre38-author.json.gz` | unreleased `f970155f4bc549158d7b73fccb7f317b7dcdb403` | schema-v2 author conversation, native tool exchange, returned reasoning, current-tree write and receipts |

The published v0.4.0 author workflow used an in-memory map; it did not write a
durable author conversation. The second fixture therefore carries `release: null`.
Both fixtures use deterministic model responses through the historical
`ScriptedModelHost`; they verify storage compatibility, not external providers.

To generate another sample, export the exact historical source with `git archive`
into an isolated directory and install that revision's dependencies there. Run:

```sh
node scripts/generate-released-preset-fixture.mjs /path/to/v0.4.0 /path/to/empty-data /path/to/output.json.gz
node scripts/generate-pre38-author-fixture.mjs /path/to/f970155 /path/to/output.json.gz
```

Generators verify the imported historical modules against fixed SHA-256 values
before writing data. They do not import current Runtime modules. Fresh samples
have different generated identities and timestamps; do not replace a checked-in
sample merely to match current output.

Checked-in gzip SHA-256:

- `released-v040/storage.json.gz`: `f7d7becd7f1ca841f811210d50fdd099119654324182b935c7c610c265677d7e`
- `pre38-author.json.gz`: `9d205dcc59114c322c32e28ee3abcd7fd0678cb48f9a3700e232ea9858b44dab`
