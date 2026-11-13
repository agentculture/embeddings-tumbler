# Workforce brief: building the embeddable space viewer

This is the hand-off for the build. It was written in the `embeddings-cli`
session that scoped, specified, challenged and planned the work on 2026-11-13.
Read it together with the spec and the plan; where they disagree, the spec and
plan win, because they are the confirmed record.

| Document | Role |
|----------|------|
| `docs/specs/2026-11-13-embeddable-space-viewer.md` | What to build. Confirmed claims, honesty conditions, obligations, decisions, scope findings, parked unknowns. |
| `docs/plans/2026-11-13-embeddable-space-viewer.md` | How to build it. 18 tasks in 7 waves, each with acceptance criteria and the spec targets it covers. |
| `docs/specs/reference/embedding-tumbler-demo.html` | The reference. The built site is expected to look and move like it. |
| `docs/evidence/2026-11-13-real-vector-probe.md` | Measurements on real vectors that changed the spec. |
| `docs/workforce/examples/` | Illustrative sketches. Not binding; task `t2` writes the authoritative contract. |

## How to continue

1. Open a session in this repository.
2. Run `/assign-to-workforce`. The frame and plan state are already in
   `.devague/`, so `devague plan waves` works here.
3. The next human gate is the **implementation split plan** below. Nothing is
   fanned out until the user approves it.
4. After each wave: run the tests before and after every merge, as the skill
   describes. The final gate is the PR.

The user has asked for the workforce route. Gate 1 (the spec) is closed. Gate 2
(the split plan) is open and must be approved in the new session.

## Proposed implementation split

Proposed, not approved. Model choices follow one rule: tasks that port or
design graphics and mathematics get the strongest model; well-specified
mechanical tasks get a cheaper one.

| Wave | Task | Summary | Model | Why this is safe to delegate |
|------|------|---------|-------|------------------------------|
| 1 | t1 | Bring the spec into the repo; retarget README and CLAUDE.md | — | **Mostly done by the PR that added this file.** Remaining: the README still carries template text. |
| 1 | t2 | Data contract document and fixtures | opus | Sets the interface every later task builds on; fixtures make it testable. |
| 1 | t3 | JS source layout, assembler, node test runner | sonnet | Small, deterministic, fully specified by its criteria. |
| 2 | t4 | Mathematics module | opus | Numerical correctness; pure functions with exact tests. |
| 2 | t5 | Contract loader and validator | sonnet | Driven entirely by `t2`'s fixtures. |
| 2 | t6 | Renderer port (WebGL 2) | opus | Hardest port; must generalise the reference from 384-d. |
| 2 | t12 | Python CLI verbs (write files, serve) | sonnet | Follows the existing rubric and CLI pattern. |
| 2 | t15 | Producer verb, **in `embeddings-cli`** | opus | Separate repository and PR; see "Two repositories". |
| 3 | t7 | The three modes over one interface | opus | Ports the reference's motion; determinism tests. |
| 3 | t9 | Built-in sample set | sonnet | Direct port of the reference's generator. |
| 4 | t8 | Viewer API, lifecycle, provenance, controls | opus | Integrates loader, renderer and modes. |
| 5 | t10 | Web component shell | sonnet | Thin; static test forbids logic in it. |
| 5 | t11 | Standalone page | opus | Carries the reference's look; fonts must be local. |
| 5 | t18 | Host and producer guides | sonnet | Examples are exercised by the harness. |
| 6 | t13 | Packaging and release | opus | Two registries, trusted publishing, byte-identity check. |
| 6 | t14 | Browser test harness | opus | Headless graphics is the riskiest tooling. |
| 6 | t17 | Reference comparison and sign-off | sonnet | Needs the **user's** sign-off; an agent prepares, the user decides. |
| 7 | t16 | Real-Atlas proof | main agent | Needs the gateway key and the user's desktop; do not delegate blind. |

## Two repositories

Seventeen tasks build here. **`t15` builds in `embeddings-cli`** (the producer
verb that turns an Atlas into a viewer data file). It depends only on `t2`
(the contract), so:

- Do `t2` first and treat `docs/data-contract.md` as frozen for the first
  version once it merges.
- Run `t15` as its own branch and PR in `../embeddings-cli`, with that repo's
  version bump, rubric gate and `tests/test_roadmap_lockstep.py`. It must not
  change `embeddings map`, the Atlas schema, or the three stable-contract CLI
  modules.
- `t16` needs both: an Atlas surveyed by `embeddings-cli`, viewed here.

## Repository layout to create

Nothing below exists yet. It is the layout the plan assumes, chosen so that
same-wave tasks touch different files.

```text
js/src/                      source modules, concatenated in filename order
  00-header.js               version + source banner            (t3)
  10-math.js                 seeded random, frames, tour, kNN   (t4)
  20-contract.js             loader + validator                 (t5)
  30-renderer.js             WebGL 2 drawing                    (t6)
  40-mode-tumble.js          one file per mode                  (t7)
  41-mode-lattice.js
  42-mode-wander.js
  50-viewer.js               mount / update / destroy           (t8)
js/sample/sample-data.js     built-in synthetic sample set      (t9)
js/shells/web-component.js   <embeddings-tumbler>               (t10)
js/page/                     standalone page: html, css, js     (t11)
js/test/                     node --test unit tests
scripts/assemble.py          builds the single core file        (t3)
embeddings_tumbler/static/   assembled core file + shells + page (shipped in the wheel)
embeddings_tumbler/cli/_commands/   new verbs                   (t12)
tests/fixtures/contract/     contract fixtures                  (t2)
tests/browser/               three host fixtures + harness      (t14)
docs/data-contract.md        the contract                       (t2)
docs/guides/                 host guide, producer guide         (t18)
docs/reference-differences.md                                   (t17)
package.json                 npm metadata + test script         (t3, t13)
```

## Guidance per task

Acceptance criteria are in the plan. These notes are what the planning session
learned that the criteria do not say.

**t2 — data contract.** Start from `examples/data-file.example.json`. Decide
and write down: whether the vector block is a sibling file or embedded; how an
append is expressed in a file versus through `update()`; the reduction record
(`none`, `rotation`, `top-k` with directions kept and variance dropped). Mirror
`embeddings-cli`'s `AtlasManifest`: `limitations` and `uncertain` should travel
into provenance. Byte order is little-endian float32.

**t3 — assembler.** Plain concatenation in sorted filename order inside one
function wrapper. No transpiler, no minifier. The staleness test compares the
committed assembled file against a fresh assembly. The static test bans
`http://`, `https://`, `eval`, `new Function`, and `import`.

**t4 — mathematics.** Port from the reference: `mulberry32`, `gauss`,
`orthonormalize`, `stepTumble`, `stepSwap`, `localFrame`, `alignTo`. Then
change two things. First, the tour must be **seeded** (the reference uses an
unseeded walk for Tumble). Second, the tour must be **guided**: draw the
frame's motion inside the data's high-variance directions and report the share
of variance those directions hold. The probe measured a random 3-D frame at a
group separation of 1.11 against 1.12 in the full space, 1.48 inside the top
eight principal directions, and 1.90 for the top three. Principal directions
for N points in D dimensions come from the N×N Gram matrix when N < D, as
`localFrame` already does.

**t5 — loader.** Pure functions over `t2`'s fixtures. Refusals return a
message; they do not throw into the host.

**t6 — renderer.** The reference packs four dimensions per RGBA32F texel, 96
texels per point, 16 points per texture row, and loops `k < 96` in the shader.
Generate those from `ceil(D / 4)` and check `MAX_TEXTURE_SIZE`. Keep the HDR
half-float target, the mip-chain bloom, depth of field, trails and twinkle.
The reference falls back when `EXT_color_buffer_float` is missing; keep that.
At 1024-d each vertex does 256 texel fetches times five lookups; measure before
optimising.

**t7 — modes.** One file each. A mode owns its motion and draw parameters and
nothing else. Lattice's wires are true neighbours in the full space; in the
reference only the first 1,000 points get neighbours, computed in slices so the
page stays responsive. Wander visits labelled points and re-fits a local frame
from 24 neighbours.

**t8 — viewer.** `mount`, `update`, `destroy`. Pause with
`document.visibilitychange` and an `IntersectionObserver`. The readout strip
has one cell per dimension. Colours come from the host's CSS custom
properties with built-in defaults. Use `textContent`, never `innerHTML`, for
anything from data. An append must not reset the camera; how the centre and
scale re-settle is an open risk, so make it gradual and note what you chose.

**t9 — sample set.** Port the reference's generator exactly, including its
seed, and mark the provenance `synthetic`. Note for the docs: the month ring in
the sample is invented, but the probe found a real one in Qwen3-Embedding-0.6B.

**t10 — web component.** `connectedCallback` mounts, `disconnectedCallback`
destroys, a `src` attribute loads a data file from the host's own origin.

**t11 — standalone page.** Port the reference page's structure and styles.
Replace the Google Fonts link: bundle the font files in the package, or fall
back to a local stack and record the difference for `t17`. No inline script and
no `style` attributes that a strict policy would block.

**t12 — CLI verbs.** Follow the pattern in `embeddings_tumbler/cli/_commands/`.
A noun with action verbs needs `overview`. `serve` is static only and binds to
loopback.

**t13 — packaging.** PyPI already uses Trusted Publishing in
`.github/workflows/publish.yml`. Three npm facts are **unverified** and must be
checked first: whether a trusted publisher can be attached before a package's
first publish, the exact scope string for the `culture.dev` organisation, and
whether the name is free. If a first publish by token turns out to be needed,
stop and ask the user; the token is held in `grant` and must not enter the
repository or CI secrets.

**t14 — browser harness.** Playwright is not a dependency of this repo yet;
Chromium builds are present in the local Playwright cache on the planning
machine. CI runners may have no GPU, so decide early whether render tests run
with a software renderer in CI or only locally, and say so in the test names.
`../webglass-cli` can drive a page too but refuses loopback targets without an
explicit policy profile.

**t15 — producer (in `embeddings-cli`).** Read that repo's `CLAUDE.md` first.
The verb name is not chosen; it must read as a global verb or be a noun with
`overview`. Committed Atlas studies there have records but no `vectors.npy`,
so the verb must refuse with a hint naming `embeddings survey`.

**t16 — real-Atlas proof.** Run the embedding step with
`grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- <command>` so
the key never appears in a file or log. Targets: Tumble separation at least
1.3 against the 1.11 baseline, at least 30 frames per second with 10,000
points, zero foreign requests. Report what was seen and what was not; a missed
target is a recorded result, not something to tune away quietly.

**t17 — reference comparison.** Prepare the side-by-side on the sample set and
the list of differences. The sign-off is the user's.

**t18 — guides.** The second producer is written from the guide alone and
shares no code with `embeddings-cli`.

## Risks carried from the plan

- The first npm release may need a one-time token publish.
- Two release channels add JavaScript tooling to a repo whose CI is
  pytest-only.
- Appending points shifts the cloud's centre, scale and neighbour sets.
- Headless browsers in CI may have no GPU. Only desktop Chrome has been seen.
- The 30 frames-per-second target at 10,000 × 1024-d is unmeasured.
- The producer verb's name is not chosen.

## Not in this build

The single-embedding view, an iframe form, image embedding in the
`embeddings-cli` client, a route in `embodiment` that serves its vectors, an
export verb in `eidetic-cli`, a text alternative to the canvas, and the
interchange format `innereye` asked for. Each is a later piece of work.
