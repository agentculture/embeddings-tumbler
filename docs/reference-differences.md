# Differences from the reference demo

The reference is one page, `docs/specs/reference/embedding-tumbler-demo.html`.
The built viewer is the standalone page (`embeddings_tumbler/static/index.html`)
over the one core file. This document lists every difference between them that
was intended, so a person can check them off, and then lists what a side-by-side
look found that nobody had written down. It is prepared for the user's
sign-off. **The user signed off on 2026-11-14, with one qualification; see the last
section.**

How to read this document:

- Each difference has four lines: what the reference does, what the build does,
  why, and whether it can be seen on the built-in sample set (12,288 points,
  384 dimensions).
- A difference is **intended** when a builder recorded it as deliberate, when the
  spec requires it, or when the user asked for it during live testing. Anything
  else seen in the side-by-side goes under "Unintended differences found".
- Statements about how something *looks* come from screenshots taken on
  2026-11-14. Statements marked *(read from the code)* come from reading the
  source or its notes and were not seen in a rendered picture.
- The side-by-side was made with headless Chromium on the GPU (renderer string
  `ANGLE (AMD, Vulkan 1.4.318 (AMD Radeon 760M Graphics (RADV PHOENIX)
  (0x000015BF)), radv)`) at 1280 by 800 and 390 by 844, in Tumble, Lattice and
  Wander, after 9 seconds in each. The reference's request for Google Fonts was
  blocked, so its fonts fell back as well (see "Fonts"). Both pages ran at
  60.5 frames per second. The reference's Tumble is unseeded and its Wander
  route is random, so the two pages never show the same frame; the comparison is
  of look and layout, not of frames.
- The development page `js/dev/side-by-side/` shows both pages next to each
  other with this list beside them. Serve the repository root with
  `uv run embeddings-tumbler viewer serve . --port 8791` and open
  `/js/dev/side-by-side/`.

## Fonts

The reference loads Instrument Serif, IBM Plex Sans and IBM Plex Mono from
Google Fonts, another origin. The built page may not load anything from another
origin and bundles no font files, so each role uses a local stack
(`js/page/page.css`, `--page-font-*`). Each stack names the reference's face
first, so a machine that has it installed uses it.

Measured with Chromium's `CSS.getPlatformFontsForNode` on the development
machine (Ubuntu, none of the reference's faces installed), 2026-11-14:

| Reference face | Where it is used | Face used here | What looks different |
|----------------|------------------|----------------|----------------------|
| Instrument Serif, italic | The title "Embedding Tumbler", the selected mode name (Tumble, Lattice, Wander), the note headings | P052 Italic (a Palatino clone) | Instrument Serif is a condensed, high-contrast display face; P052 is wider and rounder. At 64 px the title is 510 px wide against the reference's 460 px (11% wider); the mode names and note headings look heavier and less narrow. |
| Instrument Serif, upright | The unselected mode names | P052 Roman | Same: wider, less contrast. |
| IBM Plex Sans | The mode summaries and the note paragraphs | Ubuntu Regular | Ubuntu is rounder; line breaks in the note paragraphs fall in different places (seen at 1280 px). |
| IBM Plex Mono | The counts line, the status line, the readout caption, the controls and hint, the provenance block, the note headings' labels ("What is happening") and the closing note | Ubuntu Mono Regular | Ubuntu Mono is narrower: "WHAT IS HAPPENING" at 11 px is 123 px wide against 138 px (11% narrower), so the counts line, status line and captions are shorter. |

Those widths were measured with the reference's Google Fonts loaded and the
built page offline. In the side-by-side made for this document the reference's
fonts were blocked, so it fell back to its own stacks: Liberation Serif for its
serif text, Noto Sans for its body text and DejaVu Sans Mono for its data text,
against the built page's P052, Ubuntu and Ubuntu Mono. The two pages therefore
differ in typeface in every screenshot even where neither has the reference's
fonts. On other systems the fallbacks differ again; going by the stacks' order,
not checked on those systems: Palatino Linotype, Segoe UI and Cascadia Mono or
Consolas on Windows; Iowan Old Style, Seravek and SF Mono on macOS.

Bundling the reference's faces (all three are under the SIL Open Font License)
as same-origin files with `@font-face` would remove these differences. It was
not done; see "Not yet compared or not yet decided".

### Display face: the title, mode names and note headings

- **Reference:** Instrument Serif, italic for the title, the selected mode and the headings.
- **Build:** the local serif stack, P052 here.
- **Why:** nothing may be loaded from another origin and no font file is bundled.
- **Visible on the sample set:** yes, in every mode and at both widths: wider letters, less contrast.

### Body face: the mode summaries and note paragraphs

- **Reference:** IBM Plex Sans.
- **Build:** the local sans stack, Ubuntu here.
- **Why:** the same.
- **Visible on the sample set:** yes: round letters, and line breaks in the notes fall in different places.

### Data face: counts, status, captions, controls and the closing note

- **Reference:** IBM Plex Mono.
- **Build:** the local monospace stack, Ubuntu Mono here.
- **Why:** the same.
- **Visible on the sample set:** yes: narrower letters, so the counts line, status line and captions are shorter.

## Page chrome and layout

### A shorter stage on short screens

- **Reference:** the stage is `clamp(420px, 72vh, 900px)` tall at every screen height.
- **Build:** the same, except that under 560 px of screen height it is `clamp(260px, 70vh, 420px)`, so the panel stays in reach below the sky.
- **Why:** a phone held sideways and a small board's display *(read from the code)*.
- **Visible on the sample set:** no, not at 1280 by 800 or 390 by 844 (both pages are 576 and 608 px tall there).

### Note text filled in from the data

- **Reference:** the note paragraphs say "384 dimensions", "a thousand of the points" and "the ring of months" as fixed text.
- **Build:** the page fills in the dimension, the wire count and the ring sentence from the loaded set, and uses neutral words ("hundreds of", "a ring") when the data does not have them.
- **Why:** the dimension comes from the data; the spec forbids hard-coding it.
- **Visible on the sample set:** no. The text of all three notes is identical to the reference's (compared as text).

### The closing note depends on the data

- **Reference:** one closing note, "The data is synthetic: ...", always.
- **Build:** the same note for the sample set; for a data file, a note that the vectors came from that file and that the provenance block says where.
- **Why:** the note would be false for real data.
- **Visible on the sample set:** no. The sample set's note is identical to the reference's.

### The mode comes from `?mode=`, not from `#mode`

- **Reference:** the mode is kept in the URL fragment (`#lattice`); switching modes changes the fragment and a changed fragment switches modes.
- **Build:** the page reads `?mode=tumble|lattice|wander` once at load, and `?seed=` and `?data=` the same way; switching modes does not change the address.
- **Why:** the page takes a seed and a data address as well, and a query string carries all three *(read from the code)*.
- **Visible on the sample set:** no.

## Tumble's motion

### A seeded guided tour, not an unseeded random walk

- **Reference:** the frame drifts with a smoothed random velocity through all 384 dimensions. It is different on every load.
- **Build:** a closed-form tour that turns inside the eight strongest principal directions of the data. The frame is a function of time, the seed and the data, so the same data, seed and elapsed time give the same frame. The rate is the reference's, 0.42 radians per second.
- **Why:** reproducibility is a spec requirement, and a random frame does not work on real vectors. `docs/evidence/2026-11-13-real-vector-probe.md` measured 311 real texts embedded by Qwen3-Embedding-0.6B in 1024 dimensions: group separation (1.0 means no visible grouping) was 1.117 in the full space and 1.110 for the mean of 300 random 3-D frames (5th to 95th percentile 1.030 to 1.206), against 1.479 for a random frame inside the top 8 principal directions and 1.902 for the top 3. The evidence file's own conclusion: "A uniformly random frame in 1024-d shows no more grouping than chance. The demo's random tour only works because its synthetic regions were generated tight."
- **Visible on the sample set:** yes, strongly. See the next item.

### What the guided tour looks like on the sample set

- **Reference:** each of the nine topic regions is a wide, fuzzy cloud of many small, sharp stars; regions overlap and slide through each other.
- **Build:** each region is a compact bright blob, and the filaments and bridges between regions show as thin dotted arcs between the blobs; while the view moves, those arcs smear into long streaks. With the motion paused the arcs are dotted threads, so they are structure and not trails. The faint unstructured halo shows as a small ball near the middle.
- **Why:** the tour stays inside the strongest directions, where the distances between regions are large and the spread inside a region is small, so a region collapses to a blob. This follows from the item above; it is not a separate setting. It is written down here because it is the largest visible change on the sample set, and the user has not yet judged it.
- **Visible on the sample set:** yes, in every Tumble picture (`ref-tumble-1280.png` against `build-tumble-1280.png`, and the paused pair `paused-ref-tumble.png` and `paused-build-tumble.png`).

### The starting frame

- **Reference:** a random frame.
- **Build:** the top three principal directions when there is no earlier view; when the mode is entered from another mode, the frame that was showing.
- **Why:** a random frame is not reproducible, and the top three directions are the best-grouped view.
- **Visible on the sample set:** no, apart from the first seconds *(read from the code)*.

### Tumble's summary under its tab

- **Reference:** "The window turns through every dimension at once".
- **Build:** "The window turns through the strongest directions", of the same length and, like the reference's summaries, without a full stop. Lattice's and Wander's summaries are the reference's words exactly.
- **Why:** a guided tour turns only through the strongest directions, so the reference's words would not be true of it.
- **Visible on the sample set:** yes, under the Tumble tab at 1280 px wide (summaries are hidden under 600 px).

## Lattice

### Hidden directions are seeded per swap

- **Reference:** the hidden direction for each swap is drawn from one running random stream.
- **Build:** each swap's hidden direction is drawn from the seed and the swap's number. The swap period (3.4 seconds), the eased quarter turn and the rule that one visible axis is traded at a time are the reference's.
- **Why:** reproducibility.
- **Visible on the sample set:** no.

### Hidden directions come from the strongest directions

- **Reference:** each hidden direction is drawn from the whole space.
- **Build:** each hidden direction is drawn inside the span of the data's 8 strongest principal directions (the same fit Tumble's tour uses), orthogonal to the axes still shown. The mode option `hidden: "full"` gives the reference's rule.
- **Why:** found on real vectors (`docs/evidence/2026-11-14-real-atlas-proof.md`). In a real 768-d or 1024-d set a direction drawn from the whole space holds about a thousandth of the variance, so after three swaps the picture was a random one: group separation 1.126 against a random baseline of 1.114. With this rule it is 1.472 on the same file. The reference's synthetic regions are tight enough to survive random directions; real vectors are not. Approved by the owner on 2026-11-14 (deviation `d5`).
- **Visible on the sample set:** yes. After the first swaps the regions stay apart as compact groups, as in Tumble, instead of drifting through looser random views. Lattice also waits for the fit before its first frame.

### A fresh Lattice starts from a seeded frame

- **Reference:** a random frame when nothing came before.
- **Build:** a seeded random frame.
- **Why:** reproducibility.
- **Visible on the sample set:** no.

### The dimming, trails and wires no longer wait for the neighbours

- **Reference:** the neighbours of the first 1,000 points are measured first. Lattice's motion runs meanwhile, but the dimming of unlabelled points, the shorter trails and the wires all ease in together, with a time constant of 0.4 seconds, only after measuring has finished.
- **Build:** the dimming and the shorter trails blend in when the mode is entered (1.2 seconds); the wires fade in over 1.2 seconds when they have been measured.
- **Why:** the mode responds at once and the wires do not make the rest wait.
- **Visible on the sample set:** yes, for the first seconds after switching to Lattice. After that both pages show the same 1,870 wires.

### Crowded wires are dimmed instead of burning out to white

- **Reference:** every wire is drawn at the same gain however many pile up in the same part of the picture. On the sample set the lattice burns out to a white mass, most of all when a swap is nearly through and the lattice collapses to a thin shape: 3,435 near-white pixels (channel sum above 600) on a 320 by 180 copy of the build's stage before this change, with the same rule.
- **Build:** the viewer measures the wire light per pixel where the wires' light lands, from the number of wires and how tightly the current frame packs them on the stage, and scales all wires down by the same factor when it is above a fixed load (`js/api/50-viewer.md`, "Crowded wires"; the renderer's draw key `wireLoad`). A wire seen near its true length still flares against one that is not. The same rule applies with a search shown, on top of the wires following the search.
- **Why:** the owner found Lattice "very bright" and asked for it to be toned down ("Please do", 2026-11-14), an approved deviation from the rule that the no-search picture must not change. Tumble, Wander and Focus draw exactly as before.
- **Visible on the sample set:** yes. At a swap 90% through the near-white count falls from 3,435 to 693 (about 360 of those are the cores of labelled points), at 10% from 3,130 to 686; the wires stay visible as thin coloured lines, and the blocky glow around the brightest parts mostly goes with the burn-out (GPU, 1280 by 900, 2026-11-14).

## Wander

### Wander starts at once

- **Reference:** a global pass measures 24 neighbours for each of the first 1,000 points before Wander can start. Until it ends, choosing Wander plays Tumble's motion and the status line reads "measuring true neighbours in 384-d ... N%".
- **Build:** no global pass. Each stop's 24 neighbours are measured when the route reaches the stop, among the first 1,000 points plus every labelled point. On the sample set all 290 labelled points lie inside the first 1,000, so the pool is the reference's.
- **Why:** the first stop appears at once and the work is spread out.
- **Visible on the sample set:** yes, for the first seconds after switching to Wander.

### The route comes from the seed

- **Reference:** each hop draws from one shared random stream, so every load wanders differently.
- **Build:** each hop draws from the seed and the hop's number, so the route depends only on the seed and the data. The rules are the reference's: a near hop picks among the first six labelled neighbours, every fifth hop leaps to another group, and no stop repeats within 16 stops.
- **Why:** reproducibility.
- **Visible on the sample set:** yes: with the default seed the build's first stops are always the same ("surplus" in both runs made here); the reference's differed between loads ("relief", "octave").

### Where a fresh Wander starts, and a stop with no group

- **Reference:** the first flight leaves from the current frame and centre.
- **Build:** the same from another mode; a fresh Wander starts from a seeded frame and the data's mean. A stop with no group may leap to any group.
- **Why:** reproducibility and data that has no groups.
- **Visible on the sample set:** no.

### Distances tuned by eye are scaled to the data

- **Reference:** the fog distances and Wander's zoom are fixed numbers chosen for the sample set.
- **Build:** the same numbers multiplied by the data's radius over the sample set's (0.963).
- **Why:** other data has other distances.
- **Visible on the sample set:** no; on the sample set the numbers are the reference's *(read from the code)*.

## Mode switching and timing

### Motion is a function of time, not of frames

- **Reference:** the centre eases toward the mean and the zoom toward its target by a fixed fraction each frame, so the motion depends on the frame rate.
- **Build:** the same time constants (0.7 seconds for the centre, 0.6 for the zoom) in closed form, so the same time gives the same picture at any frame rate. After a frame that took over 50 milliseconds, or an update that took over 20, the next frame advances by one normal frame instead of leaping.
- **Why:** reproducibility.
- **Visible on the sample set:** no.

### Switching modes blends over a fixed time

- **Reference:** a new mode continues from the current frame; draw settings ease by exponential mixes with time constants between 0.4 and 0.7 seconds.
- **Build:** the new mode starts exactly at the last frame drawn and blends the frame and the draw settings with a smoothstep over 1.5 seconds (Tumble), 1.2 (Lattice) or 1.0 (Wander).
- **Why:** one rule for all three modes and for modes a host adds.
- **Visible on the sample set:** yes, as a difference in how a switch feels; not seen in a still picture.

### Auto-framing uses a fixed sample

- **Reference:** the zoom that frames the cloud is computed from the 290 named points.
- **Build:** from the first 512 points, a fixed sample, so an append past it does not move the framing.
- **Why:** appends must not change the framing.
- **Visible on the sample set:** no; on the sample set the 290 named points are the first 290 of the 512 *(read from the data)*.

### Auto-framing keeps the outermost regions and their names inside the stage

- **Reference:** zoom = 0.78 divided by the root mean square of the projected coordinates.
- **Build:** the same, but never more than puts the 98th-percentile radius of the sample at 0.88 units, which leaves room for the group names inside the stage's shorter side (the edge is at 1.087 units). Tumble and Lattice use it; Wander's flight keeps the reference's fixed zoom.
- **Why:** on the guided tour the regions are compact blobs far apart and the names sit on the outermost ones, so with the reference's rule alone "ASTRONOMY" and "MUSIC" were cut off at 390 px wide and the cloud reached the title at 1280. Measured over 120 seconds on the sample set, as the 98th-percentile distance of the points from the stage's centre in shares of half the stage (1.0 is the edge): Tumble, median 0.95 and at most 1.38 at 390 px wide before, median 0.67 and at most 0.85 after; at 1280 px, median 0.90 and at most 1.33 before, 0.63 and 0.85 after. Lattice: at 390 px, 1.02 and 1.54 before, 0.66 and 0.82 after; at 1280 px, 0.93 and 1.50 before, 0.63 and 0.77 after. Group names, with their width: Tumble at 390 px at most 1.44 before, 0.99 after. The reference's own rule on random frames measured median 0.97 and at most 1.59 at 390 px: it also leaves the stage, but there the outermost points are dim dust and the names sit near the middle, so it does not show.
- **Visible on the sample set:** yes: Tumble and Lattice show a smaller cloud than before with every name inside the stage (`after-build-tumble-390.png`).

## Status lines

### Tumble's status line

- **Reference:** "view turned 218° through 384-d", the angle turned so far.
- **Build:** "tour of 8 strongest directions · 64.6% of variance", the share of the data's variance held by the directions the tour moves through. After an append it adds "before N new points" until the directions are fitted again.
- **Why:** the tour is not a random walk, so there is no angle to count; the share says what the picture can and cannot show.
- **Visible on the sample set:** yes.

### Lattice and Wander status lines

- **Reference:** Lattice reads "swap 3 · axis Z trading for a hidden direction · 66% · 1,870 wires"; Wander reads `at "relief" · emotion · stop 2` or `"octave" → "tempo"`, with "· long leap to ocean" when the group changes.
- **Build:** the same wording and numbers. Names longer than 24 characters are cut. Before the neighbours are measured the line reads "... · measuring N%" instead of the reference's "measuring true neighbours in 384-d ... N%"; while Tumble's directions are being found it reads "finding the strongest directions in 384-d ... N%".
- **Why:** the build prepares each mode in small steps and reports them.
- **Visible on the sample set:** slightly: the wording is the same; the preparing lines show for a moment.

### The status line may wrap

- **Reference:** one line, cut off with an ellipsis when too long (seen at 390 px wide: "swap 3 · axis Z trading for a hidden directio...").
- **Build:** wraps onto a second line (seen at 390 px wide).
- **Why:** nothing the status says is lost on a narrow screen.
- **Visible on the sample set:** yes, at 390 px wide in Lattice.

## Labels

### Labels are page text, not canvas drawing

- **Reference:** group names, the stop's name, its neighbours' names and the hover name are drawn on a 2-D canvas over the sky.
- **Build:** they are text elements over the sky, filled in with `textContent`, at most 64 at once, taken from at most 300 labelled points per frame. Names longer than 40 characters are cut. Group names are capitals by style sheet, so the text itself is unchanged.
- **Why:** untrusted text must be inserted as text; text is selectable and takes the page's fonts *(read from the code)*.
- **Visible on the sample set:** slightly: the layout, sizes, colours and the dark outline are the reference's (the outline is a ring of text shadows standing in for the canvas stroke); the typeface differs as under "Fonts".

### Which points are labelled

- **Reference:** the 290 named points.
- **Build:** every point whose label is a non-empty string that is not just its id.
- **Why:** real data has no list of named points.
- **Visible on the sample set:** no; they are the same 290.

## The readout strip

### One cell per dimension of the data

- **Reference:** 384 cells, and the caption says "384 dimensions" and "dimension 384".
- **Build:** one cell per dimension of the loaded data (a canvas that many pixels wide, stretched), and the caption names the real number, with a thousands separator ("2,560"). The formula is the reference's (the colours are not; see the next item).
- **Why:** the dimension comes from the data.
- **Visible on the sample set:** no. The strip's size (22 px between two 1 px lines) and the 6 px gap before its caption are the reference's (measured at 1280 and 390 px wide).

### The strip's cells are coloured by screen axis

- **Reference:** the demo's strip draws every cell in the one accent colour, its green channel lowered a little where the contribution is large.
- **Build:** each cell mixes three colours (horizontal orange, vertical green, depth blue-violet) by how much its dimension feeds each of the three screen axes, so a dimension that feeds only one axis shows that axis's colour. The opacity is the reference's formula, unchanged. The caption gains a legend naming the three colours. On a light background the three colours are darker so they stay readable; the colours are fixed and not themable.
- **Why:** the user asked for it (2026-11-14): it shows which dimensions are carrying which direction of the view.
- **Visible on the sample set:** yes: the strip is orange, green and blue-violet where the reference's is amber, and the caption ends with the three coloured words *(read from the code; not yet seen in a rendered picture)*.

## Controls and input

### User zoom

- **Reference:** none; each mode frames the cloud by itself and the user cannot change that.
- **Build:** the user can zoom on top of each mode's automatic zoom: the mouse wheel (only while the viewer has focus, so the page still scrolls), Ctrl or Cmd with the wheel (a trackpad pinch arrives this way), a pinch with two fingers, `+` and `-`; double-click, double-tap, the Reset zoom button or `0` put it back. Switching modes still frames the cloud.
- **Why:** the user asked for it during live testing on a desktop and on an iPhone 13.
- **Visible on the sample set:** yes, as an added button and hint; the picture is unchanged until the user zooms.

### The Reset zoom button

- **Reference:** none.
- **Build:** a button beside Pause.
- **Why:** a way back from user zoom for touch screens, which have no keys.
- **Visible on the sample set:** yes.

### Touch-friendly buttons

- **Reference:** a Pause button of 76 by 28 px at every width; mode buttons without a minimum height.
- **Build:** the mode buttons are real buttons at least 44 px tall. The Pause button is the reference's 76 by 28 px at 600 px wide and over (Reset zoom the same height); under 600 px wide both are 32 px tall. The speed slider is the reference's 130 px.
- **Why:** the user asked for touch-friendly buttons during live testing on an iPhone 13; 32 px is the height that was tested there.
- **Visible on the sample set:** yes, slightly, at 390 px wide (Pause 76 by 32 px against 76 by 28).

### Keys 1 to 3 switch modes, only while the viewer has focus

- **Reference:** no keys.
- **Build:** `1` to `3` switch modes in button order, `Space` plays and pauses, `Escape` dismisses a notice. They work only while focus is inside the viewer; no listener is added to the page or the window.
- **Why:** the user asked for keys 1 to 3, and a viewer on a host page must not take keys from it.
- **Visible on the sample set:** yes: the hint line says so.

### A longer hint that sits on its own line

- **Reference:** "Drag the sky to turn it. Hover a bright star to name it." on the same row as the controls.
- **Build:** "Drag to turn. Pinch, or Ctrl + wheel, to zoom; double-click or double-tap resets. Keys 1-3 switch views while the viewer has focus." on a row of its own.
- **Why:** it tells the user about zoom and keys.
- **Visible on the sample set:** yes.

### Treatments for a light background

- **Reference:** dark only.
- **Build:** a host with a light background gets one treatment, soft coloured ink: each group drawn as ink of its own hue, laid on lightly over a light sky. There is no option to choose another. The standalone page is dark only, as the reference is, so it does not show there.
- **Why:** the user rejected an earlier inverted-ink look because "the clusters are black". Three treatments followed (a dark stage inside a light page, saturated coloured ink, and soft ink); the user saw all three, accepted soft ink only, and the other two were removed (2026-11-14).
- **Visible on the sample set:** no.

## The provenance block

### A provenance block under the controls

- **Reference:** none.
- **Build:** a block that says where the vectors came from, the model, the dimension, the item count, the view seed and the data's seed, that a view is linear, whether the data is synthetic, what a reduction lost, and the producer's limitations, then the sentence "A projection is a shadow of the space, not the space ...".
- **Why:** the spec requires every view to state these facts.
- **Visible on the sample set:** yes. On the standalone page the block starts collapsed, and its summary line still names the source, model, dimension, items, seed, "synthetic" and the shadow sentence; one click opens the full list. In an embedded viewer it is open by default.

## Dimension and data

### The dimension and the count come from the data

- **Reference:** 384 and 12,288 are written into the page, the shaders, the readout, the labels for screen readers and the notes.
- **Build:** both come from the data; nothing hard-codes a dimension. The sample set's defaults (384, 12,288, seed 20261113) are the one place the numbers appear.
- **Why:** real vectors seen so far are 768, 1024 and 2560 dimensions; the spec requires it.
- **Visible on the sample set:** no.

### The same vectors, with the point weights and bridge colours rebuilt

- **Reference:** the sample set carries a size and brightness weight and a colour for each point; the points on bridges between regions blend the colours of both ends.
- **Build:** the sample vectors are bit-identical to the reference's (tested), but the data contract has no per-point weights or colours. The viewer derives weight from the point's index with the reference's ranges (labelled points full weight, other points 0.1 to 0.65, the unstructured halo 0.05 to 0.25), takes colours from the group, and gives a bridge point the colour of the nearer end instead of a blend.
- **Why:** the contract carries labels and groups only.
- **Visible on the sample set:** slightly: the same kinds of point in the same proportions, but not the same individual points, and bridges are not graded in colour *(read from the code; not isolated in a picture)*.

### The page opens on real vectors, and the generated set is one choice away

- **Reference:** the page always shows its generated sample set (12,288 points, 384 dimensions); none of its numbers come from a model.
- **Build:** with no address the page shows about a thousand English Wikipedia articles (the Level 3 list of vital articles), each embedded from the first sentences of its introduction by a real model, and says so in a note, with the source, the model and the licence of the text (CC BY-SA 4.0) in the provenance block. The generated set is shown with `?sample=synthetic` or by the link under the notes ("Show the synthetic sample set instead"), and it is shown, with a line saying why, when the Wikipedia pair is missing beside the page, when the page is opened as a file, or when the viewer refuses the pair.
- **Why:** the owner searched the generated set and asked whether "sear" and "searing" were unconnected because the numbers are fake; they are. A real model puts the two words next to each other. The owner asked for real vectors as the default, about 1,000 items and about 4 MB, with the generated set kept.
- **Visible on the sample set:** slightly: chosen with `?sample=synthetic`, the sample set looks as before, with one extra line under the notes that links back to the Wikipedia set.

### A view seed

- **Reference:** none; nothing about the view is repeatable.
- **Build:** every view has a seed (default 1, set with `?seed=`) that is shown in the provenance block next to the data's own seed.
- **Why:** reproducible views are a spec requirement.
- **Visible on the sample set:** yes, in the provenance block.

## Behaviour the reference does not have

### Data files

- **Reference:** the sample set is generated in the page.
- **Build:** the page also shows a data file given with `?data=`, a JSON file with a binary float32 block beside it, from its own origin only. Anything else is refused with a plain message and nothing is requested.
- **Why:** this is what the viewer is for.
- **Visible on the sample set:** no.

### Refusals and plain messages

- **Reference:** none, except a WebGL message.
- **Build:** a set that breaks the data contract (a newer schema version, mixed models or dimensions, and the rest of the 15 refusal codes) is refused with a plain message over the stage, or as a notice with a Dismiss button when a view is already showing. A viewer with no data yet says so; a lost graphics context, a missing WebGL 2 and a mode that cannot show the data each have a message.
- **Why:** the spec requires refusing, never guessing.
- **Visible on the sample set:** no.

### Appends turn the view gently

- **Reference:** none.
- **Build:** points can be appended to a running view. The camera does not jump, the centre glides to the new mean, and once appends have stopped for two seconds and added at least 1% new points, Tumble fits its directions again and turns onto the new tour over a length chosen from how far the tour moved, between 1.5 and 12 seconds.
- **Why:** the user reported "a momentary jump" at an append; the turn replaced the jump.
- **Visible on the sample set:** no, unless points are appended.

### Pausing when hidden or off screen

- **Reference:** the loop keeps running.
- **Build:** while the tab is hidden or the viewer is scrolled off screen no frame is requested at all; motion continues from where it stopped, without a jump.
- **Why:** battery and shared hosts.
- **Visible on the sample set:** no.

### Reduced motion

- **Reference:** starts paused when the user prefers reduced motion; the stars still twinkle.
- **Build:** starts paused, and the stars do not twinkle either.
- **Why:** accessibility.
- **Visible on the sample set:** no, only for a user who prefers reduced motion.

### Several viewers, and three ways to use the file

- **Reference:** one page, one viewer.
- **Build:** several viewers can share a page; the same core file is delivered as a script, as a web component (`<embeddings-tumbler>`) and as this standalone page.
- **Why:** spec requirements.
- **Visible on the sample set:** no.

### A strict content security policy

- **Reference:** needs another origin (Google Fonts) and an inline script, and sets no policy.
- **Build:** runs under `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`, with no inline script, handler or style attribute. The test records zero violations.
- **Why:** the spec requires it.
- **Visible on the sample set:** no.

### Loading and error panels on the page

- **Reference:** a blank page until its script has generated the data.
- **Build:** the title and "Loading the viewer..." while the data loads; a plain message when the page itself cannot continue (opened from `file:`, a data address on another origin, a missing file).
- **Why:** a data file can fail to load.
- **Visible on the sample set:** slightly: only for a moment.

## The reference's own defects that were not copied

Each was checked by loading the reference on 2026-11-14, from its DOM, a
screenshot, its character set or its compatibility mode.

### All three mode notes shown at once

- **Reference:** the page shows the notes for Tumble, Lattice and Wander together under the controls (3 notes visible at 1280 px wide and at 390 px). Its style sheet gives `.explain` `display: grid`, which overrides the `hidden` attribute its script sets on the other two.
- **Build:** shows the note for the current mode only.
- **Why:** the reference's own script means to show one; this is a bug there.
- **Visible on the sample set:** yes: the reference's page is 1,562 px tall at 1280 px wide with three notes, the build's 1,232 with one.

### The WebGL fallback text drawn over the sky

- **Reference:** the sentence "This view draws on the graphics card and needs WebGL 2, which this browser does not offer." is shown in the middle of the sky although WebGL 2 works, because `.fallback` has `display: grid`, which overrides `hidden`. It sits over the stars in every reference screenshot.
- **Build:** shows a message only when WebGL 2 is really unavailable.
- **Why:** the same bug.
- **Visible on the sample set:** yes.

### No character set

- **Reference:** the file has no `<meta charset>`. Served without a charset in the header (a plain `python -m http.server`), the browser read it as windows-1252 and the counts line showed "12,288 EMBEDDINGS Â· 384 DIMENSIONS Â· ONE RESTLESS 3-D WINDOW". Opened from a file, or from a server that sends `charset=utf-8`, it is fine.
- **Build:** declares UTF-8.
- **Why:** the same bug.
- **Visible on the sample set:** no, only when the reference is served without a charset.

### No document type, so the reference runs in quirks mode

- **Reference:** the file starts with `<title>`, with no document type, and the browser lays it out in quirks mode (`document.compatMode` is `BackCompat`).
- **Build:** has a document type (`CSS1Compat`).
- **Why:** the same bug. Quirks mode can change spacing and sizes in ways that are hard to separate from the differences above.
- **Visible on the sample set:** unknown: not separated; see "Not yet compared or not yet decided".

### No style reset, so the reference has an 8 px page margin

- **Reference:** the sky is inset 8 px from the top and the sides (stage at x = 8, y = 8, 1264 px wide at 1280; 374 px wide at 390), and the title and status start 8 px further in, because the browser's default body margin applies.
- **Build:** the sky starts at the corner and spans the full width; the title and status start at 20 px.
- **Why:** the reference means a full-bleed sky; the margin is the browser's default, not a choice.
- **Visible on the sample set:** yes, in every mode.

## What the user has said so far

These are decisions already made during live testing on a desktop, an iPhone 13
(Chrome and Safari) and a small ARM board. Only the user's own words are quoted.

| What the user said or asked for | Where it appears above |
|---------------------------------|------------------------|
| User zoom, with the wheel when the viewer has focus or with Ctrl or Cmd, by pinch, and a reset by double-click, double-tap or a button | "User zoom", "The Reset zoom button" |
| Touch-friendly buttons | "Touch-friendly buttons" |
| Keys 1 to 3 only while the viewer has focus | "Keys 1 to 3 switch modes, only while the viewer has focus" |
| An earlier inverted-ink look for a light background was rejected: "the clusters are black" | "Treatments for a light background" |
| The teal look "is great" | not a difference; recorded so it is not changed by accident |
| After an append the view should turn instead of jumping; the user reported "a momentary jump" | "Appends turn the view gently" |
| All modes "look good" on the board | not a difference; it was said of the build, not of a comparison |
| Safari on the phone runs slower than Chrome there, and this "is not a concern" | not a difference; recorded as accepted |

## Unintended differences found

None remain from the side-by-side of 2026-11-14. It found seven; six were put
back to the reference and checked again in new screenshot pairs the same day
(headless Chromium on the same GPU, 1280 by 800 and 390 by 844, 9 seconds in
each mode):

- the names' dark outline and weight, in every mode;
- Wander's stop name (26 px, white), neighbour names (`#c5cddb`), ring and spokes (72% lightness);
- Tumble's framing, now inside the stage at both widths (see "Auto-framing keeps the outermost regions and their names inside the stage");
- the readout strip's 24 px with its two lines and the 6 px gap before the caption;
- the speed slider's 130 px and the Pause button's 76 by 28 px (32 px tall under 600 px wide, see "Touch-friendly buttons");
- Lattice's and Wander's summaries, now the reference's words (Tumble's is recorded under "Tumble's summary under its tab").

The seventh, the reference's 8 px page margin, is the reference's own defect and
is now listed under "No style reset, so the reference has an 8 px page margin".

The screenshots are not committed; they are kept with this run's working files
and can be made again with the side-by-side page.

## Looked the same

Checked in the screenshots or measured on 2026-11-14; none of these differ.

| What | Result |
|------|--------|
| The stage's height | 576 px at 1280 by 800 and 608 px at 390 by 844, on both pages |
| The sky's gradient and its fade into the panel | the same in every picture *(by eye)* |
| The masthead | the same counts text, the same title size and the same offsets (20 px from the left and 22 px from the top, plus the reference's 8 px margin) |
| Mode buttons | the same size (28 px titles, 24 px under 600 px), the selected title in italics and amber, summaries hidden under 600 px |
| Lattice's wires | 1,870 wires on both pages, and the same status wording |
| The text of the three notes and of the closing note | identical, compared as text |
| The panel's width and position | 1,120 px, centred (x = 80 at 1280 px wide) |
| The renderer's settings (point size 6.5 px, depth of field 1.1, bloom 0.55, exposure 1.35, gamma 0.92, vignette 0.72, trails 0.17 s, twinkle 0.18) | the reference's values, per the renderer's notes *(read from the code; the renderer's picture could not be compared frame for frame, see below)* |

## Not yet compared or not yet decided

- **The three light-background treatments** (`panel`, `ink`, `soft`) were seen
  by the user, who accepted `soft` and not the other two (2026-11-14). The other
  two were then removed at the user's decision the same day: a light background
  is always drawn as `soft` ink, and there is no option to choose. It does not
  appear on the standalone page.
- **No frame-for-frame comparison is possible.** The reference's Tumble is
  unseeded and its Wander route is random, so the two pages never show the same
  frame. Point size, glow, bloom, depth of field and trail length were judged by
  eye, on different frames; a small difference in them would not be seen. The
  renderer's settings are the reference's by its notes, not by a pixel check.
- **Fidelity on Firefox and on desktop Safari** is unchecked. The side-by-side
  used Chromium only. The iPhone 13's Safari was used in live testing, but its
  fidelity against the reference was not checked here.
- **The GPU path** was used for the comparison. The software path (SwiftShader)
  was not compared.
- **The fonts.** Whether to bundle the reference's three faces (all under the SIL
  Open Font License) as same-origin files, which would remove the typeface
  differences, is undecided; it was not done because no font file was to be
  downloaded.
- **The reference's quirks mode** and 8 px margin could not be separated from the
  differences listed above, because the reference was loaded as it is, not
  corrected. Some small spacing differences may come from them.
- **What the guided tour looks like on the sample set** ("What the guided tour
  looks like on the sample set") has not been judged by the user, and the
  sample set's tight regions are the reason it looks so different from the
  reference.
- **The fixes to the unintended differences** were checked in Chromium on the GPU only.
- **Real vectors** were not compared: the reference cannot show them.

## Sign-off

The user's sign-off of this comparison is recorded below, in the user's own
words. It was given after the user had tried the build on their own devices and
on real vectors, and with two changes asked for in the same message and made
since: the light-background default is `soft`, and Lattice draws its hidden
directions from the strongest directions.

The agreed form of the line is:

```text
Signed off by the user on YYYY-MM-DD: <the user's words>
```

Signed off by the user on 2026-11-14: confirmed, light -> soft ink is ok, the two others not.

## Search: the two references and how they were compared

Everything from here on is a second comparison, made for search. It leaves the
first comparison above, and its sign-off, as they are.

Search has two reference pages:

- `docs/specs/reference/tumbler-sky-search.html` (the sky reference): the first
  demo with search added on top of Tumble, Lattice and Wander. Up to four
  searches, one per line; a panel that opens and closes; a choice of what is
  lit; a Reranker and a Distance difference control; and the readout strip
  coloured by screen axis.
- `docs/specs/reference/tumbler-focus-view.html` (the Focus reference): one
  search on a plain 2-D canvas, with the ranked results beside the stage,
  suggestions under the box and the point-of-view option.

What was built is the search code in the core file (ranking, several searches,
the Focus view, the panel) and the standalone page over it;
`docs/search-interface.md` is its written interface, including what was
corrected while building.

How to read this part:

- Each difference has five lines: what the reference does, what the build does,
  why, whether it can be seen **on comparable data**, and who decided it.
- **Comparable data** means the same vectors on both sides. For the sky
  reference that is the built-in synthetic sample set (`?sample=synthetic`;
  12,288 points, 384 dimensions, 290 of them named), whose vectors are
  bit-identical to the reference's, with the reference's own three starting
  searches (`tide harbor`, `reef kelp`, `comet nebula`) typed into both. For the
  Focus reference it is the reference's own 124 texts and their vectors, which
  the development page reads out of the reference page and hands to the built
  viewer, with the reference's own starting search (`water`). No embedder and no
  reranker is connected on the sample set. On the Focus data a stand-in embed
  callback places a typed text from the reference's stored vectors exactly as
  the reference does, and there is no reranker.
- **Decided by** is one of four words. `owner`: the owner asked for it or
  approved it, and the line says where that is recorded. `spec`: the confirmed
  spec requires it. `build`: chosen while building and recorded in
  `docs/search-interface.md`; the owner has not been asked about it one by one,
  and the sign-off at the end is where it is accepted or not. `open`: put to the
  owner, or noticed, and not decided.
- The side-by-side page `js/dev/side-by-side/` shows each reference next to the
  build on that data: choose "Search in the views" or "Focus". It needs only
  the repository, served from its root.
- Statements about results, counts and wording were read from both pages in
  that side-by-side on 2026-11-14 (headless Chromium, software rendering,
  1500 by 1000, requests to any other origin refused). Statements about look
  come from screenshots of the same run unless marked *(read from the code)*,
  which means the source was read and no picture was compared.

## Search: where a query comes from and how it is ranked

### A typed query is embedded by the host, or matched among the loaded points

- **Reference:** no model runs in either page. The sky reference places a query at the mean of the named words it mentions, one share per word. The Focus reference places it from the stored vector of the whole phrase, or else from the mean of the stored vectors of the words it knows.
- **Build:** typed text goes to the host's `embed` callback, which returns a vector and the id of the model that made it; the viewer checks the model, the dimension and the values before using it. With no callback (or on data that was reduced), the words are matched among the labels and texts of the loaded points and the query is the mean of the matches, one share per word, and the panel says which of the two happened and that nothing was sent.
- **Why:** real text needs a real embedder, and the gateway's address and key must never reach a page, so the host supplies the function.
- **Visible on comparable data:** no. With no embedder the sample set gives the same eight named results for each of the three starting searches as the sky reference (the third in a slightly different order, see "Distance is cosine distance"); on the Focus data `water`, `things that flow`, `interest on a loan` and `glass of water` gave the same eight results in the same order on both sides.
- **Decided by:** spec.

### Which words a word search understands

- **Reference:** the sky reference also understands the eleven region names (`ocean` is placed from all of ocean's named words), skips the words `mid` and `late`, takes the first named word that starts with a typed word of three or more letters (`sea` is placed from `sear`), and splits searches at a semicolon as well as at a line end.
- **Build:** matches words in a point's label and text only, so a group's name alone matches nothing (`ocean` is reported as not found); a word of three or more letters with no exact match is placed from every point with a word that starts with it (`sea` from `sear`, `searing` and `seabed`); a whole label or text that equals the line wins first (`mid march` is the point "mid-March"); and only a line end separates searches (`tide; reef` is one search of two words).
- **Why:** the reference's rules are written for its own 290 words and eleven regions; the build's must work on any labels and texts.
- **Visible on comparable data:** yes. Typing `ocean`, `sea` and `tide; reef` gave four searches in the reference (544, 233, 382 and 408 points) and two in the build (`sea` and `tide; reef`), with `ocean` listed as not found. The three starting searches are not affected.
- **Decided by:** build.

### Distance is cosine distance

- **Reference:** the sky reference ranks and lights by straight-line distance in all 384 dimensions and shows it to two or three decimals. The Focus reference ranks by cosine similarity and shows "similarity", or "distance" (1 minus similarity) with Distance difference on.
- **Build:** one measure everywhere, cosine distance (1 minus cosine similarity) in every dimension of the data, in double precision: for ranking, for what is lit, for the pair reports and for the numbers shown. The panel and the provenance block name it.
- **Why:** the embedding models seen so far are compared by cosine; one named measure avoids two numbers for one thing.
- **Visible on comparable data:** slightly. On the sample set the lit counts are 423, 521 and 402 points against the sky reference's 422, 525 and 403 (1,006 lit in all against 1,011; 340 found by both A and B against 339); `comet nebula` lists nebula before comet and equinox before solstice, where the reference has them the other way round; the closest pair of A and B is "0.019 apart" against "0.184 apart". On the Focus data the order is the same and the build shows no similarity figure.
- **Decided by:** build.

### The reranker comes from the host

- **Reference:** both pages have a Reranker checkbox backed by a toy: the sky reference favours the topic most of the first results share, the Focus reference rewards a word shared with the query.
- **Build:** the host supplies a `rerank` callback that scores candidate texts and names its model. Without one, or on data that carries no text, there is no Reranker control at all. A reranker that fails or is late leaves the results in embedding order and the search says so.
- **Why:** a toy would present invented scores as a second opinion; a real reranker is a model the host has to provide.
- **Visible on comparable data:** yes: the build shows no Reranker checkbox on either comparison, since no reranker is connected.
- **Decided by:** spec.

### Candidates and Keep top, and up to 100 results

- **Reference:** Results goes from 3 to 20; with the Reranker on, the three times as many nearest are rescored and the first Results of them are kept.
- **Build:** Results goes from 3 to 100 (8 at the start). With a reranker there are two more controls: Candidates (the nearest handed to the reranker, 3 to 100, 50 at the start) and Keep top (how many of them are kept, 20 at the start), and Results is then switched off with the reason as its title. Each result list scrolls inside its own box.
- **Why:** the owner asked for it after trying the build: "we need more results, 50 or 100, and add reranker and top x out of that (top 20?)", and chose 50 candidates and top 20 (2026-11-14; `docs/search-interface.md`, "Candidates and top").
- **Visible on comparable data:** yes, as the Results slider's range; Candidates and Keep top do not appear, since no reranker is connected.
- **Decided by:** owner.

### Every point as near as the last named result is lit, in Focus too

- **Reference:** the sky reference lists the nearest named points and lights every point at least as near as the last of them. The Focus reference lights only its results.
- **Build:** the sky reference's rule in every view: the results are the nearest named points (a point is named when its label or text is something other than its id) and every loaded point at least as near as the farthest result is lit, named or not. With a reranker, the farthest kept result sets that distance, so a nearer candidate that was not kept is lit without being a result.
- **Why:** the spec's assumptions, which the owner confirmed, say so; the first browser run had ranked every point and returned eight unnamed ids for `tide harbor` (`docs/search-interface.md`, "Corrected after the first browser run").
- **Visible on comparable data:** no. On the sample set it is the sky reference's own rule. On the Focus data every text is named, so the lit points are the results (8 lit for 8 results).
- **Decided by:** spec.

### The point of view is offered in every view, and the picture stays one linear frame

- **Reference:** only the Focus reference has it, as a checkbox. It scales every vector by the size of the query's value in each dimension, makes each unit length again, and draws those scaled vectors.
- **Build:** a choice in the panel in every view (off, or the letter of one search). Ranking and shown distances use the scaled space as the reference does; the fitted axes are then mapped back onto the loaded vectors and made orthonormal, so every point is still drawn by one linear frame.
- **Why:** several searches need a choice of whose point of view it is, and every view must stay a linear projection of the loaded vectors.
- **Visible on comparable data:** yes, as a select in place of a checkbox, and on the sample set as a control the sky reference does not have. Whether the picture with the option on differs from the reference's was not compared.
- **Decided by:** build.

### Refusals, waiting, stale results and latest-wins

- **Reference:** a search is instant and cannot fail; words it cannot place are named in a line under the box.
- **Build:** a query whose model or dimension does not match, an embedder that fails or does not answer in 15 seconds, and more than four searches are each refused with a plain message, and the earlier results stay. A newer search replaces one still being worked out. After points are appended the results are marked as from before the new points and worked out again. Ranking runs in slices inside the frame budget, so the view keeps moving.
- **Why:** a real embedder is slow and can fail, and real data is appended to.
- **Visible on comparable data:** slightly. On the Focus data a text with no known word (`zzz`) clears the reference's results and shows every text, while the build keeps the earlier results and says "The embedder failed to answer. The earlier results are kept."
- **Decided by:** spec.

## Search: the panel

### The panel starts empty

- **Reference:** the sky reference opens with three searches already typed (`tide harbor`, `reef kelp`, `comet nebula`), and the Focus reference with `water`.
- **Build:** the box starts empty and nothing is lit until something is typed.
- **Why:** the build does not know what a host's data holds, so it has no words to start with.
- **Visible on comparable data:** yes on opening the page; the side-by-side types the reference's starting searches into the build so that the rest can be compared.
- **Decided by:** build.

### The wording of the bar, the note and the lists

- **Reference:** the closed bar reads "nothing typed: the whole sky is shown"; the note reads "1,011 points lit." and then the pairs; a list's heading reads "A · tide harbor · 8 named results, 422 points · placed from tide, harbor".
- **Build:** the closed bar reads "nothing searched: every point is shown"; the note says how many points are lit and how many of them are unnamed, where the typed text went, which measure is used, which words were not found and whether stage labels were left out; a heading reads "A · tide harbor · 8 named results and 415 unnamed points as near as the last of them · words matched: tide, harbor". The pairs have lines of their own and name the results two searches have in common ("5 named results in common (tide, surf, kelp, reef, atoll)"), where the reference gives the number.
- **Why:** the build's data is not a sky of stars, and the spec requires the panel to say where the text went and to carry as text everything the picture shows.
- **Visible on comparable data:** yes.
- **Decided by:** build.

### Suggestions under the box in every view

- **Reference:** only the Focus reference suggests texts as you type (up to eight); the sky reference has none.
- **Build:** suggestions in every view: up to eight texts of named points that the line being typed can match; a click puts the text on that line and searches at once.
- **Why:** recorded in `docs/search-interface.md` as asked for in every view; the rule is the Focus reference's.
- **Visible on comparable data:** yes, on the sample set, when typing.
- **Decided by:** build.

### Names and distances on the stage are page text and do not overlap

- **Reference:** the sky reference draws every result's word on the canvas, on top of each other where results are close, and distances to two decimals.
- **Build:** letters, result texts (cut at 28 characters), ranks and distances are text elements over the stage. A label that would overlap one already placed is left out (letters first, then nearest results) and the note says so; the lists carry every result. Distances have three decimals.
- **Why:** untrusted text must be inserted as text; nearby results differ in the third decimal; overlapping words could not be read.
- **Visible on comparable data:** yes. In Tumble with the three starting searches the reference shows a pile of overlapping words on each cluster and the build two or three readable ones.
- **Decided by:** build.

### Links fade with rank

- **Reference:** the sky reference draws every link at the same strength; the Focus reference fades a link by how its similarity compares with the nearest and farthest result's.
- **Build:** in every view a link's strength falls evenly from the first result to the last.
- **Why:** one rule for all four views that needs no extra numbers *(read from the code)*.
- **Visible on comparable data:** slightly.
- **Decided by:** build.

### Result lists show the text, not its group

- **Reference:** the sky reference colours each word by its region and writes the region's name after it. The Focus reference shows a dot in the topic's colour, the topic's name and "similarity 0.828" on every result.
- **Build:** a result is its rank (with its search's letter), its text, and, when asked for, its distance, its gap to the nearest, how the reranker moved it and where plain distance had it. No group name, no group colour and no similarity figure.
- **Why:** not every data set has groups, and one measure is shown, as distance *(read from the code)*.
- **Visible on comparable data:** yes.
- **Decided by:** build.

### A search line in the provenance block

- **Reference:** none; the notes at the foot of each page say how queries are placed.
- **Build:** while a search is shown, the provenance block carries a Search row (the measure, the counts, the lit setting, each query's model, the reranker or "no reranker", and where the text went) and its summary line a short clause, for example "search: searched among the loaded points, nothing sent".
- **Why:** the spec requires every view to say what a search used and where the text went, also with the panel closed.
- **Visible on comparable data:** yes.
- **Decided by:** spec.

### Search colours for a light background

- **Reference:** dark only; searches are amber, cyan, pink and green, and a point found by more than one search burns white.
- **Build:** the reference's four colours on a dark stage. On a light stage four darker hues of the same colours (`--tumbler-search-1` to `-4`) and a dark shared mark, since the reference's colours and white would vanish there. Every search also has its letter wherever its colour is used.
- **Why:** hosts with a light background get the soft-ink treatment, and no meaning may rest on colour alone.
- **Visible on comparable data:** no: both comparisons are on a dark stage.
- **Decided by:** build.

## Search: Tumble, Lattice and Wander

### The swing toward the searches is seeded and the same in every view

- **Reference:** for six seconds after a new search the view tumbles at half rate (from a running random stream) while it is pulled toward a frame fitted to the searches; that frame's spare axes also start from random draws.
- **Build:** the same six seconds and the same pull, with a seeded drift at half the reference's rate in all three views and a seeded fit, so the same data, searches, seed and time give the same frames. Afterwards Tumble turns back onto its tour at a bounded rate, Lattice starts a new swap schedule and Wander its next hop, with no jump. The status line is the reference's ("swinging to face the 3 searches, then tumbling on").
- **Why:** reproducible views are a requirement of the first spec.
- **Visible on comparable data:** no: both swing and neither shows the same frame twice against the other *(the motion was not compared frame by frame)*.
- **Decided by:** spec.

### Lattice's wires follow the search, and crowded wires are scaled down

- **Reference:** the wires are drawn the same with or without a search; only the points dim.
- **Build:** with a search shown, a wire between two lit points keeps its strength and every other wire is dimmed like an unlit point. Wires that pile up in one part of the stage are scaled down as well, with or without a search (see "Crowded wires are dimmed instead of burning out to white" above).
- **Why:** the owner tried the build and found Lattice with a search very bright; the wires buried the results (2,175 near-white pixels of 57,600, against 0 in Tumble). The change was approved by the owner on 2026-11-14 (deviation `d1`; `docs/search-interface.md`, "Corrected after the owner's browser look").
- **Visible on comparable data:** yes, in Lattice with a search.
- **Decided by:** owner.

### Results are not fogged away in Wander

- **Reference:** Wander dims points by their true distance from the camera's stop, results included.
- **Build:** a lit point's distance dimming is relieved in proportion to how strongly it is lit, so results stay visible wherever the camera is; unlit points keep the fog.
- **Why:** the owner saw Wander with a search almost black (2 lit pixels): the search dimmed every unlit point and the fog dimmed the results.
- **Visible on comparable data:** yes, in Wander with a search.
- **Decided by:** build.

### The view keeps turning while a mode prepares

- **Reference:** while the neighbours are being measured, the sky reference plays Tumble's motion in place of Lattice's or Wander's.
- **Build:** the mode's own motion waits until its preparation is done, and meanwhile the view keeps its slow spin, so the picture is never still.
- **Why:** approved by the owner as deviation `d3` during the search build: a view that stood still while preparing looked stuck.
- **Visible on comparable data:** slightly, for the first moments after choosing a view.
- **Decided by:** owner.

## Search: Focus

### Focus is drawn by the viewer, not on a plain canvas

- **Reference:** a 2-D canvas: each text is a flat dot with a soft halo, with no glow, trails or depth of field.
- **Build:** Focus is a fourth mode of the WebGL viewer, so its points are drawn like every other view's, with bloom and trails, and it works on any loaded set.
- **Why:** the spec makes Focus the fourth view of the one viewer, not a second renderer.
- **Visible on comparable data:** yes. On the reference's 124 texts the reference shows separate dots; the build shows glowing points whose trails streak while the view turns onto a new fit.
- **Decided by:** spec.

### Focus is a view of the viewer, not a page of its own

- **Reference:** a page with its own title ("Embedding Search"), an always-open box under the stage, a row of texts to try, a legend of topic colours, a Pause button and three columns of notes.
- **Build:** the viewer with Focus chosen: the viewer's title and counts line, its four view buttons (keys 1 to 4), the readout strip, the provenance block, and the Search panel under the stage, closed until opened. No row of texts to try and no legend; the results are listed beside the stage as in the reference, and below it on a narrow screen.
- **Why:** the same reason as above.
- **Visible on comparable data:** yes.
- **Decided by:** spec.

### Up to four searches in Focus

- **Reference:** one search. Results are numbered 1 to 8 and the query is marked "query".
- **Build:** up to four, lettered A to D. The view is fitted to all of their queries and results together; the list beside the stage has a part per search and numbers its results with the letter ("A1"); the query's mark carries its letter ("A query"). On the stage a rank has its letter only when there is more than one search.
- **Why:** the spec gives every view the same searches.
- **Visible on comparable data:** slightly: with the one starting search, the list reads "A1 flood" for the reference's "1 flood", under a line "A · water".
- **Decided by:** spec.

### Focus is always fitted to the results

- **Reference:** a checkbox, "Turn the view to the results", on at the start; off, the view stays fitted to every text.
- **Build:** no such control. With a search Focus is fitted to the results, and with none to every point. "Face the searches" is switched off in Focus and the note says why.
- **Why:** the fit is what Focus is for; a second frame to swing toward would fight it (`docs/search-interface.md`, decision 16).
- **Visible on comparable data:** yes, as a missing checkbox and a disabled button.
- **Decided by:** build.

### Turning onto a new fit

- **Reference:** the view eases toward the new fit by a fixed share each frame and jumps there at once under reduced motion.
- **Build:** a blend over 1.6 seconds of the view's own time, so the same time gives the same picture, and it waits while paused. The turning rate with a search is the reference's 0.13 radians per second.
- **Why:** reproducibility *(read from the code)*.
- **Visible on comparable data:** slightly, as how a change of search feels.
- **Decided by:** build.

### Points that are not results are fainter

- **Reference:** a text that is not a result is drawn at 0.13 of a result's strength.
- **Build:** at 0.05, or hidden with Only results.
- **Why:** on the sample set's 12,288 points 0.13 piled up under the glow and read far brighter than on the reference's 124; 0.05 was picked by comparing screenshots (`docs/search-interface.md`, "Corrected after the owner's browser look").
- **Visible on comparable data:** unknown. On the reference's 124 texts the two pictures differ too much in how a point is drawn for this to be told apart from "Focus is drawn by the viewer, not on a plain canvas".
- **Decided by:** build.

### Hovering and the list

- **Reference:** hovering a point shows a box with its text, topic, rank, distance and "click to search from this text"; hovering a result in the list rings its point on the stage.
- **Build:** hovering a point shows the viewer's usual name; the list does not ring points. A click on a point searches from it, as in the reference.
- **Why:** not built; the spec does not ask for either *(read from the code)*.
- **Visible on comparable data:** yes, when hovering.
- **Decided by:** build.

### The status line

- **Reference:** "8 nearest of 124 · cosine in all 1024 dimensions · view fitted to the results".
- **Build:** "fitted to the results of A"; the counts and the measure are in the list's sub line ("8 named results, plain distance · cosine distance (1 minus cosine similarity)") and in the note.
- **Why:** the status line is the mode's, as in the other three views, and the panel carries what a search used.
- **Visible on comparable data:** yes.
- **Decided by:** build.

## Search: the page and its data

### The page opens on real articles, not on the references' data

- **Reference:** the sky reference always shows its generated sample set; the Focus reference its own 124 texts.
- **Build:** with no address the standalone page shows 999 English Wikipedia articles embedded by a real model, as recorded above under "The page opens on real vectors, and the generated set is one choice away"; the generated set is at `?sample=synthetic`.
- **Why:** the owner searched the generated set, asked whether two related words were unconnected because the numbers are made up (they are), and asked for real vectors as the default.
- **Visible on comparable data:** no: the comparison is made with `?sample=synthetic`. On opening the page with no address, yes.
- **Decided by:** owner.

### Typed text can be embedded through a local helper

- **Reference:** neither page can embed text.
- **Build:** `viewer serve --embed` adds a route on the page's own origin that embeds a query (and reranks, when a reranking model is named) with the gateway key held only in the server process. The page asks its own origin whether the route is there and, if it is not, matches words among the loaded points.
- **Why:** the spec's way to search real data from the standalone page without the key or the gateway's address reaching the page.
- **Visible on comparable data:** no: the comparison is served without it, and the sample set's vectors come from no model.
- **Decided by:** spec.

## Search: open questions

Neither of these is a difference from the sky reference on a dark stage. They
are listed as items so that they are checked off like the rest, and the search
sign-off cannot be recorded while either is still open.

### The readout strip's axis colours on a light background

- **Reference:** dark only. The sky reference colours each cell of the strip by its dimension's share of the horizontal (orange), vertical (green) and depth (blue-violet) axes.
- **Build:** the same three colours on a dark stage, which the owner approved "per the artifact" (see "The strip's cells are coloured by screen axis" above). On a light stage three darker colours are used so that they stay readable.
- **Why:** the reference's colours are too pale on a light background; the darker three were chosen while building.
- **Visible on comparable data:** no: the references and the standalone page are dark only.
- **Decided by:** open: the light colours have not been shown to the owner and are not approved.

### Search A's amber beside the strip's orange

- **Reference:** search A is amber (`#ffc56b`) and the strip's horizontal axis is orange (`rgb(255, 150, 60)`); both are on the page at once.
- **Build:** the same two colours, from the reference.
- **Why:** noted by the owner's assistant during the build as a possible clash: two unrelated things in near colours. Nothing was changed.
- **Visible on comparable data:** yes, on both pages alike.
- **Decided by:** open: not decided.

## Search: looked the same

Read from both pages in the side-by-side of 2026-11-14, or from the code where
marked.

| What | Result |
|------|--------|
| The three starting searches' named results on the sample set | the same eight for each search; A and B in the same order |
| The points lit by more than one search | marked white on both; 5 named results in common for A and B on both |
| The Focus results for `water`, `things that flow`, `interest on a loan`, `glass of water` | the same eight in the same order |
| The panel's bar, its + and − mark, and that closing it keeps the searches | the same *(read from the code)* |
| The Lit choices | the same three, in the same words *(read from the code)* |
| The search colours on a dark stage | the reference's four |
| The readout strip's axis colours and its legend on a dark stage | the reference's three colours and words *(read from the code)* |
| The status line during a swing | the reference's words, in every view |
| The typing pause before a search runs | 140 ms, the sky reference's *(read from the code)* |
| Focus: turning rate with a search, the zoom that frames the results, a click on a point searching from it | the reference's *(read from the code)* |

## Search: not yet compared

- **A real embedder and a real reranker** were not part of this comparison:
  neither reference has one. Search with both on real vectors is covered by the
  build's own tests and evidence, not here.
- **Reranked results, Candidates and Keep top** cannot be compared: the
  references' rerankers are toys and no reranker is connected on comparable
  data.
- **The point of view** was compared as a control only, not as a picture.
- **Motion** (the swing, the turn onto a new fit) was not compared frame by
  frame; the references are unseeded.
- **Software rendering only.** The side-by-side for this part ran in headless
  Chromium with SwiftShader, not on a GPU, at one size (1500 by 1000, each
  frame about half of that). No narrow screen, no Firefox, no Safari.
- **The light treatment** does not appear in either comparison; both
  references are dark only.
- **The screenshots are not committed**; they can be made again with the
  side-by-side page.
- **The deviation records `d1` and `d3`** are cited as they were reported
  during the build; the record store itself was not read for this document.

## Search: sign-off

The owner's sign-off of the search comparison is **not yet recorded**. Only the
owner gives it, after looking at the side-by-side, and it cannot be recorded
while an item above is still marked open.

The agreed form of the line is:

```text
Search signed off by the owner on YYYY-MM-DD: <the owner's words>
```
