#!/usr/bin/env python3
"""Fetch the demo corpus: English Wikipedia's Level 3 vital articles, one short text each.

    python3 scripts/build_demo_corpus.py                       # fetch (or resume) and write
    python3 scripts/build_demo_corpus.py --revision 1385567416 # rebuild from that list revision

The list is chosen by a rule a reader can check, not by hand: every article linked from
a bullet of the list page ``Wikipedia:Vital articles/Level/3`` (about 1,000), in the
page's order. The level-2 heading an article is listed under (People, History,
Geography, Arts, ...) is its group, so the viewer's colours mean something.

For each article the corpus keeps the title (the point's label), the first one or two
sentences of its introduction as plain text, cut to at most ``TEXT_CAP`` characters at a
word boundary (an ellipsis marks a cut), the page id and the revision id the text was
read from, and the group. Addresses (anything shaped ``scheme://...`` and ``www.``
names) are removed from the texts, so the shipped data file names no other origin.

Skipped, and recorded in the header with the reason: a title the wiki does not have
(``missing``), a disambiguation page (``disambiguation``), a page whose introduction is
empty (``empty-text``), and a second list entry that resolves to a page already taken
(``duplicate``). Redirects are followed to their targets.

Output: a JSONL file. Line 1 is the header record (``"record": "header"``: the list and
its revision id, the retrieval date, the licence, the text cap, the groups and what was
skipped); every later line is one article (``"record": "item"``).

``--out`` and ``--cache`` must be inside the current folder or inside this repository.

Licence: the titles and texts are Wikipedia's, under CC BY-SA 4.0; see ``NOTICE``.

Politeness: the MediaWiki API over HTTPS with a generic User-Agent that names this
project's repository, at most ``1 / --interval`` requests per second, up to
``RETRIES`` retries with exponential back-off on a failed request, an HTTP 429 or a 5xx.
Every answer is cached under ``--cache`` as it arrives, so a failed run resumes where
it stopped instead of starting over. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://en.wikipedia.org/w/api.php"
LIST_TITLE = "Wikipedia:Vital articles/Level/3"
LIST_START = "=Level 3 vital articles="
USER_AGENT = (
    "embeddings-tumbler-demo-corpus/1 (+https://github.com/agentculture/embeddings-tumbler)"
)
DEFAULT_OUT = ROOT / "data" / "wikipedia-vital-3" / "corpus.jsonl"
DEFAULT_CACHE = ROOT / ".cache" / "demo-corpus"
LICENCE = "CC BY-SA 4.0"
LICENCE_NAME = "Creative Commons Attribution-ShareAlike 4.0 International"
TEXT_CAP = 280
SENTENCES = 2
BATCH = 20  # the API's limit for extracts of whole introductions
INTERVAL = 0.5  # seconds between requests: at most two a second
RETRIES = 5
BACKOFF = 1.0  # first retry wait in seconds; doubled each time
TIMEOUT = 30.0
ELLIPSIS = "…"

#: Namespaces whose links on the list page are not articles.
_NAMESPACE = re.compile(
    r"^(?:wikipedia|wp|category|file|image|template|help|portal|special|meta|wikt|user|talk)"
    r"\s*:",
    re.IGNORECASE,
)
_HEADING = re.compile(r"^==([^=].*?)==\s*$")
_BULLET = re.compile(r"^[*#]")
_LINK = re.compile(r"\[\[([^\]|#]+)")
_ADDRESS = re.compile(r"\b[A-Za-z][A-Za-z0-9+.\-]*://\S*|\bwww\.\S+|//+", re.ASCII)
_OPEN_PAREN_PUNCT = re.compile(r"\(\s*[;,]?\s*")
# The three below are applied by ``clean_text`` only, to text whose every run of white space
# is already one space, so each names a single space where it once named a run: the same
# matches on that text, and nothing for the expression to try twice.
_EMPTY_BRACKETS = re.compile(r"\( ?[;,]? ?\)|\[ ?\]")
_SPACE_BEFORE_PUNCT = re.compile(r" ([,.;:!?)])")
_CLOSE_PAREN_SPACE = " )"
#: A possible sentence end: a stop, any closing quotes or brackets, space, then a capital
#: letter or an opening quote or bracket. A digit does not start a sentence here.
_SENTENCE_END = re.compile(r"[.!?][\"')\]]*\s+(?=[A-Z\"'(\[])")
#: Words that end with a full stop without ending a sentence (compared in lower case).
_ABBREVIATIONS = frozenset(
    "c ca cf e.g i.e lit sing pl st dr mr mrs ms jr sr vs approx no fl b d o.s n.s u.s "
    "u.k a.d b.c etc al gen lt col rev mt ft".split()
)


class FetchError(Exception):
    """A request that still failed after every retry. The message is plain text."""


# --------------------------------------------------------------------------- the list


def parse_list(wikitext: str) -> list[tuple[str, str]]:
    """``(title, group)`` for every article on the list page, in the page's order.

    Only the part after the ``=Level 3 vital articles=`` heading is read. A bullet's
    article is its first link outside the namespaces above; a bullet with none (a
    sub-heading in italics) is not an article. A title listed twice keeps its first group.
    """
    _, found, body = wikitext.partition(LIST_START)
    if not found:
        raise ValueError(f"the list page has no {LIST_START!r} heading")
    group = ""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for line in body.splitlines():
        heading = _HEADING.match(line)
        if heading:
            group = heading.group(1).strip()
            continue
        if not _BULLET.match(line):
            continue
        links = [t.strip() for t in _LINK.findall(line)]
        links = [t for t in links if t and not t.startswith(":") and not _NAMESPACE.match(t)]
        if not links:
            continue
        title = normalise_title(links[0])
        if title not in seen:
            seen.add(title)
            out.append((title, group))
    return out


def normalise_title(title: str) -> str:
    """A wiki link target as the API names it: underscores as spaces, first letter upper."""
    title = " ".join(title.replace("_", " ").split())
    return title[:1].upper() + title[1:]


# --------------------------------------------------------------------------- texts


def clean_text(text: str) -> str:
    """Plain text with no address in it and with the gaps left by removals closed."""
    text = _ADDRESS.sub(" ", text)
    text = " ".join(text.split())
    text = _OPEN_PAREN_PUNCT.sub("(", text)
    text = text.replace(_CLOSE_PAREN_SPACE, ")")
    text = _EMPTY_BRACKETS.sub(" ", text)
    text = " ".join(text.split())
    return _SPACE_BEFORE_PUNCT.sub(r"\1", text).strip()


def short_text(extract: str, sentences: int = SENTENCES, cap: int = TEXT_CAP) -> str:
    """The first ``sentences`` sentences of the first paragraph, at most ``cap`` characters.

    A cut falls at a word boundary and ends with an ellipsis (counted in the cap).
    """
    first = next((p for p in extract.split("\n") if p.strip()), "")
    text = first_sentences(clean_text(first), sentences)
    if len(text) <= cap:
        return text
    cut = text[: cap - 1]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:-") + ELLIPSIS


def _ends_sentence(text: str, stop: int) -> bool:
    """Whether the full stop at ``stop`` ends a sentence (not an abbreviation or initial)."""
    if text[stop] != ".":
        return True
    word = text[:stop].rsplit(" ", 1)[-1].lstrip("(\"'[").lower()
    return len(word) > 1 and word not in _ABBREVIATIONS


def first_sentences(text: str, count: int) -> str:
    """The first ``count`` sentences of ``text`` (all of it when it has fewer)."""
    found = 0
    for match in _SENTENCE_END.finditer(text):
        if _ends_sentence(text, match.start()):
            found += 1
            if found == count:
                return text[: match.end()].rstrip()
    return text


# --------------------------------------------------------------------------- fetching


def check_api(url: str) -> str:
    """The API address: https, or http to a loopback address only (for tests)."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme == "https" and parts.hostname:
        return url
    if parts.scheme == "http" and parts.hostname:
        try:
            if ipaddress.ip_address(parts.hostname).is_loopback:
                return url
        except ValueError:
            pass
    raise ValueError("the API address must be https (or http to a loopback address)")


class Fetcher:
    """GETs from the MediaWiki API with pacing, retries and an answer cache.

    ``sleep`` and ``clock`` are hooks so tests can run without waiting. A cached answer
    is returned without a request, so a second run after a failure resumes.
    """

    def __init__(
        self,
        api: str = API,
        cache: Path = DEFAULT_CACHE,
        *,
        interval: float = INTERVAL,
        retries: int = RETRIES,
        backoff: float = BACKOFF,
        sleep: Callable[[float], None] | None = None,
        clock: Callable[[], float] | None = None,
        opener: Callable | None = None,
    ) -> None:
        self.api = check_api(api)
        self.cache = cache
        self.interval = interval
        self.retries = retries
        self.backoff = backoff
        self.sleep = sleep or time.sleep
        self.clock = clock or time.monotonic
        self.opener = opener or urllib.request.urlopen
        self.requests = 0
        self._last: float | None = None

    def _cache_file(self, params: dict[str, str]) -> Path:
        key = json.dumps(sorted(params.items()), ensure_ascii=True)
        return self.cache / (hashlib.sha256(key.encode("utf-8")).hexdigest()[:32] + ".json")

    def _pace(self) -> None:
        if self._last is not None:
            wait = self.interval - (self.clock() - self._last)
            if wait > 0:
                self.sleep(wait)
        self._last = self.clock()

    def _once(self, url: str) -> dict:
        self._pace()
        self.requests += 1
        request = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        with self.opener(request, timeout=TIMEOUT) as response:  # nosec B310 (checked scheme)
            return json.loads(response.read().decode("utf-8"))

    def _attempt(self, url: str) -> dict | None:
        """One request: the answer, or None when the request is worth making again."""
        try:
            answer = self._once(url)
        except urllib.error.HTTPError as err:
            if err.code != 429 and err.code < 500:
                raise FetchError(f"the API answered {err.code}") from None
            return None
        except (OSError, ValueError):
            # No connection, a time-out or an answer that is not JSON: tried again.
            return None
        if isinstance(answer, dict) and "error" not in answer:
            return answer
        return None

    def get(self, params: dict[str, str]) -> dict:
        """The API's answer to ``params`` (``format=json&formatversion=2`` are added)."""
        params = {**params, "format": "json", "formatversion": "2"}
        cached = self._cache_file(params)
        if cached.is_file():
            return json.loads(cached.read_text(encoding="utf-8"))
        url = self.api + "?" + urllib.parse.urlencode(sorted(params.items()))
        wait = self.backoff
        for attempt in range(self.retries + 1):
            answer = self._attempt(url)
            if answer is not None:
                self.cache.mkdir(parents=True, exist_ok=True)
                cached.write_text(json.dumps(answer, ensure_ascii=False), encoding="utf-8")
                return answer
            if attempt < self.retries:
                self.sleep(wait)
                wait *= 2
        raise FetchError(f"the API did not answer after {self.retries + 1} attempts")


def fetch_list(fetcher: Fetcher, revision: int | None = None) -> dict:
    """The list page's wikitext with its revision id and timestamp (latest, or ``revision``)."""
    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "ids|timestamp|content",
        "rvslots": "main",
    }
    if revision is None:
        params.update({"titles": LIST_TITLE, "redirects": "1"})
    else:
        params["revids"] = str(revision)
    answer = fetcher.get(params)
    pages = answer.get("query", {}).get("pages", [])
    if not pages or "revisions" not in pages[0]:
        raise FetchError("the list page was not found")
    page = pages[0]
    rev = page["revisions"][0]
    return {
        "title": page.get("title", LIST_TITLE),
        "revision": rev["revid"],
        "timestamp": rev.get("timestamp", ""),
        "wikitext": rev["slots"]["main"]["content"],
    }


def _batches(items: list, size: int) -> Iterable[list]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _resolve(answer: dict, asked: Iterable[str]) -> dict[str, str]:
    """Each asked title mapped to the title of the page the API answered for it."""
    query = answer.get("query", {})
    steps = {}
    for key in ("normalized", "redirects"):
        for row in query.get(key, []):
            steps.setdefault(key, {})[row["from"]] = row["to"]
    resolved = {}
    for title in asked:
        name = steps.get("normalized", {}).get(title, title)
        name = steps.get("redirects", {}).get(name, name)
        resolved[title] = name
    return resolved


def _merge_pages(into: dict[str, dict], answer: dict) -> None:
    for page in answer.get("query", {}).get("pages", []):
        known = into.setdefault(page.get("title", ""), {})
        for key, value in page.items():
            if key not in known or (key == "extract" and not known.get("extract")):
                known[key] = value


def fetch_pages(fetcher: Fetcher, titles: list[str]) -> tuple[dict[str, str], dict[str, dict]]:
    """``(asked title -> page title, page title -> page)`` for every title, in batches."""
    resolved: dict[str, str] = {}
    pages: dict[str, dict] = {}
    for batch in _batches(titles, BATCH):
        params = {
            "action": "query",
            "prop": "extracts|pageprops|info",
            "exintro": "1",
            "explaintext": "1",
            "exlimit": str(BATCH),
            "ppprop": "disambiguation",
            "redirects": "1",
            "titles": "|".join(batch),
        }
        cont: dict[str, str] = {}
        while True:
            answer = fetcher.get({**params, **cont})
            resolved.update(_resolve(answer, batch))
            _merge_pages(pages, answer)
            cont = answer.get("continue") or {}
            if not cont:
                break
    return resolved, pages


# --------------------------------------------------------------------------- the corpus


def _skip_reason(page: dict | None, text: str, taken: set[int]) -> str | None:
    if page is None or page.get("missing") or page.get("invalid") or "pageid" not in page:
        return "missing"
    if "disambiguation" in (page.get("pageprops") or {}):
        return "disambiguation"
    if not text:
        return "empty-text"
    if page["pageid"] in taken:
        return "duplicate"
    return None


def build_corpus(
    listed: list[tuple[str, str]],
    resolved: dict[str, str],
    pages: dict[str, dict],
    header: dict,
) -> list[dict]:
    """The header record followed by one item per kept article, in list order."""
    items: list[dict] = []
    skipped: list[dict] = []
    taken: set[int] = set()
    for title, group in listed:
        page = pages.get(resolved.get(title, title))
        text = short_text((page or {}).get("extract") or "")
        reason = _skip_reason(page, text, taken)
        if reason:
            skipped.append({"title": title, "reason": reason})
            continue
        taken.add(page["pageid"])
        items.append(
            {
                "record": "item",
                "id": f"wp-{page['pageid']}",
                "title": page["title"],
                "group": group,
                "text": text,
                "page_id": page["pageid"],
                "revision_id": page.get("lastrevid"),
            }
        )
    groups: list[str] = []
    for item in items:
        if item["group"] not in groups:
            groups.append(item["group"])
    head = {
        "record": "header",
        **header,
        "listed": len(listed),
        "count": len(items),
        "groups": groups,
        "skipped": skipped,
    }
    return [head] + items


def to_jsonl(records: list[dict]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False, sort_keys=False) + "\n" for r in records)


def make_header(found: dict, retrieved: str) -> dict:
    return {
        "source": "English Wikipedia",
        "list": found["title"],
        "list_revision": found["revision"],
        "list_timestamp": found["timestamp"],
        "retrieved": retrieved,
        "licence": LICENCE,
        "licence_name": LICENCE_NAME,
        "attribution": "Wikipedia contributors; titles and texts from the articles named, "
        "at the revision ids given",
        "changes": f"first {SENTENCES} sentences of each introduction as plain text, addresses "
        f"removed, cut to at most {TEXT_CAP} characters at a word boundary (an ellipsis marks "
        "a cut)",
        "text_cap": TEXT_CAP,
    }


def build(fetcher: Fetcher, retrieved: str, revision: int | None = None) -> str:
    """Fetch everything (or read it from the cache) and return the corpus as JSONL text."""
    found = fetch_list(fetcher, revision)
    listed = parse_list(found["wikitext"])
    resolved, pages = fetch_pages(fetcher, [t for t, _ in listed])
    return to_jsonl(build_corpus(listed, resolved, pages, make_header(found, retrieved)))


def read_corpus(path: Path) -> tuple[dict, list[dict]]:
    """``(header, items)`` of a corpus file."""
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    if not lines or lines[0].get("record") != "header":
        raise ValueError(f"{path} does not start with a header record")
    return lines[0], lines[1:]


def _confined(base_dir: str, value: str, folder_ok: bool = False) -> str:
    """The real path of ``value`` taken under ``base_dir``; ValueError unless it is inside.

    SonarSource's documented path-traversal check: both paths through ``os.path.realpath``,
    then a plain ``startswith(base + os.sep)``. With ``folder_ok`` the base folder itself is
    accepted too.
    """
    base = os.path.realpath(base_dir)
    full = os.path.realpath(os.path.join(base, value))
    if full.startswith(base + os.sep) or (folder_ok and full == base):
        return full
    raise ValueError(f"{value} is outside {base}")


def allowed_path(value: str, what: str, folder_ok: bool = False) -> str:
    """The real path of a path argument: inside the current folder, or inside the repository.

    A relative ``value`` is taken from the current folder. Anything else is refused, so a
    mistyped or generated argument cannot make the script read or write elsewhere.
    """
    try:
        return _confined(os.getcwd(), value, folder_ok)
    except ValueError:
        pass
    try:
        return _confined(str(ROOT), os.path.abspath(value), folder_ok)
    except ValueError:
        raise ValueError(
            f"{what} must be inside the current folder or the repository: {value}"
        ) from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="the corpus file")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE, help="answer cache folder")
    parser.add_argument("--api", default=API, help=argparse.SUPPRESS)
    parser.add_argument("--revision", type=int, help="read this revision of the list page")
    parser.add_argument(
        "--retrieved", help="the retrieval date to record (default: today, UTC), YYYY-MM-DD"
    )
    parser.add_argument("--interval", type=float, default=INTERVAL, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    retrieved = args.retrieved or datetime.datetime.now(datetime.UTC).date().isoformat()
    try:
        out = allowed_path(str(args.out), "--out")
        cache = allowed_path(str(args.cache), "--cache", folder_ok=True)
        fetcher = Fetcher(args.api, Path(cache), interval=args.interval)
        text = build(fetcher, retrieved, args.revision)
    except (FetchError, ValueError, KeyError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, out)
    header = json.loads(text.split("\n", 1)[0])
    print(
        f"wrote {args.out}: {header['count']} items in {len(header['groups'])} groups "
        f"from {header['listed']} listed, {len(header['skipped'])} skipped; "
        f"list revision {header['list_revision']}; {fetcher.requests} request(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
