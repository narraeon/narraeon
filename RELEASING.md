# Releasing Narraeon

GitHub Releases are the only automated npm publication trigger. A published
release checks out its tag, verifies that the commit is contained in `main`,
runs the complete release gate, and publishes the package version from
`package.json`.

## Release contract

- Stable versions use a `v<version>` GitHub tag and publish to npm `latest`.
- SemVer prereleases such as `0.2.0-rc.1` must be marked as GitHub prereleases
  and publish to npm `next`.
- A version or tag is never reused. npm does not allow a published
  name-and-version pair to be published again.
- The workflow runs only on a published GitHub Release, not on a pushed tag or
  draft release.
- `.github/workflows/publish-npm.yml` is the exact workflow filename registered
  with npm Trusted Publishing.

## Trusted publishing

The one-time bootstrap publication of `narraeon@0.1.0` is complete. Its npm
token was revoked and the `NPM_BOOTSTRAP_TOKEN` GitHub secret was deleted. Do
not recreate either credential: every automated release now publishes only
through npm Trusted Publishing and GitHub OIDC.

The npm package settings must contain a GitHub Actions Trusted Publisher with
these exact values:

- organization or user: `narraeon`
- repository: `narraeon`
- workflow filename: `publish-npm.yml`
- environment: leave empty
- allowed action: `npm publish`

The package publishing-access setting should require 2FA and disallow tokens.
That restriction does not block the configured Trusted Publisher. The public
repository and public npm package allow npm to generate provenance linking each
published artifact to its source commit and workflow run.

## Every release

1. Update `version` in both `package.json` and `package-lock.json`. For example,
   `npm version patch --no-git-tag-version` updates both without creating a tag.
2. Review the complete diff and run:

   ```bash
   npm ci --registry=https://registry.npmjs.org/
   npm audit --audit-level=high --registry=https://registry.npmjs.org/
   npm run check
   npm run test:unit
   npm run test:release
   npx playwright install chromium
   TMPDIR=/tmp npm run test:e2e
   TMPDIR=/tmp npm run test:package
   npm publish --dry-run --json
   ```

3. Commit and push the version change to `main`.
4. Create and publish the matching GitHub Release. Mark it as a prerelease if
   and only if the package version contains a SemVer prerelease suffix.
5. Wait for the `Publish npm package` workflow to finish, then verify the npm
   version and dist-tag:

   ```bash
   npm view narraeon version --registry=https://registry.npmjs.org/
   npm view narraeon dist-tags --json --registry=https://registry.npmjs.org/
   npm view narraeon@<version> dist --json --registry=https://registry.npmjs.org/
   ```

   An OIDC publication from this public repository must include
   `dist.attestations.provenance`. Verify the provenance links to the expected
   source commit and `publish-npm.yml`, and run `npm audit signatures` from a
   consumer project that installs the exact published version.

If a workflow fails before `npm publish`, fix the cause and rerun the job. If
npm already accepted the version, do not rerun it as a new artifact; bump the
version and create a new Release instead.
