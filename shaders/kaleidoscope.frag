// kaleidoscope: spinning stained glass with N-fold radial symmetry.
// - Fold UVs into one wedge (6 sectors), draw a rich fbm/swirl pattern, mirror around.
// - Bass pumps overall brightness/saturation (the "lamp" behind the glass).
// - Treble jitters the fold angle so high-frequency content fragments the symmetry.

#define SECTORS 6.0

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  float t = u_time * 0.12;

  // Slow whole-disc rotation so the glass is alive when audio is quiet.
  uv = rot2d(t) * uv;

  // Polar coords. We add a treble-driven jitter to the angle BEFORE folding
  // so high frequencies actually shatter the symmetry instead of just shaking it.
  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Per-radius hash gives the jitter a "shard" structure rather than a uniform wobble.
  float shard = hash21(vec2(floor(r * 18.0), floor(t * 4.0)));
  float jitter = (shard - 0.5) * u_treble * 1.6;
  a += jitter;

  // Fold into a single wedge of width TAU/SECTORS, then mirror to keep continuity at seams.
  float wedge = TAU / SECTORS;
  a = mod(a, wedge);
  a = abs(a - 0.5 * wedge);

  // Back to cartesian inside the wedge.
  vec2 p = vec2(cos(a), sin(a)) * r;

  // --- Pattern inside the wedge -------------------------------------------------
  // Polar swirl: rotate by radius so strands curve like blown glass.
  vec2 sp = rot2d(r * 2.4 + t * 0.6) * p;

  // Domain-warped fbm builds the stained-glass "leading" and color cells.
  vec2 q = vec2(
    fbm(sp * 2.2 + vec2(0.0, t * 0.7)),
    fbm(sp * 2.2 + vec2(3.1, -t * 0.5))
  );
  float field = fbm(sp * 1.6 + 1.4 * q + vec2(0.0, t));

  // Cell edges: sharp dark "lead" lines between color panes.
  float edge = smoothstep(0.02, 0.0, abs(field - 0.5) - 0.02);

  // Radial spokes — a faint grid that reads as the kaleidoscope's mirrors.
  float spoke = smoothstep(0.015, 0.0, a);              // wedge boundary line
  float ring  = smoothstep(0.012, 0.0, abs(fract(r * 4.0) - 0.5) - 0.45); // soft rings

  // --- Color --------------------------------------------------------------------
  // IQ palette over the field; hue drifts with time and bass for a "lamp warming up" feel.
  vec3 col = palette(
    field + 0.25 * t + 0.35 * u_bass + 0.15 * r,
    vec3(0.55, 0.40, 0.55),
    vec3(0.45, 0.55, 0.50),
    vec3(1.00, 1.00, 1.00),
    vec3(0.10, 0.33, 0.67)
  );

  // FFT-tap per-radius adds chromatic tinting that tracks the music's spectrum.
  float spec = sampleFFT(clamp(r * 0.9, 0.05, 0.95));
  col += vec3(0.10, 0.06, 0.18) * spec;

  // Bass: pump brightness AND saturation by lifting away from grey.
  vec3 grey = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
  float sat = 1.0 + 1.2 * u_bass;
  col = mix(grey, col, sat);
  col *= 0.75 + 1.1 * u_bass;

  // Stained-glass "leading": dark seams between panes and along mirrors.
  col *= 1.0 - 0.85 * edge;
  col *= 1.0 - 0.55 * spoke;
  col += 0.06 * ring;

  // Soft vignette + circular mask so it reads as a disc, not a square.
  float vig = smoothstep(1.05, 0.15, r);
  col *= vig;

  // Reinhard-ish tonemap so bass spikes don't clip to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
