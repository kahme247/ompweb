# Release Checklist

Each release publishes two artifacts:

- npm package: `@kahme247/ompweb`
- GitHub Release: [kahme247/ompweb](https://github.com/kahme247/ompweb)

After the initial bootstrap release, publishing is performed by GitHub Actions
with npm trusted publishing. No npm access token is stored in this repository
or in GitHub secrets.

## Bootstrap the first release

`@kahme247/ompweb` is not registered on npm yet. npm exposes trusted-publisher settings
only for an existing package, so version `0.2.0` must be published once from a
reviewed local checkout using the authenticated npm account:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm publish --access public
```

Do not create a tag or GitHub Release for this bootstrap version: npm will
reject a duplicate version.
After this succeeds, configure trusted publishing before publishing any later
version.

## One-time trusted-publisher setup

1. In npm, open the `@kahme247/ompweb` package settings and add a **GitHub Actions**
   trusted publisher with:
   - Owner: `kahme247`
   - Repository: `ompweb`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
2. In GitHub, create the `npm` environment for this repository. Add required
   reviewers if releases need approval.
3. Confirm Actions are enabled for the repository.

The workflow at `.github/workflows/publish.yml` requests `contents: write` to
create the GitHub Release and `id-token: write` for trusted publishing. It
installs npm 11.5.1 or newer, as required for trusted publishing. The OIDC
permission lets npm verify the GitHub Actions identity and generate provenance
for the published package.

## Release later versions

Run these from a clean `main` checkout after the release changes are merged.

```bash
npm ci
npm test
npm run build
npm version <major|minor|patch>
git push origin main --follow-tags
```

`npm version` updates `package.json` and `package-lock.json`, creates a commit,
and creates a `v<version>` tag. Review the generated commit before pushing.

Pushing the tag starts the `Publish npm package` workflow. It checks out that
immutable tag, verifies the tag matches `package.json`, installs from the
lockfile, runs tests and the production build, then creates a draft GitHub
Release with generated notes. It publishes `ompweb` through the configured
trusted publisher and makes that release public only after npm accepts the
package. A rerun can safely finish a release if npm has already accepted its
version.

### Build identity in the UI

Click or tap the ompweb logo to reveal the package version. If the build's
Git `HEAD` has no tag, the reveal also shows the full commit hash and the
committer date in `YYYY-MM-DD` format. Any tag pointing exactly at `HEAD`
keeps the version-only display; a tag on an ancestor does not.

Both the production build and development server resolve this metadata from
the source checkout, ignoring inherited repository-location overrides. Explicit
`safe.directory` trust from Git's configured files or `GIT_CONFIG_COUNT` is preserved.
The metadata is bundled into the client, including in npm packages and binary
releases; no Git command runs when a user clicks the logo.
Source archives without Git metadata keep the version-only display.

The development bootstrap initializes missing browser constants once. Empty
commit fields are valid, and later hot reloads keep the existing listener.

## Verify

```bash
gh run list --repo kahme247/ompweb --workflow publish.yml --limit 1
npm view @kahme247/ompweb@<version> version --registry https://registry.npmjs.org/
npm view @kahme247/ompweb@<version> --json --registry https://registry.npmjs.org/
```

Confirm the workflow succeeded, the exact package version resolves, and npm
shows the expected provenance link.
