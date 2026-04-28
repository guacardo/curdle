// synthwave-grid: 80s perspective grid receding to a horizon, sliced sun, layered audio sky.
// - Grid lines scroll toward camera; bass pulses brightness AND compresses cell spacing on hits.
// - Three oscilloscope mountain ridges trace the horizon, driven by FFT history bands.
// - Sun breathes with bass and emits radial heat-shimmer that warps nearby UVs.
// - Two parallax fbm cloud layers drift overhead, tinted by the synthwave palette.
// - Subtle spectrum-driven CRT noise fills empty sky.

// ---------- helpers (local) ----------

// Sweep an oscilloscope-style ridge across X.
// xN: normalized [0,1] horizontal position
// bandLo/bandHi: which slice of the FFT to read (0..1 each)
// scrollT: time-based offset so the trace sweeps
// depth:   FFT history depth (0=now, ~1=second ago) — lets back ridges lag
// Smooths over a few neighbor samples for a ridge feel rather than barcode jaggies.
float scopeRidge(float xN, float bandLo, float bandHi, float scrollT, float depthT) {
  float x = fract(xN + scrollT);
  float span = bandHi - bandLo;
  // 3-tap horizontal blur over a small frequency window.
  float w = 0.012;
  float s0 = sampleFFTHistory(bandLo + x * span,           depthT);
  float s1 = sampleFFTHistory(bandLo + (x - w) * span,     depthT);
  float s2 = sampleFFTHistory(bandLo + (x + w) * span,     depthT);
  float s3 = sampleFFTHistory(bandLo + (x - 2.0*w) * span, depthT);
  float s4 = sampleFFTHistory(bandLo + (x + 2.0*w) * span, depthT);
  return (s1 + s2 + 2.0 * s0 + 0.5 * (s3 + s4)) / 5.0;
}

void main() {
  // Centered, aspect-correct UV. y up. y=0 sits at the horizon.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

  // Horizon sits slightly above center. Anything with uv.y < horizon is the ground.
  float horizon = -0.05;

  // Smoothed bass envelope — sharp for the pulse, slower decay reads as "thump".
  float bassPulse = pow(u_bass, 1.6);

  // ---------- SUN-CENTERED HEAT SHIMMER (computed early so it can warp the sky) ----------
  // Distance from sun, in pre-warp UVs. Falls off fast so only nearby pixels ripple.
  vec2 sunPos = vec2(0.0, horizon + 0.18);
  vec2 sd0 = uv - sunPos;
  float sunDist = length(sd0);
  // Heat ripples: cheap sin-stack as a function of polar angle + radius + time.
  float ang = atan(sd0.y, sd0.x);
  float ripple = sin(sunDist * 28.0 - u_time * 3.0 + ang * 4.0)
               + 0.6 * sin(sunDist * 44.0 - u_time * 5.2 - ang * 2.0);
  // Strength: rises with bass+mid, dies with distance from sun.
  float heatFalloff = exp(-sunDist * 4.0);
  float heatAmp = (0.004 + 0.012 * (bassPulse + u_mid * 0.6)) * heatFalloff;
  vec2 warp = vec2(ripple * heatAmp, ripple * heatAmp * 0.6);
  vec2 wuv = uv + warp;

  // ---------- HORIZON MIRAGE BAND ----------
  // Heat shimmer concentrated in a narrow strip just above + below the horizon.
  // Vertical displacement of sampled coords = a slow sine + low-amplitude noise.
  // Smooth altitude mask falls off into both sky and foreground so it doesn't strobe.
  float mirageDist = abs(wuv.y - horizon);
  float mirageMask = exp(-mirageDist * mirageDist * 220.0); // ~Gaussian band, ~0.07 wide
  // Slow vertical wobble — long horizontal wavelength so it reads as heat, not waves.
  float mirageWave = sin(wuv.x * 9.0 - u_time * 1.6)
                   + 0.55 * sin(wuv.x * 17.0 + u_time * 2.3);
  // A touch of low-amp noise gives it organic texture without strobing.
  float mirageNoise = vnoise(vec2(wuv.x * 6.0, u_time * 0.7)) - 0.5;
  float mirageAmp = (0.0022 + 0.0030 * (u_mid + 0.6 * bassPulse)) * mirageMask;
  wuv.y += mirageWave * mirageAmp;
  wuv.y += mirageNoise * mirageAmp * 0.8;
  // Tiny lateral smear — reads as the air shifting sideways with the wind.
  wuv.x += mirageNoise * mirageAmp * 0.4;

  // ---------- DUNE SURFACE LIFT ----------
  // Compute a screen-space lift for the visible ground surface as a function of
  // the (unwarped) view direction. We sample dune height in world space at the
  // *flat* projection of this pixel, then convert to a screen-y rise. This raises
  // the apparent horizon at crests so dune tops poke into the sky band.
  // For pixels at or above the flat horizon we evaluate at a clamped "far" depth
  // so the dune field still has a defined height at the horizon line — that's how
  // crests can rise into what would otherwise be sky.
  float flatYFromHorizon = max(horizon - wuv.y, 1e-4);
  float flatDepthRaw = 0.18 / flatYFromHorizon;
  float flatDepth = min(flatDepthRaw, 22.0); // cap so sky pixels still sample dunes
  float flatWorldZ = flatDepth - u_time * 0.6;
  float flatWorldX = wuv.x * flatDepth;

  // Big rolling crests (long wavelength) + a finer wind-chop layer.
  // Two crossed long-wave sines drift slowly so the dune field shifts with the wind.
  float duneA = sin(flatWorldZ * 0.18 - u_time * 0.20 + flatWorldX * 0.05);
  float duneB = sin(flatWorldZ * 0.31 + u_time * 0.13 - flatWorldX * 0.09);
  // Asymmetric profile via pow — gentle windward face, sharper leeward.
  float duneCrest = 0.5 + 0.5 * (0.6 * duneA + 0.4 * duneB);
  duneCrest = pow(duneCrest, 1.6);
  float chop = vnoise(vec2(flatWorldX * 0.8 + u_time * 0.3, flatWorldZ * 0.7)) - 0.5;
  // Combined height, with a gentle bass swell.
  float duneH = duneCrest * 0.085 + chop * 0.022;
  duneH *= 1.0 + 0.35 * bassPulse;
  // Suppress dunes near the camera so the foreground stays planted; let them rise toward horizon.
  float duneDistRamp = smoothstep(1.2, 6.0, flatDepth);
  duneH *= duneDistRamp;

  // Convert world height to a screen-y lift. Tuned empirically: max duneH ~0.10
  // and max desired lift ~0.035 (about a third of the way from horizon to top of frame),
  // so the constant is ~0.35. duneDistRamp above already accounts for distance falloff.
  float screenLift = duneH * 0.35;

  // Effective horizon at this column = unwarped horizon + dune lift.
  // A pixel is "ground" iff it sits below this lifted horizon.
  float effHorizon = horizon + screenLift;

  vec3 col;

  if (wuv.y < effHorizon) {
    // ---------- GROUND PLANE (sand dunes) ----------
    // Use the unwarped projection for grid math (so the grid stays perspective-correct),
    // but drape the grid sampling by dune height so lines bend over the crests.
    // Clamp yFromHorizon to a tiny positive value so crest-poke-through pixels
    // (where wuv.y is just above the flat horizon) still resolve to a valid far depth
    // rather than negative depth artifacts.
    float yFromHorizon = max(horizon - wuv.y, 0.0045);
    float depth = 0.18 / (yFromHorizon + 0.001);

    // Scroll lines toward camera; bass compresses cell size so the grid "breathes".
    float cellZ = 1.0 - 0.18 * bassPulse;
    float cellX = 1.0 - 0.10 * bassPulse;

    float worldZ = depth - u_time * 0.6;
    float worldX = wuv.x * depth;

    // Drape: bend Z lines forward over crests, push X lines sideways with the slope.
    float worldZdraped = worldZ + duneH * 2.4;
    float worldXdraped = worldX + duneH * 0.6 * sin(worldZ * 0.4);

    float gz = abs(fract(worldZdraped / cellZ) - 0.5);
    float gx = abs(fract(worldXdraped / cellX) - 0.5);

    float lwZ = fwidth(worldZdraped / cellZ) * 1.2;
    float lwX = fwidth(worldXdraped / cellX) * 1.2;

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
    // Sun-warmth tint on crests, deeper purple in troughs.
    float crestLit = smoothstep(0.3, 0.85, duneCrest) * fade;
    ground += vec3(0.30, 0.10, 0.20) * crestLit * 0.55;

    col = ground + grid * gridCol * gridBright;

    // Subtle ground-reflected sun glow on the near plane.
    float sunGlowGround = exp(-abs(wuv.x) * 3.5) * exp(-yFromHorizon * 4.0);
    col += vec3(1.0, 0.45, 0.25) * sunGlowGround * 0.35;

  } else {
    // ---------- SKY ----------
    // Pixels can land here either because they're truly above the horizon (wuv.y >= horizon)
    // or because they're behind a dune crest poking up (wuv.y < horizon but < effHorizon=false).
    // For sky-band math we clamp to horizon so the latter group reads as horizon-haze
    // rather than negative-altitude weirdness in the ridge/cloud layers.
    float skyY = max(wuv.y, horizon);

    // Vertical ramp from horizon upward through the IQ palette.
    float h = (skyY - horizon) / (0.55 - horizon);
    h = clamp(h, 0.0, 1.0);

    vec3 sky = palette(
      h * 0.85,
      vec3(0.50, 0.30, 0.55),
      vec3(0.50, 0.35, 0.45),
      vec3(1.00, 0.85, 0.70),
      vec3(0.10, 0.25, 0.55)
    );

    // ---------- (4) SPECTRAL CRT NOISE ----------
    // Two scales of noise tinted by spectrum bands; very low amplitude.
    // Fine grain rides treble (high freq), broader pulse rides bass (low freq).
    vec2 px = gl_FragCoord.xy;
    float fine = hash21(floor(px) + floor(u_time * 24.0));
    float coarse = vnoise(px * 0.012 + vec2(u_time * 0.15, -u_time * 0.08));
    float spectrumTint = sampleFFT(0.15 + 0.7 * fract(px.x * 0.0017 + u_time * 0.05));
    vec3 crtCol = mix(vec3(0.6, 0.2, 0.9), vec3(0.2, 0.8, 1.0), spectrumTint);
    sky += crtCol * (fine - 0.5) * 0.06 * (0.4 + u_treble);
    sky += crtCol * (coarse - 0.5) * 0.10 * (0.2 + u_bass * 0.8);

    // ---------- (3) MOVING CLOUDS ----------
    // Two parallax layers; only render meaningfully above mid-sky (uv.y > ~0.05).
    float skyMask = smoothstep(0.02, 0.20, skyY);
    // Aspect-ish coords for cloud space so they don't squish on widescreen.
    vec2 cuv = vec2(wuv.x, skyY * 0.9);
    // Far layer: slow drift right, wider scale, fainter.
    vec2 cuvFar = cuv * 2.2 + vec2(u_time * 0.04, -u_time * 0.01);
    float cloudFar = fbm(cuvFar);
    // Near layer: faster drift left, finer scale, brighter; thicken with mids.
    vec2 cuvNear = cuv * 3.6 + vec2(-u_time * 0.09, u_time * 0.02);
    float cloudNear = fbm(cuvNear + vec2(cloudFar * 0.4, 0.0));
    // Density threshold lifts with mids — loud passages = thicker clouds.
    float densBias = mix(0.55, 0.38, u_mid);
    float dFar  = smoothstep(densBias + 0.05, 0.85, cloudFar);
    float dNear = smoothstep(densBias,        0.80, cloudNear);
    // Tint: deep purple core, magenta/cyan rim. Use cloud density as palette t.
    vec3 cloudCore = vec3(0.18, 0.06, 0.32);
    vec3 cloudRim  = mix(vec3(1.0, 0.30, 0.85), vec3(0.30, 0.85, 1.0), 0.5 + 0.5 * sin(u_time * 0.2));
    vec3 cloudColFar  = mix(cloudCore, cloudRim * 0.6, dFar);
    vec3 cloudColNear = mix(cloudCore, cloudRim,       dNear);
    // Horizon haze: clouds fade as they approach the horizon line.
    float hazeFade = smoothstep(0.0, 0.35, skyY - horizon);
    sky = mix(sky, cloudColFar,  dFar  * 0.55 * skyMask * hazeFade);
    sky = mix(sky, cloudColNear, dNear * 0.75 * skyMask * hazeFade);

    // Faint stars high up — denser away from horizon, hidden behind cloud bodies.
    float starField = step(0.985, hash21(floor(gl_FragCoord.xy)));
    float starVis = (1.0 - dNear * 0.9) * (1.0 - dFar * 0.6);
    sky += vec3(starField) * smoothstep(0.15, 0.5, skyY) * (0.6 + 0.4 * u_treble) * starVis;

    col = sky;

    // ---------- (1) OSCILLOSCOPE MOUNTAIN RIDGES ----------
    // Three ridges layered front-to-back. Each samples a different FFT band.
    // The ridge "height" above the horizon is compared to the pixel's height-above-horizon.
    // Below the ridge = solid mountain body; right at the edge = bright rim.
    float yAbove = skyY - horizon;

    // Map screen X to a normalized [0,1] horizontal coordinate.
    // Shift to keep the trace centered at uv.x=0.
    float xN = wuv.x * 0.5 + 0.5;

    // -- back ridge: treble band, drifts slowest, faint, fogged.
    {
      float ridge = scopeRidge(xN, 0.55, 0.95, u_time * 0.015, 0.5);
      // Convert FFT magnitude to a height; back ridge stays low and far.
      float hR = 0.025 + ridge * 0.10;
      float edge = fwidth(yAbove) * 1.5;
      float body = 1.0 - smoothstep(hR - edge, hR + edge, yAbove);
      float rim  = exp(-abs(yAbove - hR) * 80.0);
      vec3 backCol = mix(vec3(0.10, 0.04, 0.22), vec3(0.35, 0.15, 0.55), 0.5);
      vec3 backRim = vec3(0.55, 0.30, 0.95);
      // Atmospheric fog: blend toward sky based on distance from horizon.
      float fog = 0.45;
      col = mix(col, mix(backCol, col, fog), body);
      col += backRim * rim * (0.18 + 0.5 * u_treble);
    }

    // -- mid ridge: mid band, medium drift, medium height.
    {
      float ridge = scopeRidge(xN, 0.18, 0.55, u_time * 0.05, 0.25);
      float hR = 0.04 + ridge * 0.18;
      float edge = fwidth(yAbove) * 1.5;
      float body = 1.0 - smoothstep(hR - edge, hR + edge, yAbove);
      float rim  = exp(-abs(yAbove - hR) * 90.0);
      vec3 midBody = vec3(0.14, 0.03, 0.26);
      vec3 midRim  = vec3(0.95, 0.25, 0.85);
      float fog = 0.75;
      col = mix(col, mix(midBody, col, 1.0 - fog), body);
      col += midRim * rim * (0.30 + 0.7 * u_mid);
    }

    // -- front ridge: bass band, fastest drift, tallest, sharp rim.
    {
      float ridge = scopeRidge(xN, 0.0, 0.22, u_time * 0.10, 0.05);
      float hR = 0.06 + ridge * 0.28;
      float edge = fwidth(yAbove) * 1.5;
      float body = 1.0 - smoothstep(hR - edge, hR + edge, yAbove);
      float rim  = exp(-abs(yAbove - hR) * 110.0);
      vec3 frontBody = vec3(0.06, 0.01, 0.14);
      vec3 frontRim  = vec3(1.0, 0.35, 0.85);
      // No fog on the closest range — full opacity.
      col = mix(col, frontBody, body);
      col += frontRim * rim * (0.45 + 0.9 * bassPulse);
    }
  }

  // ---------- (2) SUN with breathing radius, drifting slices, pulsing corona ----------
  // Use original uv (not warped) so the sun itself stays anchored; warp affects surroundings.
  vec2 sd = uv - sunPos;
  float sdist = length(sd);
  float sunR = 0.20 + 0.025 * bassPulse + 0.008 * sin(u_time * 1.7);

  // Outer bass-pulsed corona/bloom — separate from the inner halo.
  float corona = exp(-sdist * 2.6) * (0.18 + 0.6 * bassPulse);
  col += vec3(1.0, 0.45, 0.25) * corona;

  // Inner halo, brightens with mids.
  float halo = exp(-sdist * 4.5) * (0.45 + 0.4 * u_mid);
  vec3 haloCol = mix(vec3(1.0, 0.35, 0.55), vec3(1.0, 0.75, 0.30), 0.5 + 0.5 * sin(u_time * 0.4));
  col += haloCol * halo;

  // Sun disc with vertical gradient (yellow top -> magenta bottom).
  float sunMask = smoothstep(sunR, sunR - 0.005, sdist);
  vec3 sunGrad = mix(vec3(1.0, 0.25, 0.55), vec3(1.0, 0.90, 0.35), (sd.y / sunR) * 0.5 + 0.5);

  // Horizontal slices, but their phase scrolls vertically over time and jitters with bass —
  // sells the heat-distortion: the bands look like they're rising off the surface.
  float sliceY = (sd.y + sunR) / (sunR * 1.2); // 0 at bottom, ~1 toward top
  float sliceMask = step(sliceY, 0.6);
  float sliceFreq = 22.0 - sliceY * 14.0;
  // Phase shift: scroll up + a small bass jitter.
  float slicePhase = u_time * 0.35 + bassPulse * 0.4;
  float slice = step(0.5, fract((sliceY + slicePhase * 0.05) * sliceFreq));
  float cut = sliceMask * (1.0 - slice);

  col = mix(col, sunGrad, sunMask * (1.0 - cut));

  // ---------- TREBLE SCANLINE FLICKER ----------
  float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 1.8 + u_time * 12.0);
  float flicker = hash21(vec2(floor(gl_FragCoord.y), floor(u_time * 30.0)));
  col *= 1.0 - (0.18 * u_treble) * scan;
  col += vec3(0.05, 0.02, 0.08) * u_treble * flicker;

  // ---------- BLOOM-ISH BASS LIFT ----------
  col += vec3(0.10, 0.04, 0.18) * bassPulse;

  // Soft vignette to focus the eye on the horizon.
  float vig = smoothstep(1.3, 0.3, length(uv * vec2(0.9, 1.1)));
  col *= mix(0.7, 1.0, vig);

  // Tonemap so bass spikes don't clip to white.
  col = col / (1.0 + col * 0.85);

  outColor = vec4(col, 1.0);
}
