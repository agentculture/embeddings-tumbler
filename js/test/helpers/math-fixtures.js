"use strict";
// Synthetic fixtures for the mathematics tests. Independent of the module under
// test: its own seeded generator and its own linear algebra, so tests can
// recompute what the module reports.

function rngFrom(seed) {
  let a = seed | 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    // Box-Muller, no spare: simple and independent of the module's polar method.
    let u = next();
    while (u === 0) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, gauss };
}

// Orthonormal rows by plain Gram-Schmidt (Float64Array, rows x D).
function orthoRows(rows, D, rng) {
  const M = new Float64Array(rows * D);
  for (let i = 0; i < rows; i++) {
    for (let d = 0; d < D; d++) M[i * D + d] = rng.gauss();
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < i; j++) {
        let dp = 0;
        for (let d = 0; d < D; d++) dp += M[i * D + d] * M[j * D + d];
        for (let d = 0; d < D; d++) M[i * D + d] -= dp * M[j * D + d];
      }
    }
    let n = 0;
    for (let d = 0; d < D; d++) n += M[i * D + d] ** 2;
    n = Math.sqrt(n);
    for (let d = 0; d < D; d++) M[i * D + d] /= n;
  }
  return M;
}

// Points with a planted spectrum: the coordinates along the planted directions
// have sample standard deviations exactly sds[j] and are exactly uncorrelated
// in the sample (so the planted directions ARE the sample's principal
// directions, up to the noise); every dimension also gets isotropic noise.
// Needs N > sds.length. Returns { X: Float32Array(N*D), dirs: Float64Array(m*D) }.
function plantedSpectrum(N, D, sds, noise, seed) {
  const rng = rngFrom(seed);
  const m = sds.length;
  const dirs = orthoRows(m, D, rng);
  // Coefficients: m centred, mutually orthogonal columns over the N samples.
  const ones = new Float64Array(N).fill(1 / Math.sqrt(N));
  const cols = new Float64Array((m + 1) * N);
  cols.set(ones, 0);
  const tail = orthoRows(m + 1, N, rng);
  // Re-orthogonalise the random rows against the constant row, so each column is centred.
  for (let j = 1; j <= m; j++) {
    for (let a = 0; a < N; a++) cols[j * N + a] = tail[j * N + a];
    for (let pass = 0; pass < 2; pass++) {
      for (let q = 0; q < j; q++) {
        let dp = 0;
        for (let a = 0; a < N; a++) dp += cols[j * N + a] * cols[q * N + a];
        for (let a = 0; a < N; a++) cols[j * N + a] -= dp * cols[q * N + a];
      }
    }
    let n = 0;
    for (let a = 0; a < N; a++) n += cols[j * N + a] ** 2;
    n = Math.sqrt(n);
    for (let a = 0; a < N; a++) cols[j * N + a] /= n;
  }
  const X = new Float32Array(N * D);
  const offset = new Float64Array(D);
  for (let d = 0; d < D; d++) offset[d] = rng.gauss() * 0.5; // a non-zero mean
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) X[i * D + d] = offset[d] + noise * rng.gauss();
    for (let j = 0; j < m; j++) {
      const c = sds[j] * Math.sqrt(N) * cols[(j + 1) * N + i];
      for (let d = 0; d < D; d++) X[i * D + d] += c * dirs[j * D + d];
    }
  }
  return { X, dirs };
}

// Planted groups, built to resemble the probe: in the full space the groups
// barely separate (isotropic noise dominates), a few high-variance nuisance
// directions carry no group information, and the group centres lie in a small
// subspace. Returns { X, N, D, groups: string[] }.
function plantedGroups(D, opts) {
  const o = Object.assign(
    { groups: 6, perGroup: 40, centreScale: 0.7, noise: 1, nuisance: [3, 2.6, 2.2], seed: 7 },
    opts || {}
  );
  const rng = rngFrom(o.seed);
  const k = o.groups;
  const sub = orthoRows(k + o.nuisance.length, D, rng);
  const N = k * o.perGroup;
  const X = new Float32Array(N * D);
  const groups = [];
  // Centre norm chosen relative to the noise's full-space spread.
  const scale = o.centreScale * o.noise * Math.sqrt(D);
  const centres = [];
  for (let g = 0; g < k; g++) {
    const c = new Float64Array(D);
    for (let j = 0; j < k; j++) {
      const w = (rng.gauss() * scale) / Math.sqrt(k);
      for (let d = 0; d < D; d++) c[d] += w * sub[j * D + d];
    }
    centres.push(c);
  }
  for (let i = 0; i < N; i++) {
    const g = i % k;
    groups.push("g" + g);
    for (let d = 0; d < D; d++) X[i * D + d] = centres[g][d] + o.noise * rng.gauss();
    for (let n = 0; n < o.nuisance.length; n++) {
      const c = o.nuisance[n] * o.noise * Math.sqrt(D / 64) * rng.gauss();
      const row = (k + n) * D;
      for (let d = 0; d < D; d++) X[i * D + d] += c * sub[row + d];
    }
  }
  return { X, N, D, groups };
}

module.exports = { rngFrom, orthoRows, plantedSpectrum, plantedGroups };
