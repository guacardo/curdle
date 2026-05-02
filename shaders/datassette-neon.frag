// datassette-neon: a neon constellation of 8 drifting nodes woven together
// by a dense triangulated lattice (24 edges) that fires asynchronously like
// a synaptic circuit. Inspired by the Datassette "Homes For Waifs 165"
// Spotify Canvas — same node-graph composition, recolored into Curdle's
// rotating triad and pumped to react harder to audio.
//
// Construction:
//   - 8 hand-placed *base* node positions form a loose constellation. Each
//     node slowly drifts around its base on two uncorrelated lissajous-like
//     axes (different period/phase per node) so the lattice subtly breathes
//     and reshapes itself over time without any node visibly jumping.
//   - Per node: hashes to a triad hue selector, a phase offset, and an FFT
//     bin assignment so the graph behaves like a frequency-driven equalizer.
//   - Per node activation: baseline + (sin^n) periodic peak + FFT bin gate
//     + bass-triggered global firing. Multiple bloom radii stacked for the
//     neon-tube halo.
//   - 24 hand-picked edges forming a dense Delaunay-ish triangulation —
//     mostly short-range neighbors (4–6 connections per node) with a few
//     long cross-frame wires for visual interest. Edges recompute geometry
//     each frame from the moving endpoints. Each edge: thin core line +
//     soft halo, brightness scales with the *average* activation of the two
//     endpoints. Traveling bead animates when both endpoints are firing.
//   - Background: deep near-black tinted with the cooler triad slot, plus
//     subtle slowly-drifting FBM haze (low contrast, never competes).
//
// Audio:
//   - Bass: triggers the global firing pulse — fast attack, slow decay —
//     that briefly lights every node. Bass also widens bloom radii.
//   - Mid: scales edge core/halo brightness — louder mids = thicker wires.
//   - Treble: per-edge shimmer (sparkle dots traveling along the wire).
//   - FFT bins: each node watches its own bin; loud bins keep that node's
//     baseline elevated even between periodic pulses.

// ---------- distance helpers ----------

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// Same as sdSeg but also returns the t-along-segment of the nearest point.
vec2 sdSegT(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return vec2(length(pa - ba * h), h);
}

// ---------- node table ----------
// Eight constellation *base* positions in screen-units (aspect-correct UV
// space, short axis = 1.0). Picked by hand so they read as a sparse,
// slightly triangulated graph — not a regular grid.
vec2 nodeBase(int i) {
  if (i == 0) return vec2(-0.62, -0.28);
  if (i == 1) return vec2(-0.34,  0.30);
  if (i == 2) return vec2(-0.05, -0.05);
  if (i == 3) return vec2( 0.22,  0.34);
  if (i == 4) return vec2( 0.55, -0.10);
  if (i == 5) return vec2( 0.40, -0.42);
  if (i == 6) return vec2(-0.18, -0.42);
  return            vec2( 0.70,  0.30);  // i == 7
}

// Compute the *current* drifted node position. Each node oscillates on two
// uncorrelated axes (sin x, cos y) with hash-derived amplitudes (~0.05–0.09)
// and slow periods (~8–22s). The motion is below the threshold of obvious
// per-frame movement but the lattice as a whole reshapes over time.
vec2 nodePos(int i) {
  vec2 base = nodeBase(i);
  float fi = float(i);
  // Per-node hashes for amplitudes, phases, and periods.
  float h0 = hash21(vec2(fi, 9.13));
  float h1 = hash21(vec2(fi * 2.71, 1.41));
  float h2 = hash21(vec2(fi * 5.19, 6.28));
  float h3 = hash21(vec2(fi * 0.77, 3.14));
  // Amplitudes ~0.05–0.09 so neighboring nodes never collide.
  vec2 amp = vec2(0.05 + 0.04 * h0, 0.05 + 0.04 * h1);
  // Periods 8–22s → angular rate TAU/period.
  vec2 period = vec2(mix(8.0, 22.0, h2), mix(9.0, 25.0, h3));
  vec2 rate = TAU / period;
  vec2 phase = vec2(h0, h1) * TAU;
  return base + amp * vec2(
    sin(u_time * rate.x + phase.x),
    cos(u_time * rate.y + phase.y)
  );
}

// Compute a node's *current activation* in [0, ~1.5]. This is the value the
// edges and bloom both consume — keep it cheap, no per-pixel branching.
float nodeActivation(int i, float bassFire) {
  float fi = float(i);
  float h = hash21(vec2(fi, 0.137));
  float h2 = hash21(vec2(fi * 1.71, 4.2));
  // Each node listens to its own FFT bin, spread across the spectrum.
  float bin = (fi + 0.5) / 8.0;
  float fftE = sampleFFT(mix(0.05, 0.85, bin));
  // Asynchronous periodic pulse — different rates per node so the graph
  // fires out of phase, like neurons.
  float rate = mix(0.45, 1.10, h);          // Hz-ish
  float phase = h2 * TAU;
  // sin^8 -> sharp peak with long quiet between firings.
  float s = sin(u_time * rate * TAU + phase) * 0.5 + 0.5;
  float pulse = pow(s, 8.0);
  // Baseline so even quiet nodes are faintly visible.
  float baseline = 0.18;
  // Bass globally lights the constellation but each node responds with a
  // hash-jittered weight so the kick reads as the graph "going off" rather
  // than every node lighting identically.
  float bassWeight = 0.45 + 0.55 * h2;
  return baseline
       + 0.95 * pulse
       + 1.40 * fftE
       + 1.10 * bassFire * bassWeight;
}

// ---------- edge table ----------
// 24 hand-picked edges forming a Delaunay-ish triangulation of the 8 base
// positions. Most edges connect each node to its 3–5 nearest neighbors;
// a few longer cross-frame edges (0-5, 0-7, 1-7, 6-4, 2-7) keep the lattice
// from feeling locally clustered. Average degree ≈ 6, with visible
// triangulated cells covering the whole frame.
//
// Why the if-chain: keeps the table self-contained without globals; the
// compiler unrolls it cheaply since the loop bound is constant.
#define EDGE_COUNT 24
void edgeNodes(int e, out int a, out int b) {
  if      (e ==  0) { a = 0; b = 1; }
  else if (e ==  1) { a = 0; b = 6; }
  else if (e ==  2) { a = 0; b = 2; }
  else if (e ==  3) { a = 1; b = 2; }
  else if (e ==  4) { a = 1; b = 3; }
  else if (e ==  5) { a = 2; b = 3; }
  else if (e ==  6) { a = 2; b = 5; }
  else if (e ==  7) { a = 2; b = 6; }
  else if (e ==  8) { a = 3; b = 4; }
  else if (e ==  9) { a = 3; b = 7; }
  else if (e == 10) { a = 4; b = 5; }
  else if (e == 11) { a = 4; b = 7; }
  // --- denser triangulation ---
  else if (e == 12) { a = 1; b = 7; } // top sweep
  else if (e == 13) { a = 5; b = 6; } // bottom edge
  else if (e == 14) { a = 0; b = 5; } // long lower diagonal
  else if (e == 15) { a = 3; b = 6; } // upper to lower-left cross
  else if (e == 16) { a = 2; b = 4; } // center to right
  else if (e == 17) { a = 2; b = 7; } // center to far-right-top
  else if (e == 18) { a = 1; b = 6; } // left column
  else if (e == 19) { a = 4; b = 6; } // long lower sweep
  else if (e == 20) { a = 5; b = 7; } // right column
  else if (e == 21) { a = 0; b = 3; } // long upper diagonal
  else if (e == 22) { a = 3; b = 5; } // mid-right vertical
  else              { a = 0; b = 7; } // longest cross-frame
}

// ---------- main ----------

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // Bass firing envelope: fast attack, slower decay. Power-curve the bass so
  // soft kicks don't trigger a global flash.
  float bassFire = pow(clamp(u_bass, 0.0, 1.0), 1.6);

  // Triad base hue — shared with the rest of the visualizer.
  float baseHue = triadHue(0.12);

  // ---------- pre-compute node state ----------
  // We need each node's *drifted* position, color, and activation in BOTH
  // the bloom pass and the edge pass — collect them ONCE here so the
  // per-pixel inner loops just read from arrays.
  vec2  pos[8];
  vec3  col_[8];
  float act[8];
  // Unroll — fixed bound, cheap.
  for (int i = 0; i < 8; i++) {
    pos[i] = nodePos(i);
    float fi = float(i);
    float hueSel = hash21(vec2(fi * 3.31, 7.7));
    // Sat slightly varied per node, lit kept in the bright-but-not-blown range.
    col_[i] = triadPickHard(hueSel, baseHue, 0.95, 0.55, 0.05);
    act[i] = nodeActivation(i, bassFire);
  }

  // ---------- background ----------
  // Deep near-black with a faint cool-triad wash so the void isn't totally
  // dead. FBM haze drifts very slowly — readable but never competing.
  vec3 voidTint = triadPickHard(0.05, baseHue, 0.55, 0.10, 0.05);
  float haze = fbm(uv * 1.4 + vec2(u_time * 0.04, u_time * 0.025));
  vec3 col = voidTint * (0.35 + 0.55 * haze);
  // Knock the background way down — these are the "paper" replacement.
  col *= 0.18;

  // ---------- edge pass ----------
  // For each edge: a thin bright core + a soft halo, scaled by the average
  // activation of the two endpoints. Plus a traveling bead when both ends
  // are firing, plus a treble shimmer band.
  vec3 edgeAccum = vec3(0.0);

  // Mid widens the wires; bass widens halos.
  float midBoost  = 0.7 + 1.1 * u_mid;
  float haloBoost = 1.0 + 0.9 * bassFire;

  for (int e = 0; e < EDGE_COUNT; e++) {
    int ia, ib;
    edgeNodes(e, ia, ib);
    vec2 a = pos[ia];
    vec2 b = pos[ib];
    vec2 dt = sdSegT(uv, a, b);
    float d = dt.x;
    float t = dt.y;

    // Endpoint activations — average for steady glow, min for the bead so
    // the bead only travels when *both* ends are alive.
    float aA = act[ia];
    float aB = act[ib];
    float aAvg = 0.5 * (aA + aB);
    float aMin = min(aA, aB);

    // Hue: mix the two endpoint colors along the wire so each edge fades
    // chromatically between its ends.
    vec3 wireHue = mix(col_[ia], col_[ib], smoothstep(0.0, 1.0, t));

    // Core line — narrow, bright. Width gently breathes with the average
    // activation so a hot edge looks thicker.
    float coreW = 0.0020 + 0.0035 * aAvg;
    float core  = smoothstep(coreW + 0.0015, 0.0, d);

    // Outer halo — soft 1/(d^2)-ish falloff. Width grows with bass.
    // Halo radius trimmed slightly vs. the 12-edge version since 24 edges
    // accumulate twice as much glow — keeps the frame from washing out.
    float haloR = 0.038 * haloBoost;
    float halo  = pow(max(0.0, 1.0 - d / haloR), 2.5);

    // Both pieces gated by activation — edges are dim baseline, hot when lit.
    // Gate scaled down a touch so the denser lattice doesn't blow out.
    float gate = 0.16 + 1.10 * aAvg;
    edgeAccum += wireHue * core * gate * (0.9 + 0.6 * midBoost);
    edgeAccum += wireHue * halo * gate * 0.42 * midBoost;

    // Traveling bead — fires only when *both* endpoints are lit. Bead position
    // moves at a per-edge phase + speed; we draw a bright Gaussian centered on
    // (a + bead*(b-a)) using the projected-t coordinate.
    float fe = float(e);
    float bedSpeed = 0.45 + 0.6 * hash21(vec2(fe, 11.7));
    // Direction flips per-edge so the network doesn't all flow one way.
    float dir = (hash21(vec2(fe, 3.1)) > 0.5) ? 1.0 : -1.0;
    float bedT = fract(u_time * bedSpeed * dir + hash21(vec2(fe, 0.5)));
    float along = abs(t - bedT);
    along = min(along, 1.0 - along); // wrap-aware distance along edge in [0, 0.5]
    // Combine along-edge and perpendicular distance for a bead with size in
    // both dimensions. d is in screen units so this stays aspect-correct.
    float bead = exp(-((along * along) * 900.0 + (d * d) * 12000.0));
    float bothLit = smoothstep(0.45, 1.10, aMin);
    edgeAccum += mix(wireHue, vec3(1.0), 0.4) * bead * bothLit * 1.3;

    // Treble shimmer — a few sparkle dots scattered along the wire that pop
    // on treble peaks. Cheap: hash the (edge, time-slot) and gate with treble.
    float slot = floor(u_time * 9.0);
    float spark = hash21(vec2(fe * 13.7 + slot, 2.1));
    float sparkT = hash21(vec2(fe * 5.3 + slot, 7.7));
    float sparkAlong = abs(t - sparkT);
    sparkAlong = min(sparkAlong, 1.0 - sparkAlong);
    float sparkBlob = exp(-((sparkAlong * sparkAlong) * 4000.0 + (d * d) * 30000.0));
    float sparkGate = step(0.82, spark) * u_treble * (0.4 + 0.8 * aAvg);
    edgeAccum += vec3(1.0) * sparkBlob * sparkGate * 1.6;
  }

  col += edgeAccum;

  // ---------- node bloom pass ----------
  // Stacked radii: a tiny blown-out core, a mid bloom, and a wide outer halo.
  // Each node's contribution scales with its activation, so the constellation
  // breathes with the music.
  vec3 bloomAccum = vec3(0.0);

  for (int i = 0; i < 8; i++) {
    vec2 d2 = uv - pos[i];
    float r = length(d2);
    float a = act[i];

    // Inner hot core — small, near-white at peak activation.
    float coreR = 0.012 + 0.010 * a;
    float coreI = exp(-pow(r / coreR, 2.0));
    vec3 coreCol = mix(col_[i], vec3(1.0), 0.55 * smoothstep(0.5, 1.4, a));

    // Mid bloom — the node's own hue.
    float midR = 0.055 + 0.045 * a + 0.03 * bassFire;
    float midI = exp(-pow(r / midR, 1.6));

    // Outer wide halo — long soft falloff for the neon-tube look.
    float farR = 0.20 + 0.10 * a + 0.06 * bassFire;
    float farI = pow(max(0.0, 1.0 - r / farR), 2.4);

    bloomAccum += coreCol * coreI * (0.9 + 1.8 * a);
    bloomAccum += col_[i] * midI  * (0.55 + 1.4 * a);
    bloomAccum += col_[i] * farI  * (0.30 + 0.9 * a) * 0.6;
  }

  col += bloomAccum;

  // ---------- finishing ----------
  // Vignette toward the void — keeps the constellation sitting in space.
  float vig = smoothstep(1.20, 0.25, length(uv));
  col *= mix(0.55, 1.05, vig);

  // Subtle global lift on bass so the kick reads even where no node is firing.
  col *= 1.0 + 0.10 * bassFire;

  // Tonemap — exp curve preserves chroma at the bright peaks and prevents
  // bass-firing the whole constellation from clipping to white. Slightly
  // more aggressive than the 12-edge version since the denser lattice
  // contributes more total brightness at peak.
  col = vec3(1.0) - exp(-col * 1.05);

  outColor = vec4(col, 1.0);
}
