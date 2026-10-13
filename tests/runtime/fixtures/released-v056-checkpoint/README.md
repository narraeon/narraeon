# v0.5.6 checkpoint recovery fixture

`storage.json.gz` was written by the unchanged Narraeon implementation at
commit `2cd320bb6a5f4cc37b0d6d8049c175b03cc9d450` (package version 0.5.6).
It contains two newly invented worlds, one per locale, with a real compiled
request rejected before generation. The original checkpoint round marker,
tool definitions, bootstrap and request bytes come from that implementation.
No stored world or request was constructed by editing current-format objects.
The scripted rejection supplies a deterministic recovery boundary and is not
evidence about real-model interaction behavior.

To regenerate, export that exact commit into a temporary directory, make the
repository's dependencies available there, then run:

```sh
node scripts/generate-checkpoint-recovery-fixture.mjs /path/to/exported-2cd320b
```

`generate-checkpoint-recovery-fixture.mjs` verifies historical source hashes and only calls the supplied historical implementation. The test
restores every file verbatim, verifies the cold retry equals the original
request, and checks later sends retain the old marker without adding one.

Checked-in gzip SHA-256:
`1a7d16bb9d57021da57fac8c83884f27b05364362f46208628d5944bae370fc8`.
