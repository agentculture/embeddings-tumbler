"""Challenge-pass probe: does a real embedding space behave like the demo's synthetic one? Read-only; writes only next to itself."""
import json, sys, time
from pathlib import Path
import numpy as np
from embeddings.backends.client import EmbeddingClient

repo = Path(sys.argv[1]); out = Path(__file__).parent
rng = np.random.default_rng(0)
items = []
for line in (repo / "docs/evidence/corpus.jsonl").read_text().splitlines():
    r = json.loads(line); items.append((r["text"], "doc:" + r["source"]))
for line in (repo / "docs/studies/probe-corpus.jsonl").read_text().splitlines():
    r = json.loads(line); items.append((r["text"], "fact:" + r.get("kind", "?")))
MONTHS = "January February March April May June July August September October November December".split()
DAYS = "Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split()
TEMPS = "frozen icy frosty bitter chilly cold brisk cool mild temperate lukewarm warm balmy toasty hot sweltering torrid searing scorching blazing".split()
for w in MONTHS: items.append((w, "months"))
for w in DAYS: items.append((w, "days"))
for w in TEMPS: items.append((w, "temperature"))
texts = [t for t, _ in items]; groups = np.array([g for _, g in items])
client = EmbeddingClient()
t0 = time.time(); vecs = []
for i in range(0, len(texts), 32): vecs += client.embed(texts[i:i + 32])
X = np.asarray(vecs, dtype=np.float64); dt = time.time() - t0
np.save(out / "vectors.npy", X.astype(np.float32)); (out / "groups.json").write_text(json.dumps(groups.tolist()))
N, D = X.shape
print(f"model={client.model} N={N} D={D} embed_seconds={dt:.1f} norms mean={np.linalg.norm(X,axis=1).mean():.4f}")
Xn = X / np.linalg.norm(X, axis=1, keepdims=True)
G = Xn @ Xn.T; iu = np.triu_indices(N, 1)
print(f"raw cosine between all pairs: mean={G[iu].mean():.3f} min={G[iu].min():.3f} max={G[iu].max():.3f}")
Xc = Xn - Xn.mean(0)
s = np.linalg.svd(Xc, compute_uv=False); var = s**2 / (s**2).sum()
print("PCA variance share: top1=%.3f top3=%.3f top10=%.3f top50=%.3f ; participation ratio=%.1f dims" % (var[0], var[:3].sum(), var[:10].sum(), var[:50].sum(), 1 / (var**2).sum()))

def sep(P, labels):
    """mean inter-group distance / mean intra-group distance (1.0 = no visible grouping)."""
    d = np.linalg.norm(P[:, None] - P[None], axis=2); same = labels[:, None] == labels[None]
    off = ~np.eye(len(P), dtype=bool)
    return d[~same].mean() / d[same & off].mean()
big = np.array([g in ("doc:README.md", "doc:CLAUDE.md", "fact:value", "fact:negation", "months", "days", "temperature") or True for g in groups])
print("groups:", {g: int((groups == g).sum()) for g in sorted(set(groups))})
full = sep(Xc, groups)
U, S, Vt = np.linalg.svd(Xc, full_matrices=False); pca3 = Xc @ Vt[:3].T
rs = []
for _ in range(300):
    Q, _ = np.linalg.qr(rng.standard_normal((D, 3))); rs.append(sep(Xc @ Q, groups))
rs = np.array(rs)
# guided tour: random 3-frame drawn inside the top-k principal subspace
gs = {}
for k in (8, 16, 32):
    v = []
    for _ in range(300):
        Q, _ = np.linalg.qr(rng.standard_normal((k, 3))); v.append(sep(Xc @ Vt[:k].T @ Q, groups))
    gs[k] = np.mean(v)
print(f"group separation (inter/intra distance): full-D={full:.3f}  PCA-3={sep(pca3, groups):.3f}  random 3-D frames mean={rs.mean():.3f} p5={np.percentile(rs,5):.3f} p95={np.percentile(rs,95):.3f}")
print("  random 3-D frame inside top-k PCA subspace:", {k: round(float(v), 3) for k, v in gs.items()})

def ring(words, label):
    idx = [texts.index(w) for w in words]; M = Xn[idx] - Xn[idx].mean(0)
    u, sv, vt = np.linalg.svd(M, full_matrices=False); share = sv**2 / (sv**2).sum()
    p = M @ vt[:2].T; ang = np.unwrap(np.arctan2(p[:, 1], p[:, 0]))
    order = np.argsort(np.arctan2(p[:, 1], p[:, 0])); n = len(words)
    # is the angular order a rotation (either direction) of the calendar order?
    steps = np.diff(np.concatenate([order, order[:1]])) % n
    cyc = max((steps == 1).sum(), (steps == n - 1).sum())
    rad = np.linalg.norm(p, axis=1)
    print(f"{label}: top-2 plane holds {share[:2].sum():.2f} of variance (top-3 {share[:3].sum():.2f}); {cyc}/{n} neighbours in calendar order around the plane; radius cv={rad.std()/rad.mean():.2f}; order={[words[i][:3] for i in order]}")
ring(MONTHS, "months"); ring(DAYS, "weekdays")
idx = [texts.index(w) for w in TEMPS]; M = Xn[idx] - Xn[idx].mean(0); u, sv, vt = np.linalg.svd(M, full_matrices=False)
pc1 = M @ vt[0]; r = np.corrcoef(np.argsort(np.argsort(pc1)), np.arange(len(TEMPS)))[0, 1]
print(f"temperature scale: |rank correlation of first principal axis with cold->hot order| = {abs(r):.2f}")
# nearest-neighbour agreement: do 3-D neighbours match true neighbours?
def knn(P, k=3):
    d = np.linalg.norm(P[:, None] - P[None], axis=2); np.fill_diagonal(d, np.inf); return np.argsort(d, 1)[:, :k]
true = knn(Xc); 
def overlap(P): 
    a = knn(P); return np.mean([len(set(a[i]) & set(true[i])) / 3 for i in range(N)])
Q, _ = np.linalg.qr(rng.standard_normal((D, 3)))
print(f"share of true 3 nearest neighbours that are also nearest in the picture: PCA-3={overlap(pca3):.2f} random frame={overlap(Xc @ Q):.2f}")
print(f"payload: {N} points x {D} float32 = {N*D*4/1e6:.2f} MB raw; as JSON decimal text about {len(json.dumps(X[0].round(6).tolist()))*N/1e6:.2f} MB; per 10k points raw {10000*D*4/1e6:.0f} MB")
