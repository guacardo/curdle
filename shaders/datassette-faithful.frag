// datassette-faithful: monochrome homage to the Spotify Canvas for
// Datassette's "Homes For Waifs 165". The visual is a sparse constellation of
// ~9 nodes, where each "node" is a dense tangle of thin pen-scribbles (think
// coiled wire, balled-up cursive) sitting on cool grey marble. Thin slightly
// imperfect lines connect the nodes. Faint ghost-scribbles dust the entire
// background like duplicate echoes drifting at low opacity. The whole frame
// slowly drifts and breathes — a meditative camera, never still.
//
// Strict monochrome — cool grey marble + dark ink, no color. Audio reactivity
// is intentionally subtle:
//   - u_bass slightly nudges the global firing rate (faster pulses on bass).
//   - u_mid lifts per-node bloom intensity (bolder ink on melody).
//   - u_treble dusts a touch of extra paper grain.
// When silent, the piece still drifts and pulses on its own clock.

// ---- Tunables --------------------------------------------------------------
#define NODE_COUNT 9
#define EDGE_COUNT 12

// Cool grey marble palette. `STONE_LIT` is the bright marble surface,
// `STONE_VEIN` is the darker mineral veining, `INK` is the pen ink.
const vec3 STONE_LIT  = vec3(0.78, 0.79, 0.80);
const vec3 STONE_VEIN = vec3(0.55, 0.56, 0.58);
const vec3 INK        = vec3(0.06, 0.06, 0.07);

// ---- Constellation layout --------------------------------------------------
// Hand-placed positions in centered aspect-correct UV space (roughly
// [-0.85..0.85] horizontally for a 16:9-ish frame). Loose, asymmetric — reads
// as a hand-drawn graph rather than a regular lattice.
vec2 nodePos(int i) {
  if (i == 0) return vec2(-0.62,  0.34);
  if (i == 1) return vec2(-0.18,  0.46);
  if (i == 2) return vec2( 0.30,  0.38);
  if (i == 3) return vec2( 0.66,  0.18);
  if (i == 4) return vec2(-0.48, -0.05);
  if (i == 5) return vec2( 0.04,  0.02);
  if (i == 6) return vec2( 0.46, -0.14);
  if (i == 7) return vec2(-0.28, -0.38);
  return            vec2( 0.22, -0.42); // i == 8
}

// Per-node phase offset — pseudo-random but deterministic, so each node fires
// on its own clock.
float nodePhase(int i) {
  return hash21(vec2(float(i) * 1.31, 7.77));
}

// Per-node scribble orientation (radians) — gives clusters horizontal /
// diagonal / vertical leans like the reference.
float nodeOrient(int i) {
  return hash21(vec2(float(i) * 2.91, 1.13)) * PI;
}

// Per-node aspect ratio (x,y radii of the elliptical mask). Some clusters are
// roughly round, others elongated — adds variety to the silhouettes.
vec2 nodeRadii(int i) {
  float a = 0.060 + 0.025 * hash21(vec2(float(i) * 3.77, 9.41));
  float b = 0.045 + 0.030 * hash21(vec2(float(i) * 5.13, 4.27));
  return vec2(a, b);
}

// ---- Edge list -------------------------------------------------------------
// Sparse "Delaunay-ish" connections — every node has at least two links, no
// long crossings. Same topology as before; this part of the previous build
// was right.
int edgeA(int i) {
  if (i ==  0) return 0;
  if (i ==  1) return 0;
  if (i ==  2) return 1;
  if (i ==  3) return 1;
  if (i ==  4) return 1;
  if (i ==  5) return 2;
  if (i ==  6) return 2;
  if (i ==  7) return 3;
  if (i ==  8) return 4;
  if (i ==  9) return 4;
  if (i == 10) return 5;
  return            7; // i == 11
}
int edgeB(int i) {
  if (i ==  0) return 1;
  if (i ==  1) return 4;
  if (i ==  2) return 2;
  if (i ==  3) return 4;
  if (i ==  4) return 5;
  if (i ==  5) return 3;
  if (i ==  6) return 5;
  if (i ==  7) return 6;
  if (i ==  8) return 5;
  if (i ==  9) return 7;
  if (i == 10) return 6;
  return            8; // i == 11
}

// ---- Distance from point to line segment (for edges) ----------------------
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2  pa = p - a;
  vec2  ba = b - a;
  float h  = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// ---- Per-node bloom envelope ----------------------------------------------
// Sharp asymmetric bump per cycle — "fire" then long quiet tail, so each node
// reads as a distinct event rather than a sine.
float bloomEnv(int i, float wheel) {
  float ph   = nodePhase(i);
  float t01  = fract(wheel + ph);
  float x    = (t01 - 0.5) * 2.0;       // -1..1
  return exp(-x * x * 6.0);             // gaussian bump, peak at t01=0.5
}

// ---- Scribble field --------------------------------------------------------
// Returns an "ink amount" in [0,1] for the tangled-pen-scribble texture at
// local coordinate `q`. Implementation: take fbm-like value noise at a high
// frequency and extract a thin band around its mid value — band → line. Stack
// two passes at different scales/rotations to produce the criss-crossing
// coiled-string look. `density` (0..1) widens the band so peak-bloom strokes
// are bolder than resting strokes.
float scribbleField(vec2 q, float density) {
  // First pass: dense fine loops.
  float n1 = fbm(q * 6.5);
  // Half-width of the contour band. Wider when density is high → bolder ink.
  float w  = 0.04 + 0.10 * density;
  float band1 = 1.0 - smoothstep(w, w + 0.025, abs(n1 - 0.5));

  // Second pass: rotated and at slightly different scale so curls cross.
  vec2  q2    = rot2d(0.9) * q * 1.7;
  float n2    = fbm(q2 * 5.1 + vec2(11.3, -3.7));
  float band2 = 1.0 - smoothstep(w, w + 0.025, abs(n2 - 0.5));

  // Union of the two bands gives the tangled overlapping-line look.
  return max(band1, band2 * 0.85);
}

void main() {
  // Aspect-correct UV centered on screen.
  vec2 uv0 = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Slow camera drift + breathing zoom -------------------------------
  // Long period (~50s for the zoom, 80s for the pan) so it reads as a
  // meditative camera, not motion sickness.
  vec2  drift = vec2(sin(u_time * 0.013), cos(u_time * 0.011)) * 0.04;
  float wave  = 1.0 + 0.025 * sin(u_time * 0.04);
  vec2  uv    = (uv0 - drift) * wave;

  // ---- Cool grey marble background --------------------------------------
  // Veining = ridged noise: abs(2*fbm-1) gives sharp linear streaks rather
  // than soft blobs. Slow domain warp so the veins drift like polished stone.
  float tDrift = u_time * 0.018;
  vec2  warp   = vec2(
    fbm(uv * 1.3 + vec2( tDrift,        0.31)),
    fbm(uv * 1.3 + vec2( 4.20, -tDrift * 0.7))
  ) - 0.5;

  float marbleField = fbm(uv * 1.9 + 0.6 * warp + vec2(2.1, -tDrift * 1.1));
  float vein        = 1.0 - abs(2.0 * marbleField - 1.0);     // ridge — peaks at fbm≈0.5
  vein              = pow(vein, 2.4);                         // sharpen the veins
  // Mix: most of the page is lit stone; veins darken toward STONE_VEIN.
  vec3  stone       = mix(STONE_LIT, STONE_VEIN, vein * 0.7);

  // High-frequency paper grain — tiny per-pixel noise. Treble dusts a touch.
  float grainAmp = 0.018 + 0.018 * u_treble;
  float grain    = (hash21(gl_FragCoord.xy + floor(u_time * 24.0)) - 0.5) * grainAmp;
  vec3  col      = stone + vec3(grain);

  // ---- Faint ghost scribbles across the whole canvas --------------------
  // Same scribble noise but tiled & low-contrast, drifting on its own clock.
  // Different scale/phase from the foreground nodes so the carpet doesn't
  // visually rhyme with the main clusters.
  vec2  ghostQ   = uv * 1.4 + vec2(u_time * 0.012, u_time * -0.008);
  float ghostInk = scribbleField(ghostQ, 0.15) * 0.18;
  // Modulate with a low-frequency mask so ghosts cluster patchily rather
  // than uniformly carpeting — looks more like leftover sketch traces.
  float ghostMask = smoothstep(0.35, 0.75, fbm(uv * 0.9 + 3.7));
  ghostInk *= mix(0.55, 1.10, ghostMask);
  col = mix(col, INK, clamp(ghostInk, 0.0, 0.30));

  // ---- Per-node bloom envelopes -----------------------------------------
  // Bass nudges the wheel rate from ~0.10 to ~0.16 cycles/sec — barely
  // perceptible but the firing feels a touch more eager on bass.
  float wheelRate = 0.10 + 0.06 * smoothstep(0.0, 1.0, u_bass);
  float wheel     = u_time * wheelRate;

  float bloom[NODE_COUNT];
  for (int i = 0; i < NODE_COUNT; i++) {
    bloom[i] = bloomEnv(i, wheel);
  }

  // Mid-frequency content lifts peak bloom slightly.
  float midLift = 1.0 + 0.30 * smoothstep(0.0, 1.0, u_mid);

  // ---- Edges (drawn under nodes so scribbles overlap their lines) -------
  // Thin pencil-stroke lines with a tiny waver — sample low-freq noise along
  // the segment and offset the test point perpendicularly so the line isn't
  // a perfect CAD vector.
  float edgeInk = 0.0;
  for (int e = 0; e < EDGE_COUNT; e++) {
    int   ia = edgeA(e);
    int   ib = edgeB(e);
    vec2  a  = nodePos(ia);
    vec2  b  = nodePos(ib);

    // Tiny perpendicular waver — a noise sample whose domain follows the
    // segment direction, scaled so the line wobbles ~1-2px at typical res.
    vec2  dir   = normalize(b - a + 1e-6);
    vec2  perp  = vec2(-dir.y, dir.x);
    float along = dot(uv - a, dir);
    float wobN  = vnoise(vec2(along * 22.0, float(e) * 4.7)) - 0.5;
    vec2  uvW   = uv + perp * wobN * 0.004;

    float d = segDist(uvW, a, b);

    // Endpoint activity drives line darkness; faint baseline so the graph
    // skeleton is always readable.
    float act      = 0.5 * (bloom[ia] + bloom[ib]);
    float line     = 1.0 - smoothstep(0.0010, 0.0030, d);
    float strength = 0.20 + 0.55 * act * midLift;
    edgeInk = max(edgeInk, line * strength);
  }
  col = mix(col, INK, clamp(edgeInk, 0.0, 0.92));

  // ---- Nodes (tangled-pen scribble clusters) ----------------------------
  // Each node: rotate into its local frame, scale by its (anisotropic) radii,
  // sample the scribble field, mask with a soft elliptical gaussian. Bloom
  // envelope drives both the band width (bolder strokes) and the overall
  // opacity (faint → fully inked).
  for (int i = 0; i < NODE_COUNT; i++) {
    vec2  c   = nodePos(i);
    vec2  r   = nodeRadii(i);
    float ang = nodeOrient(i);

    // Local oriented coords. Divide by radii so the elliptical mask is
    // unit-circular in this frame.
    vec2 local = rot2d(-ang) * (uv - c);
    vec2 q     = local / r;

    // Elliptical gaussian falloff — densest at the core, fades stringy
    // toward the edges. Slight asymmetric bias so one side trails further
    // (matches the "tendrils on one side" look in the reference).
    float bias  = 0.20 * sin(ang * 1.7 + float(i));
    float rdist = length(q + vec2(bias, 0.0));
    float mask  = exp(-rdist * rdist * 1.6);

    // Per-node bloom: density (band width) goes from 0.05 (faint, hairline)
    // to ~1.0 (fat ink lines). Opacity envelope rides on top.
    float b   = bloom[i] * midLift;
    float den = mix(0.05, 1.00, clamp(b, 0.0, 1.0));

    // Sample scribble in slightly stretched local coords so the loops feel
    // anisotropic with the cluster.
    vec2  sq    = local * 11.0 + float(i) * 17.3;
    float scrib = scribbleField(sq, den);

    // Mask the scribble by the elliptical falloff; multiply by an opacity
    // that ramps with bloom (faint resting tone → bold inked stroke).
    float opacity = mix(0.30, 0.95, clamp(b, 0.0, 1.0));
    float ink     = scrib * mask * opacity;

    // Add a small dense-core dot — the very center of each cluster has a
    // tighter knot of ink that survives even at low bloom, matching the
    // dark cores in the reference.
    float core = exp(-rdist * rdist * 8.0) * scrib * (0.35 + 0.65 * b);
    ink = max(ink, core * 0.85);

    col = mix(col, INK, clamp(ink, 0.0, 0.95));
  }

  // ---- Vignette ----------------------------------------------------------
  // Subtle dim around the edges to keep the eye on the constellation.
  float vig = smoothstep(1.30, 0.35, length(uv0));
  col *= mix(0.85, 1.0, vig);

  // ---- Soft tonemap ------------------------------------------------------
  col = col / (1.0 + 0.05 * col);

  outColor = vec4(col, 1.0);
}
