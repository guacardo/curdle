// hatched-pyramids: M.C. Escher / op-art monochrome tessellation.
//
// A hexagonal grid where every cell is a 6-faced pyramid viewed from above.
// Each triangular face is filled with parallel hatching whose direction is
// keyed to the face index — adjacent faces hatch in different directions so
// every pyramid reads as a faceted 3D form drawn in pen-and-ink. The whole
// field drifts and slowly rotates. A handful of beveled hexagonal "voids"
// pulse with the bass — pure-black craters that breathe and wander, drawing
// the eye against the busy striped surface.
//
// Audio:
//   u_bass    → void radii pulse / breathe; mild push on stripe contrast.
//   u_treble  → fine perturbation of the hatching frequency (shimmer).
//   u_mid     → very slow extra drift on the field rotation.
//
// All math stays monochrome; output is grayscale only.

// ---- Hex grid utilities ----------------------------------------------------
// Pointy-top hex tiling. Convert world-space coords to (cellCenter, localPos)
// where localPos is relative to the cell center, in the same units.
// Standard trick: test the two candidate hex centers from the two sub-grids
// of a skewed lattice, pick the closer one.

const vec2 HEX_E = vec2(1.7320508, 0.0);          // sqrt(3), 0
const vec2 HEX_F = vec2(0.8660254, 1.5);          // sqrt(3)/2, 3/2

// Returns vec4(localOffset.xy, cellCenter.xy) for a pointy-top hex grid of
// size 1 (circumradius = 1). World coord `p` is in the same units.
vec4 hexCell(vec2 p) {
  // Two candidate centers: one from the "even" sub-lattice, one from "odd".
  // a-grid: spans (HEX_E, HEX_F).
  // b-grid: same spans, but offset by half a row so the two together cover all hex centers.
  vec2 aId = floor(vec2(
    (p.x * HEX_F.y - p.y * HEX_F.x) / (HEX_E.x * HEX_F.y - HEX_E.y * HEX_F.x),
    (HEX_E.x * p.y - HEX_E.y * p.x) / (HEX_E.x * HEX_F.y - HEX_E.y * HEX_F.x)
  ));
  // Try four neighbouring lattice cells and pick whichever center is closest.
  // (Hex centers occur at integer combos of HEX_E and HEX_F, plus half-offsets.)
  vec2 bestC = vec2(1e9);
  float bestD = 1e9;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 id = aId + vec2(float(i), float(j));
      vec2 c = id.x * HEX_E + id.y * HEX_F;
      vec2 d = p - c;
      float dd = dot(d, d);
      if (dd < bestD) { bestD = dd; bestC = c; }
    }
  }
  return vec4(p - bestC, bestC);
}

// Distance to a regular hexagon edge from its center, oriented pointy-top.
// Returns signed distance: negative inside, zero on edge.
float hexEdgeSDF(vec2 p) {
  p = abs(p);
  // Edges of a pointy-top hex of circumradius 1: width = sqrt(3)/2 across flats.
  // Standard hex SDF (flat-top); rotate input 30° to convert orientation.
  vec2 q = vec2(p.y, p.x); // swap to flat-top
  float d = max(dot(q, vec2(0.8660254, 0.5)), q.y) - 0.8660254;
  return d;
}

// ---- Drifting void field ---------------------------------------------------
// Five voids wander through world space on independent slow paths. Each void
// is a hex-shaped dark crater with a beveled rim. Returns:
//   x: 1.0 deep inside any void's core (pure black region).
//   y: 0..1 rim factor near the void edge (for the beveled gray ring).

vec2 voidField(vec2 worldPos, float t) {
  float core = 0.0;
  float rim  = 0.0;

  // Bass pulse — voids breathe in unison but each with a phase offset so the
  // breathing reads as wandering swells, not a single global throb.
  float bassP = smoothstep(0.0, 1.0, u_bass);

  // 5 voids — small enough cap to stay performant, large enough to feel scattered.
  // Each iteration is a unique constant index so the loop unrolls cleanly.
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    // Distinct slow path per void. Non-commensurate frequencies → never repeats.
    vec2 path = vec2(
      4.5 * sin(t * (0.07 + 0.013 * fk) + fk * 1.7),
      3.2 * cos(t * (0.05 + 0.017 * fk) + fk * 2.3)
    );
    // Static seed offsets so voids don't all pile near the origin at t=0.
    vec2 seed = vec2(
      6.0 * cos(fk * 2.11),
      6.0 * sin(fk * 1.73)
    );
    vec2 c = path + seed;

    // Per-void breathing radius. Base radius varies per void so they don't
    // look like clones. Bass kicks the radius outward; phase offset per void.
    float phase = fk * 0.9;
    float baseR = 1.6 + 0.5 * sin(t * 0.3 + phase);
    float r = baseR + 1.4 * bassP * (0.6 + 0.4 * sin(t * 1.5 + phase));

    // Distance to this void center, measured against a hex-shape so the void
    // itself reads as a hexagonal crater (matches the underlying tiling).
    vec2 d = (worldPos - c) / r;
    float hd = hexEdgeSDF(d); // negative inside

    // Core: well inside the hex crater.
    float thisCore = smoothstep(0.0, -0.18, hd);
    // Rim: a beveled ring at the edge of the crater.
    float thisRim  = smoothstep(0.22, 0.0, abs(hd + 0.05));

    core = max(core, thisCore);
    rim  = max(rim,  thisRim * (1.0 - thisCore));
  }

  return vec2(core, rim);
}

// ---- Hatched-pyramid shading ----------------------------------------------
// Given a hex cell's local coord (origin at center), produce the
// black-and-white hatched value of a faceted pyramid drawn from above.
//
// The hex is divided into 6 triangular faces (slices) by angle. Each slice
// has its own stripe direction (rotated 60° per slice) and a slight tonal
// offset that simulates light from one direction, so opposite faces look
// "lit" vs "shadowed".

float hatchedPyramid(vec2 local, float stripeFreq, float tFlow, float trebleJit) {
  // Polar within the hex cell.
  float r = length(local);
  float a = atan(local.y, local.x);

  // Slice index 0..5. Add a tiny rotation offset so a face edge doesn't sit
  // exactly on the +x axis (cleaner look as the field rotates).
  float slice = floor((a + PI) / (TAU / 6.0));
  // Center angle of this slice — used to orient stripes per face.
  float sliceCenter = -PI + (slice + 0.5) * (TAU / 6.0);

  // Each face's stripe direction: rotate by sliceCenter + a global twist so
  // that adjacent faces clearly hatch in different directions. The +PI/2
  // makes stripes run *along* the face (parallel to the outer edge of that
  // triangle), which reads as "shaded" rather than radial spokes.
  float dir = sliceCenter + PI * 0.5;

  // Project the local position onto the perpendicular of the stripe direction
  // so isolines of `proj` are the stripes themselves.
  vec2 nrm = vec2(cos(dir), sin(dir));
  float proj = dot(local, nrm);

  // Treble shimmer — perturb stripe spacing very slightly per pixel via a
  // smooth function so it's clearly a shimmer, not noise hash.
  float shimmer = trebleJit * 0.06 * sin(local.x * 9.0 + local.y * 7.0 + tFlow * 4.0);
  proj += shimmer;

  // Stripes: use a triangle wave so we get sharp, anti-aliasable edges.
  // freq is the number of stripe pairs per unit hex-radius.
  float s = proj * stripeFreq;
  float tri = abs(fract(s) - 0.5) * 2.0;       // 0..1 triangle wave

  // Anti-alias: the local rate of change of `s` per pixel sets the smoothing
  // width. fwidth approximates that.
  float w = fwidth(s) * 1.2;
  // Convert tri wave to a black/white stripe with anti-aliased edges.
  // Threshold at 0.5 — half of each cycle is "ink", half is "paper".
  float stripe = smoothstep(0.5 - w, 0.5 + w, tri);

  // Per-face tonal bias — fakes directional lighting on the pyramid's facets.
  // Faces whose normal points toward the imaginary light are paler (less ink),
  // away faces are darker (more ink). Light direction rotates very slowly.
  float lightAng = tFlow * 0.15;
  vec2 lightDir = vec2(cos(lightAng), sin(lightAng));
  // Outward normal of this face — points away from cell center, midway across
  // the slice.
  vec2 faceN = vec2(cos(sliceCenter), sin(sliceCenter));
  float lit = dot(faceN, lightDir);            // -1..1
  // Bias the stripe value: lit faces stay closer to white, shadowed faces
  // closer to black. Keep the bias modest so stripes still read everywhere.
  float litBias = 0.18 * lit;

  float ink = 1.0 - stripe;                    // 1 where stripe is dark
  ink = clamp(ink + (-litBias), 0.0, 1.0);     // shadow side gets more ink
  // Final cell value: 1 = white paper, 0 = full ink.
  float cellVal = 1.0 - ink;

  // Cell rim: thin dark hex outline so each pyramid sits in its own footprint
  // (the original etching has visible cell boundaries between pyramids).
  float hd = hexEdgeSDF(local); // negative inside
  float rimW = fwidth(hd) * 1.5;
  float rim  = 1.0 - smoothstep(-0.04 - rimW, -0.04 + rimW, hd);
  cellVal *= 1.0 - 0.85 * rim;

  // Inner ridge highlight — a faint white spot near the apex of the pyramid
  // (the meeting point of all 6 faces) sells the 3D pop.
  float apex = smoothstep(0.18, 0.0, r);
  cellVal = mix(cellVal, 1.0, apex * 0.35);

  // Spoke shadows along face edges — the ridges between facets read as fine
  // dark lines in the reference. Boundaries between the 6 slices lie at
  // angles where sin(3a)=0, so |sin(3a)| is a smooth proxy for "distance to
  // the nearest spoke" with no fract() discontinuities.
  float spokeMetric = abs(sin(3.0 * a));            // 0 at spokes, 1 between
  float spokeW = fwidth(spokeMetric) * 1.5 + 0.01;
  float spoke  = 1.0 - smoothstep(0.0, spokeW, spokeMetric - 0.005);
  // Suppress spokes near the apex (where r→0, atan is unstable) and near the
  // outer rim (where they'd merge with the rim line into corner blobs).
  spoke *= smoothstep(0.07, 0.25, r);
  spoke *= smoothstep(0.05, 0.4, -hd);
  cellVal *= 1.0 - 0.65 * spoke;

  return cellVal;
}

void main() {
  // Aspect-correct, centered UV. Y in canvas units so hex grid stays regular.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Slow whole-field drift + rotation ---------------------------------
  // Always-on motion so quiet music isn't a static print. Mid frequencies
  // nudge the rotation rate gently (musical sway) but never reverse it.
  float t  = u_time;
  float rotRate = 0.025 + 0.015 * smoothstep(0.0, 1.0, u_mid);
  float ang = t * rotRate;
  vec2 drift = vec2(0.18, 0.10) * t;

  // World-space coords: rotate the screen, then push along the drift, then
  // scale into hex-grid units. The scale sets pyramid density on screen.
  float hexScale = 5.5; // ≈5.5 hex radii across half-screen
  vec2 worldPos = (rot2d(ang) * uv) * hexScale + drift;

  // Cell lookup.
  vec4 cell = hexCell(worldPos);
  vec2 local = cell.xy;
  vec2 center = cell.zw;

  // Per-cell variation: tiny random per-cell phase so adjacent pyramids
  // don't all hatch in lock-step (hand-drawn feel).
  float cellHash = hash21(floor(center * 13.0));
  float cellTwist = (cellHash - 0.5) * 0.25;  // rotate stripe dir slightly per cell
  // Apply by rotating local coords for stripe sampling only.
  vec2 stripeLocal = rot2d(cellTwist) * local;

  // Stripe density. Slight breathe with treble; clamp so it never thins out
  // to invisibility or turns into moire.
  float trebleP = smoothstep(0.0, 1.0, u_treble);
  float stripeFreq = 4.5 + 1.8 * trebleP;

  float cellVal = hatchedPyramid(stripeLocal, stripeFreq, t, trebleP);

  // ---- Voids (bass-pulsing dark holes) -----------------------------------
  // Sample in the same world space the cells live in, so voids sit ON the
  // tiling, not on top in screen space.
  vec2 vf = voidField(worldPos, t);
  float voidCore = vf.x;
  float voidRim  = vf.y;

  // Inside a void: the cell's stripes fade to black (pure dark).
  // On the rim: a mid-gray bevel that suggests a depressed crater wall.
  float bevel = voidRim * (0.55 + 0.20 * sin(voidRim * PI));
  float v = mix(cellVal, 0.0, voidCore);          // black core
  v = mix(v, bevel, voidRim * (1.0 - voidCore));  // gray bevel on rim

  // ---- Global tone shaping ------------------------------------------------
  // Bass slightly increases ink contrast so a hit reads as the whole etching
  // sharpening, not as bands of color.
  float bassP = smoothstep(0.0, 1.0, u_bass);
  float contrast = 1.0 + 0.35 * bassP;
  v = clamp(0.5 + (v - 0.5) * contrast, 0.0, 1.0);

  // Soft paper tint: keep strict monochrome but add a barely-perceptible
  // off-white so pure-white regions don't feel like a lit screen. Subtle.
  vec3 paper = vec3(0.96, 0.95, 0.93);
  vec3 ink   = vec3(0.02, 0.02, 0.025);
  vec3 col   = mix(ink, paper, v);

  // Vignette toward near-black so the etched field reads as a printed plate
  // floating against a void edge.
  float vig = smoothstep(1.30, 0.30, length(uv));
  col = mix(ink, col, vig);

  // Reinhard tone — paper never blows out on bass spikes.
  col = col / (1.0 + 0.4 * col);

  outColor = vec4(col, 1.0);
}
