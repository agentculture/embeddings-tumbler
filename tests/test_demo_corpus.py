"""The demo corpus: ``scripts/build_demo_corpus.py`` against a fake MediaWiki API, and the
committed corpus itself (``data/wikipedia-vital-3/corpus.jsonl``).

The fake API runs on a loopback port; nothing here reaches Wikipedia.
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "data" / "wikipedia-vital-3" / "corpus.jsonl"
LIST_REVISION = 4242

_spec = importlib.util.spec_from_file_location(
    "build_demo_corpus", ROOT / "scripts" / "build_demo_corpus.py"
)
corpus_script = importlib.util.module_from_spec(_spec)
sys.modules["build_demo_corpus"] = corpus_script
_spec.loader.exec_module(corpus_script)

WIKITEXT = """{{Short description|x}}
Intro text with a link to [[Wikipedia:Vital articles/Level 2|Level 2]].
* [[Not counted]] because it is above the list heading
=Level 3 vital articles=
==People==
=== Leaders ===
* {{Icon|GA}} [[Hammurabi]]
* {{Icon|B}} '''[[Ramesses II]]''' ([[Wikipedia:Vital articles/Level 2|Level 2]])
** {{Icon|C}} [[Limit (mathematics)|Limit]]
* ''A sub-heading with no link''
==Science==
* [[moon]]
* [[Old name]]
* [[Mercury]]
* [[Ghost page]]
* [[Blank page]]
* [[Luna]]
* [[Category:Not an article]]
* [[Hammurabi]] (listed twice; keeps its first group)
==Mathematics==
""" + "\n".join(f"* [[Number {i}]]" for i in range(25))

EXTRACTS = {
    "Hammurabi": "Hammurabi (c. 1810 BC – c. 1750 BC) was a king of Babylon. He wrote laws. "
    "He ruled long.\nSecond paragraph.",
    "Ramesses II": "Ramesses II ( RAM-ih-seez; c. 1303 BC – 1213 BC) was a pharaoh. See "
    "https://example.invalid/x and www.example.invalid for more; //cdn.example.invalid too.",
    "Limit (mathematics)": "In mathematics, a limit is the value that a function approaches. "
    + "word " * 120,
    "Moon": "The Moon is Earth's only natural satellite. It orbits at about 384,400 km.",
    "Mercury": "Mercury may refer to several things.",
    "Blank page": "",
}
PAGE_IDS = {title: 100 + i for i, title in enumerate(sorted(EXTRACTS))}


class FakeWiki:
    """A loopback MediaWiki API: the list page and batched extracts, with failures on demand."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.agents: list[str] = []
        self.fail_next = 0  # answer this many requests with 503
        self.fail_titles: str | None = None  # 503 for any extracts batch naming this title
        wiki = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query))
                wiki.requests.append(query)
                wiki.agents.append(self.headers.get("User-Agent", ""))
                status, body = wiki.answer(query)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args) -> None:  # noqa: A002
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True)
        self.thread.start()
        self.api = f"http://127.0.0.1:{self.server.server_address[1]}/w/api.php"

    def answer(self, query: dict) -> tuple[int, dict]:
        if self.fail_next > 0:
            self.fail_next -= 1
            return 503, {"error": "busy"}
        if query.get("prop") == "revisions":
            page = {
                "pageid": 1,
                "title": "Wikipedia:Vital articles/Level 3",
                "revisions": [
                    {
                        "revid": LIST_REVISION,
                        "timestamp": "2026-11-14T00:00:00Z",
                        "slots": {"main": {"content": WIKITEXT}},
                    }
                ],
            }
            return 200, {"query": {"pages": [page]}}
        titles = query["titles"].split("|")
        if self.fail_titles and self.fail_titles in titles:
            return 503, {"error": "busy"}
        return 200, self.extracts(titles)

    @staticmethod
    def extracts(titles: list[str]) -> dict:
        normalized, redirects, pages = [], [], []
        for title in titles:
            name = title
            if name == "Ramesses II":  # an identity step, as the API sends for some titles
                normalized.append({"from": title, "to": name})
            if name in ("Old name", "Luna"):
                redirects.append({"from": name, "to": "Moon"})
                name = "Moon"
            if name.startswith("Number "):
                pages.append(
                    {
                        "pageid": 1000 + int(name.split()[1]),
                        "title": name,
                        "lastrevid": 5,
                        "extract": f"{name} is a number. It counts.",
                    }
                )
            elif name in EXTRACTS:
                page = {"pageid": PAGE_IDS[name], "title": name, "lastrevid": 7}
                page["extract"] = EXTRACTS[name]
                if name == "Mercury":
                    page["pageprops"] = {"disambiguation": ""}
                pages.append(page)
            else:
                pages.append({"title": name, "missing": True})
        return {"query": {"normalized": normalized, "redirects": redirects, "pages": pages}}

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


@pytest.fixture
def wiki():
    w = FakeWiki()
    yield w
    w.close()


def _fetcher(wiki: FakeWiki, cache: Path, **kw) -> corpus_script.Fetcher:
    kw.setdefault("interval", 0.0)
    kw.setdefault("sleep", lambda s: None)
    return corpus_script.Fetcher(wiki.api, cache, **kw)


def _records(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines()]


# --------------------------------------------------------------------------- pure parts


def test_list_parsing_takes_each_bullets_first_article_link_under_its_section():
    listed = corpus_script.parse_list(WIKITEXT)
    assert listed[:9] == [
        ("Hammurabi", "People"),
        ("Ramesses II", "People"),
        ("Limit (mathematics)", "People"),
        ("Moon", "Science"),
        ("Old name", "Science"),
        ("Mercury", "Science"),
        ("Ghost page", "Science"),
        ("Blank page", "Science"),
        ("Luna", "Science"),
    ]
    assert len(listed) == 9 + 25
    assert ("Number 24", "Mathematics") in listed


def test_list_parsing_refuses_a_page_without_the_list_heading():
    with pytest.raises(ValueError, match="Level 3 vital articles"):
        corpus_script.parse_list("== People ==\n* [[A]]\n")


def test_texts_lose_every_address_and_keep_two_sentences_within_the_cap():
    text = corpus_script.short_text(EXTRACTS["Ramesses II"])
    assert "://" not in text
    assert "www." not in text
    assert "//" not in text
    assert text.startswith("Ramesses II (RAM-ih-seez; c. 1303 BC")
    first = corpus_script.short_text(EXTRACTS["Hammurabi"])
    assert first == "Hammurabi (c. 1810 BC – c. 1750 BC) was a king of Babylon. He wrote laws."
    long = corpus_script.short_text(EXTRACTS["Limit (mathematics)"])
    assert len(long) <= corpus_script.TEXT_CAP
    assert long.endswith(corpus_script.ELLIPSIS)
    assert corpus_script.short_text("") == ""


def test_abbreviations_and_initials_do_not_end_a_sentence():
    text = "J. S. Bach (fl. 1700) was a composer, e.g. of fugues. He lived in St. Thomas. Third."
    assert corpus_script.first_sentences(text, 2) == (
        "J. S. Bach (fl. 1700) was a composer, e.g. of fugues. He lived in St. Thomas."
    )
    assert corpus_script.first_sentences("No stop here", 2) == "No stop here"
    assert corpus_script.first_sentences("Is it? Yes! Done.", 2) == "Is it? Yes!"


def test_the_api_address_must_be_https_or_loopback():
    assert corpus_script.check_api("https://en.wikipedia.org/w/api.php")
    assert corpus_script.check_api("http://127.0.0.1:9/w/api.php")
    for bad in ("http://en.wikipedia.org/w/api.php", "ftp://127.0.0.1/", "http://host:1/"):
        with pytest.raises(ValueError):
            corpus_script.check_api(bad)


def test_titles_are_normalised_as_the_api_names_them():
    assert corpus_script.normalise_title("moon_landing  x") == "Moon landing x"


# --------------------------------------------------------------------------- against the fake


def test_build_against_the_fake_api(wiki, tmp_path):
    fetcher = _fetcher(wiki, tmp_path / "cache")
    text = corpus_script.build(fetcher, "2026-11-14")
    header, *items = _records(text)
    assert header["record"] == "header"
    assert header["list_revision"] == LIST_REVISION
    assert header["retrieved"] == "2026-11-14"
    assert header["licence"] == "CC BY-SA 4.0"
    assert header["listed"] == 34
    assert {s["title"]: s["reason"] for s in header["skipped"]} == {
        "Old name": "duplicate",
        "Mercury": "disambiguation",
        "Ghost page": "missing",
        "Blank page": "empty-text",
        "Luna": "duplicate",
    }
    assert header["count"] == len(items) == 29
    assert header["groups"] == ["People", "Science", "Mathematics"]
    moon = next(i for i in items if i["title"] == "Moon")
    assert moon == {
        "record": "item",
        "id": f"wp-{PAGE_IDS['Moon']}",
        "title": "Moon",
        "group": "Science",
        "text": "The Moon is Earth's only natural satellite. It orbits at about 384,400 km.",
        "page_id": PAGE_IDS["Moon"],
        "revision_id": 7,
    }
    assert [i["title"] for i in items[:3]] == ["Hammurabi", "Ramesses II", "Limit (mathematics)"]
    for item in items:
        assert "://" not in item["text"]
    # Two batches of extracts (34 titles, 20 a batch) after the list: three requests.
    assert len(wiki.requests) == 3
    assert all("embeddings-tumbler" in a and "github.com" in a for a in wiki.agents)
    assert all(r["format"] == "json" and r["formatversion"] == "2" for r in wiki.requests)


def test_the_same_answers_give_the_same_bytes(wiki, tmp_path):
    first = corpus_script.build(_fetcher(wiki, tmp_path / "a"), "2026-11-14")
    second = corpus_script.build(_fetcher(wiki, tmp_path / "b"), "2026-11-14")
    assert first == second
    assert len(wiki.requests) == 6


def test_a_failed_run_resumes_from_its_cache(wiki, tmp_path):
    cache = tmp_path / "cache"
    wiki.fail_titles = "Number 24"  # the second extracts batch fails every time
    failing = _fetcher(wiki, cache, retries=1)
    with pytest.raises(corpus_script.FetchError, match="did not answer"):
        corpus_script.build(failing, "2026-11-14")
    made = len(wiki.requests)
    assert made == 1 + 1 + 2  # the list, batch one, batch two twice
    wiki.fail_titles = None
    text = corpus_script.build(_fetcher(wiki, cache), "2026-11-14")
    # Only the failed batch is asked again; the list and batch one come from the cache.
    assert len(wiki.requests) == made + 1
    assert _records(text)[0]["count"] == 29


def test_retries_back_off_and_pacing_waits_between_requests(wiki, tmp_path):
    sleeps: list[float] = []
    now = [100.0]
    wiki.fail_next = 2
    fetcher = corpus_script.Fetcher(
        wiki.api,
        tmp_path / "cache",
        interval=0.5,
        backoff=1.0,
        sleep=lambda s: (sleeps.append(round(s, 3)), now.__setitem__(0, now[0] + s)),
        clock=lambda: now[0],
    )
    corpus_script.fetch_list(fetcher)
    # Two failures: back-off 1 s then 2 s; the pacing has nothing left to wait after them.
    assert sleeps == [1.0, 2.0]
    assert fetcher.requests == 3
    now[0] += 0.1  # a quick next request waits for the rest of the interval
    fetcher.get({"action": "query", "prop": "extracts", "titles": "Moon"})
    assert sleeps[-1] == pytest.approx(0.4)


def test_a_client_error_is_not_retried(tmp_path):
    calls = []

    def opener(request, timeout):
        calls.append(request.full_url)
        raise corpus_script.urllib.error.HTTPError(request.full_url, 404, "x", {}, None)

    fetcher = corpus_script.Fetcher(
        "https://wiki.invalid/w/api.php", tmp_path, sleep=lambda s: None, opener=opener
    )
    with pytest.raises(corpus_script.FetchError, match="404"):
        fetcher.get({"action": "query"})
    assert len(calls) == 1


def test_an_answer_with_an_error_field_is_retried_and_never_cached(wiki, tmp_path):
    fetcher = _fetcher(wiki, tmp_path / "cache", retries=0)
    original = wiki.answer
    wiki.answer = lambda q: (200, {"error": {"code": "x"}})
    with pytest.raises(corpus_script.FetchError):
        fetcher.get({"action": "query", "titles": "Moon"})
    assert not (tmp_path / "cache").exists() or not list((tmp_path / "cache").iterdir())
    wiki.answer = original


def test_a_missing_list_page_is_an_error(wiki, tmp_path):
    wiki.answer = lambda q: (200, {"query": {"pages": [{"title": "x", "missing": True}]}})
    fetcher = _fetcher(wiki, tmp_path)
    with pytest.raises(corpus_script.FetchError, match="list page"):
        corpus_script.fetch_list(fetcher, revision=5)
    assert wiki.requests[-1]["revids"] == "5"


def test_continuation_is_followed_and_merged(tmp_path):
    answers = [
        {
            "continue": {"excontinue": "1", "continue": "||"},
            "query": {"pages": [{"pageid": 1, "title": "A", "lastrevid": 2, "extract": ""}]},
        },
        {"query": {"pages": [{"pageid": 1, "title": "A", "extract": "A is a letter."}]}},
    ]

    class Stub:
        def get(self, params):
            return answers.pop(0)

    resolved, pages = corpus_script.fetch_pages(Stub(), ["A"])
    assert resolved == {"A": "A"}
    assert pages["A"]["extract"] == "A is a letter."
    assert pages["A"]["lastrevid"] == 2


def test_main_writes_the_corpus_and_reports(wiki, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(corpus_script.time, "sleep", lambda s: None)
    monkeypatch.chdir(tmp_path)  # paths are taken inside the current folder (or the repository)
    out = tmp_path / "out" / "corpus.jsonl"
    args = ["--api", wiki.api, "--cache", str(tmp_path / "c"), "--out", str(out)]
    assert corpus_script.main(args + ["--retrieved", "2026-11-14", "--interval", "0"]) == 0
    assert "29 items in 3 groups" in capsys.readouterr().out
    header, _ = corpus_script.read_corpus(out)
    assert header["retrieved"] == "2026-11-14"
    wiki.fail_next = 100
    bad = ["--api", wiki.api, "--cache", str(tmp_path / "d"), "--out", str(out)]
    assert corpus_script.main(bad + ["--interval", "0"]) == 1
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("option", ["--out", "--cache"])
def test_main_refuses_a_path_outside_the_current_folder_and_the_repository(
    wiki, tmp_path, capsys, monkeypatch, option
):
    inside = tmp_path / "inside"
    inside.mkdir()
    monkeypatch.chdir(inside)
    paths = {"--out": "corpus.jsonl", "--cache": "cache"}
    paths[option] = str(tmp_path / "elsewhere" / "x")
    args = ["--api", wiki.api, "--out", paths["--out"], "--cache", paths["--cache"]]
    assert corpus_script.main(args + ["--interval", "0"]) == 1
    assert (
        f"{option} must be inside the current folder or the repository" in capsys.readouterr().err
    )
    assert not wiki.requests
    assert not list(inside.iterdir())
    assert not (tmp_path / "elsewhere").exists()


def test_a_path_inside_the_repository_is_taken_from_any_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert corpus_script.allowed_path(str(CORPUS), "--out") == str(CORPUS.resolve())
    assert corpus_script.allowed_path(".", "--cache", folder_ok=True) == str(tmp_path.resolve())
    with pytest.raises(ValueError, match="--cache must be inside"):
        corpus_script.allowed_path(".", "--cache")


@pytest.mark.parametrize(
    "text, cleaned",
    [
        (
            "Ada ( ; ) was , it is said ( born 1815 ) here .",
            "Ada was, it is said (born 1815) here.",
        ),
        ("A [ ] b ( , ) c (  ) d [] e (;) f", "A b c d e f"),
        ("See ( https://example.org/x ) and www.example.org now !", "See and now!"),
        ("x" + " " * 4000 + "y" + "( " * 2000, "x y" + "(" * 2000),
    ],
)
def test_clean_text_closes_the_gaps_left_by_removals(text, cleaned):
    assert corpus_script.clean_text(text) == cleaned


def test_read_corpus_refuses_a_file_without_a_header(tmp_path):
    path = tmp_path / "c.jsonl"
    path.write_text('{"record": "item"}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="header"):
        corpus_script.read_corpus(path)


# --------------------------------------------------------------------------- the committed corpus


@pytest.fixture(scope="module")
def committed():
    return corpus_script.read_corpus(CORPUS)


def test_committed_corpus_header_names_the_list_revision_date_and_licence(committed):
    header, items = committed
    assert header["list"] == "Wikipedia:Vital articles/Level 3"
    assert isinstance(header["list_revision"], int)
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", header["retrieved"])
    assert header["licence"] == "CC BY-SA 4.0"
    assert header["count"] == len(items)
    assert header["listed"] == len(items) + len(header["skipped"])


def test_committed_corpus_has_about_a_thousand_complete_items(committed):
    header, items = committed
    assert 950 <= len(items) <= 1050
    for item in items:
        for key in ("id", "title", "group", "text"):
            assert isinstance(item[key], str), (key, item.get("id"))
            assert item[key], (key, item.get("id"))
        assert item["id"] == f"wp-{item['page_id']}"
        assert len(item["text"]) <= header["text_cap"]
    assert len({i["id"] for i in items}) == len(items), "duplicate ids"
    assert len(set(header["groups"])) >= 10


def test_committed_corpus_texts_hold_no_address(committed):
    _, items = committed
    for item in items:
        assert not re.search(r"[A-Za-z][A-Za-z0-9+.\-]*://", item["text"]), item["id"]
        assert "//" not in item["text"], item["id"]
        assert "www." not in item["text"], item["id"]
