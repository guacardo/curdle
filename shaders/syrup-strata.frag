// syrup-strata: stacked sweeping bands that bend and re-bend like pouring honey.
// A low-frequency advected warp drives a quantized "altitude" field, so wide
// flat layers stay flat-looking while their boundaries undulate viscously.
// Color cycles smoothly through three palette modes:
//   0) Birds of Paradise — saturated tropical
//   1) Strong Neons      — CRT-glow primaries on near-black
//   2) Muted Naturals    — clay / mustard / tan / faded teal (the reference)
//
// Audio: subtle. Bass thickens the warp; mid sways the band slope; treble
// dusts a faint shimmer along the band boundaries.

// ---- Palette modes ---------------------------------------------------------
// Returns the color for band-index t∈[0,1] in palette `mode` (0,1,2).
// Each mode is a hand-picked 5-stop-ish ramp built around earth/neon/tropical
// vibes. Returned in linear-ish RGB; tonemapped at the end of main().

vec3 palBirds(float t) {
  // Hot magenta → vivid orange → gold → emerald → electric blue, cycling.
  // Built from an IQ cosine palette tuned for tropical saturation.
  return palette(
    t,
    vec3(0.55, 0.40, 0.55),   // mid bias — pinks/purples baseline
    vec3(0.55, 0.55, 0.55),   // wide swing → vivid
    vec3(1.00, 1.00, 1.00),   // each channel completes one cycle
    vec3(0.00, 0.33, 0.67)    // 120° offsets → rainbow spread
  );
}

vec3 palNeon(float t) {
  // Discrete-feeling neon ramp: cyan, magenta, yellow-green, purple, near-black.
  // Pick from a small set by binning t, then smooth-blend between neighbors so
  // boundaries are soft but each band still reads as one neon hue.
  vec3 c0 = vec3(0.05, 1.00, 1.00);   // neon cyan
  vec3 c1 = vec3(1.00, 0.10, 0.85);   // neon magenta
  vec3 c2 = vec3(0.80, 1.00, 0.05);   // neon yellow-green
  vec3 c3 = vec3(0.65, 0.10, 1.00);   // neon purple
  vec3 c4 = vec3(0.02, 0.02, 0.06);   // near-black gap

  float ft = fract(t) * 5.0;
  float i  = floor(ft);
  float f  = smoothstep(0.0, 1.0, fract(ft));

  vec3 a = c0, b = c1;
  if (i < 0.5)      { a = c0; b = c1; }
  else if (i < 1.5) { a = c1; b = c2; }
  else if (i < 2.5) { a = c2; b = c3; }
  else if (i < 3.5) { a = c3; b = c4; }
  else              { a = c4; b = c0; }
  return mix(a, b, f);
}

vec3 palNatural(float t) {
  // Reference-image palette: deep umber, clay red, burnt orange, mustard,
  // tan, faded teal. Stepped ramp with smooth interpolation between stops.
  vec3 c0 = vec3(0.10, 0.07, 0.06);   // deep umber / near-black
  vec3 c1 = vec3(0.42, 0.10, 0.08);   // clay red
  vec3 c2 = vec3(0.78, 0.32, 0.12);   // burnt orange
  vec3 c3 = vec3(0.82, 0.60, 0.22);   // mustard
  vec3 c4 = vec3(0.78, 0.66, 0.45);   // tan
  vec3 c5 = vec3(0.18, 0.42, 0.40);   // faded teal accent

  float ft = fract(t) * 6.0;
  float i  = floor(ft);
  float f  = smoothstep(0.0, 1.0, fract(ft));

  vec3 a = c0, b = c1;
  if (i < 0.5)      { a = c0; b = c1; }
  else if (i < 1.5) { a = c1; b = c2; }
  else if (i < 2.5) { a = c2; b = c3; }
  else if (i < 3.5) { a = c3; b = c4; }
  else if (i < 4.5) { a = c4; b = c5; }
  else              { a = c5; b = c0; }
  return mix(a, b, f);
}

// Cross-fade between the three modes. Cycle period: ~36s (12s per mode hold +
// smooth transition). We compute weights for all three modes that sum to 1.
vec3 paletteByMode(float t) {
  float cycle = u_time / 36.0;          // one full revolution every 36s
  float phase = fract(cycle) * 3.0;     // 0..3 across the three modes

  // Triangular blend: each mode has weight 1 at its center, 0 at neighbors,
  // smoothed so transitions are gentle instead of linear ramps.
  float w0 = max(0.0, 1.0 - min(abs(phase - 0.0), abs(phase - 3.0)));
  float w1 = max(0.0, 1.0 - abs(phase - 1.0));
  float w2 = max(0.0, 1.0 - abs(phase - 2.0));
  // Smooth the weights so the hold-period feels longer than a pure triangle.
  w0 = smoothstep(0.0, 1.0, w0);
  w1 = smoothstep(0.0, 1.0, w1);
  w2 = smoothstep(0.0, 1.0, w2);
  float wsum = w0 + w1 + w2 + 1e-5;

  return (palBirds(t) * w0 + palNeon(t) * w1 + palNatural(t) * w2) / wsum;
}

void main() {
  // Aspect-correct UV centered on screen. Y kept in canvas units so the bands
  // read as horizontal strata of similar visual thickness regardless of width.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Slow syrup motion --------------------------------------------------
  // Two timescales: a very slow drift (the pour) and a slightly-faster wobble
  // (the surface lazily settling). Both are *slow* — this is honey, not water.
  float tSlow = u_time * 0.05;
  float tDrip = u_time * 0.025;

  // Sweeping curvature: a single broad arc so bands feel like one big ribbon
  // bending across the frame, not like noise everywhere. Mid frequencies
  // gently push the slope so the curve sways with the music.
  float slope = 0.55 + 0.10 * sin(tSlow * 0.7) + 0.08 * (u_mid - 0.3);
  float arc   = slope * uv.x + 0.35 * sin(uv.x * 1.6 + tSlow * 0.9);

  // Low-frequency warp — large, lazy bulges. Two octaves stacked manually so
  // we control amplitude precisely (no whipping high-freq detail).
  float w1 = vnoise(vec2(uv.x * 0.9 + tDrip,  uv.y * 0.7 - tDrip * 0.6));
  float w2 = vnoise(vec2(uv.x * 1.8 - tDrip * 0.7, uv.y * 1.4 + tDrip * 0.4));
  float warp = (w1 - 0.5) * 0.55 + (w2 - 0.5) * 0.18;

  // Bass *thickens* the warp (more pull-and-stretch), but capped so it never
  // turns into chaos. Subtle by design.
  warp *= 1.0 + 0.35 * smoothstep(0.0, 1.0, u_bass);

  // The "altitude" of the layered syrup. uv.y dominates so bands stay
  // horizontal-ish; arc sweeps them into a curve; warp gives viscous bulge.
  float altitude = uv.y * 1.15 + arc + warp;

  // ---- Quantize into bands ------------------------------------------------
  // 6 broad bands across the visible range. Soft inner gradient + soft edges
  // (no hard step) so each band has the painted, flat-but-not-flat feel of
  // the reference image.
  float bandCount = 6.0;
  float scaled    = altitude * bandCount;
  float idx       = floor(scaled);
  float frac      = fract(scaled);

  // Soft band edges: smooth pulse across the boundary (width ~0.12 of a band).
  // edge ≈ 1 at the boundary, 0 in the middle of a band.
  float edge = smoothstep(0.0, 0.12, frac) * smoothstep(1.0, 0.88, frac);
  edge = 1.0 - edge;

  // ---- Color --------------------------------------------------------------
  // Index each band into the active palette. Slow palette-index drift adds
  // a gentle shimmer of color shift across all bands together.
  float colorT = idx / bandCount + 0.05 * tSlow;
  vec3 col     = paletteByMode(colorT);

  // Subtle in-band shading: fake a soft cylindrical highlight across each band
  // so each strip has a hint of curvature instead of being dead-flat.
  float curve = sin(frac * PI);          // 0 at edges, 1 at band center
  col *= 0.85 + 0.20 * curve;

  // Darken at band boundaries — the painted-edge look from the reference.
  col *= 1.0 - 0.45 * edge;

  // ---- Audio sparkle (subtle) ---------------------------------------------
  // Treble dusts a faint shimmer along band boundaries only. Very small.
  float shimmer = sampleFFT(0.55 + 0.35 * fract(idx * 0.317)) * u_treble;
  col += vec3(0.18, 0.14, 0.12) * shimmer * edge;

  // Volume gives a barely-perceptible global brightness lift — keeps the
  // image from feeling dead during quiet sections without making it pulse.
  col *= 0.92 + 0.12 * u_volume;

  // ---- Vignette + tonemap -------------------------------------------------
  float vig = smoothstep(1.35, 0.20, length(uv));
  col *= mix(0.55, 1.0, vig);

  // Soft tonemap so bass-thickening or neon mode never clips to white.
  col = col / (1.0 + col);

  // Lift blacks slightly toward the warm-near-black of the reference instead
  // of pure 0,0,0 — only matters in the natural-palette mode but harmless
  // elsewhere because it's tiny.
  col = max(col, vec3(0.012, 0.010, 0.014));

  outColor = vec4(col, 1.0);
}
