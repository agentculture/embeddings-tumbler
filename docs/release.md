# Releasing embeddings-tumbler

This runbook is for a person cutting a release. Two registries carry the same
viewer:

| Channel | Name | What it carries |
|---------|------|-----------------|
| PyPI | `embeddings-tumbler` (wheel and sdist) | The CLI, plus the viewer files as package data under `embeddings_tumbler/static/` |
| npm | `@culture.dev/embeddings-tumbler` | Only the viewer files, at the same paths, plus `package.json`, `README.md` and `LICENSE` |

The six viewer files are `embeddings-tumbler.js` (the core file),
`web-component.js`, `sample-data.js`, `index.html`, `page.css` and `page.js`.
There is exactly one copy of each in the repository, under
`embeddings_tumbler/static/`. The wheel takes them from there, and so does the
npm tarball (`package.json`'s `files` field points into that folder). Nothing is
copied at pack time.

Both registries are published from CI by **trusted publishing**: the workflow's
own GitHub identity (OIDC) is exchanged for a short-lived upload credential. No
registry token is stored in the repository, in its secrets or in any workflow.
`scripts/scan-secrets.py` (run in CI) and `tests/test_scan_secrets.py` fail if
one appears.

Items marked **(not done yet)** need the user's action. Read
[What could not be verified](#what-could-not-be-verified-from-here) before the
first release.

## Where the version lives

`pyproject.toml` is the single source. Everything else follows it, and a test
fails when any of them is out of step.

| Place | Updated by | Checked by |
|-------|------------|------------|
| `pyproject.toml` `version` | the `version-bump` skill | (the source) |
| `CHANGELOG.md` top `## [x.y.z]` entry | the `version-bump` skill | `tests/test_packages.py` |
| `package.json` `version` | `python3 scripts/sync_version.py` | `scripts/sync_version.py --check` (CI), `tests/test_packages.py`, `tests/test_assemble.py` |
| core file header and `ET.version` | `python3 scripts/assemble.py` | `scripts/assemble.py --check` (CI), `tests/test_assemble.py` |
| inside the two built packages | the build | `scripts/check_packages.py` |

The vendored `version-bump` skill predates `package.json` and is cited verbatim,
so it is not edited. After a bump, run the two scripts yourself.

## A normal release

1. Make the change on a branch.
2. Bump the version and carry it everywhere:

   ```bash
   # version-bump skill: pyproject.toml + CHANGELOG.md
   python3 .claude/skills/version-bump/scripts/bump.py patch < entries.json
   python3 scripts/sync_version.py    # package.json
   python3 scripts/assemble.py        # the core file's header
   ```

3. Dry-run both packages locally. This builds the wheel (`uv build --wheel`)
   and the npm tarball (`npm pack`) into a temporary folder, publishes nothing,
   and prints `packages agree` or one `FAIL` line per problem:

   ```bash
   python3 scripts/check_packages.py
   ```

4. Open the pull request. CI then runs:
   - `tests.yml`: pytest, `node --test`, the generated-file checks
     (`assemble.py`, `sync_sample.py`, `sync_static.py`, `sync_version.py`, each
     with `--check`), lint, the harness smoke check and the version-bump check;
   - `packages.yml`: the dry-run build of **both** packages and
     `scripts/check_packages.py`. It never publishes and asks for no OIDC token;
   - `publish.yml` (pull request path, same-repository branches only): tests,
     `verify-packages` (the same build-and-compare), then a `.devN` build to
     **TestPyPI**. Nothing goes to npm from a pull request: npm has no test
     registry and a version can never be reused.
5. Merge. `publish.yml` runs on the merge commit, in this order, every job on
   the same commit:
   1. `test`;
   2. `verify-packages`: builds both packages and fails unless the core file and
      the static files are byte-identical and every version agrees. Neither
      registry is touched before this passes;
   3. `publish-npm` (environment `npm`): rebuilds both, checks again, then runs
      `npm publish <tarball> --provenance --access public` with npm 11.21.1 and
      no token. If that version is already on npm (a re-run, or the one-time
      bootstrap below), it downloads the registry copy, checks it against this
      commit's wheel, and skips publishing;
   4. `publish` (environment `pypi`): builds, checks the exact wheel it is about
      to upload against a fresh npm tarball, then `uv publish
      --trusted-publishing always`.

   npm goes first because it is the newer channel and the likelier to fail; if
   it fails, nothing has been published. Both publish jobs can be re-run safely.
6. Verify what was published (below).

A TestPyPI `.devN` build has `.devN` in its metadata but the plain version in
the core file's header. That is expected: TestPyPI builds are previews, not
releases, and are not compared.

## The one-time first npm release (not done yet)

npm attaches a trusted publisher only to a package that already exists. The
very first version of `@culture.dev/embeddings-tumbler` must therefore be
published once with a token, from the user's machine. Every later release is
tokenless from CI.

An npm version can never be reused, not even after an unpublish. Run every
check before the publish command, and publish the exact tarball you checked.

### Order of events

The least risky order is: merge first, bootstrap from the merge commit, then
re-run CI.

1. Merge the release pull request as usual. On the merge commit, `publish-npm`
   **fails** (the package does not exist and no trusted publisher is configured
   yet), so `publish` (PyPI) does not run. That is expected and publishes
   nothing.
2. Publish that same commit to npm with the token (next section).
3. Configure the trusted publisher on npmjs.com (the section after).
4. In the Actions tab, open the failed `Publish to PyPI and npm` run for the
   merge commit and choose **Re-run failed jobs**. `publish-npm` finds the
   version already on npm, checks the registry copy matches the commit, and
   skips. `publish` then uploads to PyPI.

### Publish the first version with the token held in grant

The token is the hidden `grant` secret `NPM_ACCESS_TOKEN`. It is handed only to
the one `npm` process by `grant run --inject` and is written nowhere. npm does
not read a token from an arbitrary environment variable, so a throwaway user
config file outside the repository tells npm to take it from
`NPM_ACCESS_TOKEN`. That file holds only the `${NPM_ACCESS_TOKEN}` reference,
never the value.

```bash
# 1. A clean checkout of the exact merge commit, outside any working tree.
SHA=<merge commit sha>
WORK=$(mktemp -d)
git clone https://github.com/agentculture/embeddings-tumbler.git "$WORK/repo"
cd "$WORK/repo"
git checkout "$SHA"
git status --porcelain                 # must print nothing

# 2. Build both packages and prove they agree. Must end "packages agree".
python3 scripts/check_packages.py --out-dir "$WORK/dist"
VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
TARBALL="$WORK/dist/culture.dev-embeddings-tumbler-$VERSION.tgz"

# 3. Look at what will be published: exactly nine files, all under package/:
#    package.json, README.md, LICENSE and embeddings_tumbler/static/<the six files>.
tar -tzvf "$TARBALL"

# 4. The package must not exist yet (expect a 404).
npm view @culture.dev/embeddings-tumbler

# 5. A throwaway npm user config that reads the token from the environment.
RC="$WORK/npmrc"
printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_ACCESS_TOKEN}' > "$RC"

# 6. Confirm the token works and names the expected npm user.
grant run --inject NPM_ACCESS_TOKEN=NPM_ACCESS_TOKEN -- npm whoami --userconfig "$RC"

# 7. Publish the checked tarball. This is the one irreversible step.
grant run --inject NPM_ACCESS_TOKEN=NPM_ACCESS_TOKEN -- \
  npm publish "$TARBALL" --access public --userconfig "$RC"

# 8. Clean up.
rm -f "$RC"
cd / && rm -rf "$WORK"
```

Notes:

- This is the planned `grant run --inject NPM_ACCESS_TOKEN=NPM_ACCESS_TOKEN --
  npm publish --access public`, with two additions: `--userconfig`, because
  without it npm never sees the injected variable, and an explicit tarball path,
  so what is published is the file step 2 checked.
- Do not pass `--provenance` here. Provenance needs the CI identity; a local
  publish with it fails. CI releases carry provenance.
- If npm asks for a one-time password, the account requires two-factor auth for
  publishing; add `--otp <code>` to the publish command.
- Never paste the token into a command line, a file or a chat, and do not add it
  to the repository's GitHub secrets. CI does not need it.

### Add the trusted publisher on npmjs.com (not done yet)

On <https://www.npmjs.com/package/@culture.dev/embeddings-tumbler>, open
**Settings**, then **Trusted Publisher**, choose **GitHub Actions** and enter:

| Field | Value |
|-------|-------|
| Organization or user | `agentculture` |
| Repository | `embeddings-tumbler` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |

npm checks that the workflow file exists in the repository, which is why this
step comes after the merge.

A new trusted-publisher configuration expires if it has not completed a
successful publish within **2 days**. The re-run in step 4 above skips
publishing (the version is already there), so it does not count. Either ship
the next release (a patch is fine) within two days, or re-add the trusted
publisher just before the next release.

After the first tokenless CI release succeeds, consider setting the package's
**Publishing access** to require two-factor authentication and disallow
tokens. Trusted publishing keeps working, and the bootstrap token can then no
longer publish this package. Whether to keep or revoke the token in `grant` is
the user's call.

## GitHub environments (not verified from here)

The publish jobs run in GitHub environments. They must exist in the
repository's settings (**Settings**, then **Environments**) and must hold **no
secrets**:

| Environment | Used by | Trusted publisher it must match | Suggested protection |
|-------------|---------|---------------------------------|----------------------|
| `testpypi` | `test-publish` (pull requests) | TestPyPI project `embeddings-tumbler`: `agentculture/embeddings-tumbler`, `publish.yml`, environment `testpypi` | No branch restriction (pull-request runs use `refs/pull/N/merge`, which a branch rule would block) |
| `pypi` | `publish` (push to `main`) | PyPI project `embeddings-tumbler`: `agentculture/embeddings-tumbler`, `publish.yml`, environment `pypi` | Deployment branches: `main` only. Optional required reviewer |
| `npm` | `publish-npm` (push to `main`) | npm package `@culture.dev/embeddings-tumbler`: as in the table above | Deployment branches: `main` only. Optional required reviewer **(not done yet: create it)** |

If you add a required reviewer to `npm`, add the same one to `pypi`, or PyPI can
be approved while npm waits. The workflow's display name changed to `Publish to
PyPI and npm`; the PyPI trusted publishers match on the file name
(`publish.yml`) and the environment, so they are unaffected.

## Verify a published release

From a checkout of the release commit (so the script reads the right versions):

```bash
VERSION=<x.y.z>
D=$(mktemp -d)
(cd "$D" && npm pack "@culture.dev/embeddings-tumbler@$VERSION")
python3 -m pip download "embeddings-tumbler==$VERSION" --no-deps --only-binary=:all: -d "$D"
python3 scripts/check_packages.py \
  --wheel "$D/embeddings_tumbler-$VERSION-py3-none-any.whl" \
  --tarball "$D/culture.dev-embeddings-tumbler-$VERSION.tgz"
```

It must print `packages agree`. By hand, the two core files must have the same
hash and the same first line:

```bash
unzip -p "$D"/embeddings_tumbler-*.whl embeddings_tumbler/static/embeddings-tumbler.js | sha256sum
tar -xOzf "$D"/culture.dev-embeddings-tumbler-*.tgz package/embeddings_tumbler/static/embeddings-tumbler.js | sha256sum
unzip -p "$D"/embeddings_tumbler-*.whl embeddings_tumbler/static/embeddings-tumbler.js | head -1
tar -xOzf "$D"/culture.dev-embeddings-tumbler-*.tgz package/embeddings_tumbler/static/embeddings-tumbler.js | head -1
```

For a CI-published npm version, `npm view
@culture.dev/embeddings-tumbler@$VERSION dist.attestations` shows its
provenance. The bootstrap version has none.

## After a partial publish

Neither registry lets a version be reused: a PyPI file name can never be
uploaded again, even after deletion, and an npm `name@version` can never be
published again, even after an unpublish. So never "fix" a release by deleting
and re-uploading.

| What happened | What to do |
|---------------|------------|
| `publish-npm` failed before uploading | Nothing is published (PyPI waits for npm). Fix the cause, then **Re-run failed jobs**. |
| `publish-npm` uploaded but the job still failed (for example a network error afterwards) | **Re-run failed jobs**. The npm job finds the version, checks the registry copy matches the commit, skips, and PyPI proceeds. |
| npm succeeded, `publish` (PyPI) failed | **Re-run failed jobs**. `uv publish --check-url` skips files PyPI already has. |
| The re-run's check says the npm registry copy does **not** match the commit | Stop. Do not publish PyPI from this commit. Find out how the registry copy was made, then bump the patch version and release both registries from a new commit. |
| A version is on one registry and can never be published on the other (for example a broken upload) | Bump the patch version and release both. Record in `CHANGELOG.md` that the skipped version exists on only one registry. Do not unpublish the orphan; its number is gone either way. |

## What could not be verified from here

This runbook and the workflows were written and checked without access to
GitHub Actions or to the repository's settings. In particular:

- **No workflow has run.** The YAML parses and `tests/test_workflows.py` checks
  its structure: pinned actions, permissions, job order, guards, no tokens.
  `actionlint` was not installed. Every shell step that does not need a
  registry was run locally: the generated-file checks, `node --test`, the
  dry-run build and `check_packages.py`, the npm-version gate, and the
  re-run branch's comparison (with a local tarball standing in for the
  registry copy).
- **npm trusted publishing end to end**: the OIDC exchange, `npm publish
  <tarball> --provenance` from a tarball path, npm's match of `package.json`'s
  `repository` against the GitHub repository, and that `actions/setup-node`
  without `registry-url` is right for OIDC. These follow npm's documented
  requirements but have not been exercised.
- **The runner's toolchain**: Node 24 through the pinned `actions/setup-node`
  v4 and `npm install -g npm@11.21.1` on the runner. The local npm is 9.2.0, so
  the tarball's file list was measured with npm 9.2.0; the CI dry run repeats
  the check with npm 11.21.1 and fails if the list differs.
- **Repository settings**: whether the `pypi`, `testpypi` and `npm`
  environments exist, their protection rules, that they hold no secrets, and
  that the PyPI and TestPyPI trusted publishers are configured (the existing
  workflow implies they are).
- **npm facts settled by the user, not re-checked here**: that a trusted
  publisher can be added only to an existing package, the 2-day expiry, and the
  11.5.1 minimum npm version.
