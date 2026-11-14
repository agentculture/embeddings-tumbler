"""Keeps ``docs/reference-differences.md`` and the side-by-side page honest (task t17).

The document lists every intended difference from the reference demo, starting
with fonts, and ends with the user's sign-off. The agent prepares the document;
only the user signs off. So these tests pass while the sign-off is open, and
keep passing once the real sign-off is recorded, but they fail if the document
claims a sign-off without the agreed line, or keeps saying "not yet recorded"
after one is added.

The agreed form of the recorded sign-off is one line that starts at the left
margin::

    Signed off by the user on YYYY-MM-DD: <the user's words>

The words may also follow on the next non-blank line.
"""

from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "docs" / "reference-differences.md"
SBS = ROOT / "js" / "dev" / "side-by-side"
SIGNED = re.compile(r"^Signed off by the user on (\d{4}-\d{2}-\d{2}):(.*)$", re.MULTILINE)
VISIBLE = re.compile(r"^- \*\*Visible on the sample set:\*\* (\w+)", re.MULTILINE)


def _text() -> str:
    return DOC.read_text(encoding="utf-8")


def _sections(text: str) -> list[tuple[str, str]]:
    """The (title, body) of every ``##`` section, in order. Fenced code is skipped."""
    out: list[tuple[str, list[str]]] = []
    fenced = False
    for line in text.splitlines():
        if line.startswith("```"):
            fenced = not fenced
        match = None if fenced else re.match(r"^## (.+)$", line)
        if match:
            out.append((match.group(1).strip(), []))
        elif out:
            out[-1][1].append(line)
    return [(title, "\n".join(body)) for title, body in out]


def _groups(text: str) -> list[dict]:
    """Every ``##`` section that has ``###`` items, with each item's title and its
    "Visible on the sample set" word, as the checklist file records them."""
    groups = []
    for title, body in _sections(text):
        items = []
        for chunk in re.split(r"^### ", body, flags=re.MULTILINE)[1:]:
            heading, _, rest = chunk.partition("\n")
            found = VISIBLE.search(rest)
            items.append(
                {
                    "title": heading.strip().replace("`", ""),
                    "visible": found.group(1).lower() if found else "",
                }
            )
        if items:
            groups.append({"group": title, "items": items})
    return groups


def test_document_exists_and_starts_with_fonts():
    assert DOC.is_file()
    sections = _sections(_text())
    assert sections, "no sections"
    assert sections[0][0] == "Fonts"
    assert (ROOT / "docs" / "reference-differences-fonts.md").exists() is False


def test_required_sections_in_order():
    titles = [title for title, _ in _sections(_text())]
    for name in (
        "Unintended differences found",
        "Not yet compared or not yet decided",
        "Sign-off",
    ):
        assert name in titles, name
    assert titles[-1] == "Sign-off"
    assert titles.index("Unintended differences found") < titles.index(
        "Not yet compared or not yet decided"
    )


def test_every_difference_says_whether_it_is_visible():
    for group in _groups(_text()):
        for item in group["items"]:
            assert item["visible"] in {"yes", "no", "slightly", "unknown"}, item["title"]


def test_no_task_ids_or_agent_names():
    # The document is for a reader who has not followed the build.
    assert not re.search(r"\bt\d{1,2}\b", _text())
    assert "agent" not in _text().lower().replace("user agent", "")


def _check_sign_off(text: str) -> str:
    """Return "open" or "recorded"; raise AssertionError when the text contradicts itself."""
    body = dict(_sections(text))["Sign-off"]
    recorded = SIGNED.search(text)
    if recorded is None:
        assert "not yet recorded" in body.lower()
        assert "approved" not in text.lower()
        return "open"
    words = recorded.group(2).strip()
    if not words:
        after = text[recorded.end() :].strip().splitlines()
        words = after[0].strip() if after else ""
    assert words, "the sign-off line must carry the user's words"
    assert "not yet recorded" not in body.lower()
    assert recorded.start() > text.index("## Sign-off")
    return "recorded"


def test_sign_off_is_open_unless_the_agreed_line_is_present():
    # Passes while the sign-off is open and after the real one is recorded.
    assert _check_sign_off(_text()) in {"open", "recorded"}


def test_sign_off_check_accepts_a_recorded_line_and_rejects_contradictions():
    text = _text()
    if SIGNED.search(text):
        pytest.skip("the real sign-off is recorded")
    signed = text.replace("is **not yet recorded**", "is recorded").rstrip("\n")
    signed += "\nSigned off by the user on 2026-11-20: looks right to me\n"
    assert _check_sign_off(signed) == "recorded"
    # a recorded line while the document still says "not yet recorded" is refused
    with pytest.raises(AssertionError):
        _check_sign_off(text.rstrip("\n") + "\nSigned off by the user on 2026-11-20: ok\n")
    # a recorded line without the user's words is refused
    with pytest.raises(AssertionError):
        _check_sign_off(signed.rsplit("\n", 2)[0] + "\nSigned off by the user on 2026-11-20:\n")
    # saying it is signed off without the line is refused
    with pytest.raises(AssertionError):
        _check_sign_off(text.replace("is **not yet recorded**", "is recorded"))


def test_the_form_line_in_the_instruction_is_not_a_recorded_sign_off():
    # The instruction shows the form with placeholders; it must not count as a sign-off.
    assert SIGNED.search("```text\nSigned off by the user on YYYY-MM-DD: words\n```") is None


def test_checklist_matches_the_document():
    data = json.loads((SBS / "checklist.json").read_text(encoding="utf-8"))
    assert data["groups"] == _groups(_text())


class _Collect(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict[str, str | None]]] = []
        self.script_bodies: list[str] = []
        self._script = False

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))
        self._script = tag == "script"

    def handle_startendtag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def handle_endtag(self, tag):
        if tag == "script":
            self._script = False

    def handle_data(self, data):
        if self._script:
            self.script_bodies.append(data)


def test_side_by_side_page_is_plain_and_points_at_the_two_pages():
    for name in ("index.html", "page.css", "page.js", "README.md", "checklist.json"):
        assert (SBS / name).is_file(), name
    parser = _Collect()
    parser.feed((SBS / "index.html").read_text(encoding="utf-8"))
    assert not any(body.strip() for body in parser.script_bodies), "inline script"
    assert not [t for t, _ in parser.tags if t == "style"], "style element"
    for tag, attrs in parser.tags:
        assert "style" not in attrs, f"style attribute on <{tag}>"
        assert not any(k.startswith("on") for k in attrs), f"inline handler on <{tag}>"
    frames = {a.get("id"): a.get("src") for t, a in parser.tags if t == "iframe"}
    assert frames["frame-ref"].startswith("/docs/specs/reference/embedding-tumbler-demo.html")
    assert frames["frame-build"].startswith("/embeddings_tumbler/static/index.html")
    assert (ROOT / frames["frame-ref"].split("#")[0].lstrip("/")).is_file()
    assert (ROOT / frames["frame-build"].split("?")[0].lstrip("/")).is_file()
    meta = [a for t, a in parser.tags if t == "meta" and a.get("http-equiv")]
    assert "script-src 'self'" in (meta[0]["content"] or "")


def test_side_by_side_page_is_not_shipped():
    # The wheel packages only ``embeddings_tumbler``; the page lives under js/dev.
    assert "embeddings_tumbler" not in SBS.parts[-4:]
    assert not list((ROOT / "embeddings_tumbler").rglob("side-by-side*"))


@pytest.mark.parametrize("name", ["page.js", "page.css", "index.html"])
def test_side_by_side_page_loads_nothing_from_elsewhere(name):
    text = (SBS / name).read_text(encoding="utf-8")
    assert "http://" not in text and "https://" not in text
