"""The per-harness smoke check must fail when ANY ONE harness config breaks.

This is the load-bearing property of ``scripts/harness-smoke.py`` (t12
criterion 4). All four harnesses are live for interactive use over the same
clone at all times, so a check that only exercises the harness ``culture.yaml``
declares would let three-quarters of a clone's configs rot unnoticed.

Each break test builds a faithful fixture clone from the real repo's own files,
breaks exactly one harness's config, and asserts:

* the whole check fails (non-zero exit), and
* the broken harness — and only the broken harness — is reported FAIL.

The second half matters as much as the first: it proves the check discriminates
between harnesses rather than collapsing on any perturbation.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "harness-smoke.py"


def _load_smoke():
    """Import scripts/harness-smoke.py by path (scripts/ is not a package)."""
    spec = importlib.util.spec_from_file_location("harness_smoke_under_test", SMOKE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = _load_smoke()

#: Everything a fixture clone needs for the offline ``config`` stage. Copied
#: from the real repo so the fixture cannot drift into a private fiction.
FIXTURE_FILES = (
    "docs/harness-invocations.yaml",
    "CLAUDE.md",
    "AGENTS.override.md",
    "AGENTS.colleague.md",
    "QWEN.md",
    ".pi/SYSTEM.md",
    ".claude/skills/agent-config/data/backend-fingerprints.yaml",
    ".claude/skills/cicd/SKILL.md",
)

FIXTURE_SYMLINKS = (
    (".qwen/skills", "../.claude/skills"),
    (".colleague/skills", "../.claude/skills"),
    (".pi/skills", "../.claude/skills"),
)


def _build_fixture(dest: Path) -> Path:
    for rel in FIXTURE_FILES:
        src = REPO_ROOT / rel
        assert src.is_file(), f"fixture source {rel} vanished from the repo"
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out)
    for rel, target in FIXTURE_SYMLINKS:
        link = dest / rel
        link.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, link)
    return dest


def _run_smoke(repo: Path) -> tuple[int, dict[str, str], str]:
    """Run the config stage over ``repo``; return (rc, harness->status, stdout)."""
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(repo), "--stage", "config", "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    statuses = {r["check"]: r["status"] for r in payload["results"]}
    return proc.returncode, statuses, proc.stdout


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    return _build_fixture(tmp_path / "clone")


# --- the baseline: an intact clone passes ---------------------------------


def test_smoke_passes_on_an_intact_clone(clone: Path) -> None:
    rc, statuses, out = _run_smoke(clone)
    assert rc == 0, out
    assert set(statuses) == {
        "claude",
        "pi",
        "qwen",
        "colleague",
        "fingerprint-registry",
        "no-bare-agents-md",
    }
    assert all(status == "PASS" for status in statuses.values()), out


def test_smoke_passes_on_the_real_repo() -> None:
    """The fixture is a stand-in; the real tree must pass too."""
    rc, statuses, out = _run_smoke(REPO_ROOT)
    assert rc == 0, out
    assert all(status == "PASS" for status in statuses.values()), out


# --- criterion 4: break each harness in turn ------------------------------


def _assert_only_broken(statuses: dict[str, str], rc: int, broken: str, out: str) -> None:
    assert rc != 0, f"the smoke check passed with {broken} broken:\n{out}"
    assert statuses[broken] == "FAIL", out
    for name in ("claude", "pi", "qwen", "colleague"):
        if name != broken:
            assert statuses[name] == "PASS", f"{name} collapsed too:\n{out}"


def test_smoke_fails_when_the_claude_config_is_broken(clone: Path) -> None:
    """Claude Code resolves CLAUDE.md; an empty one is not a config."""
    (clone / "CLAUDE.md").write_text("\n", encoding="utf-8")
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "claude", out)


def test_smoke_fails_when_the_pi_config_is_broken(clone: Path) -> None:
    """Pi's system prompt is .pi/SYSTEM.md; without it Pi is a stock agent."""
    (clone / ".pi" / "SYSTEM.md").unlink()
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "pi", out)


def test_smoke_fails_when_the_qwen_config_is_broken(clone: Path) -> None:
    """Qwen Code resolves QWEN.md."""
    (clone / "QWEN.md").unlink()
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "qwen", out)


def test_smoke_fails_when_the_colleague_config_is_broken(clone: Path) -> None:
    """colleague's prompt cascade resolves AGENTS.colleague.md."""
    (clone / "AGENTS.colleague.md").unlink()
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "colleague", out)


# --- the skills-discovery half of each harness's config -------------------


def test_smoke_fails_when_pi_settings_points_at_a_home_directory(clone: Path) -> None:
    link = clone / ".pi" / "skills"
    link.unlink()
    link.symlink_to("/opt/elsewhere/skills")  # absolute: breaks clone portability
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "pi", out)


def test_smoke_fails_when_qwen_skills_is_a_forked_real_directory(clone: Path) -> None:
    link = clone / ".qwen" / "skills"
    link.unlink()
    link.mkdir()
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "qwen", out)


def test_smoke_fails_when_colleague_skills_symlink_is_absolute(clone: Path) -> None:
    link = clone / ".colleague" / "skills"
    link.unlink()
    os.symlink(str(clone / ".claude" / "skills"), link)
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "colleague", out)


def test_smoke_fails_when_the_canonical_skill_tree_is_gone(clone: Path) -> None:
    """Removing the one kit breaks every harness's discovery at once."""
    shutil.rmtree(clone / ".claude" / "skills")
    rc, statuses, out = _run_smoke(clone)
    assert rc != 0
    assert [statuses[n] for n in ("claude", "pi", "qwen", "colleague")] == ["FAIL"] * 4, out
    assert statuses["fingerprint-registry"] == "FAIL", out


# --- global invariants ----------------------------------------------------


def test_smoke_fails_when_a_bare_agents_md_appears(clone: Path) -> None:
    """A bare AGENTS.md would shadow the Pi/colleague prompt cascade."""
    (clone / "AGENTS.md").write_text("# stray\n", encoding="utf-8")
    rc, statuses, out = _run_smoke(clone)
    assert rc != 0, out
    assert statuses["no-bare-agents-md"] == "FAIL", out


def test_smoke_fails_when_a_prompt_file_is_unregistered(clone: Path) -> None:
    """A prompt file no registry knows is a config that tooling cannot see."""
    registry = clone / ".claude/skills/agent-config/data/backend-fingerprints.yaml"
    registry.write_text(
        registry.read_text(encoding="utf-8").replace("QWEN.md", "QWEN-typo.md"),
        encoding="utf-8",
    )
    rc, statuses, out = _run_smoke(clone)
    _assert_only_broken(statuses, rc, "qwen", out)


def test_smoke_refuses_to_run_when_the_yaml_drops_a_harness(clone: Path) -> None:
    """A harness deleted from the YAML must abort, never silently shrink."""
    path = clone / "docs" / "harness-invocations.yaml"
    text = path.read_text(encoding="utf-8")
    head, _, _tail = text.partition("\n  qwen:")
    path.write_text(head + "\n", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(clone), "--stage", "config"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode != 0
    assert "qwen" in proc.stderr


# --- honesty: a skipped check is never a pass -----------------------------


def test_unavailable_harness_binaries_skip_loudly_and_are_not_passes() -> None:
    """The live stage must announce what it did NOT verify."""
    env = dict(os.environ, PATH="")
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(REPO_ROOT), "--stage", "live"],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    assert proc.returncode == 0, proc.stdout
    # Results on stdout, diagnostics on stderr (the repo's CLI contract).
    assert "NOT VERIFIED" in proc.stderr
    assert "NOT VERIFIED" not in proc.stdout
    for name in ("claude", "pi", "qwen", "colleague"):
        assert f"[SKIP  ] live/{name}" in proc.stdout
    assert "PASS" not in proc.stdout


def test_require_turns_a_skipped_stage_into_a_failure() -> None:
    """--require live is how a local run refuses to accept a silent skip."""
    env = dict(os.environ, PATH="")
    proc = subprocess.run(
        [
            sys.executable,
            str(SMOKE),
            "--repo",
            str(REPO_ROOT),
            "--stage",
            "live",
            "--require",
            "live",
        ],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    assert proc.returncode == 1
    assert "--require named stage(s) that skipped: live" in proc.stderr
    assert "ERROR:" not in proc.stdout


# --- the CLI output/exit-code contract ------------------------------------


def test_a_clean_run_writes_nothing_to_stderr() -> None:
    """Diagnostics on stderr must not fire when every check passed."""
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(REPO_ROOT), "--stage", "config"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stderr == ""
    assert "summary:" in proc.stdout


def test_failure_diagnostics_go_to_stderr_not_stdout(clone: Path) -> None:
    """A failing run keeps its explanation off the results stream."""
    (clone / "QWEN.md").write_text("", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(clone), "--stage", "config"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1
    assert "FAILED:" in proc.stderr
    assert "FAILED:" not in proc.stdout


def test_json_mode_stdout_stays_pure_json_when_a_check_fails(clone: Path) -> None:
    (clone / "QWEN.md").write_text("", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(clone), "--stage", "config", "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)  # would raise if diagnostics leaked in
    assert payload["failed"] >= 1


def test_an_unknown_stage_is_a_user_error_exit_1_not_environment_exit_2() -> None:
    """Exit 2 is reserved for environment/system failures, not bad input."""
    proc = subprocess.run(
        [sys.executable, str(SMOKE), "--repo", str(REPO_ROOT), "--stage", "nosuchstage"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1, proc.stderr
    assert "unknown stage(s): nosuchstage" in proc.stderr
    assert proc.stdout == ""


# --- the live stage reads the answer, not the noise -----------------------


def _live_spec(harness: str) -> dict:
    import yaml

    data = yaml.safe_load((REPO_ROOT / "docs" / "harness-invocations.yaml").read_text("utf-8"))
    return data["harnesses"][harness]


def test_a_yes_no_probe_requires_exactly_yes() -> None:
    """A hedged or negative sentence mentioning 'yes' is not an affirmative."""
    pattern, described = smoke._expectation(_live_spec("claude"))
    assert described == "exactly 'yes'"
    assert pattern.search("Yes")
    assert pattern.search("yes.")
    assert not pattern.search("No, but the answer would be yes for CLAUDE.md")
    assert not pattern.search("warning: yes/no probes may be flaky")


def test_only_stdout_can_satisfy_a_live_expectation() -> None:
    """stderr is kept for diagnostics; it must never answer the probe."""
    assert smoke._answer_lines("") == []
    assert smoke._answer_lines("\n  Yes \n\n") == ["Yes"]
    pattern, _ = smoke._expectation(_live_spec("claude"))
    # The affirmative lives only on stderr — stdout says no.
    stdout, stderr = "no\n", "note: expected answer is yes\n"
    assert not any(pattern.search(line) for line in smoke._answer_lines(stdout))
    assert "yes" in stderr  # present, and deliberately not consulted


# --- a failed external tool can never look verified -----------------------


def _fake_tool(bin_dir: Path, name: str, stdout: str, stderr: str, code: int) -> None:
    """Plant a fake ``name`` on PATH that prints ``stdout`` and exits ``code``."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    script = bin_dir / name
    # Written against the interpreter running the tests rather than /bin/sh:
    # PATH is emptied down to bin_dir, so a shell script could not find `cat`.
    script.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        f"sys.stdout.write({stdout!r})\n"
        f"sys.stderr.write({stderr!r})\n"
        f"sys.exit({code})\n",
        encoding="utf-8",
    )
    script.chmod(0o755)


@pytest.fixture
def on_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An empty PATH containing only the fake tools a test plants."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    monkeypatch.setenv("PATH", str(bin_dir))
    return bin_dir


def test_steward_exiting_nonzero_with_empty_findings_json_is_a_failure(
    on_path: Path, clone: Path
) -> None:
    """Success-shaped JSON must not launder a failed run into a PASS."""
    _fake_tool(on_path, "steward", "[]", "boom", 1)
    result = smoke.check_steward_doctor(clone, 30)
    assert result.status == "FAIL", result.detail
    assert "exited 1" in result.detail


def test_steward_exiting_zero_with_empty_findings_json_passes(on_path: Path, clone: Path) -> None:
    """The honest success path is unchanged."""
    _fake_tool(on_path, "steward", "[]", "", 0)
    result = smoke.check_steward_doctor(clone, 30)
    assert result.status == "PASS", result.detail


def test_steward_exiting_nonzero_with_no_output_skips_loudly(on_path: Path, clone: Path) -> None:
    """An unavailable tool is a SKIP — reported as not-verified, never a pass."""
    _fake_tool(on_path, "steward", "", "steward: command failed", 1)
    result = smoke.check_steward_doctor(clone, 30)
    assert result.status == "SKIP", result.detail


def test_guild_exiting_nonzero_with_a_valid_plan_is_a_failure(on_path: Path, clone: Path) -> None:
    """A dry-run that exits nonzero did not succeed, whatever it printed."""
    payload = json.dumps(
        {
            "applied": False,
            "prompt_file": "CLAUDE.md",
            "plan": {"steps": ["write CLAUDE.md"]},
        }
    )
    _fake_tool(on_path, "guild", payload, "guild: backend unavailable", 1)
    results = smoke.check_guild_create(clone, smoke.load_invocations(clone), 30)
    assert results, "expected one result per harness"
    assert all(r.status == "FAIL" for r in results), [r.detail for r in results]
    assert all("exited 1" in r.detail for r in results)


def test_guild_exiting_nonzero_with_no_output_skips_loudly(on_path: Path, clone: Path) -> None:
    _fake_tool(on_path, "guild", "", "guild: not installed", 127)
    results = smoke.check_guild_create(clone, smoke.load_invocations(clone), 30)
    assert all(r.status == "SKIP" for r in results), [r.detail for r in results]


# --- the helpers behind stage_config and check_guild_create, branch by branch ---
#
# The two stage functions are thin loops over these helpers; each helper is
# called here directly, with a stub in place of the tool, once per outcome.


def test_resolve_problems_is_empty_for_a_registered_present_file(clone: Path) -> None:
    by_backend = smoke.registry_prompts_by_backend(clone)
    assert smoke._resolve_problems(clone, "claude", ["CLAUDE.md"], by_backend) == []


def test_resolve_problems_names_each_fault(clone: Path) -> None:
    by_backend = smoke.registry_prompts_by_backend(clone)
    assert smoke._resolve_problems(clone, "claude", [], by_backend) == [
        "the YAML lists no `resolves` paths for this harness"
    ]
    (clone / "CLAUDE.md").write_text("  \n", encoding="utf-8")
    problems = smoke._resolve_problems(clone, "claude", ["CLAUDE.md", "nope.md"], by_backend)
    assert problems[0] == "CLAUDE.md is empty"
    assert problems[1] == "nope.md is missing"
    assert problems[2].startswith("nope.md is not registered under backend 'claude' in ")
    assert len(problems) == 3


def test_config_harness_result_passes_and_fails(clone: Path) -> None:
    by_backend = smoke.registry_prompts_by_backend(clone)
    spec = smoke.load_invocations(clone)["claude"]
    good = smoke._config_harness_result(clone, "claude", spec, by_backend)
    assert (good.stage, good.name, good.status) == ("config", "claude", "PASS")
    assert good.detail == "resolves CLAUDE.md; skills discovery wired"
    bad = smoke._config_harness_result(clone, "claude", {"resolves": ["nope.md"]}, by_backend)
    assert (bad.stage, bad.name, bad.status) == ("config", "claude", "FAIL")
    assert bad.detail.startswith("nope.md is missing; nope.md is not registered")


def test_fingerprint_registry_result_passes_and_fails() -> None:
    good = smoke._fingerprint_registry_result({"claude": ("CLAUDE.md",), "pi": ("a", "b")})
    assert (good.name, good.status) == ("fingerprint-registry", "PASS")
    assert "registers 3 prompt path(s) across 2 backend(s)" in good.detail
    bad = smoke._fingerprint_registry_result({})
    assert (bad.name, bad.status) == ("fingerprint-registry", "FAIL")
    assert "missing, unreadable, or registers no prompt paths" in bad.detail


def test_bare_agents_md_result_passes_and_fails(clone: Path) -> None:
    good = smoke._bare_agents_md_result(clone)
    assert (good.name, good.status) == ("no-bare-agents-md", "PASS")
    (clone / "AGENTS.md").write_text("x\n", encoding="utf-8")
    bad = smoke._bare_agents_md_result(clone)
    assert (bad.name, bad.status) == ("no-bare-agents-md", "FAIL")
    assert bad.detail.startswith("AGENTS.md exists")


def test_stage_config_reports_an_unreadable_registry(clone: Path) -> None:
    (clone / smoke.FINGERPRINTS_REL).unlink()
    results = smoke.stage_config(clone, smoke.load_invocations(clone))
    statuses = {r.name: r.status for r in results}
    assert statuses["fingerprint-registry"] == "FAIL"
    assert statuses["no-bare-agents-md"] == "PASS"
    assert all(statuses[name] == "FAIL" for name in smoke.HARNESSES)


def _guild_payload(expected: str, **changes: object) -> dict:
    payload: dict = {"prompt_file": expected, "plan": {"steps": ["mkdir", f"write {expected}"]}}
    payload.update(changes)
    return payload


def test_guild_payload_result_accepts_a_plan_that_names_and_writes_the_file() -> None:
    result = smoke._guild_payload_result(
        "claude", "claude", "CLAUDE.md", _guild_payload("CLAUDE.md")
    )
    assert (result.stage, result.name, result.status) == (
        "toolchain",
        "guild-create/claude",
        "PASS",
    )
    assert result.detail == "--harness claude names and writes CLAUDE.md"


@pytest.mark.parametrize(
    ("changes", "expected_detail"),
    [
        ({"applied": True}, "guild create reported applied=true for a dry-run"),
        (
            {"prompt_file": "X.md"},
            "--harness claude named prompt_file 'X.md', expected 'CLAUDE.md'",
        ),
        (
            {"plan": {"steps": ["write other"]}},
            "--harness claude declares prompt_file 'CLAUDE.md' but no planned step "
            "writes it: write other",
        ),
        (
            {"plan": None},
            "--harness claude declares prompt_file 'CLAUDE.md' but no planned step writes it: ",
        ),
    ],
    ids=["applied", "wrong-prompt-file", "no-step-writes-it", "no-plan"],
)
def test_guild_payload_result_fails_each_wrong_plan(changes: dict, expected_detail: str) -> None:
    payload = _guild_payload("CLAUDE.md", **changes)
    result = smoke._guild_payload_result("claude", "claude", "CLAUDE.md", payload)
    assert (result.name, result.status) == ("guild-create/claude", "FAIL")
    assert result.detail == expected_detail


def test_guild_exit_result_skips_without_output_and_fails_with_it() -> None:
    silent = subprocess.CompletedProcess(["guild"], 127, "  \n", "not installed\n")
    skipped = smoke._guild_exit_result("pi", "pi", silent)
    assert (skipped.name, skipped.status) == ("guild-create/pi", "SKIP")
    assert skipped.detail == "guild create unavailable (exit 127): not installed"
    spoke = subprocess.CompletedProcess(["guild"], 3, "{}", "backend down")
    failed = smoke._guild_exit_result("pi", "pi", spoke)
    assert (failed.name, failed.status) == ("guild-create/pi", "FAIL")
    assert failed.detail == "guild create exited 3 for --harness pi: backend down"


def _stub_guild(monkeypatch: pytest.MonkeyPatch, outcome) -> list[list[str]]:
    """Replace the tool runner; ``outcome(argv, expected)`` answers or raises."""
    calls: list[list[str]] = []
    expected_by_guild_name = dict(smoke.GUILD_HARNESS.values())

    def fake_run(argv: list[str], cwd: Path, timeout: int) -> subprocess.CompletedProcess:
        calls.append(argv)
        return outcome(argv, expected_by_guild_name[argv[argv.index("--harness") + 1]])

    monkeypatch.setattr(smoke, "_run", fake_run)
    return calls


def _guild_one(clone: Path, name: str, harnesses: dict | None = None):
    harnesses = harnesses or smoke.load_invocations(clone)
    return smoke._guild_create_result(clone, ["guild"], name, harnesses, 5)


def test_guild_create_result_passes_on_a_good_dry_run(
    clone: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _stub_guild(
        monkeypatch,
        lambda argv, expected: subprocess.CompletedProcess(
            argv, 0, json.dumps(_guild_payload(expected)), ""
        ),
    )
    for name in smoke.HARNESSES:
        result = _guild_one(clone, name)
        assert (result.name, result.status) == (f"guild-create/{name}", "PASS"), result.detail
    assert len(calls) == len(smoke.HARNESSES)
    assert calls[0][:2] == ["guild", "create"]
    assert calls[0][-1] == "--json"


def test_guild_create_result_fails_without_running_when_the_yaml_drops_the_file(
    clone: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _stub_guild(monkeypatch, lambda argv, expected: pytest.fail("guild must not be run"))
    harnesses = smoke.load_invocations(clone)
    harnesses["qwen"] = dict(harnesses["qwen"], resolves=[])
    result = _guild_one(clone, "qwen", harnesses)
    assert (result.name, result.status) == ("guild-create/qwen", "FAIL")
    assert "is not among this harness's resolves []" in result.detail
    assert calls == []


@pytest.mark.parametrize(
    "error",
    [OSError("boom"), subprocess.TimeoutExpired(["guild"], 5)],
    ids=["os-error", "timeout"],
)
def test_guild_create_result_skips_when_guild_cannot_be_run(
    clone: Path, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    def outcome(argv: list[str], expected: str):
        raise error

    _stub_guild(monkeypatch, outcome)
    result = _guild_one(clone, "claude")
    assert (result.name, result.status) == ("guild-create/claude", "SKIP")
    assert result.detail.startswith("could not run guild: ")


def test_guild_create_result_judges_a_nonzero_exit(
    clone: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_guild(
        monkeypatch, lambda argv, expected: subprocess.CompletedProcess(argv, 2, "", "gone")
    )
    result = _guild_one(clone, "claude")
    assert (result.status, result.detail) == ("SKIP", "guild create unavailable (exit 2): gone")


def test_guild_create_result_fails_on_unparseable_output(
    clone: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_guild(
        monkeypatch, lambda argv, expected: subprocess.CompletedProcess(argv, 0, "not json", "")
    )
    result = _guild_one(clone, "claude")
    assert result.status == "FAIL"
    assert result.detail == "guild create --json emitted unparseable output: not json"


def test_check_guild_create_skips_once_when_no_tool_is_available(
    clone: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(smoke, "_tool_argv", lambda binary, dist: None)
    results = smoke.check_guild_create(clone, smoke.load_invocations(clone), 5)
    assert [(r.name, r.status) for r in results] == [("guild-create", "SKIP")]
    assert "were NOT run" in results[0].detail


def test_check_guild_create_gives_one_result_per_harness(
    clone: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(smoke, "_tool_argv", lambda binary, dist: [binary])
    _stub_guild(
        monkeypatch,
        lambda argv, expected: subprocess.CompletedProcess(
            argv, 0, json.dumps(_guild_payload(expected)), ""
        ),
    )
    results = smoke.check_guild_create(clone, smoke.load_invocations(clone), 5)
    assert [r.name for r in results] == [f"guild-create/{name}" for name in smoke.HARNESSES]
    assert all(r.status == "PASS" for r in results)
