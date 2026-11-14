# Searching in the viewer: the search guide

This guide is for you if you have a page with the `embeddings-tumbler` viewer
open in front of you and want to find things in it. The viewer shows a set of
embedding vectors (texts that a model has turned into long lists of numbers) as
a moving picture of points. Search lets you type text and see which points are
nearest to it. You do not need to know anything about the code.

If you build pages and want to add search to your own, read the
[host guide](host.md), section "Search".

Every step below was taken in a real browser by a test
(`tests/browser/test_search_guide.py`), on the page exactly as the package
ships it. The results quoted are what that test reads.

## The words this guide uses

Each of these has one meaning here, and the viewer uses them the same way.

- A **point** is one text of the data, drawn as a dot. Its vector has hundreds
  or thousands of numbers, one per **dimension**.
- A **search** is one thing you asked for, and what was found for it. You can
  have up to four at once. They are lettered **A**, **B**, **C** and **D**, in
  the order you wrote them, and each letter has its own colour.
- **Distance** is how far apart two vectors are. Here it is always cosine
  distance (1 minus cosine similarity): 0 means the same direction, larger
  means less alike. It is measured over every dimension of the data.
- A **named point** is a point that has text you can read: a title, a label or
  a passage. In most data every point is named. In the generated sample set
  only a few hundred are.
- The **results** of a search are the named points nearest to it. You choose
  how many: 8 unless you change it.
- The **radius** of a search is the distance of its farthest result.
- A point is **lit** when it is within the radius of a search, whether it is
  named or not. Lit points are drawn bright. Every other point is dimmed, not
  removed.

## Opening the page

If someone gave you a page, open it. To try the page that comes with the
package on your own machine:

```text
pip install embeddings-tumbler
embeddings-tumbler viewer write tumbler --apply
embeddings-tumbler viewer serve tumbler
```

Then open `http://127.0.0.1:8000/` in a browser.

The page opens on a real data set: 999 articles from English Wikipedia's list
of vital articles (Level 3). Each point is one article. Its vector was made by
the model `Qwen/Qwen3-Embedding-0.6B` from the first sentences of the article's
introduction, and has 1,024 dimensions. The titles and texts are Wikipedia's,
written by Wikipedia contributors and shortened; they are under the Creative
Commons Attribution-ShareAlike 4.0 licence (CC BY-SA 4.0), and the package's
`NOTICE` file gives the source and the changes made.

There is also a generated set with made-up vectors, 12,288 points of which 290
carry a word. Open it with `index.html?sample=synthetic`, or use the link under
the notes on the page.

## A first search

Under the picture is one line that begins **Search**. It says
`nothing searched: every point is shown`. That line is the whole search panel
while it is closed.

1. Click the line. The panel opens: a text box, a row of controls, and a note.
2. Type `river` in the box.

A moment after you stop typing, eight points light up and the rest dim. The
line now reads `A river · 8 points lit`. On the picture, a ring marks where
your search itself sits, lines join it to its results, and each result carries
its text. Under the controls there is a list headed **A**. Click it to see the
results in order, nearest first:

| Rank | Article | Distance |
|------|---------|----------|
| 1 | River | 0.000 |
| 2 | Flood | 0.435 |
| 3 | Lake | 0.454 |
| 4 | Nile | 0.499 |
| 5 | Amazon River | 0.553 |
| 6 | Drink | 0.555 |
| 7 | Yangtze | 0.563 |
| 8 | Drinking water | 0.564 |

The radius of this search is 0.564, the distance of its eighth result.

The picture did not stop while this happened, and it does not stop while a
search is shown. When a new search arrives, the view swings toward it for a few
seconds and then carries on moving as before.

### What "river" was compared with

On this page as served above, nothing can embed your text: the page has no
connection to an embedding model. So the viewer looks for your words among the
titles and texts of the loaded points. `river` is exactly the title of one
article, so the search starts from that article's own vector, which is why the
first result is River at distance 0. The note in the panel says so in words:
"No embedder is connected, so typed words are matched against the labels and
texts of the loaded points, and nothing is sent."

When your words are not one whole title, each word is matched on its own. A
word matches every point that has it in its title or text. A word of three or
more letters that matches nothing exactly may match the start of a word. The
search then starts from the middle of the matched points. Words that match
nothing are named in the note; they are never dropped silently.

Under the box, the viewer suggests texts from the loaded points that match what
you are typing. Click one to search for it.

## Several searches

Write one search per line, up to four. Add a second line:

```text
river
music
```

Now there are two searches. The line reads
`A river · B music · 16 points lit`. Search B's results are Music, History of
music, Musical instrument, Singing, The arts, Folk music, Art and Classical
music, with a radius of 0.494.

For each pair of searches the panel adds a line that compares them: how many
points are within both radii, which results they have in common, and the
closest two different results, one from each. For river and music it begins
"A and B: no point found by both". A point that is lit and within the radius of
two or more searches is marked: it is drawn white on a dark picture (dark on a
light one), and the pair line carries the same mark.

Lines after the fourth are not searched, and the note says how many were left
out.

## The controls

The panel opens and closes when you click its **Search** line. Closing it does
not clear or pause anything: the line still names your searches and how many
points are lit. Every control is an ordinary button, menu, checkbox or slider,
so all of them work from the keyboard.

| Control | What it does |
|---------|--------------|
| **The text box** | One search per line, up to four. The viewer searches a moment after you stop typing. |
| **Face the searches** | Swings the view so that the searches are spread across the picture, then lets it move on. A new search does this once by itself; the button does it again. It does nothing in Focus, where the view is already fitted to the results. |
| **Lit** | Which points are lit. *The results, evenly*: every point within the radius, all equally bright. *By closeness: nearer is brighter*: a variable lit power, where the nearest result is lit most strongly and points fade with distance, down to nothing a little beyond the radius. *Named results only*: just the results themselves. |
| **Distance difference** | Writes the distances out. Each result in the lists shows its distance and how much farther it is than the nearest result, with a small bar, and each line on the picture shows its distance. |
| **Results** | How many results each search has: 3 to 100, and 8 to begin with. More results also means a larger radius, so more points are lit. |
| **From this search's point of view** | Off, or one of your searches. See below. |
| **Only results** | Shown in Focus only. Hides the points that are not lit, where every other view dims them. |
| **Clear** | Removes every search. Every point is shown again. |

Three more controls appear only when the page is connected to a reranker (see
[Searching by meaning](#searching-by-meaning)):

| Control | What it does |
|---------|--------------|
| **Reranker** | Lets a second model reorder the results. The nearest named points are taken as candidates, the reranker scores each against your text, and the best are kept. |
| **Candidates** | How many of the nearest named points are given to the reranker: 3 to 100, and 50 to begin with. |
| **Keep top** | How many of the reranked candidates are kept as the results: from 3 up to the number of candidates, and 20 to begin with. |

While the reranker is on, **Keep top** sets how many results there are, so the
**Results** slider is switched off. Each reranked result shows how many places
it moved. If the reranker fails or is slow, the results stay in order of
distance and the note says so.

### From a search's point of view

Normally every dimension counts the same in a distance. With this option on for
one search, each dimension is scaled by how large that search's own vector is
there. Dimensions that matter to the search count for more; dimensions where it
is near zero count for little. That search's results, its distances and the
fitted picture are then worked out in the scaled space. The other searches keep
plain distance. A result whose rank changed shows the rank it had in plain
distance.

This is still a linear change, one fixed scale per dimension. It is another way
of measuring, not a truer one, and the panel names it whenever it is on.

## The four views, with a search

The view buttons are under the panel. A search stays when you change view.

- **Tumble**, **Lattice** and **Wander** move as they always do. A search
  lights its points, dims the rest, and swings the view once toward the
  searches. In Lattice, a wire between two lit points keeps its strength and
  every other wire fades.
- **Focus** is the view made for search. It fits the picture to your searches
  and their results, so the results are spread across the picture instead of
  sitting wherever the tour happens to be. It keeps turning slowly. The results
  are numbered on the picture (`1`, or `A1` with several searches) and the
  full lists are laid beside it. In Focus you can also click a point to search
  from that point, and **Only results** hides everything that is not lit. With
  no search, Focus fits the picture to every point.

## Reading a search honestly

Two things are always true, and the viewer says both on the page.

**Distances are measured in the full space.** Every distance you read, in a
list, on a line, in the radius or in a pair line, is the cosine distance
between the whole vectors, over every dimension. It is never a length measured
in the picture. The same number decides the ranking, what is lit and what is
written.

**A picture is a shadow of the space.** The picture shows three directions out
of hundreds or thousands. Two points that look close may be far apart, and two
results that look far apart may be near. A lit point that seems to sit away
from the others is still within the radius: trust the list, not the positions.
This is why the lists and pair lines carry, as text, everything the picture
shows.

A search also says what it used. The viewer's provenance block, the folding
list at the bottom that says where the data came from, has a **Search** row
while a search is shown. It names the distance, how many
results were kept, the lit setting, how each search's vector was made and by
which model, the reranker if one was used, the point of view if it is on, and
where your text went.

Search finds near points. It does not answer questions, and a near point is not
a claim that two texts mean the same thing.

## Where your typed text goes

That depends on the kind of search, and the panel's note tells you each time.

| What you did | Where the text goes |
|--------------|---------------------|
| Typed words on a page with no embedder connected | Nowhere. The words are matched against the points already loaded in your browser. |
| Clicked a point in Focus to search from it | Nowhere. There is no typed text; the point's own vector is used. |
| Searched from a vector (only a page's own code can do this) | Nowhere. There is no typed text. |
| Typed text on a page with an embedder connected | To the page's embedder: code supplied by whoever made the page, which sends the text to an embedding model and gets a vector back. The note reads "The typed text was sent to the host's embedder." |
| Any of the above, with **Reranker** on | Your search text, together with the texts of the candidates, goes to the page's reranker. For a search from a clicked point the search text is that point's text. The note reads "The query and the candidate texts were sent to the reranker." |

The viewer itself sends nothing anywhere. It hands the text to the page's code
and to nothing else, and it does not store it. Who runs the embedder and what
they keep is a question for whoever made the page.

On the page that comes with this package, the embedder is the local helper
described next, and it is there only if you started it.

## Searching by meaning

Matching words finds articles that contain your words. To search by meaning,
with any text you like, your text has to be embedded: turned into a vector by
the same model that made the data. The page cannot do that alone. The package
has a helper for your own machine:

```text
embeddings-tumbler viewer serve tumbler --embed
```

With `--embed`, the page's own server can also embed a search text. The page
notices, and from then on what you type is embedded. The note changes to "Typed
text is sent to the host's embedder; nothing else leaves the page."

The helper needs an embedding service to ask, and a key for it. Both are read
from the environment of the server you started, not from the page:

| Variable | Meaning |
|----------|---------|
| `EMBEDDINGS_EMBED_URL` | The address of an OpenAI-compatible embedding service, including `/v1`. Without it, `http://localhost:8001/v1`. |
| `EMBEDDINGS_API_KEY`, or else `COLLEAGUE_API_KEY` | The key. Without one the command stops and names these variables. |
| `EMBEDDINGS_EMBED_MODEL` | The model to ask for. Without it, `Qwen/Qwen3-Embedding-0.6B`, the model that made the Wikipedia set. |

**The address and the key never reach the page.** They stay in the helper's
process. The helper answers the page with a vector and the model's name, and
nothing else about the service. Your text goes from the page to the helper on
your machine, and from the helper to the embedding service.

**The helper answers only your own machine** (the loopback address) unless you
pass `--embed-allow-remote` together with another `--host`. Do that only if you
mean other machines to use your key.

More flags:

| Flag | Meaning |
|------|---------|
| `--embed-model MODEL` | Ask for this model. It has to be the model that made the data you are viewing. |
| `--rerank-model MODEL` | Offer a reranker as well. This is what makes the **Reranker**, **Candidates** and **Keep top** controls appear. |
| `--query-prefix TEXT` | Put this text before every search text before embedding, for models that expect it. |

## When a search is refused

The viewer refuses a search it cannot make faithfully, with a plain message in
the note, and leaves the earlier searches as they were.

- **No word matched.** "None of these words matches a label or text among the
  loaded points", followed by the words.
- **Another model.** A search text embedded by a different model than the data
  cannot be compared with it, and is refused. One view compares one model.
- **Reduced data.** Some data files carry vectors that were rotated or cut
  down after embedding. A freshly embedded text is not in that changed space,
  so on such a file search by meaning is not possible; the viewer says so and
  matches your words among the loaded points instead.
- **The embedder failed or was slow.** The earlier results are kept.
- **New points arrived.** If the page adds points while a search is shown, the
  results are marked as being from before the new points, and are worked out
  again by themselves.

## What is not done

- Only Chromium (the engine of Chrome and Edge) has been tested automatically.
  Other browsers have not been measured.
- Reduced data files (rotated, or cut to their strongest directions) cannot be
  searched by meaning. Matching words and searching from a point still work on
  them.
- Where result texts on the picture would overlap, the later ones are left
  out. The lists always carry every result.
- Wander does not visit the results; it keeps its own route.
- In the automatic tests the helper talks to a stand-in for an embedding
  service, not to a live one.
