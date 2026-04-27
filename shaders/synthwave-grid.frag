// synthwave-grid: 80s perspective grid receding to a horizon, sliced sun, gradient sky.
// - Grid lines scroll toward camera; bass pulses brightness AND compresses cell spacing on hits.
// - Sky uses IQ palette for the magenta->orange->cyan ramp; sun rides the horizon line.
// - Treble drives a fine scanline flicker overlay.

void main() {
  // Centered, aspect-correct UV. y up. y=0 sits at the horizon.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

  // Horizon sits slightly above center. Anything with uv.y < horizon is the ground.
  float horizon = -0.05;

  // Smoothed bass envelope — sharp for the pulse, slower decay reads as "thump".
  float bassPulse = pow(u_bass, 1.6);

  vec3 col;

  if (uv.y < horizon) {
    // ---------- GROUND PLANE ----------
    // Project screen y to world depth. As uv.y -> horizon, depth -> infinity.
    // Adding a small epsilon prevents division blowups right at the horizon line.
    float yFromHorizon = horizon - uv.y;
    float depth = 0.18 / (yFromHorizon + 0.001);

    // Scroll lines toward camera; bass compresses cell size so the grid "breathes".
    float cellZ = 1.0 - 0.18 * bassPulse;
    float cellX = 1.0 - 0.10 * bassPulse;

    // World coords. x widens with depth (perspective), z scrolls with time.
    float worldZ = depth - u_time * 0.6;
    float worldX = uv.x * depth;

    // Distance to nearest gridline in each axis, then convert to a thin line via fwidth.
    // Using fwidth keeps line width roughly constant in screen space regardless of depth.
    float gz = abs(fract(worldZ / cellZ) - 0.5);
    float gx = abs(fract(worldX / cellX) - 0.5);

    float lwZ = fwidth(worldZ / cellZ) * 1.2;
    float lwX = fwidth(worldX / cellX) * 1.2;

    float lineZ = 1.0 - smoothstep(0.0, lwZ, gz);
    float lineX = 1.0 - smoothstep(0.0, lwX, gx);
    float grid = max(lineZ, lineX);

    // Distance fade: faraway lines dim out, foreground lines pop.
    float fade = exp(-depth * 0.06);

    // Grid color: hot magenta baseline, shifts toward cyan with bass kick.
    vec3 gridCol = mix(vec3(1.00, 0.20, 0.85), vec3(0.30, 0.95, 1.00), bassPulse);
    float gridBright = (0.55 + 1.6 * bassPulse) * fade;

    // Ground base: deep purple gradient that darkens away from camera.
    vec3 ground = mix(vec3(0.18, 0.02, 0.22), vec3(0.02, 0.0, 0.06), 1.0 - fade);

    col = ground + grid * gridCol * gridBright;

    // Subtle ground-reflected sun glow on the near plane.
    float sunGlowGround = exp(-abs(uv.x) * 3.5) * exp(-yFromHorizon * 4.0);
    col += vec3(1.0, 0.45, 0.25) * sunGlowGround * 0.35;

  } else {
    // ---------- SKY ----------
    // Vertical ramp from horizon upward through the IQ palette.
    float h = (uv.y - horizon) / (0.55 - horizon);
    h = clamp(h, 0.0, 1.0);

    // Magenta near horizon -> orange mid -> deep indigo/cyan up top.
    vec3 sky = palette(
      h * 0.85,
      vec3(0.50, 0.30, 0.55),
      vec3(0.50, 0.35, 0.45),
      vec3(1.00, 0.85, 0.70),
      vec3(0.10, 0.25, 0.55)
    );

    // Faint stars high up — denser away from horizon, hidden behind the sun area.
    float starField = step(0.985, hash21(floor(gl_FragCoord.xy)));
    sky += vec3(starField) * smoothstep(0.15, 0.5, uv.y) * (0.6 + 0.4 * u_treble);

    col = sky;
  }

  // ---------- SUN ----------
  // Centered on horizon. Render in screen space so it sits on top of both halves.
  vec2 sunPos = vec2(0.0, horizon + 0.18);
  float sunR = 0.20;
  vec2 sd = uv - sunPos;
  float sdist = length(sd);

  // Glow halo always visible, brightens with mids.
  float halo = exp(-sdist * 4.5) * (0.45 + 0.4 * u_mid);
  vec3 haloCol = mix(vec3(1.0, 0.35, 0.55), vec3(1.0, 0.75, 0.30), 0.5 + 0.5 * sin(u_time * 0.4));
  col += haloCol * halo;

  // Sun disc with vertical gradient (yellow top -> magenta bottom).
  float sunMask = smoothstep(sunR, sunR - 0.005, sdist);
  vec3 sunGrad = mix(vec3(1.0, 0.25, 0.55), vec3(1.0, 0.90, 0.35), (sd.y / sunR) * 0.5 + 0.5);

  // Horizontal cutout slices in the lower half of the sun — the classic look.
  // Slices only carve the bottom 60% so the top stays solid.
  float sliceY = (sd.y + sunR) / (sunR * 1.2); // 0 at bottom, ~1 toward top
  float sliceMask = step(sliceY, 0.6);
  // Spacing widens upward so slices fan out as in the original art.
  float sliceFreq = 22.0 - sliceY * 14.0;
  float slice = step(0.5, fract(sliceY * sliceFreq));
  float cut = sliceMask * (1.0 - slice);

  col = mix(col, sunGrad, sunMask * (1.0 - cut));

  // ---------- TREBLE SCANLINE FLICKER ----------
  // Fine horizontal scanlines that wobble in intensity with treble + a per-line jitter.
  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 1.8 + u_time * 12.0);
  float flicker = hash21(vec2(floor(gl_FragCoord.y), floor(u_time * 30.0)));
  col *= 1.0 - (0.18 * u_treble) * scan;
  col += vec3(0.05, 0.02, 0.08) * u_treble * flicker;

  // ---------- BLOOM-ISH BASS LIFT ----------
  // Push midtones brighter on bass hits without clipping.
  col += vec3(0.10, 0.04, 0.18) * bassPulse;

  // Soft vignette to focus the eye on the horizon.
  float vig = smoothstep(1.3, 0.3, length(uv * vec2(0.9, 1.1)));
  col *= mix(0.7, 1.0, vig);

  // Tonemap so bass spikes don't clip to white.
  col = col / (1.0 + col * 0.85);

  outColor = vec4(col, 1.0);
}
