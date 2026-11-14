"""t13: the CI and publish workflows, checked statically (nothing here runs Actions).

- every action is pinned to a full commit SHA with a version comment;
- every job declares least-privilege permissions, and an OIDC token is requested
  only by a publish job that runs in a named GitHub environment;
- the only CI secret referenced anywhere is the SonarCloud token (registry
  tokens are banned outright by scripts/scan-secrets.py, check 3);
- a pull request dry-run builds both packages and publishes nothing;
- the publish workflow checks byte identity before either registry is touched,
  publishes npm by trusted publishing with provenance, and keeps the existing
  TestPyPI / PyPI guards;
- the test workflow runs node --test and every generated-file check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"
FILES = sorted(WORKFLOWS.glob("*.yml"))
PUBLISH_CMD = re.compile(r"\b(?:npm|uv|twine)\s+publish\b")


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _triggers(doc: dict) -> dict:
    # PyYAML reads the bare key `on` as the boolean True.
    return doc.get("on", doc.get(True))


def _run_text(job: dict) -> str:
    return "\n".join(step.get("run", "") for step in job.get("steps", []))


def _step_index(job: dict, pattern: str) -> int:
    for i, step in enumerate(job.get("steps", [])):
        if re.search(pattern, step.get("run", "")):
            return i
    raise AssertionError(f"no step matches {pattern!r}")


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_workflow_parses_and_every_job_declares_permissions(path: Path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert doc["jobs"], path.name
    for name, job in doc["jobs"].items():
        perms = job.get("permissions", doc.get("permissions"))
        assert isinstance(perms, dict), f"{path.name}:{name} has no permissions block"
        assert perms.get("contents") in ("read", None), f"{path.name}:{name}"
        for scope, level in perms.items():
            assert level in ("read", "write", "none"), (path.name, name, scope)


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_every_action_is_pinned_to_a_full_sha_with_a_version_comment(path: Path):
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not re.match(r"\s*-?\s*uses:", line):
            continue
        assert re.search(
            r"uses:\s*[\w.-]+/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d", line
        ), f"{path.name}:{lineno} is not pinned to a 40-char SHA with a # vN comment: {line}"


def test_the_only_ci_secret_is_the_sonar_token():
    for path in FILES:
        names = set(
            re.findall(r"(?<![\w-])secrets\.([A-Za-z_]\w*)", path.read_text(encoding="utf-8"))
        )
        assert names <= {"SONAR_TOKEN"}, (path.name, names)


def test_oidc_is_requested_only_by_publish_jobs_in_an_environment():
    for path in FILES:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert (doc.get("permissions") or {}).get("id-token") is None, path.name
        for name, job in doc["jobs"].items():
            wants_oidc = (job.get("permissions") or {}).get("id-token") == "write"
            publishes = bool(PUBLISH_CMD.search(_run_text(job)))
            assert wants_oidc == publishes, f"{path.name}:{name}"
            if wants_oidc:
                assert job.get("environment"), f"{path.name}:{name} needs an environment"


# ---------------------------------------------------------------------------
# packages.yml: the pull-request dry run of both packages (criterion 3)
# ---------------------------------------------------------------------------


def test_pull_requests_dry_run_both_packages_without_publishing():
    doc = _load("packages.yml")
    assert "pull_request" in _triggers(doc)
    text = (WORKFLOWS / "packages.yml").read_text(encoding="utf-8")
    assert not PUBLISH_CMD.search(text)
    assert "id-token" not in text
    assert "environment:" not in text
    job = doc["jobs"]["dry-run"]
    assert "scripts/check_packages.py" in _run_text(job)
    assert not job.get("if"), "the dry run must run on every pull request"


# ---------------------------------------------------------------------------
# publish.yml: ordering, guards and trusted publishing (criteria 1 and 2)
# ---------------------------------------------------------------------------


def test_publish_triggers_mirror_the_existing_paths_plus_package_json():
    on = _triggers(_load("publish.yml"))
    for event in ("push", "pull_request"):
        assert on[event]["branches"] == ["main"]
        assert set(on[event]["paths"]) == {
            "pyproject.toml",
            "package.json",
            "embeddings_tumbler/**",
        }


def test_byte_identity_check_gates_every_publish_job():
    jobs = _load("publish.yml")["jobs"]
    assert "scripts/check_packages.py" in _run_text(jobs["verify-packages"])
    for name in ("test-publish", "publish-npm", "publish"):
        assert "verify-packages" in jobs[name]["needs"], name
        assert "test" in jobs[name]["needs"], name
    # Each production publish job re-checks the very files it uploads, first,
    # and uploads exactly the paths the check printed (no globbing).
    npm = jobs["publish-npm"]
    build = _step_index(npm, r"check_packages\.py --out-dir \S+ --github-output")
    assert npm["steps"][build]["id"] == "build"
    assert build < _step_index(npm, r"npm publish")
    publish_step = npm["steps"][_step_index(npm, r"npm publish")]
    assert publish_step["env"] == {"TARBALL": "${{ steps.build.outputs.tarball }}"}
    pypi = jobs["publish"]
    build = _step_index(pypi, r"check_packages\.py --out-dir \S+ --github-output")
    assert pypi["steps"][build]["id"] == "build"
    upload = _step_index(pypi, r"uv publish")
    assert build < upload
    assert pypi["steps"][upload]["run"].rstrip().endswith('"$WHEEL" "$SDIST"')
    assert pypi["steps"][upload]["env"] == {
        "WHEEL": "${{ steps.build.outputs.wheel }}",
        "SDIST": "${{ steps.build.outputs.sdist }}",
    }


def test_no_step_globs_or_ls_for_package_paths():
    for path in FILES:
        text = path.read_text(encoding="utf-8")
        assert "$(ls" not in text, path.name
        assert not re.search(r"dist[\w-]*/\*\.(?:whl|tgz|tar\.gz)", text), path.name


def test_npm_already_published_is_decided_by_the_fail_closed_script():
    job = _load("publish.yml")["jobs"]["publish-npm"]
    steps = job["steps"]
    state = _step_index(job, r"scripts/npm_release_state\.py")
    assert steps[state]["id"] == "npm"
    assert "|| true" not in steps[state]["run"]
    assert "2>/dev/null" not in steps[state]["run"]
    compare = steps[_step_index(job, r"--registry-tarball")]
    publish = steps[_step_index(job, r"npm publish")]
    assert compare["if"] == "steps.npm.outputs.state == 'present'"
    assert publish["if"] == "steps.npm.outputs.state == 'absent'"
    assert state < _step_index(job, r"--registry-tarball")
    assert state < _step_index(job, r"npm publish")
    assert "npm view" not in _run_text(job), "npm view lives in the tested script only"


def test_npm_publishes_first_and_pypi_waits_for_it():
    jobs = _load("publish.yml")["jobs"]
    assert "publish-npm" in jobs["publish"]["needs"]
    assert "publish" not in jobs["publish-npm"]["needs"]


def test_npm_job_uses_trusted_publishing_only():
    job = _load("publish.yml")["jobs"]["publish-npm"]
    assert job["if"] == "github.event_name == 'push'"
    assert job["environment"] == "npm"
    assert job["permissions"] == {"contents": "read", "id-token": "write"}
    run = _run_text(job)
    assert re.search(r"npm publish \"\$TARBALL\" --provenance --access public", run)
    assert re.search(r"npm install -g npm@11\.(\d+)\.\d+", run)
    minor = int(re.search(r"npm@11\.(\d+)\.(\d+)", run).group(1))
    assert minor >= 6 or (minor == 5 and "npm@11.5.1" in run), "trusted publishing needs >= 11.5.1"
    # No credential is handed to npm: env only carries earlier steps' outputs,
    # and no registry-url .npmrc.
    assert "env" not in job
    for step in job["steps"]:
        for value in (step.get("env") or {}).values():
            assert re.fullmatch(r"\$\{\{ steps\.\w+\.outputs\.\w+ \}\}", value), value
        assert "registry-url" not in (step.get("with") or {})
        assert "token" not in step.get("run", "").lower().replace("id-token", "")


def test_existing_pypi_guards_are_kept():
    jobs = _load("publish.yml")["jobs"]
    tp = jobs["test-publish"]
    assert tp["if"] == (
        "github.event_name == 'pull_request' && "
        "github.event.pull_request.head.repo.full_name == github.repository"
    )
    assert tp["environment"] == "testpypi"
    assert "--trusted-publishing always" in _run_text(tp)
    assert "test.pypi.org/legacy/" in _run_text(tp)
    prod = jobs["publish"]
    assert prod["if"] == "github.event_name == 'push'"
    assert prod["environment"] == "pypi"
    assert "uv publish --trusted-publishing always" in _run_text(prod)
    # Both the wheel and the sdist go to PyPI, as before t13; both are checked.
    assert '"$WHEEL" "$SDIST"' in _run_text(prod)


# ---------------------------------------------------------------------------
# tests.yml: node tests and generated-file checks
# ---------------------------------------------------------------------------


def test_test_job_runs_node_and_every_generated_file_check():
    doc = _load("tests.yml")
    run = _run_text(doc["jobs"]["test"])
    for command in (
        "node --test",
        "python3 scripts/assemble.py --check",
        "python3 scripts/sync_sample.py --check",
        "python3 scripts/sync_static.py --check",
        "python3 scripts/sync_version.py --check",
    ):
        assert command in run, command
    names = [step.get("name") for step in doc["jobs"]["test"]["steps"]]
    assert "SonarCloud Scan" in names
    assert {"lint", "harness-smoke", "version-check"} <= set(doc["jobs"])


# ---------------------------------------------------------------------------
# Installs: locked versions, no build or lifecycle scripts run
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_uv_installs_only_locked_built_distributions(path: Path):
    # `uv sync` and `uv run` (which syncs first) install exactly uv.lock (--locked fails
    # when it is stale) and never build a source distribution (--no-build runs no setup code).
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        for match in re.finditer(r"\buv\s+(sync|run)\b(.*)", line):
            assert "--locked" in match.group(2).split(), f"{path.name}:{lineno}: {line.strip()}"
            assert "--no-build" in match.group(2).split(), f"{path.name}:{lineno}: {line.strip()}"


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_npm_installs_run_no_lifecycle_scripts(path: Path):
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if re.search(r"\bnpm\s+(install|i|ci)\b", line):
            assert "--ignore-scripts" in line.split(), f"{path.name}:{lineno}: {line.strip()}"


def test_no_workflow_carries_a_todo():
    for path in FILES:
        assert "TODO" not in path.read_text(encoding="utf-8"), path.name


# ---------------------------------------------------------------------------
# Shell robustness in every run: step
# ---------------------------------------------------------------------------


def _steps(path: Path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    for job_name, job in doc["jobs"].items():
        for step in job.get("steps", []):
            if "run" in step:
                yield f"{path.name}:{job_name}:{step.get('name', step['run'][:40])}", step


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_every_workflow_runs_steps_under_explicit_bash(path: Path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert doc.get("defaults", {}).get("run", {}).get("shell") == "bash", path.name
    for label, step in _steps(path):
        assert step.get("shell", "bash") == "bash", label


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_multi_line_steps_start_with_strict_mode(path: Path):
    for label, step in _steps(path):
        lines = [ln for ln in step["run"].strip().splitlines() if ln.strip()]
        if len(lines) > 1:
            assert lines[0].strip() == "set -euo pipefail", label


def _unquoted_expansions(script: str) -> list[str]:
    """$VAR / ${VAR} references outside double quotes.

    Single quotes and ${{ }} expressions are skipped. A $( ) substitution opens
    a fresh quoting context (as in bash), so "$(cmd "$X")" counts $X as quoted.
    """
    script = re.sub(r"\$\{\{.*?\}\}", "X", script)
    script = "\n".join(ln for ln in script.splitlines() if not ln.strip().startswith("#"))
    found, stack, i = [], ["top"], 0
    while i < len(script):
        ch = script[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "'" and stack[-1] != "dq":
            end = script.find("'", i + 1)
            i = len(script) if end == -1 else end + 1
            continue
        if script.startswith("$(", i):
            stack.append("cmd")
            i += 2
            continue
        if ch == ")" and stack[-1] == "cmd":
            stack.pop()
        elif ch == '"':
            if stack[-1] == "dq":
                stack.pop()
            else:
                stack.append("dq")
        elif ch == "$" and stack[-1] != "dq":
            match = re.match(r"\$\{?[A-Za-z_]\w*", script[i:])
            if match:
                found.append(match.group(0))
        i += 1
    return found


def test_the_quoting_check_bites():
    assert _unquoted_expansions("tar -tzf $TARBALL") == ["$TARBALL"]
    assert _unquoted_expansions('tar -tzf "$TARBALL"') == []
    assert _unquoted_expansions("echo '$NOT_EXPANDED' ${{ github.sha }}") == []
    assert _unquoted_expansions('V="$(cmd "$X")"') == []
    assert _unquoted_expansions('V="$(cmd $X)"') == ["$X"]


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_shell_variables_are_quoted(path: Path):
    for label, step in _steps(path):
        assert _unquoted_expansions(step["run"]) == [], label
