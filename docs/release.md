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
`embeddings_tumbler/static/`. The wheel and the sdist take them from there, and
so does the npm tarball (`package.json`'s `files` field points into that
folder). Nothing is copied at pack time.

## What each artefact may carry

`scripts/check_packages.py` builds all three artefacts (or takes given ones)
and enforces this. The expected static set is the `embeddings_tumbler/static/`
entries of `package.json`'s `files`.

| Artefact | Uploaded to | Allowed contents |
|----------|-------------|------------------|
| npm tarball | npm | Exactly `package.json`, `README.md`, `LICENSE` and the expected static set. Anything else fails. |
| wheel | PyPI | Its own `embeddings_tumbler-<version>.dist-info/`, `.py` modules of the `embeddings_tumbler` package, and exactly the expected static set (flat). Anything else fails, including `js/`, `tests/`, `docs/`, `.devague/` and dev pages. |
| sdist | PyPI | A source distribution: the repository's tracked sources may travel in it (`js/src/`, `tests/`, `docs/` and so on; this is what hatchling's default sdist did before this work, and it is kept). Its `embeddings_tumbler/static/` must be exactly the expected set, and it must carry no `.npmrc`, `.pypirc` or `.env`. |

In all three the static files, the core file first, must be byte-identical to
the wheel's, and the core file's header version must equal `pyproject.toml`'s
and `package.json`'s.

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
| inside the three built artefacts | the build | `scripts/check_packages.py` |

The vendored `version-bump` skill predates `package.json` and is cited verbatim,
so it is not edited. After a bump, run the two scripts yourself.

## A normal release

1. Make the change on a branch.
2. Bump the version with the `version-bump` skill (it updates
   `pyproject.toml` and `CHANGELOG.md`), then carry the new version into
   `package.json` and the core file's header, and commit all four files:

   ```bash
   python3 .claude/skills/version-bump/scripts/bump.py patch < entries.json
   python3 scripts/sync_version.py && python3 scripts/assemble.py
   git add pyproject.toml CHANGELOG.md package.json embeddings_tumbler/static/embeddings-tumbler.js
   git commit -m "Bump version to x.y.z"
   ```

   Skipping the second line fails CI (`sync_version.py --check`,
   `assemble.py --check` and the version tests).

3. Dry-run all three artefacts locally. This builds the wheel and the sdist
   (`uv build`) and the npm tarball (`npm pack`) into a temporary folder,
   publishes nothing, and prints `packages agree` or one `FAIL` line per
   problem:

   ```bash
   python3 scripts/check_packages.py
   ```

4. Open the pull request. **Opening a pull request from a branch of this
   repository publishes a dev build (`x.y.z.devN`) to TestPyPI.** That is this
   repository's existing behaviour, from before npm was added; pull requests
   from forks skip it. Nothing reaches PyPI or npm proper until the merge. CI
   runs:
   - `tests.yml`: pytest, `node --test`, the generated-file checks
     (`assemble.py`, `sync_sample.py`, `sync_static.py`, `sync_version.py`, each
     with `--check`), lint, the harness smoke check and the version-bump check;
   - `packages.yml`: the dry-run build of **both** packages (wheel, sdist and
     npm tarball) and `scripts/check_packages.py`. It never publishes and asks
     for no OIDC token;
   - `publish.yml` (pull request path, same-repository branches only): tests,
     `verify-packages` (the same build-and-compare), then a `.devN` build to
     **TestPyPI**. Nothing goes to npm from a pull request: npm has no test
     registry and a version can never be reused.
5. Merge. **Merging publishes for real, to npm first and then to PyPI; PyPI
   waits for npm.** `publish.yml` runs on the merge commit, in this order,
   every job on the same commit:
   1. `test`;
   2. `verify-packages`: builds the wheel, the sdist and the npm tarball and
      fails unless the core file and the static files are byte-identical and
      every version agrees. Neither registry is touched before this passes;
   3. `publish-npm` (environment `npm`): rebuilds all three and checks again
      (`check_packages.py --github-output` hands the exact verified paths to
      later steps; nothing is globbed). `scripts/npm_release_state.py` then asks
      npm whether the version exists and answers `absent` or `present`; any
      other answer (a network or registry error) fails the job and publishes
      nothing. `absent`: `npm publish <tarball> --provenance --access public`
      with npm 11.21.1 and no token. `present` (a re-run, or the one-time
      bootstrap below): it downloads the registry copy and checks it against
      this commit's wheel and sdist, failing if they differ, and publishes
      nothing;
   4. `publish` (environment `pypi`): builds the wheel and the sdist, checks
      both against a fresh npm tarball, then uploads exactly those two files
      with `uv publish --trusted-publishing always`.

   npm goes first because it is the newer channel and the likelier to fail; if
   it fails, nothing has been published. Both publish jobs can be re-run safely.
6. Verify what was published (below).

A TestPyPI `.devN` build has `.devN` in its metadata but the plain version in
the core file's header. That is expected: TestPyPI builds are previews, not
releases, and are not compared.

## The one-time first npm release (done 2026-11-14, version 0.11.2)

Done as described below, from merge commit `bfebbcf`. The registry copy was
compared byte for byte with the checked tarball, and PyPI received the same
version from the re-run CI job. The steps stay here as the record of how it
was done. The account required a one-time password for publishing; a token
set to bypass two-factor authentication was used.

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

# 2. Build all three artefacts and prove they agree. Must end "packages agree".
#    --github-output records the exact paths it built and checked.
python3 scripts/check_packages.py --out-dir "$WORK/dist" --github-output "$WORK/paths"
TARBALL="$(sed -n 's/^tarball=//p' "$WORK/paths")"
echo "$TARBALL"

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
D="$(mktemp -d)"
# The wheel and the sdist exactly as PyPI serves them.
python3 - "$VERSION" "$D" <<'PY'
import json, sys, urllib.request
version, dest = sys.argv[1], sys.argv[2]
url = f"https://pypi.org/pypi/embeddings-tumbler/{version}/json"
with urllib.request.urlopen(url) as response:
    for item in json.load(response)["urls"]:
        urllib.request.urlretrieve(item["url"], f"{dest}/{item['filename']}")
        print(item["filename"])
PY
# Compare them with the npm registry copy (packed into a fresh folder).
python3 scripts/check_packages.py \
  --wheel "$D/embeddings_tumbler-$VERSION-py3-none-any.whl" \
  --sdist "$D/embeddings_tumbler-$VERSION.tar.gz" \
  --registry-tarball "@culture.dev/embeddings-tumbler@$VERSION" \
  --out-dir "$D/npm"
```

It must print `packages agree`. By hand, the core files must have the same
hash and the same first line:

```bash
WHEEL="$D/embeddings_tumbler-$VERSION-py3-none-any.whl"
SDIST="$D/embeddings_tumbler-$VERSION.tar.gz"
TGZ="$D/npm/culture.dev-embeddings-tumbler-$VERSION.tgz"
CORE=embeddings_tumbler/static/embeddings-tumbler.js
unzip -p "$WHEEL" "$CORE" | sha256sum
tar -xOzf "$SDIST" "embeddings_tumbler-$VERSION/$CORE" | sha256sum
tar -xOzf "$TGZ" "package/$CORE" | sha256sum
unzip -p "$WHEEL" "$CORE" | head -1
tar -xOzf "$TGZ" "package/$CORE" | head -1
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
| `publish-npm` failed at "is this version already on npm?" (npm or the network did not answer clearly) | Nothing is published. **Re-run failed jobs** once npm answers again. |
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
  dry-run build and `check_packages.py` (wheel, sdist and tarball), the
  npm-version gate, `npm_release_state.py` against the live registry (the
  package is absent today), and the re-run branch's comparison (with a local
  tarball standing in for the registry copy). The `--github-output` hand-off
  between steps and `uv publish` with explicit file paths were not run.
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
