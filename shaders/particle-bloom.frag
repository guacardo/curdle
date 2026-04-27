// particle-bloom: spatial spectrum analyzer made of soft glowing dots.
// - 32 particles on two counter-rotating rings (inner = bass, outer = treble).
// - Each particle's frequency bin is fixed by its index, so it always represents
//   the same band — the visual stays legible like a polar EQ display.
// - Brightness AND radius scale with sampleFFT() at that band.
// - Additive accumulation gives the bloom feel; a soft tonemap tames spikes.

const int N_PER_RING = 16;
const int N_TOTAL    = 32;

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

  // Faint radial haze pumped by overall volume — gives the "atmosphere"
  // around the dots without washing them out.
  float haze = exp(-length(uv) * 1.6) * (0.04 + 0.18 * u_volume);
  col += haze * vec3(0.35, 0.30, 0.55);

  // Bass kicks a brief warm wash at the center.
  float core = exp(-dot(uv, uv) * 6.0) * u_bass * 0.6;
  col += core * vec3(1.00, 0.55, 0.30);

  // Soft vignette.
  float vig = smoothstep(1.25, 0.25, length(uv));
  col *= vig;

  // Reinhard-ish tonemap: keep additive sums from clipping to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
