// liquid-curdle: the original liquid-metal — chromatic surface that destabilizes
// ("curdles") on bass hits. Preserved when liquid-metal evolved into a cel-shaded
// oil-on-steel; this version is the smooth, gradient-based ancestor.
// - Domain warp driven by FBM, amplitude modulated by bass.
// - Rotating triadic palette: warp magnitude selects between three hues (120°
//   apart) that slowly rotate around the wheel. Uses the *hard* triad picker
//   with a thin seam (~0.07) so most of the screen lands on ONE clean neon hue
//   instead of bleeding through desaturated RGB-interpolated midtones.
// - Body color is held in the chroma-rich band (sat≈0.95, lit≈0.45–0.65); a
//   separate additive emissive boost lights up the warp peaks as if they're
//   neon tubes burning above a near-black void.
// - Treble adds a fine chromatic ripple. Bass swells the emissive halo.

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  float t = u_time * 0.15;

  // Slow rotation to keep the field alive when audio is quiet.
  uv = rot2d(t * 0.3) * uv;

  // First-order FBM domain warp.
  vec2 q = vec2(
    fbm(uv * 1.7 + vec2(0.0, t)),
    fbm(uv * 1.7 + vec2(5.2, -t * 0.8))
  );

  // Bass aggressively pumps a second-order warp — the "curdle".
  float curdle = 0.6 + 2.4 * pow(u_bass, 1.4);
  vec2 r = vec2(
    fbm(uv + curdle * q + vec2(1.7, 9.2)),
    fbm(uv + curdle * q + vec2(8.3, 2.8) + t)
  );

  float field = fbm(uv + curdle * r);

  // ---- Triadic palette (NEON) ---------------------------------------------
  // Hard picker with a thin (~0.07) seam: nearly every pixel resolves to ONE
  // of three saturated triad hues, so the screen reads as deliberate neon
  // panels of color rather than a muddy gradient.
  float baseHue  = triadHue(0.0);
  float selector = fract(field + 0.2 * t);
  // Saturation pinned high — the whole point of neon. Lit kept in the
  // chroma-rich band [0.45, 0.65] so colors don't desaturate toward white or
  // crush toward black; brightness comes from the additive emissive pass.
  float sat      = 0.95;
  float lit      = 0.50 + 0.10 * sin(field * TAU + t) + 0.05 * u_mid;
  lit            = clamp(lit, 0.45, 0.65);
  vec3 hueRGB    = triadPickHard(selector, baseHue, sat, lit, 0.07);

  // ---- Dark void baseline -------------------------------------------------
  // Low-field regions fall to a near-black violet void so the neon hues pop.
  // Avoids the previous behaviour of fading toward a desaturated triad colour.
  vec3 voidCol  = vec3(0.015, 0.005, 0.030);
  float bodyMix = smoothstep(0.20, 0.55, field);
  vec3 col      = mix(voidCol, hueRGB, bodyMix);

  // ---- Emissive neon highlight --------------------------------------------
  // Additive on the hue, NOT lerp toward white. The brightest field values
  // glow as if lit from within; bass swells the emission. Crucially, this
  // brightens the existing hue rather than dragging it toward grey/white.
  float emissive = smoothstep(0.62, 0.92, field);
  col += hueRGB * emissive * (1.10 + 1.30 * u_bass);

  // Soft outer halo — radial bleed of the emissive band, so peaks read as
  // glowing tubes rather than flat patches.
  float halo = smoothstep(0.45, 0.85, field);
  col += hueRGB * halo * halo * 0.35;

  // ---- Treble ripple ------------------------------------------------------
  // Cool blue-violet shimmer keyed off high frequencies; tinted to play
  // against (not wash out) the rotating triad.
  float ripple = sampleFFT(0.7 + 0.2 * length(uv)) * u_treble;
  col += vec3(0.20, 0.30, 0.60) * ripple;

  // Soft vignette toward the void colour (not toward black multiply, which
  // would just darken everything uniformly — this preserves contrast).
  float vig = smoothstep(1.25, 0.25, length(uv));
  col = mix(voidCol, col, vig);

  // Gentle tonemap — soft enough that emissive peaks still read as bright
  // without clipping to flat white. (1.0 + 0.7*col) ramps slower than the
  // canonical (1.0 + col) so saturated neons keep their chroma at peaks.
  col = col / (1.0 + 0.7 * col);

  outColor = vec4(col, 1.0);
}
