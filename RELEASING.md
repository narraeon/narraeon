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

## One-time first publication

npm Trusted Publishing can only be configured after a package already exists.
The first release therefore uses a short-lived bootstrap token once; every
later release uses GitHub OIDC without a stored write token.

1. Merge and push the release workflow to `main` before creating the Release.
2. On npmjs.com, create a short-expiry granular access token that can create and
   publish public packages. Enable the publishing/2FA bypass required for CI.
3. Add it as the `NPM_BOOTSTRAP_TOKEN` GitHub Actions repository secret. To keep
   the token out of shell history, run `gh secret set NPM_BOOTSTRAP_TOKEN` and
   paste it at the prompt.
4. Confirm the package version and run the local gate below.
5. Publish a GitHub Release whose tag is exactly `v<package version>` and whose
   target is a commit in `main`. The workflow will create the first npm package.
6. In the new package's npm settings, configure a GitHub Actions Trusted
   Publisher with these exact values:
   - organization or user: `narraeon`
   - repository: `narraeon`
   - workflow filename: `publish-npm.yml`
   - environment: leave empty
   - allowed action: `npm publish`
7. Delete the GitHub secret with
   `gh secret delete NPM_BOOTSTRAP_TOKEN`, revoke the npm bootstrap token, and
   set npm publishing access to require 2FA and disallow tokens.

The repository can remain private and still use OIDC publishing, but npm cannot
generate provenance for a package built from a private repository. A public npm
package also exposes repository, homepage, and issue links that private-repo
users cannot open. Decide repository visibility before the first public release.

## Every later release

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
   npm view narraeon@<version> dist.integrity --registry=https://registry.npmjs.org/
   ```

If a workflow fails before `npm publish`, fix the cause and rerun the job. If
npm already accepted the version, do not rerun it as a new artifact; bump the
version and create a new Release instead.
