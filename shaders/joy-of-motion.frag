// joy-of-motion: an Animals As Leaders "Joy of Motion" tribute.
// One central iris/eye on a watercolor wash of crimson, rust, and burnt sienna.
// Fine radial filaments shoot outward from the core, each angle bound to one
// FFT bin so loud frequencies "shoot" longer rays. History sampling at
// increasing depth-with-radius gives the rays a slow trailing decay so they
// breathe instead of popping.
//
// Audio coupling
//   - u_bass slowly inflates the watercolor warp (the wash "blooms" outward).
//   - sampleFFT at angle drives ray length and brightness.
//   - sampleFFTHistory(angle, radius-as-depth) gives each ray a fading tail.

// ---- Hardcoded album palette ----------------------------------------------
// Hex refs (approx): #5a1010 deep crimson, #a04020 rust, #c66030 burnt sienna,
// #2a0808 maroon shadow, #3a8090 teal accent (core only).
const vec3 COL_SHADOW   = vec3(0.165, 0.030, 0.030);  // maroon/brown corner
const vec3 COL_CRIMSON  = vec3(0.353, 0.063, 0.063);  // deep crimson body
const vec3 COL_RUST     = vec3(0.628, 0.250, 0.125);  // rust orange mid
const vec3 COL_SIENNA   = vec3(0.776, 0.376, 0.188);  // burnt sienna highlight
const vec3 COL_TEAL     = vec3(0.227, 0.502, 0.565);  // teal core accent
const vec3 COL_WARM_HOT = vec3(1.000, 0.870, 0.690);  // warm white core

// Domain-warped fbm: gives the bleeding "wet on wet" feathered edges that a
// straight fbm can't. q is a low-frequency offset field; warpAmt scales how
// much it kicks the sample point. Returns a single 0..1 wash value.
float watercolor(vec2 p, float warpAmt, float warpScale) {
  vec2 q = vec2(
    fbm(p * warpScale + vec2(0.0, u_time * 0.018)),
    fbm(p * warpScale + vec2(4.7, -u_time * 0.014))
  );
  return fbm(p + warpAmt * (q - 0.5));
}

void main() {
  // Aspect-corrected, centered. Range roughly [-aspect/2..aspect/2] x [-0.5..0.5].
  vec2 p = (v_uv - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0);

  float r   = length(p);
  float ang = atan(p.y, p.x);             // -PI..PI
  float ang01 = ang / TAU + 0.5;          // 0..1 around the circle

  // -------- Background watercolor wash ------------------------------------
  // Bass slowly pushes the bleed outward. We smooth bass against a windowed
  // history mean so the wash "breathes" instead of jittering on transients.
  float bassPast = (
      sampleFFTHistory(0.05, 0.20) +
      sampleFFTHistory(0.05, 0.45) +
      sampleFFTHistory(0.10, 0.30) +
      sampleFFTHistory(0.10, 0.65)
  ) * 0.25;
  float bassEnv = mix(bassPast, u_bass, 0.55);
  bassEnv = smoothstep(0.0, 1.0, bassEnv);

  // Slow drift so the bg never freezes during silence.
  vec2 bgUV = p * 1.6 + vec2(u_time * 0.012, u_time * 0.009);
  float warpAmt   = 0.85 + 0.55 * bassEnv;     // bass blooms the bleed
  float warpScale = 0.85 - 0.20 * bassEnv;     // and slightly enlarges it
  float wash = watercolor(bgUV, warpAmt, warpScale);

  // Map the wash through the warm palette stops. Two layers blended so a
  // single fbm value doesn't read as a flat ramp — the second layer is a
  // higher-frequency wisp of darker crimson that overlays the base.
  vec3 bg = mix(COL_CRIMSON, COL_RUST,   smoothstep(0.30, 0.65, wash));
  bg      = mix(bg,          COL_SIENNA, smoothstep(0.62, 0.85, wash));
  // A second wisp pass — darker pools that creep over the wash.
  float wisp = fbm(bgUV * 2.3 + vec2(-u_time * 0.022, u_time * 0.018));
  bg = mix(bg, COL_CRIMSON * 0.55, smoothstep(0.55, 0.85, wisp) * 0.55);

  // Paper grain: high-freq deterministic noise multiplied at low amplitude.
  // Tied to gl_FragCoord so it's per-pixel, like real fiber texture.
  float grain = hash21(gl_FragCoord.xy + floor(u_time * 12.0)) - 0.5;
  bg *= 1.0 + 0.06 * grain;

  // Vignette toward the maroon shadow color (NOT black — the album's corners
  // are warm-dark, not void).
  float vigD = length(p * vec2(1.0, 1.15));
  float vig  = smoothstep(0.95, 0.20, vigD);
  bg = mix(COL_SHADOW, bg, vig);

  vec3 col = bg;

  // -------- Focal iris / spiral -------------------------------------------
  // Logarithmic spiral coordinate: combine angle with log(radius) so a fixed
  // spiral arm count traces an even curve from core to edge.
  float spinT = u_time * 0.07;
  float spiralAng = ang + 2.4 * log(max(r, 1e-3)) + spinT;
  // 5 arms — enough to feel like an iris without becoming a pinwheel.
  float arms = 0.5 + 0.5 * cos(5.0 * spiralAng);
  // Soften arms toward the edge so the spiral doesn't extend to the corners.
  arms *= smoothstep(0.55, 0.10, r);

  // Iris ring around the core: a soft annulus of brighter rust.
  float iris = exp(-pow((r - 0.085) * 14.0, 2.0));
  vec3 irisCol = mix(COL_RUST, COL_SIENNA, arms);
  col += irisCol * iris * 0.85;

  // Soft warm halo a bit further out — bridges core to bg.
  float halo = exp(-pow((r - 0.16) * 7.5, 2.0));
  col += COL_SIENNA * halo * 0.35 * (0.7 + 0.5 * arms);

  // -------- Solar flare filaments -----------------------------------------
  // For each pixel: read its angular FFT bin, plus a history-tailed sum at
  // increasing depth as radius grows. The "now" sample is freshest at the
  // core; deeper samples linger further out, producing trailing rays.
  //
  // Angular noise jitters the bin sample so rays look like organic filaments
  // rather than a clean polar bargraph. We add a fine angular-noise modulation
  // so adjacent pixels at the same angle get slightly different intensities.
  float angN = vnoise(vec2(ang01 * 220.0, u_time * 0.5)) - 0.5;  // fine jitter
  float angBin = fract(ang01 + angN * 0.0035);

  // History-blended FFT along this ray. Depth grows with radius — pixels
  // further from the core sample older spectra, so a shouted frequency leaves
  // a fading tail that reaches outward over ~0.6s.
  float depthAtR = clamp(r * 1.6, 0.0, 0.95);
  float fNow  = sampleFFT(angBin);
  float fMid  = sampleFFTHistory(angBin, depthAtR * 0.5);
  float fOld  = sampleFFTHistory(angBin, depthAtR);
  // Weighted toward "now" near the core, toward "old" near the edge.
  float wNow = 1.0 - depthAtR;
  float wOld = depthAtR;
  float energy = fNow * wNow + fMid * 0.6 + fOld * wOld;

  // Filament fineness: many thin rays. We carve thin angular slits using a
  // high-frequency angular pattern, modulated by a slow rotation so the
  // filaments aren't locked to fixed angles.
  float filamentFreq = 90.0;
  float filamentPhase = u_time * 0.18;
  float slit = abs(sin(ang * filamentFreq + filamentPhase + angN * 1.5));
  // Sharpen: most pixels are dark, only the thin peaks are bright.
  float filament = pow(slit, 14.0);

  // Radial shape: bright at the core, falling off fast. Use 1/r-style decay
  // softened so the core doesn't go infinite.
  float radialShape = 1.0 / (0.04 + r * r * 4.5);
  // Cap to avoid blowing the core to white before tonemap.
  radialShape = min(radialShape, 22.0);

  // Mask filaments to the iris area outward — don't draw them inside the
  // bright core (they'd just wash it out).
  float coreMask = smoothstep(0.018, 0.06, r);
  // And fade them out before the screen edge so the vignette stays clean.
  float edgeMask = smoothstep(0.65, 0.30, r);

  float rayBright = filament * radialShape * energy * coreMask * edgeMask;

  // Color the rays warm-white near core → orange → crimson at the tip.
  // Use radius (not r alone, since rays extend) for the gradient.
  vec3 rayCol = mix(COL_WARM_HOT, COL_SIENNA, smoothstep(0.0, 0.20, r));
  rayCol      = mix(rayCol,      COL_CRIMSON, smoothstep(0.20, 0.50, r));

  col += rayCol * rayBright * 0.35;

  // -------- Bright glowing core -------------------------------------------
  // Tight gaussian core with a teal-tinted center fading to warm white. The
  // teal is the *only* place in the frame the album's cyan accent shows up.
  float coreG = exp(-r * r * 520.0);
  float coreOuter = exp(-r * r * 90.0);
  vec3 coreCol = mix(COL_TEAL, COL_WARM_HOT, smoothstep(0.0, 0.018, r));
  col += coreCol * coreG * 1.4;
  col += COL_WARM_HOT * coreOuter * 0.35;

  // Volume gives a tiny global lift so quiet sections still feel alive.
  col *= 0.94 + 0.10 * u_volume;

  // Vignette pass over the whole composition (multiplicative, gentle) — the
  // bg already sits on COL_SHADOW so this just deepens the corners further.
  col *= mix(0.55, 1.0, vig);

  // Soft tonemap — preserves the painterly feel while preventing bass spikes
  // or stacked filaments from clipping to white.
  col = col / (1.0 + 0.85 * col);

  // Lift blacks slightly toward warm-dark instead of pure 0 — keeps the
  // album's painterly shadow feel.
  col = max(col, vec3(0.020, 0.008, 0.008));

  outColor = vec4(col, 1.0);
}
