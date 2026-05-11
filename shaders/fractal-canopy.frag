// fractal-canopy: a recursive binary-branching tree that endlessly grows
// outward. The camera slowly rotates and zooms out, so the oldest trunk
// shrinks toward the center while fresh outer branches fill the frame.
//
// Build strategy (since fragment shaders can't recurse): inverse traversal.
// For each pixel we transform INTO the tree's frame, then at each generation
// fold the half-plane around the parent branch axis into the closer child's
// local frame. At every step we accumulate the min SDF distance to that
// generation's branch segment. Result is a true binary-tree topology — every
// generation contributes a visible branch, not just the leaves.
//
// Audio coupling
//   - u_bass advances the active generation depth (smoothed envelope vs the
//     last ~1 second of bass history → musical, not a smooth ramp).
//   - u_volume nudges the zoom so loud passages "breathe" the camera.
//   - u_treble pulses leaf-tip glow.
//   - u_mid biases the branching angle slightly so the canopy "leans" with
//     mid-range content.
//
// Color: triadic palette via the shared triadHue() base. Trunk → hue A,
// mid generations → hue B, leaves → hue C, with smooth interpolation by
// generation index.

#define MAX_DEPTH 9              // hard cap — every pixel walks this many levels
#define BRANCH_SHRINK 0.72       // child branch length / parent length
#define BASE_ANGLE 0.52          // branch split half-angle (radians, ~30°)
#define TRUNK_LEN 0.55           // length of generation-0 branch in tree-space
#define TRUNK_THICK 0.018        // half-width of trunk
#define THICK_SHRINK 0.72        // child thickness / parent thickness

// SDF: distance from point p to a vertical line segment from (0,0) to (0,L),
// half-thickness w. Returns *unsigned* distance to the segment surface.
// (The segment is drawn pointing +Y in the local frame.)
float segmentSDF(vec2 p, float L, float w) {
  // Clamp y into [0,L], measure distance to the spine.
  float y = clamp(p.y, 0.0, L);
  vec2  d = p - vec2(0.0, y);
  return length(d) - w;
}

// Smoothed bass envelope. Compares "now" bass to a windowed average of the
// last ~0.7s; on a hit, depth pushes deeper, then relaxes. Returns a
// continuous "active depth" in [MIN_D, MAX_DEPTH-0.5] so generations fade
// in/out smoothly across the boundary.
float activeDepth() {
  // History mean (low end). Sampling several depths smooths out per-frame jitter.
  float past = (
      sampleFFTHistory(0.04, 0.20) +
      sampleFFTHistory(0.04, 0.45) +
      sampleFFTHistory(0.08, 0.30) +
      sampleFFTHistory(0.08, 0.65) +
      sampleFFTHistory(0.12, 0.50)
  ) * 0.20;

  // "Hit" = current bass exceeding recent average. Squashed so it can saturate
  // on hard kicks but stays musical on background bass.
  float hit = clamp((u_bass - 0.5 * past) * 1.6 + 0.25 * u_bass, 0.0, 1.0);
  hit = pow(hit, 0.85);

  // Map to depth: silence parks at ~5 generations; full kick reaches MAX_DEPTH.
  float minD = 5.0;
  float maxD = float(MAX_DEPTH) - 0.5;
  return mix(minD, maxD, hit);
}

void main() {
  // Centered, aspect-corrected pixel coord — ranges roughly ±0.5 vertically.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Camera: rotate + zoom-out forever ---------------------------------
  // The zoom cycles on a long period: each cycle the world scale grows by
  // BRANCH_SHRINK^-1, which exactly matches the size of one new generation.
  // Net effect: the tree appears to "grow one generation outward per cycle"
  // while the trunk shrinks back toward the center, and we never run out of
  // detail because the inverse traversal is depth-locked, not scale-locked.
  float zoomPeriod = 9.0;                          // seconds per generation-of-zoom
  float zoomPhase  = u_time / zoomPeriod;
  // Volume slightly pushes the camera back on loud sections.
  float zoomBias   = 0.12 * smoothstep(0.0, 0.8, u_volume);
  // Continuous zoom: world scales up exponentially with phase. Higher scale =
  // we see more of the (small) tree → tree appears smaller on screen.
  float worldScale = pow(1.0 / BRANCH_SHRINK, fract(zoomPhase) + zoomBias);

  // Slow whole-scene rotation. Period chosen so it drifts ~one full turn per
  // ~80s — present, not dizzying.
  float camAngle = u_time * 0.04;

  // Inverse camera transform: undo rotation, then scale to "tree space".
  // Tree space has its trunk base at (0, -0.25) growing upward.
  vec2 p = rot2d(-camAngle) * uv * worldScale;
  // Drop the camera so the trunk base sits comfortably below center.
  p += vec2(0.0, 0.25);

  // ---- Walk the tree (inverse traversal) ---------------------------------
  // Convention: at each level, the local frame has the current branch's BASE
  // at the origin, growing in +Y. The branch length is `len`, half-thickness
  // is `thick`. We compute SDF to this branch, then fold the plane into
  // whichever child sub-tree contains `p`.
  float len   = TRUNK_LEN;
  float thick = TRUNK_THICK;

  // Branching angle wobbles slightly with mid-range and time so the tree
  // sways instead of being mathematically rigid.
  float angle = BASE_ANGLE
              + 0.12 * sin(u_time * 0.35)
              + 0.18 * (u_mid - 0.3);
  angle = clamp(angle, 0.30, 0.85);

  // Active depth gate (continuous): generations beyond `activeD` fade out
  // their contribution to the SDF (push them far away).
  float activeD = activeDepth();

  // Per-generation accumulators: track the minimum SDF distance encountered
  // *and* the generation index at which it was hit (for coloring).
  float bestDist = 1e6;
  float bestGen  = 0.0;
  // Leaf-glow accumulator: distance to the *tip* of the deepest branch a
  // pixel encountered. Used for the bright pulsing leaf bloom.
  float bestTipDist = 1e6;

  // Trunk segment first (generation 0 lives at the tree base).
  {
    float d0 = segmentSDF(p, len, thick);
    if (d0 < bestDist) { bestDist = d0; bestGen = 0.0; }
    // Translate origin to the TIP of the trunk so children start there.
    p.y -= len;
  }

  // Now N children. Each iteration: pick the closer child (left/right),
  // rotate INTO that child's local frame, scale lengths down.
  // Loop bound is a constant — required by WebGL2.
  for (int g = 1; g <= MAX_DEPTH; g++) {
    len   *= BRANCH_SHRINK;
    thick *= THICK_SHRINK;

    // Symmetric fold: the two children mirror across the parent's spine
    // (the +Y axis here). Choose by the sign of p.x, then mirror so we
    // always work in the "right child" frame.
    float side = sign(p.x);
    if (side == 0.0) side = 1.0;
    p.x = abs(p.x);

    // Rotate INTO the right-child's local frame. The right child's spine
    // direction in the parent frame is (sin angle, cos angle) — i.e. `angle`
    // clockwise from +Y. rot2d() here is CW (see common.glsl), so to bring
    // that spine direction back to (0, 1) we apply rot2d(-angle).
    p = rot2d(-angle) * p;

    // SDF to this generation's branch segment.
    float dG = segmentSDF(p, len, thick);

    // Smooth fade for generations beyond the active depth: instead of a hard
    // cutoff, push contribution away as `g - activeD` grows positive.
    float gen = float(g);
    float fade = smoothstep(0.0, 1.0, activeD - gen + 1.0);
    // When fade is small, inflate the distance so this generation can't win
    // the min — but not infinite (keeps gradients well-behaved).
    dG = mix(dG + 0.6, dG, fade);

    if (dG < bestDist) { bestDist = dG; bestGen = gen; }

    // Tip distance for leaf glow (only for the deepest visible generation).
    // The "tip" is the point (0, len) in the current local frame.
    if (gen >= activeD - 1.5 && gen <= activeD + 0.5) {
      float dTip = length(p - vec2(0.0, len));
      // Apply same fade so partial-generations contribute proportionally.
      dTip = mix(dTip + 0.6, dTip, fade);
      if (dTip < bestTipDist) bestTipDist = dTip;
    }

    // Translate to the tip so the next iteration's children start there.
    p.y -= len;
  }

  // ---- Color =============================================================
  // Triadic palette. `bestGen` (0..MAX_DEPTH) drives the triad selector so
  // trunk lands on hue A, mid generations on hue B, leaves on hue C. The
  // base hue rotates slowly via the shared global triad.
  float maxGen = float(MAX_DEPTH);
  float genT   = clamp(bestGen / maxGen, 0.0, 1.0);
  float baseHue = triadHue(0.0);
  // Triad selector: 0 → first hue, 0.5 → second, 1 → third. Use the soft
  // picker so adjacent generations feather into each other.
  vec3 branchCol = triadPick(genT, baseHue, 0.95, 0.55);

  // Antialiased branch alpha. fwidth gives ~1px in current coord space; we
  // scale by worldScale so the line stays roughly constant pixel-width
  // regardless of zoom (since we're drawing in tree-space).
  float aa = fwidth(bestDist) * 1.2;
  float branchMask = 1.0 - smoothstep(0.0, aa, bestDist);

  // Outer glow: soft falloff outside the line for that "luminescent vine" feel.
  float glow = exp(-bestDist * 65.0) * 0.7
             + exp(-bestDist * 15.0) * 0.18;

  // ---- Background ---------------------------------------------------------
  // Deep-violet wash with a slow fbm haze so quiet sections still move.
  vec2 bgUV = uv * 1.8 + vec2(u_time * 0.02, u_time * 0.013);
  float haze = fbm(bgUV);
  vec3 bgDeep = vec3(0.018, 0.010, 0.045);
  vec3 bgWash = vec3(0.06, 0.03, 0.10);
  vec3 bg = mix(bgDeep, bgWash, smoothstep(0.30, 0.85, haze));

  // Vignette.
  float vig = smoothstep(1.05, 0.20, length(uv));
  bg *= mix(0.55, 1.0, vig);

  vec3 col = bg;

  // Composite branch glow (additive, hue-preserving).
  col += branchCol * glow * (0.55 + 0.6 * u_volume);
  // Sharp branch core on top — lighter in lit so it reads as a hot spine.
  vec3 branchCore = triadPick(genT, baseHue, 0.85, 0.72);
  col = mix(col, branchCore, branchMask);

  // ---- Leaf tip glow ------------------------------------------------------
  // Tips of the deepest active generation flare on treble. Treble also picks
  // up history-tail so the leaves "pulse" rather than flicker.
  float trebleNow = u_treble;
  float treblePast = (
      sampleFFTHistory(0.75, 0.10) +
      sampleFFTHistory(0.85, 0.20) +
      sampleFFTHistory(0.92, 0.35)
  ) * 0.333;
  float leafEnergy = mix(treblePast, trebleNow, 0.6);

  float leafGlow = exp(-bestTipDist * 95.0) * 1.2
                 + exp(-bestTipDist * 25.0) * 0.35;
  // Leaf color: third triad hue, a touch brighter for the bloom.
  vec3 leafCol = triadPick(1.0, baseHue, 1.0, 0.65);
  // Warm-white core in the very center of the bloom for that "lit lamp" feel.
  vec3 leafHot = mix(leafCol, vec3(1.0, 0.95, 0.85), 0.45);
  col += leafCol * leafGlow * (0.35 + 1.4 * leafEnergy);
  // Sub-pixel hot core
  col += leafHot * exp(-bestTipDist * 240.0) * (0.8 + 1.0 * leafEnergy);

  // ---- Bass thump: brief brightness lift on the whole canopy --------------
  col *= 0.92 + 0.18 * u_bass;

  // Soft tonemap so stacked glows don't clip to white.
  col = col / (1.0 + 0.85 * col);

  // Lift blacks a hair so the void doesn't crush during quiet sections.
  col = max(col, vec3(0.012, 0.008, 0.020));

  outColor = vec4(col, 1.0);
}
