// particle-bloom: spatial spectrum analyzer made of soft glowing dots.
// - 32 particles on two counter-rotating rings (inner = bass, outer = treble).
// - Each particle's frequency bin is fixed by its index, so it always represents
//   the same band — the visual stays legible like a polar EQ display.
// - Brightness AND radius scale with sampleFFT() at that band.
// - Additive accumulation gives the bloom feel; a soft tonemap tames spikes.

const int N_PER_RING = 16;
const int N_TOTAL    = 32;

// Electron rings: three concentric outer rings of small, transient-driven
// particles. Each ring samples a narrower, higher band than the previous.
const int N_PER_ERING = 18;
const int N_ERINGS    = 3;
const int N_ETOTAL    = 54; // N_PER_ERING * N_ERINGS

// One "electron" particle. Same idea as particle() but driven by transient
// energy (now minus a windowed past mean) so it flashes on attacks and dies
// fast instead of glowing through sustained treble.
vec3 electron(vec2 p, int idx, float t) {
  int ring = idx / N_PER_ERING;             // 0,1,2 (inner -> outer of the new set)
  int slot = idx - ring * N_PER_ERING;
  float fring = float(ring);

  // Frequency band per ring: each one narrower and higher than the last.
  // ring 0 -> upper-treble (0.55..0.75)
  // ring 1 -> top-treble   (0.75..0.90)
  // ring 2 -> very highest (0.90..1.00)
  float bandLo, bandHi;
  if (ring == 0)      { bandLo = 0.55; bandHi = 0.75; }
  else if (ring == 1) { bandLo = 0.75; bandHi = 0.90; }
  else                { bandLo = 0.90; bandHi = 1.00; }
  float freq = bandLo + (bandHi - bandLo) * (float(slot) + 0.5) / float(N_PER_ERING);

  // Transient detector: instantaneous energy minus a short windowed mean of
  // the recent past. Negative values clamped to zero — we only want attacks.
  float now = sampleFFT(freq);
  float past = (
      sampleFFTHistory(freq, 0.10) +
      sampleFFTHistory(freq, 0.20) +
      sampleFFTHistory(freq, 0.35) +
      sampleFFTHistory(freq, 0.55)
  ) * 0.25;
  float transient = max(now - past * 0.85, 0.0);
  // Sharpen: pow(.,0.5) to make small attacks pop, then a soft threshold
  // so quiet treble stays dark and real hits BURST.
  float excite = smoothstep(0.04, 0.35, pow(transient, 0.5));

  // Ring radii: progressively larger; outermost reaches near screen edges.
  // Min screen half-extent in our normalized coords is 0.5.
  float baseR = 0.72 + 0.13 * fring;        // 0.72, 0.85, 0.98

  // Radial bounce — outer rings oscillate faster ("electrons orbit faster").
  // Per-particle phase keeps them out of unison.
  float bounceFreq = 2.2 + 1.8 * fring;
  float phase      = float(slot) * 1.913 + fring * 2.7;
  float bounce     = 0.018 * sin(t * bounceFreq + phase);
  // Attack momentarily kicks the particle outward a bit too.
  float radius = baseR + bounce + 0.025 * excite;

  // Counter-rotate by ring so adjacent rings don't shear together; very slow
  // base spin that picks up with treble (these are the "fast" guys).
  float dir  = (ring == 1) ? -1.0 : 1.0;
  float spin = t * (0.22 + 0.45 * u_treble) * dir;
  float ang  = TAU * (float(slot) + 0.5) / float(N_PER_ERING) + spin
             + fring * (PI / float(N_PER_ERING)); // stagger per ring

  vec2 center = radius * vec2(cos(ang), sin(ang));

  // Tiny particles — ~0.35x the existing outer ring's nominal size.
  // Size grows a little with excite so flashes are also visually larger.
  float size = 0.0095 + 0.018 * excite;
  float k = 1.0 / max(size * size, 1e-5);

  vec2 d = p - center;
  float r2 = dot(d, d);
  float fall = exp(-r2 * k);

  // Icy palette — pale cyans, electric violets, whites.
  // Parameterize by ring + slight time drift so colors shimmer.
  float cT = 0.55 + 0.12 * fring + 0.04 * t + 0.03 * float(slot);
  vec3 col = palette(
    cT,
    vec3(0.85, 0.90, 1.00),  // bright cool base
    vec3(0.20, 0.25, 0.35),  // gentle chroma swing
    vec3(1.00, 1.00, 1.20),  // freq triplet (violet drifts faster)
    vec3(0.20, 0.30, 0.55)   // phase: pushes toward cyan/violet
  );

  // Brightness: dominated by the transient. Tiny idle so the rings are
  // hinted-at when totally silent (not strictly required, but reads nicer).
  float idle  = 0.015 + 0.010 * sin(t * 2.1 + float(idx) * 0.31);
  float bright = idle + 3.6 * excite * excite;

  return col * fall * bright;
}

// One particle's contribution at screen-space point p.
// idx encodes both ring assignment and angular slot.
vec3 particle(vec2 p, int idx, float t) {
  // Split into ring (0 = inner/bass, 1 = outer/treble) and slot.
  int ring = idx / N_PER_RING;
  int slot = idx - ring * N_PER_RING;

  // Each ring rotates the opposite direction; speed eases with audio so
  // there's always motion, but the field "breathes" with volume.
  float dir = (ring == 0) ? 1.0 : -1.0;
  float spin = t * (0.18 + 0.10 * u_volume) * dir;

  // Inner ring sits closer; outer ring further out. Wobble per-particle
  // so they don't look like a perfect compass rose.
  float baseR = (ring == 0) ? 0.30 : 0.55;
  float wobble = 0.020 * sin(t * 0.9 + float(slot) * 1.7);
  float radius = baseR + wobble;

  // Angular position of this slot.
  float ang = TAU * (float(slot) + 0.5) / float(N_PER_RING) + spin;
  // Stagger the outer ring by half a slot so they don't overlap radially.
  if (ring == 1) ang += PI / float(N_PER_RING);

  vec2 center = radius * vec2(cos(ang), sin(ang));

  // Frequency bin assignment: inner ring covers low half, outer covers high
  // half. A small offset keeps bin 0 (DC) out of play.
  float freq;
  if (ring == 0) {
    freq = 0.02 + 0.40 * (float(slot) + 0.5) / float(N_PER_RING);
  } else {
    freq = 0.45 + 0.55 * (float(slot) + 0.5) / float(N_PER_RING);
  }
  float amp = sampleFFT(freq);

  // Idle pulse so silent particles still shimmer.
  float idle = 0.05 + 0.03 * sin(t * 1.4 + float(idx) * 0.7);
  float energy = amp + idle;

  // Size grows with energy, and bass particles are inherently bigger.
  // Smaller k => fatter falloff. We invert: bigger size => smaller k.
  float sizeBoost = (ring == 0) ? 1.6 : 1.0;
  float size = (0.025 + 0.060 * energy) * sizeBoost;
  float k = 1.0 / max(size * size, 1e-5);

  vec2 d = p - center;
  float r2 = dot(d, d);
  // Soft Gaussian-ish falloff — the classic bloom dot.
  float fall = exp(-r2 * k);

  // Color: bass = warm (orange/red), treble = cool (cyan/violet).
  // Use the IQ palette parameterized by the particle's normalized frequency
  // so neighbors blend smoothly.
  vec3 col = palette(
    freq * 0.85 + 0.05 * t,
    vec3(0.50, 0.40, 0.55),
    vec3(0.50, 0.45, 0.50),
    vec3(1.00, 1.00, 1.00),
    vec3(0.10, 0.35, 0.70)
  );

  // Brightness scales superlinearly with energy so peaks really pop.
  float bright = 0.25 + 2.2 * energy * energy;

  return col * fall * bright;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  float t = u_time;

  // Slow global rotation of the whole pattern so the geometry isn't static
  // even when both rings happen to align.
  uv = rot2d(t * 0.05) * uv;

  // Additive bloom accumulation across all particles.
  vec3 col = vec3(0.0);
  for (int i = 0; i < N_TOTAL; i++) {
    col += particle(uv, i, t);
  }

  // Electron rings — added on top, additive. Tiny, transient-driven, cool.
  for (int i = 0; i < N_ETOTAL; i++) {
    col += electron(uv, i, t);
  }

  // Faint radial haze pumped by overall volume — gives the "atmosphere"
  // around the dots without washing them out.
  float haze = exp(-length(uv) * 1.6) * (0.04 + 0.18 * u_volume);
  col += haze * vec3(0.35, 0.30, 0.55);

  // Bass kicks a brief warm wash at the center.
  float core = exp(-dot(uv, uv) * 6.0) * u_bass * 0.6;
  col += core * vec3(1.00, 0.55, 0.30);

  // Soft vignette — pushed further out so the outer electron ring can still
  // punch through near the edges/corners on transient hits.
  float vig = smoothstep(1.55, 0.30, length(uv));
  col *= vig;

  // Reinhard-ish tonemap: keep additive sums from clipping to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
