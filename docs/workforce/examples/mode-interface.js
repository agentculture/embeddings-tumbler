/*
 * Illustrative mode interface. A sketch from planning; task t7 fixes the real
 * one. The point it makes: a mode owns its own motion and drawing parameters
 * and nothing else. The data, the projection mathematics, the renderer and the
 * provenance block are shared, so adding a fourth mode touches no existing
 * mode and no part of the data contract.
 *
 * `ctx` is what the core hands every mode:
 *   ctx.data      the loaded set: count, dimension, points, vectors (centred)
 *   ctx.math      seeded random source, frames, tour, neighbours, local frames
 *   ctx.frame     Float32Array(3 * dimension): the three viewing axes (orthonormal)
 *   ctx.centre    Float32Array(dimension): where the camera sits in the space
 *   ctx.seed      the seed in use (shown in the provenance block)
 */

const exampleMode = {
  // Stable identifier, used in the mode switch and in deep links.
  id: 'still',

  // Shown in the mode switch and the notes under the stage.
  title: 'Still',
  summary: 'The frame does not move. Useful only as the smallest possible mode.',

  // Called when the mode becomes active. Set up any state derived from ctx.
  enter(ctx) {
    this.elapsed = 0;
  },

  // Advance by dt seconds. A mode moves ctx.frame and/or ctx.centre and must
  // leave ctx.frame orthonormal. Motion must depend only on ctx.seed and the
  // elapsed time, so the same data, seed and time give the same view.
  step(ctx, dt) {
    this.elapsed += dt;
  },

  // Per-frame drawing parameters for the shared renderer.
  draw(ctx) {
    return {
      zoom: null,          // null = auto-frame the cloud
      wires: 0,            // 0..1: how strongly true-neighbour wires are drawn
      fogByDistance: 0,    // 0..1: dim points by true distance from ctx.centre
      trails: 0.16,        // seconds of motion trail
      highlight: [],       // point indexes to label and connect
    };
  },

  // One line for the status readout under the stage.
  status(ctx) {
    return 'frame held still for ' + this.elapsed.toFixed(1) + ' s';
  },

  // What the provenance block says about how this view is produced, including
  // anything the watcher must know to read it honestly (Tumble reports the
  // share of variance held by the directions it tours through).
  describe(ctx) {
    return { projection: 'fixed orthonormal 3-frame', varianceShare: null };
  },
};

// Registration is by handing the mode to the core; nothing else changes.
// EmbeddingsTumbler.registerMode(exampleMode);
