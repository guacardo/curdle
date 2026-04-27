// liquid-metal: cel-shaded oil-on-steel that drifts in a coherent direction
// and "curdles" on bass — bass briefly slows the flow and twists it (compression
// + swirl) instead of dumping chaos on top. Treble fragments the bands.
//
// - Advected sampling: features travel with a slowly-rotating flow vector.
// - Anisotropic noise (stretched along flow) for oil-streak elongation.
// - Audio-driven posterization: u_treble sets band count, u_bass shifts thresholds.
// - Inked rim line at every band boundary for the comic-book edge.

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Flow field ----------------------------------------------------------
  // Slow rotation of the drift vector so the oil "wanders" without ever stopping.
  float flowAngle = u_time * 0.04;
  vec2  flowDir   = vec2(cos(flowAngle), sin(flowAngle));

  // Bass momentarily *slows* the drift (oil bunches up against a wave).
  // 1.0 at rest, ~0.45 on a hard hit. Drift never reverses.
  float flowSpeed = 0.18 * (1.0 - 0.55 * smoothstep(0.0, 1.0, u_bass));
  vec2  flow      = flowDir * flowSpeed;

  // Bass also adds a brief swirl around screen center — a "curdle" twist
  // that *bends* the flow rather than adding chaotic warp on top.
  float swirlAmt = 0.9 * pow(u_bass, 1.5);
  vec2  baseUV   = rot2d(swirlAmt * exp(-2.0 * length(uv))) * uv - flow * u_time;

  // Anisotropic stretch: compress along flow direction so noise features
  // elongate into oil streaks aligned with the drift.
  mat2  align    = mat2(flowDir.x, -flowDir.y, flowDir.y, flowDir.x);
  vec2  oilUV    = align * baseUV;
  oilUV.x *= 0.55;          // squash along-flow → long streaks
  oilUV.y *= 1.20;          // stretch across-flow

  // ---- Domain warp that travels WITH the flow -----------------------------
  // The warp offsets are themselves advected (subtract flow*t inside fbm)
  // so the warped features inherit the drift instead of fighting it.
  float t = u_time * 0.15;
  vec2  drift = flow * u_time;

  vec2 q = vec2(
    fbm(oilUV * 1.7 - drift + vec2(0.0,  t)),
    fbm(oilUV * 1.7 - drift + vec2(5.2, -t * 0.8))
  );

  // Curdle = how much q feeds back into r. Bass deepens the warp but the
  // warp itself still drifts, so it reads as "thickening oil" not "shaking".
  float curdle = 0.5 + 1.6 * pow(u_bass, 1.4);
  vec2 r = vec2(
    fbm(oilUV - drift + curdle * q + vec2(1.7, 9.2)),
    fbm(oilUV - drift + curdle * q + vec2(8.3, 2.8) + t)
  );

  // Bias r along flowDir so the second-order warp also travels.
  r += 0.25 * flowDir;

  float field = fbm(oilUV - drift + curdle * r);   // raw [0,1]-ish

  // ---- Audio-driven cel-shading -------------------------------------------
  // Treble fragments the surface into more bands; mids drift the palette hue.
  float bands          = mix(3.0, 9.0, smoothstep(0.0, 0.6, u_treble));
  float thresholdShift = u_bass * 0.15;

  // Quantize. Use floor for discrete band index, then normalize.
  float scaled    = (field + thresholdShift) * bands;
  float bandIndex = floor(scaled);
  float fq        = bandIndex / bands;
  float residual  = fract(scaled);                 // 0..1 within the band

  // Palette indexed by the *quantized* value → discrete color steps.
  vec3 col = palette(
    fq + 0.2 * t + 0.4 * u_mid,
    vec3(0.55, 0.45, 0.65),
    vec3(0.45, 0.50, 0.40),
    vec3(1.00, 1.00, 1.00),
    vec3(0.00, 0.20, 0.55)
  );

  // Subtle in-band shading so each cel still shows curvature (≤0.08 contrib).
  col *= 1.0 + 0.08 * (residual - 0.5);

  // ---- Inked rim line at band boundaries ----------------------------------
  // bandEdge = 0 at band centers, 1 right at the boundary.
  float bandEdge = abs(fract(scaled - 0.5) - 0.5) * 2.0;
  float rim      = smoothstep(0.92, 1.0, bandEdge);
  col            = mix(col, col * 0.45, rim * 0.65);

  // ---- Treble ripple (kept from original, applied as a tint) --------------
  float ripple = sampleFFT(0.7 + 0.2 * length(uv)) * u_treble;
  col += vec3(0.10, 0.07, 0.14) * ripple;

  // ---- Specular pop on bass — brightest band gets a highlight -------------
  float topBand = step(bands - 1.5, bandIndex);
  col += vec3(0.6) * topBand * (0.15 + 0.9 * u_bass);

  // Vignette to keep the gaze centered.
  float vig = smoothstep(1.2, 0.2, length(uv));
  col *= vig;

  // Tonemap so bass spikes don't clip.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
