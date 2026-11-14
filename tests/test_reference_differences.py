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

The search part of the document (every ``##`` section whose title starts with
"Search") follows the first comparison and has its own sign-off in its last
section, "Search: sign-off". Its recorded form is::

    Search signed off by the owner on YYYY-MM-DD: <the owner's words>

Each search difference also says who decided it ("Decided by": the owner, the
spec, the build, or open). The search sign-off may be open. It is a
contradiction, and a failure here, when a line claims the sign-off without a
date, a name or words, when a recorded line stands beside "not yet recorded",
when the section says it is recorded without the line, or when it is recorded
while a difference is still marked open.
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
VISIBLE = re.compile(
    r"^- \*\*Visible on (?:the sample set|comparable data):\*\* (\w+)", re.MULTILINE
)
SEARCH = "Search"
SEARCH_SIGN_OFF = "Search: sign-off"
SEARCH_SIGNED = re.compile(
    r"^Search signed off by the owner on (\d{4}-\d{2}-\d{2}):(.*)$", re.MULTILINE
)
SEARCH_CLAIM = re.compile(r"^Search signed off\b.*$", re.MULTILINE)
DECIDED = re.compile(r"^- \*\*Decided by:\*\* (\w+)", re.MULTILINE)
DECIDERS = {"owner", "spec", "build", "open"}
NOT_YET = "not yet recorded"
CLAIMED = ("is **not yet recorded**", "is recorded")
REFERENCES = (
    "embedding-tumbler-demo.html",
    "tumbler-sky-search.html",
    "tumbler-focus-view.html",
)
SBS_FILES = (
    "index.html",
    "page.css",
    "page.js",
    "focus-build.html",
    "focus-build.js",
    "focus-build.css",
)


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
    # The first comparison ends with its sign-off; the search part follows it.
    first = [title for title in titles if not title.startswith(SEARCH)]
    assert first[-1] == "Sign-off"
    assert titles[: len(first)] == first
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
    still_open = text.rstrip("\n") + "\nSigned off by the user on 2026-11-20: ok\n"
    with pytest.raises(AssertionError):
        _check_sign_off(still_open)
    # a recorded line without the user's words is refused
    no_words = signed.rsplit("\n", 2)[0] + "\nSigned off by the user on 2026-11-20:\n"
    with pytest.raises(AssertionError):
        _check_sign_off(no_words)
    # saying it is signed off without the line is refused
    claimed = text.replace("is **not yet recorded**", "is recorded")
    with pytest.raises(AssertionError):
        _check_sign_off(claimed)


def test_the_form_line_in_the_instruction_is_not_a_recorded_sign_off():
    # The instruction shows the form with placeholders; it must not count as a sign-off.
    assert SIGNED.search("```text\nSigned off by the user on YYYY-MM-DD: words\n```") is None


def _search_sections(text: str) -> list[tuple[str, str]]:
    return [(title, body) for title, body in _sections(text) if title.startswith(SEARCH)]


def _search_items(text: str) -> list[tuple[str, str]]:
    """The (title, body) of every ``###`` difference in the search part."""
    items = []
    for _, body in _search_sections(text):
        for chunk in re.split(r"^### ", body, flags=re.MULTILINE)[1:]:
            heading, _, rest = chunk.partition("\n")
            items.append((heading.strip(), rest))
    return items


def _decided(body: str) -> str:
    found = DECIDED.search(body)
    return found.group(1).lower() if found else ""


def _claims(text: str) -> list[str]:
    """Every line that claims the search sign-off. The form shown in fenced code is not one."""
    out = []
    fenced = False
    for line in text.splitlines():
        if line.startswith("```"):
            fenced = not fenced
        elif not fenced and SEARCH_CLAIM.match(line):
            out.append(line)
    return out


def _check_search_sign_off(text: str) -> str:
    """Return "open" or "recorded"; raise AssertionError when the text contradicts itself."""
    sections = _search_sections(text)
    assert sections, "no search part"
    title, body = sections[-1]
    assert title == SEARCH_SIGN_OFF
    start = text.index("## " + SEARCH_SIGN_OFF)
    claims = _claims(text[start:])
    recorded = SEARCH_SIGNED.search(text, start)
    still_open = [name for name, rest in _search_items(text) if _decided(rest) == "open"]
    if recorded is None:
        assert not claims, "a search sign-off line without the agreed name and date"
        assert NOT_YET in body.lower()
        return "open"
    assert len(claims) == 1, "more than one search sign-off line"
    words = recorded.group(2).strip()
    if not words:
        after = text[recorded.end() :].strip().splitlines()
        words = after[0].strip() if after else ""
    assert words, "the search sign-off line must carry the owner's words"
    assert NOT_YET not in body.lower()
    assert not still_open, f"signed off while still open: {still_open}"
    return "recorded"


def test_search_part_follows_the_first_comparison_and_ends_with_its_sign_off():
    titles = [title for title, _ in _sections(_text())]
    search = [title for title in titles if title.startswith(SEARCH)]
    assert len(search) >= 3
    assert titles[-len(search) :] == search
    assert search[-1] == SEARCH_SIGN_OFF
    assert titles.index("Sign-off") == len(titles) - len(search) - 1


def test_first_sign_off_is_unchanged_by_the_search_part():
    recorded = SIGNED.findall(_text())
    assert len(recorded) == 1
    assert recorded[0][0] == "2026-11-14"
    assert recorded[0][1].strip() == "confirmed, light -> soft ink is ok, the two others not."


def test_search_part_names_both_search_references():
    body = "\n".join(body for _, body in _search_sections(_text()))
    for name in REFERENCES[1:]:
        assert name in body, name


def test_every_search_difference_has_its_five_lines():
    items = _search_items(_text())
    assert len(items) >= 20
    for title, rest in items:
        for line in ("Reference", "Build", "Why"):
            assert f"- **{line}:**" in rest, f"{title}: {line}"
        assert "- **Visible on comparable data:**" in rest, title
        assert _decided(rest) in DECIDERS, title


def test_search_differences_named_in_the_plan_are_listed():
    titles = " | ".join(title.lower() for title, _ in _search_items(_text()))
    for words in ("embedded by the host", "reranker", "plain canvas", "four searches"):
        assert words in titles, words


def test_search_open_items_say_that_nothing_was_decided():
    opened = [(title, rest) for title, rest in _search_items(_text()) if _decided(rest) == "open"]
    assert len(opened) >= 2
    for title, rest in opened:
        decided = rest[DECIDED.search(rest).start() :].lower()
        assert "not decided" in decided or "not approved" in decided, title


def test_search_sign_off_is_open_or_recorded_without_contradiction():
    assert _check_search_sign_off(_text()) in {"open", "recorded"}


GOOD_LINE = "Search signed off by the owner on 2026-11-20: looks right to me"
DECIDED_LINE = "- **Decided by:** owner."


def _signed_search_text(line: str) -> str:
    """The document with every open search item decided and ``line`` as the sign-off."""
    text = _text().replace(*CLAIMED)
    text = re.sub(r"^- \*\*Decided by:\*\* open\b.*$", DECIDED_LINE, text, flags=re.MULTILINE)
    return text.rstrip("\n") + "\n\n" + line + "\n"


def test_search_sign_off_check_accepts_a_recorded_line():
    if SEARCH_SIGNED.search(_text()):
        pytest.skip("the real search sign-off is recorded")
    assert _check_search_sign_off(_signed_search_text(GOOD_LINE)) == "recorded"


def _contradiction(case: str) -> str:
    text = _text()
    signed = _signed_search_text(GOOD_LINE)
    cases = {
        "recorded beside not yet recorded": text.rstrip("\n") + "\n\n" + GOOD_LINE + "\n",
        "no words": _signed_search_text("Search signed off by the owner on 2026-11-20:"),
        "no date": _signed_search_text("Search signed off by the owner: looks right to me"),
        "no name": _signed_search_text("Search signed off on 2026-11-20: looks right to me"),
        "claimed without the line": text.replace(*CLAIMED),
        "signed while an item is open": signed.replace(
            DECIDED_LINE, "- **Decided by:** open: not decided.", 1
        ),
        "two lines": signed + GOOD_LINE + "\n",
    }
    return cases[case]


@pytest.mark.parametrize(
    "case",
    [
        "recorded beside not yet recorded",
        "no words",
        "no date",
        "no name",
        "claimed without the line",
        "signed while an item is open",
        "two lines",
    ],
)
def test_search_sign_off_check_rejects_a_contradiction(case):
    if SEARCH_SIGNED.search(_text()):
        pytest.skip("the real search sign-off is recorded")
    broken = _contradiction(case)
    assert broken != _text()
    with pytest.raises(AssertionError):
        _check_search_sign_off(broken)


def test_the_search_form_line_in_the_instruction_is_not_a_recorded_sign_off():
    form = "```text\nSearch signed off by the owner on YYYY-MM-DD: words\n```"
    assert SEARCH_SIGNED.search(form) is None
    assert _claims(form) == []


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
    for name in (*SBS_FILES, "README.md", "checklist.json"):
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
    assert "sample=synthetic" in frames["frame-build"]
    meta = [a for t, a in parser.tags if t == "meta" and a.get("http-equiv")]
    assert "script-src 'self'" in (meta[0]["content"] or "")


def _pairs() -> dict[str, dict[str, str | None]]:
    parser = _Collect()
    parser.feed((SBS / "index.html").read_text(encoding="utf-8"))
    return {a["data-pair"]: a for t, a in parser.tags if t == "button" and "data-pair" in a}


def test_side_by_side_page_offers_each_reference_next_to_the_build():
    pairs = _pairs()
    assert sorted(pairs) == ["first", "focus", "sky"]
    shown = [pairs[name]["data-ref"].rsplit("/", 1)[1] for name in ("first", "sky", "focus")]
    assert shown == list(REFERENCES)
    for name, attrs in pairs.items():
        for key in ("data-ref", "data-build"):
            assert attrs[key].startswith("/"), f"{name} {key}: not an address on this origin"
            assert (ROOT / attrs[key].split("?")[0].lstrip("/")).is_file(), f"{name} {key}"


def test_side_by_side_search_pairs_use_comparable_data():
    pairs = _pairs()
    # The sky reference generates the sample set; the build shows the same set.
    assert pairs["sky"]["data-build"] == "/embeddings_tumbler/static/index.html?sample=synthetic"
    # The Focus reference carries its own texts; the build side reads them from that page.
    assert pairs["focus"]["data-build"] == "/js/dev/side-by-side/focus-build.html"
    script = (SBS / "focus-build.js").read_text(encoding="utf-8")
    assert '"/docs/specs/reference/tumbler-focus-view.html"' in script
    assert "EmbeddingsTumbler.mount(" in script


def test_side_by_side_sends_both_sides_the_references_own_starting_searches():
    page = (SBS / "page.js").read_text(encoding="utf-8")
    reference = ROOT / "docs" / "specs" / "reference"
    sky = (reference / REFERENCES[1]).read_text(encoding="utf-8")
    assert '"tide harbor\\nreef kelp\\ncomet nebula"' in page
    assert ">tide harbor\nreef kelp\ncomet nebula</textarea>" in sky
    focus = (reference / REFERENCES[2]).read_text(encoding="utf-8")
    assert 'search: "water"' in page
    assert ">water</textarea>" in focus


def test_focus_build_page_is_plain_and_loads_the_shipped_core_file():
    parser = _Collect()
    parser.feed((SBS / "focus-build.html").read_text(encoding="utf-8"))
    assert not any(body.strip() for body in parser.script_bodies), "inline script"
    assert not [t for t, _ in parser.tags if t == "style"], "style element"
    for tag, attrs in parser.tags:
        assert "style" not in attrs, f"style attribute on <{tag}>"
        assert not any(k.startswith("on") for k in attrs), f"inline handler on <{tag}>"
    scripts = [a.get("src") for t, a in parser.tags if t == "script"]
    assert scripts == ["/embeddings_tumbler/static/embeddings-tumbler.js", "focus-build.js"]
    meta = [a for t, a in parser.tags if t == "meta" and a.get("http-equiv")]
    assert "script-src 'self'" in (meta[0]["content"] or "")


def test_side_by_side_page_is_not_shipped():
    # The wheel packages only ``embeddings_tumbler``; the page lives under js/dev.
    assert "embeddings_tumbler" not in SBS.parts[-4:]
    assert not list((ROOT / "embeddings_tumbler").rglob("side-by-side*"))


@pytest.mark.parametrize("name", SBS_FILES)
def test_side_by_side_page_loads_nothing_from_elsewhere(name):
    text = (SBS / name).read_text(encoding="utf-8")
    assert "http://" not in text
    assert "https://" not in text
