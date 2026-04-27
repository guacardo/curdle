// liquid-metal: chromatic surface that destabilizes ("curdles") on bass hits.
// - Domain warp driven by FBM, amplitude modulated by bass.
// - IQ palette over warp magnitude, hue rotated by time + mids.
// - Treble adds a fine chromatic ripple and edge sharpness.

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

  // Palette: chromatic, hue cycles slowly, mids brighten the highlights.
  vec3 col = palette(
    field + 0.2 * t + 0.4 * u_mid,
    vec3(0.55, 0.45, 0.65),
    vec3(0.45, 0.50, 0.40),
    vec3(1.00, 1.00, 1.00),
    vec3(0.00, 0.20, 0.55)
  );

  // Treble: fine ripple via FFT lookup at high frequency.
  float ripple = sampleFFT(0.7 + 0.2 * length(uv)) * u_treble;
  col += vec3(0.15, 0.10, 0.20) * ripple;

  // Specular pop on bass — bright spots near the warp peaks.
  float spec = smoothstep(0.65, 0.95, field) * (0.3 + 1.4 * u_bass);
  col += vec3(spec);

  // Soft vignette to keep the gaze centered.
  float vig = smoothstep(1.2, 0.2, length(uv));
  col *= vig;

  // Tonemap-ish softening so bass spikes don't blow out.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
