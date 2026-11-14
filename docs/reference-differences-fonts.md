# Reference differences: fonts (standalone page, for t17)

The reference demo (`docs/specs/reference/embedding-tumbler-demo.html`) loads
three faces from Google Fonts. The built page loads nothing from another origin
and bundles no font files, so it uses local stacks instead (`js/page/page.css`,
`--page-font-*`). Each stack names the reference's face first, so a machine
that has it installed uses it.

Measured with Chromium's `CSS.getPlatformFontsForNode` on the development
machine (Ubuntu, none of the reference's faces installed), 2026-11-14:

| Reference face | Where it is used | Face used here | What looks different |
|----------------|------------------|----------------|----------------------|
| Instrument Serif, italic | The title "Embedding Tumbler", the selected mode name (Tumble, Lattice, Wander), the note headings | P052 Italic (a Palatino clone), via the stack's `P052` | Instrument Serif is a condensed, high-contrast display face; P052 is wider and rounder. At 64 px the title is 510 px wide against the reference's 460 px (11% wider); the mode names and note headings look heavier and less narrow. |
| Instrument Serif, upright | The unselected mode names | P052 Roman | Same: wider, less contrast. |
| IBM Plex Sans | The mode summaries and the note paragraphs | Ubuntu Regular | Ubuntu is rounder; line breaks in the note paragraphs fall in different places (seen at 1280 px). |
| IBM Plex Mono | The counts line, the status line, the readout caption, the controls and hint, the provenance block, the note headings' labels ("What is happening") and the closing note | Ubuntu Mono Regular | Ubuntu Mono is narrower: "WHAT IS HAPPENING" at 11 px is 123 px wide against 138 px (11% narrower), so the counts line, status line and captions are shorter. |

The reference's widths were measured with its Google Fonts loaded (the machine
had network access), the page's offline. On other systems the fallbacks differ;
going by the stacks' order, not checked on those systems: Palatino Linotype,
Segoe UI and Cascadia Mono or Consolas on Windows; Iowan Old Style, Seravek and
SF Mono on macOS.
Bundling the reference's faces (all three are under the SIL Open Font License)
as same-origin files with `@font-face` would remove these differences; it was
not done here because the brief for t11 ruled out downloading font files.
