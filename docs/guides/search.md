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
  removed. (One setting of **Lit**, *everything, results highlighted*, leaves the
  other points at their usual brightness instead.)

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
the model `google/embeddinggemma-2` from the first sentences of the article's
introduction, and has 768 dimensions. The titles and texts are Wikipedia's,
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
| 2 | Lake | 0.214 |
| 3 | Nile | 0.221 |
| 4 | Flood | 0.229 |
| 5 | Wind | 0.229 |
| 6 | Erosion | 0.233 |
| 7 | Fishing | 0.235 |
| 8 | Drinking water | 0.239 |

The radius of this search is 0.239, the distance of its eighth result.

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
music, Singing, Musical instrument, Art, The arts, Entertainment and Dance,
with a radius of 0.241.

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
| **Relative** | Tumble only. Makes the first search the vertical axis, so a point's height is its vector measured along the search. See [Relative search](#relative-search). While it is on, **Face the searches** is not shown. |
| **Show the origin** | Tumble only. Zooms out to include the all-zero vector, or, in the plain view, marks where it falls. See [Show the origin](#show-the-origin). |
| **Face the searches** | Swings the view so that the searches are spread across the picture, then lets it move on. A new search does this once by itself; the button does it again. It does nothing in Focus, where the view is already fitted to the results. |
| **Lit** | Which points are lit. *The results, evenly*: every point within the radius, all equally bright. *By closeness: nearer is brighter*: a variable lit power, where the nearest result is lit most strongly and points fade with distance, down to nothing a little beyond the radius. *Named results only*: just the results themselves. *Everything, results highlighted*: the fourth choice, described under the table. |
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

**Everything, results highlighted** is for when you want to see a search
without losing the rest of the picture. The other three choices dim every point
that is not lit, so the picture becomes the search and little else. This one
leaves every other point as bright as it is with no search, with its own colour,
and draws the results on top of that: more than twice as bright and about a
third larger. So you keep the whole cloud, its groups and its shape, and still
see where the results fall in it. What counts as a result is the same as under
*the results, evenly* (every point within the radius), and the panel's count,
"8 points lit", still counts the results, not every point; the note adds "(every
other point is shown too)". Two things to know: the other points are drawn
about a tenth larger than with no search, because the viewer has one dial for a
point's size and brightness; and where many points crowd together, the results
among them stand out by size more than by brightness, since a crowd is already
near the brightest the screen can show. The lists and the labels always say
which points are the results.

## The four views, with a search

The view buttons are under the panel. A search stays when you change view.

- **Tumble**, **Lattice** and **Wander** move as they always do. A search
  lights its points, dims the rest, and swings the view once toward the
  searches. In Tumble, the **Relative** setting
  can instead make the search the vertical axis (see
  [Relative search](#relative-search)). In Lattice, a wire between two lit points keeps its strength and
  every other wire fades. (With Lit set to *everything, results highlighted*
  the other wires fade only to about half, and in Wander the far points are
  dimmed less by distance than with no search.)
- **Focus** is the view made for search. It fits the picture to your searches
  and their results, so the results are spread across the picture instead of
  sitting wherever the tour happens to be. It keeps turning slowly. The results
  are numbered on the picture (`1`, or `A1` with several searches) and the
  full lists are laid beside it. In Focus you can also click a point to search
  from that point, and **Only results** hides everything that is not lit. With
  no search, Focus fits the picture to every point. Only results hides the
  points that are not results under every Lit setting, *everything, results
  highlighted* included: the checkbox wins.

## Relative search

Relative is a setting of the **Tumble** view. It turns a search into a ruler.
Without it, the picture is a shadow of the space and a point's place on the
screen says little about how near it is to your search. With it, one direction
on the screen is the search itself, and how high a point stands is how far
along the search its vector reaches.

This section was written from the code and from measurements of the Wikipedia
set. Its screen text is quoted from the code. The steps in it have not been
taken in a browser by a test the way the steps above were, and Only Chromium has
been tested for the rest of the viewer.

### Turning it on

Open the panel in Tumble. Two checkboxes are in the controls row, before the
other controls: **Relative** and **Show the origin**. Both are off to begin
with. They are offered in Tumble only; the setting is remembered in the other
views and applies when you come back to Tumble. A page can also start with them
on (the host guide says how).

With **Relative** on and at least one search, the view turns onto the search
over about a second and a half. While it turns, you see only a faint line for the
ruler: the ruler is not drawn as exact until the turn has ended. Turning
Relative on while the view is swinging toward a new search replaces that swing.
If the view is paused, or you prefer reduced motion (the viewer then starts
paused), nothing turns: turning Relative on or off, adding or removing a search
and Show the origin are shown at once, already settled, with the ruler exact.
You do not need to press Play to see them.
The **Face the searches** button is not shown while Relative is on, because the
search itself fixes the view.

### What you see, and what it means

Search `Rice` and turn Relative on. The searched article, Rice, is a point
that sits on the ring at the top of a vertical ruler. Beside each search's ring
is its letter and name, `A · Rice`: the words you searched for, or the title of
the point you searched from. The ruler has a tick and a
faint level ring every 0.1 and a title, `cosine to A`. A point's **height**
is its vector measured along the search: the number you read off the ruler.
Each named result is joined to the ruler by a thin stem at its height, and
carries its title and its height, for example `Cereal  0.84`. A point with no
title (only an id) shows the start of its text instead, cut at 28 characters. With several
searches, a result's label gives its height along each. The panel's lists add
`cosine 0.839` to each result row.

On this set every vector has length one, so height along the search is the same
as cosine similarity. That is the sentence the viewer's provenance block gives:
"Every vector has length one (within 0.001), which is why height is cosine
similarity." On a set whose vectors are not all of length one, the ruler's title
says `length along the search to A`, and a result's label shows both numbers:
its height, then `cosine` and its cosine to the search. In that case height and
cosine are different things, and the viewer never calls one by the other's name.
Results are still ranked by cosine, so on such a set the first result need not
be the highest on the ruler, and the viewer says so.

**What is exact and what is not.**

- **Height is exact.** It is measured over every dimension of the data. A
  point's height does not depend on how the picture is turned, and the same
  number is in the panel's list.
- **Sideways position is still a shadow.** The other two directions on the
  screen tour the set's strongest directions with the search directions
  removed (the ones the plain tour already found, so turning Relative on needs
  no second fit). They hold only a share of what is left once the search is
  taken out (the viewer prints it; on the Wikipedia set, about 18% of the
  remaining spread). Two points side by side may be far apart in the space.
- The view is level and nearly flat (the perspective is almost removed), so two
  points of equal height stand at nearly equal heights on the screen, within
  about 2 percent of the ruler's length by the build's own check. If you tilt
  the picture by dragging, heights stop reading true until you level it.
  Moving the picture without turning it (a right-button drag, Shift and drag,
  two fingers on a touch screen, or the arrow keys) is safe: it shifts the
  ruler, the stems and the points together by the same amount on screen, so
  every height still reads true. The Reset view button puts it back.

**A search made from a point or a whole title names that point first.** Type
`Rice`, the whole title of an article, and the search starts from that article's
own vector. Rice is then its own first result, at rank 1, height 1.00 on a set
of unit-length vectors. It sits on the search's marker at the top of the ruler,
so it gets no stem and no label of its own. The other results are the same as
without Relative: Relative changes the picture, not the ranking.

**The ruler's range comes from the data.** It covers the lowest point's height up
to the higher of the search's own length and the highest point's height, with a
small margin, and starts no lower than 0. How wide that is depends on the model.
For the demo set (`google/embeddinggemma-2`), articles sit in a narrow cone:
the cosine of any article to *Rice*, *Jazz* or *Volcano* lies between about 0.53
and 0.84 (apart from the article itself), and the mean of all the vectors is
0.79 from the all-zero vector. By the ruler's rule that puts its ticks for *Rice* from about 0.3
to 1.0 (worked out from the rule, not read off a screen). A model that spreads articles more gives a longer ruler. The measured
second model, `Qwen/Qwen3-Embedding-0.6B`, spreads the same articles from about
0.05 to 0.72, with a mean 0.49 from the origin. The 0.53 to 0.84 band is the
demo model's, not a property of every model.

**Labels that would collide are left out.** Ticks and the title are placed
first, then each search's letter and name, then result labels, the highest on
the ruler first, so a search's name is never hidden by a result's label. A label that would
overlap one already placed is left out. The panel's lists always carry every
result.

Points that are not results are faded, and drawn brighter the closer they are
to a search in plain cosine: every such point gets some light and the closest
ones most. The fade has one strength; there is no control for it. The results
keep the brightness the **Lit** setting gives them and stay the brightest.
With Lit set to *by closeness* every point is usually lit already, so the
fade then changes nothing.

To see the rest in full instead, set **Lit** to *everything, results
highlighted*. There is then no such gradient: every point that is not a result
is drawn at its usual brightness, the same for all of them, and the results
are highlighted over that. Lit is the one control that chooses between a
faded rest and a rest shown in full.

**The relative view is drawn sharp.** In the other views a point far in front
of or behind the middle of the picture is drawn larger and softer, and bright
points glow, which gives the cloud depth. In the relative view you read heights
off a ruler, so nothing is blurred by its depth and the glow is turned well
down: each point stays a separate dot, and a crowded cloud does not melt into
one white patch. The change comes in as the view turns into the relative view
and goes as it turns back; the plain view is drawn exactly as before. Trails
are as in every view, and the **Trails** checkbox switches them as always.

### Show the origin

**Show the origin** zooms out to include the all-zero vector, the origin, at
height 0 on the ruler. It is drawn as a cross labelled `origin (0, 0, … , 0)`.
On a set of unit-length vectors a dashed circle also marks the vectors of length
one around it. When height 0 already lies inside the ruler's range, the cross is
drawn without the checkbox.

In the plain Tumble view (no search, or Relative off) the checkbox marks where
the all-zero vector falls in the picture, with its true distance and how much of
that distance the picture shows, in the form `origin · truly {far} from the
centre, {seen} of it visible`. The first number is the true distance, over every
dimension. The second is the part of it that the three directions on the screen
can show, and it changes as the picture moves. On the Wikipedia set the picture
centres on the mean of the vectors, which is 0.79 from the origin, so the first
number reads 0.79.

### More than one search

A search's letter is its colour, and Relative keeps letters: if you have `rice`
and `wheat` (A and B) and delete the first line, the remaining search is still
B, in B's colour, and is now the vertical axis. With Relative off, letters are
given by position as before.

- **A second search** pins the horizontal axis to the part of B that A does not
  contain. The plane of A and B is then shown exactly, and a second ruler for B
  starts at the origin and has dots at 0.1 to 0.9. *Rice* and *Wheat* (cosine
  about 0.82 on the demo set) give two axes.
- **A third search** pins depth the same way. All three axes are then exact and
  nothing tumbles. The status line says so.
- **A fourth search** is lit and listed but gives no axis, and the note says so:
  the first three searches pin all three.
- **A search that points the same way as an earlier one** gives no axis. The note
  says "points the same way as", and the search is still lit. A search pointing
  exactly the opposite way is treated the same, because it lies on the same
  axis. A repeated search is the usual case; two different articles are not
  close enough to count as the same direction.
- A search whose vector has length zero has no direction and gives no axis.

### With the reranker

The reranker does not move anything. The frame comes from the search vectors
alone, so the picture stays where it was and only the results change. The
results the reranker keeps carry its ranks next to their text (`1.`, or `A1.`
with several searches). A dashed line across the ruler marks the lowest of the
candidates that were sent to it, with the words "50 candidates above this line
went to the reranker" (the number is how many were sent). The reranker saw only
the nearest candidates, not every point, and the line sits at the height of the
lowest of them.

### With a point of view

"From this search's point of view" (above) ranks that search's results in a
scaled measure. **Height is not the scaled measure.** Height is always the plain
measurement along the search, whatever point of view is on. So with it on, rank
and height can disagree: the first result need not be the highest on the ruler.
The viewer says so: "With A's point of view on, its results are ranked in the
scaled measure and height is not: rank and height use different measures." The
list shows the plain rank that a moved result had.

A real case. On the demo set, search `Jazz` (it is the whole title of an
article, so the search starts from that article's vector). Without a point of
view, the nearest results after Jazz itself are Rock music (cosine 0.778), Dance
(0.762), History of music (0.753), Pop music (0.739) and Singing (0.721). Turn
on A's point of view, which is the scaled measure. Jazz is still first, at
height 1.00. The next, in the scaled measure, are:

| Rank | Article | Height on the ruler |
|------|---------|---------------------|
| 2 | Dance | 0.762 |
| 3 | Film | 0.710 |
| 4 | History of music | 0.753 |
| 5 | History of life | 0.677 |
| 6 | Singing | 0.721 |
| 7 | Urbanization | 0.680 |
| 8 | Rock music | 0.778 |

Dance is first after Jazz itself, and is not the highest: Rock music, ranked
last of the eight, stands highest of them on the ruler, at 0.778. The scaled
distances of these results to Jazz are all between 0.008 and 0.010, so small
differences decide the scaled order. Neither order is wrong.
They answer two questions: rank answers "nearest in the measure that gives this
search's own strongest dimensions the most weight", and height answers "how far
along the search's own direction". This was worked out for this guide with a
short script, using the committed demo pair and the same rule as the viewer
(each dimension scaled by the size of the search's own vector there), and the
ranks checked against the viewer's own ranking code. It is one search and
one set. A search where the first result is also the highest, like *Rice* (Cereal
first and highest in both measures), shows nothing of this.

### Limits

- Relative applies in Tumble only.
- It needs at least one search with a direction.
- Height is exact only once the turn has ended, and only while the view is
  not tilted.
- Only Chromium has been tested automatically.
- It adds no request: Relative sends nothing anywhere, with or without a
  reranker (a reranker is sent what it is sent without Relative).

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
| `EMBEDDINGS_EMBED_MODEL` | The model to ask for. Without it, `google/embeddinggemma-2`, the model that made the Wikipedia set. |

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
