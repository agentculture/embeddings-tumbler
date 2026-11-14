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
    assert "id-token" not in text and "environment:" not in text
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
    # Each production publish job re-checks the very file it uploads, first.
    npm = jobs["publish-npm"]
    assert _step_index(npm, r"check_packages\.py") < _step_index(npm, r"npm publish")
    pypi = jobs["publish"]
    assert _step_index(pypi, r"check_packages\.py --wheel dist/") < _step_index(pypi, r"uv publish")


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
    # No credential is handed to npm: no env blocks, no registry-url .npmrc.
    assert "env" not in job
    for step in job["steps"]:
        assert "env" not in step
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
