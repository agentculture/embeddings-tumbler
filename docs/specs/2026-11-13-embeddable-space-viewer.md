# embeddable space viewer

> Any site or tool can drop in embeddings-tumbler: a self-contained viewer that takes a set of embeddings and shows them as a moving 3-D window through the full-dimensional space (Tumble, Lattice, Wander). The first version is proven on a real Atlas study from embeddings-cli; vector stores, live agent conversations and photo collections feed the same data contract later.
> instruction: Build in ../embeddings-tumbler: port the demo page into one core JS file with mount/update, add the web-component and standalone-page shells, define the data contract, then prove it on an Atlas surveyed through the lobes gateway (key via grant run --inject `EMBEDDINGS_API_KEY`=`LOBES_GATEWAY_API_KEY`). The Atlas-to-viewer producer step is the only work in embeddings-cli.

## Audience

- Three readers: (1) a developer of a host site or tool (embodiment's dashboard, a docs site, a vector-store admin page) who wants to show an embedding space without writing graphics code; (2) a producer of vectors (embeddings-cli, eidetic-cli, embodiment, a photo indexer) that must emit the data contract; (3) the person watching, who should come away with a truer feel for the space, not a prettier lie.

## Before → After

- Before: Today the only picture of an embedding space in this ecosystem is 'embeddings map --html': a static 2-D PCA scatter of one Atlas. The animated viewer exists only as a single demo page with synthetic data, web fonts from a CDN, and no way to hand it vectors.
- After: A host adds one script file and calls mount(element) then update(data). Real vectors from a named model appear as a moving 3-D window with the three views, the page says where the vectors came from and that it is a projection, and new points can be appended while it runs.

## Why it matters

- An embedding space is hundreds of dimensions and every still picture of it hides almost all of them. Motion through many projections is the honest way to show that, and one shared viewer means a vector store, a conversation and a photo collection are all read the same way.

## Requirements

- The viewer is ONE dependency-free, no-build core JS file exposing mount(el)/update(data) over a documented JSON data contract, themed by the host's CSS variables, loading nothing from an external origin (no CDN, no web fonts). The other two delivery forms are thin shells over that same file: a custom element (<embeddings-tumbler>) and a standalone page that loads a data file. None of the three uses inline script.
  - honesty: The shipped file passes embodiment's check-no-external-origin build check and runs under a script-src 'self' policy with no inline script; it has no runtime dependency and no build step is needed to use it.
- The data contract carries, per point: id, label, group, free metadata, and a float32 vector; plus set-level dimension, model id and provenance. It supports a full replace and an incremental append (for a live conversation). An Atlas directory (atlas.json + records.jsonl + vectors.npy) is the first source that must convert to it.
  - honesty: An Atlas directory written by 'embeddings survey' converts to the contract and renders without hand editing, and a second producer that is not embeddings-cli can emit the same contract from its documentation alone.
- Vectors reach the browser through a server-side step (an exported file or a same-origin proxy); the page never calls the embedding gateway and never holds the key. The key is injected into the server/CLI process with: grant run --inject `EMBEDDINGS_API_KEY`=`LOBES_GATEWAY_API_KEY` -- <cmd>.
  - honesty: With browser dev tools open on a hosted page, no request goes to the gateway and the key appears nowhere in page source, storage or network traffic.
- The viewer keeps the measurement rules: linear projections only, and the page states its provenance (source, model, item count, how the view is produced) and that a projection is a shadow of the space. Untrusted text reaches the page only as data, never as markup.
  - honesty: Every rendered view states source, model, dimension and item count, and no code path applies a non-linear layout; label text containing markup is shown as text.
- embeddings-cli gains one producer step that turns an Atlas directory (with its vectors present) into the viewer's data file, so the first proof needs no hand conversion. It is added as a new write-gated path following the survey/map --apply and --force convention, and it does not change 'map'.
  - honesty: Running the producer on a freshly surveyed Atlas and opening the standalone page with its output shows that Atlas's real points and labels, and the producer refuses, with a hint, an Atlas whose vector file is absent.
- The published demo artifact (<https://claude.ai/artifact/3Z9bhQHuwMEqSoRvgWvzgi>, source kept at docs/specs/reference/embedding-tumbler-demo.html) is part of this spec: it is the visual and behavioural reference, and the site that gets built is expected to look and move like it.
  - instruction: Port from the reference source rather than re-designing: same three views (Tumble, Lattice, Wander), same rendering (glow, bloom, depth of field, trails, twinkle), same night-sky look, masthead, 384-cell readout strip, controls and per-view notes. The reference's synthetic data generator stays available as the built-in sample set.
  - honesty: Shown side by side on the same sample data, the built standalone page and the reference artifact are recognisably the same thing to the user, who signs off on the comparison; every intended difference is written down, starting with the fonts, which the reference loads from Google Fonts and the built site must bundle or replace because nothing may load from another origin.
- Tumble on real data must be a guided tour, not a uniformly random one. In the probe 2026-11-13: 311 real texts embedded live with Qwen/Qwen3-Embedding-0.6B through the lobes gateway, the vectors are 1024-d and group separation (inter/intra distance) is 1.12 in full space, 1.11 in random 3-D frames (no better than nothing), 1.48 for frames drawn inside the top-8 principal directions and 1.90 for PCA-3. The tour is biased toward the data's high-variance directions, and the page states what share of the variance the directions it tours through hold.
  - honesty: On the probe corpus the mean group separation over Tumble's frames is clearly above the 1.11 random-frame baseline, and the stated variance share matches a recomputation from the data.
- Nothing in the viewer hard-codes 384 dimensions. The reference demo fixes D=384 in its texture layout (96 texels per point), its shader loop and its 384-cell readout strip, but the first real source is 1024-d and the other gateway lanes are 768-d and 2560-d. Dimension comes from the data; the readout strip has one cell per dimension.
  - honesty: The same core file renders the built-in 384-d sample set and a 1024-d Atlas with no code change, and is exercised at 768-d and 2560-d at least with generated data.
- The data contract carries vectors as a binary float32 block, not as JSON numbers. In the probe 2026-11-13: 311 real texts embedded live with Qwen/Qwen3-Embedding-0.6B through the lobes gateway, 311 points x 1024-d are 1.27 MB as raw float32 but about 3.3 MB as JSON decimal text; 10,000 points would be 41 MB raw and over 100 MB as JSON. Point records (id, label, group, metadata) stay JSON; the vector block is referenced or embedded beside them.
  - honesty: A data file's size is within a few percent of points x dimensions x 4 bytes plus the records, and the standalone page loads a 10,000 x 1024 file without exhausting the tab.
- The contract and the core file are versioned. The data carries a schema version and the viewer refuses an unknown or newer version with a plain message instead of best-effort drawing (the rule Atlas schema v1 already follows). Because hosts will vendor copies of the file rather than depend on a package, the file itself states its version and source at the top.
  - honesty: A data file with a bumped schema version is refused with a message naming both versions, and a vendored copy can be traced to a release from its own header.
- The viewer has a full lifecycle, not only mount and update: destroy(el) frees the GPU resources and stops the animation loop; it pauses when the tab is hidden or the element is off screen; it recovers from a lost WebGL context; several instances can live on one page; and without WebGL 2 it shows a plain message rather than an empty box. It keeps honouring reduced-motion as the reference does.
  - honesty: Mounting and destroying the viewer twenty times on one page leaves no growing GPU or timer use, a forced context loss is recovered or reported, and a hidden tab does no per-frame work.
- A view is reproducible. The tour takes a seed, the page shows it with the rest of the provenance, and the same data, seed and elapsed time give the same view, so a screenshot can be traced back to how it was produced. This is the rule docs/design-notes/semantic-measurement.md section 3 sets for every other reading of an Atlas.
  - honesty: Two page loads with the same data file and seed show the same frame at the same elapsed time, and the seed appears in the provenance block.

## Honesty conditions

- The demo's visual quality survives real data: with real vectors (not the synthetic set) the three views still show visible structure, or the page says plainly that this model's space has little.
- Handing the viewer vectors of mixed dimension or two model ids is refused with a plain message rather than drawn.
- After the viewer ships, 'embeddings map --html' output is byte-identical for the same Atlas and no file under embeddings/atlas or the stable-contract CLI modules changed for the viewer's sake.
- Each of the three readers has a concrete first user: a host page that mounts the viewer, embeddings-cli as the producer, and a person shown a real Atlas who can say what they learned from it.
- As of 2026-11-13 no repo surveyed (embeddings-lens, irc-lens, webglass-cli, embodiment, eidetic-cli) contains an embedding viewer, and the demo page's data is generated in the page.
- A host needs no code beyond including the file and the two calls; an update() that appends points while the view is running neither resets the camera nor drops existing points.
- On a real Atlas, at least one structure that is hidden or merged in the 2-D 'embeddings map' picture becomes visible in a moving view; if none does, the claim is reported as not shown rather than assumed.
- The check is run with the browser's network log captured for each of the three forms, and the Atlas used was embedded live through the gateway, not synthetic.
- The viewer contains no network call other than loading the data file it was pointed at, and a labels-only data file renders with no corpus text present in it.
- Each of the three numbers is produced by a script or recorded check kept in the repo (separation computed from the tour's frames, frame rate logged by the page, network log captured), on the named model and corpus size, so the result can be rerun.

## Success signals

- The same unmodified core file runs in all three forms showing one real Atlas embedded through the lobes gateway: the standalone page, a plain host page that calls mount/update, and a host page that uses the web component under a script-src 'self' policy. No form makes a network request to any origin other than its host's, and a point appended through update() appears without a reload.
- Measured on a real Atlas of at least 300 texts embedded live with Qwen/Qwen3-Embedding-0.6B (1024-d): Tumble's frames average a group separation of at least 1.3 against the 1.11 random-frame baseline; the standalone page holds at least 30 frames per second with 10,000 points on the user's desktop; and the network log shows 0 requests to any origin other than the host's in all three delivery forms.

## Scope / boundaries

- One view shows one embedding model. Vectors from different models are never mixed in a view: Qwen3-Embedding-0.6B is 1024-d, embed-deep 2560-d, gemma2-embed 768-d, and eidetic's offline fallback is a 128-d hash that is not semantic at all.
- The viewer is a new surface beside 'embeddings map --html', not a replacement. map --html stays a self-contained, PCA, readable-without-JavaScript artifact; Atlas schema v1 and the three stable-contract CLI modules are not changed by the viewer.
- The data file contains the corpus text and its vectors, and vectors can leak the text they were made from. The viewer never transmits data anywhere; it only reads what its host gives it. The producer says plainly that its output carries text and vectors, and can leave text out (labels only). Publishing a standalone page with a private corpus is the operator's explicit act, never a default.

## Non-goals

- No UMAP, t-SNE or other non-linear layout; no hosting inside irc-lens (an IRC-only client that forbids framing); webglass-cli is at most a test harness for the page.
- Not in the first version: the single-embedding view, an iframe/postMessage form, image embedding support in the embeddings-cli client, a route in embodiment that serves its vectors, and an export verb in eidetic-cli. Each is a later, separate piece of work in its own repo.

## Assumptions

- Photos and text can share one view only through the gemma2-embed lane (google/embeddinggemma-2, 768-d, Matryoshka 128/256/512/768). That requires a new request shape in embeddings/backends/client.py (messages + `image_url` data URL, one image per request) and re-embedding any text meant to sit beside the photos.
- The 'visualize a vector DB' case needs new code on the data side: eidetic stores no vectors (it re-embeds per search) and has no export verb, so someone must list records and embed them. embodiment already has real vectors on disk but serves none of them.
- Real models do lay out some concepts as shapes the viewer can show. In the probe 2026-11-13: 311 real texts embedded live with Qwen/Qwen3-Embedding-0.6B through the lobes gateway, the twelve months sit in calendar order around a plane (12 of 12 neighbours in order; that plane holds 44% of their variance) and the seven weekdays likewise (7 of 7; 56%), while the cold-to-hot words are only loosely ordered along one axis (rank correlation 0.56). So the demo's ring, which was made up, has a real counterpart; whether this holds for other models and larger corpora is untested.

## Scope exploration

- `s1` — `irc-lens/src/irc_lens/static/mesh.js + web/app.py CSP`: mesh.js is the only proven embed pattern in the ecosystem: a vanilla IIFE exposing globalThis.LensMesh={mount,update} over a JSON contract, themed by --lens-\* variables; irc-lens CSP is script-src 'self' and frame-ancestors 'none', so inline scripts, CDNs and iframes are all ruled out for a host like it.
  - seeds: `c2`
- `s2` — `embodiment/web (React 18 + Vite 6) build script check-no-external-origin.mjs`: embodiment's dashboard build fails if any external origin appears in the output; the prototype's Google Fonts link would break it. There is no plugin/panel/iframe mechanism: views are a hard-coded union in web/src/App.tsx:74, so mounting means adding a View that calls the script.
  - seeds: `c2`
- `s3` — `embeddings/atlas/schema.py + io.py`: Atlas v1 is atlas.json (model, endpoint, params, seed, limitations, uncertain) + records.jsonl (id, text, `vector_index`, metadata) + vectors.npy; the committed studies under docs/studies/ have records but no vectors.npy (git-ignored sidecars), so a viewer export needs a survey run or a re-embed first.
  - seeds: `c3`
- `s4` — `embodiment/embodiment/bus.py + http/server.py GET /api/events`: The live conversation is an authenticated SSE stream of {v,kind,ts,seq,source,data} envelopes (transcript: role,text; reply: text); past turns are <state>/sessions/<id>.jsonl. This is the shape an incremental append must accept.
  - seeds: `c3`
- `s5` — `lobes-cli/lobes/gateway/server.py + docs/openai-api.md`: The gateway implements only GET/POST and has no CORS code; OPTIONS /v1/embeddings returned 501 live, so a browser preflight always fails. Auth is Authorization: Bearer <`GATEWAY_API_KEY`>; /health and /capabilities are keyless.
  - seeds: `c4`
- `s6` — `grant (README, grant list)`: grant list prints names only; `LOBES_GATEWAY_API_KEY` exists. grant run --inject VAR=NAME -- cmd is the path that never prints the value. embeddings/backends/client.py reads the key only from `EMBEDDINGS_API_KEY` then `COLLEAGUE_API_KEY`, never from a flag.
  - seeds: `c4`
- `s7` — `lobes-cli/docs/embeddinggemma-2.md + live GET /capabilities`: gemma2-embed reports modalities text,code,image,video,audio, dimension 768, ready=true. Images go in a messages body as data: URLs (http URLs are refused), one embedding per request. Real-photo retrieval quality is explicitly unvalidated (lobes issue 296: only solid-colour probes passed).
  - seeds: `c5`
- `s8` — `embeddings/backends/client.py`: The client sends only {model, input:\[texts\]} with a 10 s timeout; no messages, dimensions or image support exists. Its docstring still says port 8002 while `DEFAULT_BASE_URL` is 8001.
  - seeds: `c5`
- `s9` — `eidetic-cli/eidetic/memory/embed.py + embodiment/embodiment/vectors.py`: eidetic defaults to Qwen/Qwen3-Embedding-0.6B (and a non-semantic 128-d hash fallback offline); embodiment embeds with gemma2-embed. The two systems' vectors are not comparable, and docs/design-notes/semantic-measurement.md section 2 already forbids a shared coordinate frame across models.
  - seeds: `c6`
- `s10` — `eidetic-cli/eidetic/memory/backend.py + scoring.py + recall.py`: No vectors on disk in the files, mongo or neo4j backends; scoring.py embeds fresh at query time; recall --json has no vector field and top-k defaults to 5. Backend.all() plus EmbedClient.embed() are the pieces an export would build on.
  - seeds: `c7`
- `s11` — `embodiment/embodiment/vectors.py + library/index.py`: Conversation turns are already embedded: <state>/vectors/vectors.json ({`record_id`, vec}, no text) and <state>/conversations-index.json (chunks with text, vec, tvec), both 0600 under the state dir, gemma2-embed. No HTTP route serves them; exposing them means a new guarded route.
  - seeds: `c7`
- `s12` — `embeddings/cli/_commands/map.py`: map.py's contract: deterministic PCA, the file references nothing outside itself, readable with JS disabled, corpus text only via an escaped JSON block into textContent, write-gated by --apply/--force. A WebGL2 animated page cannot meet 'readable with JS disabled', so it cannot be folded into map --html.
  - seeds: `c8`
- `s13` — `docs/design-notes/semantic-measurement.md section 3 + map.py PROJECTION_CAVEAT`: The repo rejects UMAP/t-SNE because they manufacture clusters, and requires provenance inside the artifact. Tumble/Lattice/Wander are all orthonormal linear projections, so they are consistent with this; the prototype has no provenance block and a synthetic dataset.
  - seeds: `c9`
- `s14` — `irc-lens/CLAUDE.md + webglass-cli/README.md`: irc-lens describes itself as a pure AgentIRC client and sets frame-ancestors 'none'; webglass-cli drives headless Chromium and can open and screenshot a locally served page but denies loopback targets without an explicit policy profile.
  - seeds: `c10`
- `s15` — `challenge pass / unstated-assumptions lens: real-vector probe vs the synthetic demo data`: The demo's regions were generated tight enough that a random tour shows them; real vectors are not (top-3 principal directions hold 19% of variance, effective dimensionality about 44). An unguided Tumble would show one blob.
  - seeds: `c24`
- `s16` — `challenge pass / hidden-dependencies lens: docs/specs/reference/embedding-tumbler-demo.html constants`: D=384, `PER_ROW`\*96 texel layout, the shader's 96-iteration loop and the strip canvas width are literals in the reference; the probe returned D=1024.
  - seeds: `c25`
- `s17` — `challenge pass / data-flow lens: payload size at real dimension`: The confirmed contract says 'JSON data contract' with float32 vectors; at 1024-d a JSON-number encoding is about 2.6x the raw size and must be parsed number by number.
  - seeds: `c26`
- `s18` — `challenge pass / lifecycle lens: embeddings/atlas/schema.py SCHEMA_VERSION + cite-don't-import practice (irc-lens CITATION.md)`: The confirmed spec has no version on the contract or the file, yet the producer (embeddings-cli) and the viewer (embeddings-tumbler) release separately and hosts copy the file.
  - seeds: `c27`
- `s19` — `challenge pass / failure-modes lens: reference demo's single-page assumptions`: The reference is one page with one canvas that runs forever: no teardown, no context-loss handler, no visibility pause. A web component can be created and removed many times, and browsers cap live WebGL contexts.
  - seeds: `c28`
- `s20` — `challenge pass / security lens: docs/specs/2026-11-13-embeddable-space-viewer.md c4 + the demo artifact's 'anyone with the link' sharing`: The spec protects the gateway key but says nothing about the data itself; later sources are conversation turns and personal photos, and the demo artifact was at one point shared by public link.
  - seeds: `c29`
- `s21` — `challenge pass / missing-observability lens: docs/design-notes/semantic-measurement.md sections 3-4 vs the reference's unseeded motion`: Tumble's motion in the reference draws from a random walk with no exposed seed, and Wander's hops are random; the repo's rule is that every picture is stamped with parameters and seed.
  - seeds: `c30`
- `s22` — `challenge pass / counter-evidence lens: real-vector probe of the demo's invented shapes`: The ring is real for this model and these words; the temperature arc is weak. Also only 15% of true 3-nearest neighbours are nearest in a random 3-D picture and 30% in PCA-3, which is direct support for Lattice drawing true neighbours.
  - seeds: `c31`
- `s23` — `challenge pass / adjacent-systems lens: ../embeddings-tumbler scaffold (README.md, pyproject.toml, culture.yaml, .github/workflows)`: The new repo did not exist at scope time. It is a culture-agent-template Python CLI: dependencies=\[\], console script embeddings-tumbler, PyPI Trusted Publishing, pytest-only CI and the teken rubric gate. Nothing in it ships, tests or lints JavaScript; raised as a question, not guessed.
- `s24` — `challenge pass / concurrency + reversibility lens: whole spec`: No shared mutable state, migration or destructive step is introduced; the producer is write-gated like survey/map. Clean pass on these two, with the append behaviour parked.
- `s25` — `challenge pass / unexamined surfaces`: Not examined: mounting inside embodiment's real dashboard, the gemma2-embed image lane, any corpus beyond 311 real points, non-Chrome browsers, and behaviour above the demo's 12,288 points.

## Decisions

- The viewer lives in its own repo, embeddings-tumbler (../embeddings-tumbler), created by the user for this purpose. embeddings-cli stays the measurement CLI and becomes a data producer for it; this frame is worked in embeddings-cli and the spec moves to the new repo.
- The first version is the many-points viewer only (Tumble, Lattice, Wander). The single-embedding view is a follow-up with its own spec.
- The first version ships three delivery forms: the script with mount/update, a standalone page that loads a data file, and a web component wrapping the script. An iframe-able page fed by messages is not in the first version.
- The first real data source is an Atlas study written by 'embeddings survey' in embeddings-cli (text, one model). The live embodiment conversation and photo collections come after.
- The first version supports exactly three modes: Tumble, Lattice and Wander. More modes may be added later, so a mode is a separable unit inside the viewer (its own motion and drawing rules over the shared projection and data contract), not logic spread through the core.
- The viewer ships through two channels from embeddings-tumbler: inside the Python wheel as package data, with CLI verbs that write the file, the standalone page or a data file into a host's folder and can serve it locally; and as an npm package for hosts with a JavaScript build such as embodiment's dashboard. Both channels carry the same unmodified core file.
- Vectors may be rotated onto the data's own principal directions before display. An exact rotation (nothing lost) is always allowed and stated on the page. Keeping only the top k directions is an option that is off by default; when it is used the page states how much variance was dropped, and the view is labelled an approximation of the space.
- The npm package is published under the user's npm organisation culture.dev (<https://www.npmjs.com/settings/culture.dev>). The publish credential is held in grant as the hidden secret `NPM_ACCESS_TOKEN` (with `NPM_USER` and `NPM_SECRET` beside it); because it is hidden it can only be handed to a process with 'grant run --inject', and its value never appears in the repo, in CI logs or on stdout.
- Both packages are published from CI by trusted publishing (the workflow's own identity, no long-lived token stored in the repository): PyPI as the scaffold already does, and npm under the culture.dev organisation. The `NPM_ACCESS_TOKEN` held in grant is not used by CI; it is at most a one-time bootstrap if npm requires the package to exist before a trusted publisher can be attached.

## Hard questions

- risk: The reference was tuned by eye on synthetic data with tight, well-separated regions. Real model vectors are noisier, so the same rendering may look like one blob until the tour is biased toward high-variance directions; 'looks like the artifact' is judged on the sample set, and real-data look is covered by h1 and h12.

## Open parks

- [unknown_nonblocking] Scale ceiling is unmeasured: the prototype holds 12,288 points x 384-d in one float texture and measures true neighbours for only 1,000 of them in the browser (O(n^2)); behaviour at 1024-d, 100k points, or on phones is unknown.
- [unknown_nonblocking] Photo embedding quality through gemma2-embed is unvalidated upstream (lobes issue 296), so a photo view may look structureless for reasons that are the model's, not the viewer's.
- [unknown_nonblocking] Appending points changes the cloud's centre and scale and the true-neighbour sets; how the view absorbs that without a visible jump, and at what cost per append, is unmeasured. Plan-side risk once the plan exists.
- [unknown_nonblocking] Only desktop Chrome was looked at. Firefox, Safari and phones (float-texture and half-float render support, context limits) are unexamined.
- [unknown_nonblocking] Adding an npm channel brings JavaScript tooling, a second registry credential and a second publish job into a repo whose CI is pytest-only; how the two releases are kept in step is a plan-side risk.
- [unknown_nonblocking] Not checked: the exact npm scope string for the culture.dev organisation and whether the package name is free, and whether CI publishing will use the stored token or npm's trusted publishing (the repo already uses Trusted Publishing for PyPI).
- [unknown_nonblocking] Whether npm lets a trusted publisher be configured before the package's first publish is unverified; if it does not, the first release needs a one-time token publish from grant.
- [follow_up] innereye's CLAUDE.md names embeddings-cli and embeddings-lens as producers and asks for an agreed interchange format; the viewer's data contract should be the same one, or explicitly not.
- [follow_up] Single-embedding view: one vector alone, moving in a small space to reflect its many dimensions. Not designed yet; gets its own spec after the many-points viewer ships.
- [follow_up] A moving canvas has no equivalent for someone who cannot see it; a text summary of what the view shows is not designed.
