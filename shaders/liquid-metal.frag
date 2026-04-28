// liquid-metal: cel-shaded oil-on-steel that drifts in a coherent direction
// and "curdles" on bass — bass briefly slows the flow and twists it (compression
// + swirl) instead of dumping chaos on top. Treble fragments the bands.
//
// - Advected sampling: features travel with a slowly-rotating flow vector.
// - Anisotropic noise (stretched along flow) for oil-streak elongation.
// - Audio-driven posterization: u_treble sets band count, u_bass shifts thresholds.
// - Inked rim line at every band boundary for the comic-book edge.
// - Rotating triadic palette: each cel band lands on one of three triad hues
//   (120° apart). Adjacent bands always step to a *different* hue. Picker is
//   the HARD variant with near-zero crossfade — neighbouring cels are pure
//   neon panels meeting at a sharp inked seam, no muddy blend zone.

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Flow field ----------------------------------------------------------
  // Very slow rotation of the drift vector — the oil "wanders" like honey
  // pulled across a tilted plate, never hurried.
  float flowAngle = u_time * 0.015;
  vec2  flowDir   = vec2(cos(flowAngle), sin(flowAngle));

  // Bass momentarily *slows* the drift further (oil bunches up against a wave).
  // 1.0 at rest, ~0.45 on a hard hit. Drift never reverses.
  float bassEase  = smoothstep(0.0, 1.0, u_bass);
  float flowSpeed = 0.065 * (1.0 - 0.55 * bassEase);
  vec2  flow      = flowDir * flowSpeed;

  // Bass also adds a brief swirl around screen center — a "curdle" twist
  // that *bends* the flow rather than adding chaotic warp on top.
  float swirlAmt = 0.55 * smoothstep(0.0, 1.0, pow(u_bass, 1.5));
  vec2  baseUV   = rot2d(swirlAmt * exp(-2.0 * length(uv))) * uv - flow * u_time;

  // Anisotropic stretch: compress along flow direction so noise features
  // elongate into oil streaks aligned with the drift.
  mat2  align    = mat2(flowDir.x, -flowDir.y, flowDir.y, flowDir.x);
  vec2  oilUV    = align * baseUV;
  oilUV.x *= 0.55;          // squash along-flow → long streaks
  oilUV.y *= 1.20;          // stretch across-flow

  // ---- Domain warp that travels WITH the flow -----------------------------
  float t = u_time * 0.05;
  vec2  drift = flow * u_time;

  vec2 q = vec2(
    fbm(oilUV * 1.05 - drift + vec2(0.0,  t)),
    fbm(oilUV * 1.05 - drift + vec2(5.2, -t * 0.8))
  );

  float curdle = 0.32 + 0.85 * pow(u_bass, 1.4);
  vec2 r = vec2(
    fbm(oilUV - drift + curdle * q + vec2(1.7, 9.2)),
    fbm(oilUV - drift + curdle * q + vec2(8.3, 2.8) + t)
  );

  r += 0.25 * flowDir;

  float field = fbm(oilUV - drift + curdle * r);

  // ---- Audio-driven cel-shading -------------------------------------------
  float bands          = mix(3.0, 9.0, smoothstep(0.0, 0.6, u_treble));
  float thresholdShift = u_bass * 0.15;

  float scaled    = (field + thresholdShift) * bands;
  float bandIndex = floor(scaled);
  float fq        = bandIndex / bands;
  float residual  = fract(scaled);                 // 0..1 within the band

  // ---- Triadic palette (NEON PANELS) --------------------------------------
  // Each band index slots squarely into ONE triad hue. Hard picker with a
  // very thin seam (0.02) means adjacent bands meet at a 1–2px blend before
  // the inked rim covers the seam entirely. No RGB-mixing across hues.
  float baseHue   = triadHue(0.33);
  float bandSlot  = mod(bandIndex, 3.0) / 3.0 + 1.0/6.0;  // 1/6, 3/6, 5/6
  bandSlot        = fract(bandSlot + 0.07 * t);

  // Saturation pinned high — neon panels. Lit varies *slightly* across bands
  // so the steel still has a sense of shadow→highlight gradation, but stays
  // inside the chroma-rich [0.45, 0.62] window so colours don't desaturate
  // toward grey/white. Mids nudge lightness without crossing the band.
  float sat       = 0.96;
  float lit       = clamp(0.46 + 0.14 * fq + 0.06 * u_mid, 0.42, 0.62);
  vec3 col        = triadPickHard(bandSlot, baseHue, sat, lit, 0.02);

  // Subtle in-band shading — a soft roll across each cel for curvature, but
  // multiplicative so the hue is preserved (no slide toward grey).
  float residualSoft = smoothstep(0.0, 1.0, residual);
  col *= 1.0 + 0.10 * (residualSoft - 0.5);

  // ---- Inked rim line at band boundaries ----------------------------------
  // Stronger ink than before — black seams between neon panels read as
  // deliberate cel-shade outlines and hide the picker's micro-seam.
  float bandEdge = abs(fract(scaled - 0.5) - 0.5) * 2.0;
  float rim      = smoothstep(0.88, 1.0, bandEdge);
  col            = mix(col, col * 0.18, rim * 0.85);

  // ---- Treble ripple ------------------------------------------------------
  // Tinted toward a complementary cool so it adds chromatic spice without
  // polluting the panel hues toward grey.
  float ripple = sampleFFT(0.7 + 0.2 * length(uv)) * u_treble;
  col += vec3(0.10, 0.18, 0.35) * ripple;

  // ---- Specular pop on bass — brightest band glows as emissive ------------
  // Additive on the band's own hue (preserves chroma), not a white mix.
  // Pulled from the same triad slot so the highlight stays "in the family".
  float topBand = step(bands - 1.5, bandIndex);
  vec3 hiHue    = triadPickHard(bandSlot, baseHue, 1.0, 0.58, 0.02);
  col += hiHue * topBand * (0.25 + 1.10 * u_bass);

  // Vignette toward near-black so the neon panels glow against a void edge.
  float vig = smoothstep(1.25, 0.25, length(uv));
  vec3 voidCol = vec3(0.01, 0.005, 0.02);
  col = mix(voidCol, col, vig);

  // Tonemap — soft enough to preserve chroma at the brightest peaks.
  col = col / (1.0 + 0.7 * col);

  outColor = vec4(col, 1.0);
}
