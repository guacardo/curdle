// tunnel: first-person flight down a cylindrical corridor that recedes to a vanishing point.
// - Polar coords (angle, 1/radius) map screen -> cylinder surface; 1/r gives the natural depth foreshortening.
// - Bass squeezes the radius (walls breathe inward on hits, exhale between them).
// - FBM on the (angle, depth) plane gives wall texture; periodic rings march toward the camera.
// - Depth-aware palette: near rings are warm/bright, distant rings cool and dim into fog.
// - Mids tint the hue; treble brightens individual rings via FFT lookup at depth.

void main() {
  // Centered, aspect-corrected coords. y-up.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // Soft camera sway so the tunnel doesn't feel rigidly on-rails when audio is quiet.
  vec2 sway = vec2(sin(u_time * 0.31), cos(u_time * 0.27)) * 0.04;
  uv -= sway;

  float r = length(uv);
  float a = atan(uv.y, uv.x);

  // Bass pumps the apparent tunnel radius. Below 1.0 = walls squeeze in, above = breathe out.
  // Baseline pulses gently with a slow sine so silence still has motion.
  float breathe = 1.0 + 0.06 * sin(u_time * 0.8);
  float pump    = breathe - 0.55 * pow(u_bass, 1.3);

  // Depth coordinate: 1/r is the canonical "fly into a tube" trick.
  // Multiplying by pump shrinks the visible radius when bass hits, pulling walls inward.
  float depth = pump / max(r, 1e-3);

  // Forward camera motion. Subtract from depth so rings flow toward the viewer.
  float speed = 1.4 + 0.8 * u_volume;
  float z = depth - u_time * speed;

  // Wall surface coordinate in (angle, depth) space. Use (cos, sin) of the angle
  // so the noise input is naturally 2π-periodic — avoids a seam along the -x axis
  // where atan flips between -π and +π.
  vec2 wall = vec2(cos(a), sin(a)) * 1.6 + vec2(0.0, z);

  // FBM gives organic wall grain. Add a slow angular drift so the texture isn't static.
  float grain = fbm(wall * 1.4 + vec2(0.0, u_time * 0.2));

  // Periodic rings marching toward camera. fract(z) gives sawtooth; we shape it
  // into bright bands with smoothstep so they read as discrete ribs in the tunnel.
  float ring = fract(z * 0.5);
  float ribs = smoothstep(0.45, 0.5, ring) - smoothstep(0.5, 0.55, ring);

  // Treble: pluck a different FFT bin per ring so highs visibly fire individual ribs.
  float ribFFT = sampleFFT(0.35 + 0.55 * fract(z * 0.5 + 0.123));
  ribs *= 1.0 + 2.5 * ribFFT * u_treble;

  // Combine wall grain + ribs into a single field used to drive color.
  float field = grain * 0.7 + ribs * 0.6;

  // Depth-aware palette. `fog` goes 1 (near) -> 0 (far) so distant walls darken
  // and shift hue. Mids rotate the palette phase for a slow color cycle.
  float fog = exp(-r * 1.8);   // r small near center == far down the tunnel; invert intuition
  // Actually: small r = far away (deep down tunnel), large r = near walls at screen edge.
  // We want distant (small r) to look dim/cool and near (large r) to look warm/bright.
  float nearness = smoothstep(0.0, 0.7, r);

  vec3 col = palette(
    field + 0.15 * z + 0.3 * u_mid,
    vec3(0.50, 0.40, 0.55),
    vec3(0.45, 0.50, 0.55),
    vec3(1.00, 0.90, 0.80),
    vec3(0.10, 0.30, 0.65)
  );

  // Apply depth tint: distant walls cool/dim, near walls warm/bright.
  vec3 farTint  = vec3(0.20, 0.30, 0.55);
  vec3 nearTint = vec3(1.10, 0.85, 0.65);
  col *= mix(farTint, nearTint, nearness);

  // Bright vanishing point at center — light at the end of the tunnel.
  // Bass also pushes light outward (a flash on hits).
  float core = smoothstep(0.35, 0.0, r);
  col += vec3(1.0, 0.85, 0.6) * core * (0.4 + 1.6 * u_bass);

  // Rib highlights add a metallic edge feel.
  col += vec3(0.9, 0.7, 0.5) * ribs * 0.4 * nearness;

  // Subtle vignette to keep focus down the barrel.
  float vig = smoothstep(1.3, 0.3, r * 1.1);
  col *= mix(0.6, 1.0, vig);

  // Tonemap so bass spikes saturate gracefully instead of clipping to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
