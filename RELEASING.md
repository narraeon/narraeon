# Releasing Narraeon

GitHub Releases are the only automated publication trigger. A published
release checks out its tag, verifies that the commit is contained in `main`,
runs the complete release gate, publishes the package version from
`package.json` to npm, and then publishes the matching multi-platform image to
GitHub Container Registry.

## Release contract

- Stable versions use a `v<version>` GitHub tag and publish to npm `latest`.
- Stable container images publish the exact version and `latest` tags.
- SemVer prereleases such as `0.2.0-rc.1` must be marked as GitHub prereleases
  and publish to npm and the container registry as `next`; they do not move
  `latest`.
- A version or tag is never reused. npm does not allow a published
  name-and-version pair to be published again.
- Versions must not contain SemVer build metadata (`+...`), because the same
  version must remain representable as an exact container tag.
- The workflow runs only on a published GitHub Release, not on a pushed tag or
  draft release.
- `.github/workflows/publish-npm.yml` is the exact workflow filename registered
  with npm Trusted Publishing.
- The release image is `ghcr.io/narraeon/narraeon`, with a manifest for
  `linux/amd64` and `linux/arm64`. It runs as a non-root user and persists
  `/var/lib/narraeon`.

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
   npm run test:container
   npm publish --dry-run --json
   ```

3. Commit and push the version change to `main`.
4. Create and publish the matching GitHub Release. Mark it as a prerelease if
   and only if the package version contains a SemVer prerelease suffix.
5. Wait for the `Publish release artifacts` workflow to finish, then verify the
   npm version and dist-tag:

   ```bash
   npm view narraeon version --registry=https://registry.npmjs.org/
   npm view narraeon dist-tags --json --registry=https://registry.npmjs.org/
   npm view narraeon@<version> dist --json --registry=https://registry.npmjs.org/
   ```

   An OIDC publication from this public repository must include
   `dist.attestations.provenance`. Verify the provenance links to the expected
   source commit and `publish-npm.yml`, and run `npm audit signatures` from a
   consumer project that installs the exact published version.

6. Verify the exact container version rather than relying on its moving tag:

   ```bash
   docker buildx imagetools inspect ghcr.io/narraeon/narraeon:<version>
   docker pull ghcr.io/narraeon/narraeon:<version>
   docker run --detach --name narraeon-release-check \
     --publish 127.0.0.1:4317:4317 \
     --volume narraeon-release-check:/var/lib/narraeon \
     ghcr.io/narraeon/narraeon:<version>
   curl --fail http://127.0.0.1:4317/health
   docker rm --force --volumes narraeon-release-check
   ```

   The manifest must contain both `linux/amd64` and `linux/arm64`. A stable
   release must resolve through `latest`; a prerelease must resolve through
   `next` while leaving `latest` unchanged.

The first GHCR publication creates a private package even when the repository
is public. To support the anonymous pull shown in the README, a package admin
must open the new package's settings and change its visibility to **Public**.
This is a one-time, irreversible visibility change and is deliberately not
performed by the workflow. The workflow publishes with `GITHUB_TOKEN`, embeds
the source-repository label, and does not require a long-lived registry token.

If a workflow fails before `npm publish`, fix the cause and rerun the job. If
the Docker job has a transient failure after npm succeeds, use **Re-run failed
jobs** so the successful npm job is not repeated. If npm already accepted the
version and the fix requires changing source or workflow files, do not reuse
the version or Release tag; bump the version and create a new Release instead.
