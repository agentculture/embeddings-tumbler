# Differences from the reference demo

The reference is one page, `docs/specs/reference/embedding-tumbler-demo.html`.
The built viewer is the standalone page (`embeddings_tumbler/static/index.html`)
over the one core file. This document lists every difference between them that
was intended, so a person can check them off, and then lists what a side-by-side
look found that nobody had written down. It is prepared for the user's
sign-off. **The sign-off has not happened; see the last section.**

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
- **Build:** one cell per dimension of the loaded data (a canvas that many pixels wide, stretched), and the caption names the real number, with a thousands separator ("2,560"). The formula and the colours are the reference's.
- **Why:** the dimension comes from the data.
- **Visible on the sample set:** no. The strip's size (22 px between two 1 px lines) and the 6 px gap before its caption are the reference's (measured at 1280 and 390 px wide).

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
| The readout strip's colours | the same amber cells *(by eye)* |
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
