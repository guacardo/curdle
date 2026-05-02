// dune-portals: surrealist desert with three drifting "alternate timeline" portals.
//
// One desert. Sunset-gradient sky, glowing sun, rolling Perlin dunes drawn as
// dense topographic contour lines, three obelisk portals floating along the
// horizon band. Each portal is a *lens* into the same scene under different
// world parameters — same dune geometry, same horizon, same sun *position* —
// so the viewer sees this exact desert at a different time / under a different
// sky. One portal: night (deep navy, pale moon, cool silver contour lines,
// sprinkle of stars). One: golden-hour (saturated orange/red sky, deep maroon
// contours). One: alien (teal sky, magenta sun, hue-shifted dunes).
//
// Portals drift around the horizon band on independent Lissajous paths so they
// never move in lockstep. Bass and mid subtly stretch the drift range and
// pulse the rim glow. Dunes still breathe with bass; treble still shimmers
// along the contour lines.
//
// Implementation: a single `WorldParams` struct + `sampleScene(uv, params)`
// renders the whole scene (sky, sun, dunes, contours, lotuses). The base call
// uses sunset params; each portal calls it again with its own variant params,
// guarded by a rectangle-SDF early-out so most pixels run sampleScene exactly
// once.

// ===== World parameter struct =============================================
// Everything that distinguishes "timelines" lives here. Geometry (dune
// heightfield, sun position, lotus positions) is shared — that's the whole
// point of the portal-as-lens conceit.
struct WorldParams {
  // Sky: three colour stops blended along a tilted diagonal.
  vec3 skyA;          // top-left
  vec3 skyB;          // mid
  vec3 skyC;          // bottom-right
  float skyTilt;      // diagonal weight; 0.55 is the sunset default
  // Sun / moon
  vec3 sunCore;       // tight disc tint
  vec3 sunHalo;       // close-in glow tint
  vec3 sunBloom;      // wide bloom tint
  float sunSize;      // 1.0 = baseline; <1 = smaller/dimmer (moon)
  float sunBright;    // overall sun multiplier (0..1+)
  // Dune body
  vec3 sandHi;        // crest-lit sand
  vec3 sandLo;        // valley-shadow sand
  // Contour lines
  vec3 lineDark;      // dark band
  vec3 lineLite;      // bright trailing edge
  float lineDarkAmt;  // mix amount for dark line band (0..1)
  // Stars in the sky region (night/galaxy variants enable this)
  float starDensity;  // 0 = none; 1 = packed
  vec3 starTint;
  // Optional secondary horizon body (alien second sun) — set bright=0 to skip
  vec2 sun2Pos;
  vec3 sun2Tint;
  float sun2Bright;
  // Lotus tint (silhouettes near the horizon)
  vec3 lotusCol;
  // Final per-variant colour-dodge lift (0 = none). Pushes mids toward bloom,
  // gives a bleached print-screen look. Used sparingly.
  float dodgeAmt;
};

// Build the base sunset params (the outer world).
WorldParams sunsetParams() {
  WorldParams p;
  p.skyA       = vec3(0.92, 0.32, 0.62);   // hot magenta
  p.skyB       = vec3(0.78, 0.18, 0.30);   // wine
  p.skyC       = vec3(0.98, 0.62, 0.28);   // amber
  p.skyTilt    = 0.55;
  p.sunCore    = vec3(1.00, 0.95, 0.86);
  p.sunHalo    = vec3(1.00, 0.78, 0.55);
  p.sunBloom   = vec3(0.95, 0.45, 0.35);
  p.sunSize    = 1.00;
  p.sunBright  = 1.00;
  p.sandHi     = vec3(0.86, 0.55, 0.32);
  p.sandLo     = vec3(0.42, 0.18, 0.22);
  p.lineDark   = vec3(0.30, 0.10, 0.08);   // implicit via sand*0.45 — kept for variants
  p.lineLite   = vec3(1.00, 0.82, 0.55);
  p.lineDarkAmt= 0.85;
  p.starDensity= 0.0;
  p.starTint   = vec3(1.0);
  p.sun2Pos    = vec2(0.0);
  p.sun2Tint   = vec3(0.0);
  p.sun2Bright = 0.0;
  p.lotusCol   = vec3(0.96, 0.62, 0.74);
  p.dodgeAmt   = 0.0;
  return p;
}

// Night-dune variant: same dunes, deep-navy sky, pale cool moon, cool silver
// contour lines, sprinkle of stars.
WorldParams nightParams() {
  WorldParams p = sunsetParams();
  p.skyA       = vec3(0.04, 0.05, 0.14);   // near-black top-left
  p.skyB       = vec3(0.05, 0.08, 0.22);   // deep navy mid
  p.skyC       = vec3(0.10, 0.14, 0.30);   // slate horizon
  p.skyTilt    = 0.40;
  p.sunCore    = vec3(0.92, 0.94, 1.00);   // cool moon disc
  p.sunHalo    = vec3(0.55, 0.62, 0.78);
  p.sunBloom   = vec3(0.18, 0.22, 0.36);
  p.sunSize    = 0.78;
  p.sunBright  = 0.65;
  p.sandHi     = vec3(0.22, 0.26, 0.36);   // moonlit sand
  p.sandLo     = vec3(0.06, 0.08, 0.14);
  p.lineDark   = vec3(0.02, 0.04, 0.10);
  p.lineLite   = vec3(0.70, 0.82, 0.95);   // silver/cyan grooves
  p.lineDarkAmt= 0.78;
  p.starDensity= 1.0;
  p.starTint   = vec3(0.92, 0.95, 1.00);
  p.lotusCol   = vec3(0.55, 0.60, 0.78);
  return p;
}

// Golden-hour variant: hotter saturated reds, deep maroon contours, longer
// bloom. Same sun position, same dunes.
WorldParams goldenParams() {
  WorldParams p = sunsetParams();
  p.skyA       = vec3(1.00, 0.45, 0.20);   // searing orange top-left
  p.skyB       = vec3(0.85, 0.18, 0.20);   // crimson
  p.skyC       = vec3(1.00, 0.78, 0.32);   // hot gold horizon
  p.skyTilt    = 0.60;
  p.sunCore    = vec3(1.00, 0.92, 0.70);
  p.sunHalo    = vec3(1.00, 0.55, 0.20);
  p.sunBloom   = vec3(1.00, 0.30, 0.10);
  p.sunSize    = 1.20;                     // bigger, fatter bloom
  p.sunBright  = 1.15;
  p.sandHi     = vec3(0.95, 0.50, 0.22);
  p.sandLo     = vec3(0.30, 0.06, 0.10);
  p.lineDark   = vec3(0.20, 0.02, 0.04);   // deep maroon grooves
  p.lineLite   = vec3(1.00, 0.70, 0.32);
  p.lineDarkAmt= 0.90;
  p.lotusCol   = vec3(1.00, 0.50, 0.55);
  p.dodgeAmt   = 0.18;                     // mild bleached lift
  return p;
}

// Alien variant: teal/green sky, magenta sun, banded gas-giant on the horizon.
WorldParams alienParams() {
  WorldParams p = sunsetParams();
  p.skyA       = vec3(0.10, 0.55, 0.55);   // teal top-left
  p.skyB       = vec3(0.05, 0.30, 0.42);   // deep sea-green
  p.skyC       = vec3(0.40, 0.85, 0.68);   // mint horizon
  p.skyTilt    = 0.50;
  p.sunCore    = vec3(1.00, 0.72, 0.92);
  p.sunHalo    = vec3(0.95, 0.30, 0.78);   // magenta sun
  p.sunBloom   = vec3(0.55, 0.10, 0.60);
  p.sunSize    = 0.95;
  p.sunBright  = 1.00;
  p.sandHi     = vec3(0.55, 0.70, 0.45);   // hue-shifted dunes
  p.sandLo     = vec3(0.10, 0.20, 0.25);
  p.lineDark   = vec3(0.04, 0.10, 0.12);
  p.lineLite   = vec3(0.85, 1.00, 0.70);
  p.lineDarkAmt= 0.80;
  p.starDensity= 0.45;
  p.starTint   = vec3(0.85, 1.00, 0.80);
  p.sun2Pos    = vec2(0.42, 0.10);          // banded gas-giant on the horizon
  p.sun2Tint   = vec3(0.95, 0.55, 0.30);
  p.sun2Bright = 0.55;
  p.lotusCol   = vec3(0.50, 1.00, 0.70);
  return p;
}

// ===== Geometry — shared across all variants ==============================
// Dune crest height (uv.y) at horizontal x. Same heightfield in every variant.
float duneHeight(float x, float t, float bassAmp) {
  float base = -0.18 + 0.10 * sin(x * 1.20 + t * 0.18)
                     + 0.06 * sin(x * 0.55 - t * 0.11 + 1.7);
  float n1 = vnoise(vec2(x * 1.8 + t * 0.25,  t * 0.15));
  float n2 = vnoise(vec2(x * 4.6 - t * 0.18,  t * 0.22 + 3.1));
  float undulation = (n1 - 0.5) * 0.085 + (n2 - 0.5) * 0.035;
  return base + undulation * (1.0 + 0.7 * bassAmp);
}

// Shared sun position — every timeline sees the sun in the same spot. That's
// what makes the portals read as "same world, different time".
vec2 sunPosWorld() { return vec2(-0.36, 0.30); }

// ===== Sky / sun / stars / dunes — each takes a WorldParams ===============

vec3 evalSky(vec2 uv, WorldParams p) {
  float g = clamp(0.5 + p.skyTilt * (uv.x - uv.y), 0.0, 1.0);
  vec3 lo = mix(p.skyA, p.skyB, smoothstep(0.0, 0.55, g));
  return    mix(lo,    p.skyC, smoothstep(0.45, 1.0, g));
}

vec3 evalSun(vec2 uv, float pulse, WorldParams p) {
  vec2 sp = sunPosWorld();
  float d = length(uv - sp);
  // Sun size scales the falloff distances.
  float sz = p.sunSize;
  float core  = smoothstep(0.055 * sz, 0.025 * sz, d);
  float halo  = smoothstep(0.30  * sz, 0.06  * sz, d);
  float bloom = smoothstep(0.85  * sz, 0.10  * sz, d);
  vec3 c = p.sunCore * core
         + p.sunHalo * halo  * (0.55 + 0.25 * pulse)
         + p.sunBloom * bloom * (0.20 + 0.18 * pulse);
  return c * p.sunBright;
}

// Optional second sun / gas-giant on the horizon for the alien variant.
vec3 evalSun2(vec2 uv, WorldParams p) {
  if (p.sun2Bright <= 0.001) return vec3(0.0);
  float d = length((uv - p.sun2Pos) / vec2(1.0, 0.85));
  float disc = smoothstep(0.075, 0.045, d);
  float halo = smoothstep(0.18, 0.06, d);
  // Faint horizontal banding so it reads as a gas-giant, not just a disc.
  float bands = 0.5 + 0.5 * sin((uv.y - p.sun2Pos.y) * 90.0);
  vec3 col = p.sun2Tint * disc * (0.7 + 0.3 * bands)
           + p.sun2Tint * 0.5 * halo;
  return col * p.sun2Bright;
}

// Hashed star field over the sky region. Density 0..1.
vec3 evalStars(vec2 uv, float t, float horizonY, WorldParams p) {
  if (p.starDensity <= 0.001) return vec3(0.0);
  // Only above the dune horizon (no stars in the sand).
  if (uv.y < horizonY) return vec3(0.0);
  vec2 grid = (uv + vec2(2.0, 1.0)) * vec2(80.0, 110.0);
  vec2 gi = floor(grid);
  vec2 gf = fract(grid) - 0.5;
  float h = hash21(gi);
  float threshold = mix(0.995, 0.965, p.starDensity);
  float starExists = step(threshold, h);
  float twinkle = 0.5 + 0.5 * sin(t * 1.6 + h * 31.4);
  float starD = length(gf);
  float star = smoothstep(0.32, 0.0, starD) * starExists * (0.4 + 0.6 * twinkle);
  // Fade stars near the horizon so they don't crowd the dune crest.
  float horizonFade = smoothstep(horizonY, horizonY + 0.10, uv.y);
  return p.starTint * star * horizonFade;
}

// Sand body + topographic contour lines + crest highlight. Returns the
// fully-shaded sand colour for a fragment that is below the dune horizon.
vec3 evalDunes(vec2 uv, float t, float bassAmp, float trbAmp, float horizonY, WorldParams p) {
  float depth = horizonY - uv.y;     // 0 at crest

  float bodyN = vnoise(vec2(uv.x * 2.0, uv.y * 3.0 + t * 0.05));
  vec3 sand = mix(p.sandHi, p.sandLo, smoothstep(0.0, 0.45, depth));
  sand *= 0.92 + 0.10 * bodyN;

  // Layered contour field: depth + a finer noise shift, so lines visibly
  // ripple as the dune surface breathes.
  float fineN = vnoise(vec2(uv.x * 5.0 - t * 0.12, uv.y * 7.0 + t * 0.09));
  float layered = depth + (fineN - 0.5) * 0.06;

  float lineFreq = 90.0;
  lineFreq *= 1.0 + 0.04 * trbAmp * sin(uv.x * 30.0 + t * 4.0);

  float stripe = abs(fract(layered * lineFreq) - 0.5) * 2.0;
  float lineMask = smoothstep(0.20, 0.0, stripe);

  // Per-variant line tint. Default (sunset) keeps the original "darken sand"
  // feel by mixing toward a tinted dark; other variants mix toward an
  // explicit lineDark (cool silver / maroon / alien).
  vec3 darkBand = mix(sand * 0.45, p.lineDark, 0.55);
  vec3 sandWithLines = mix(sand, darkBand, lineMask * p.lineDarkAmt);
  // Thin highlight just outside the dark line.
  float hlMask = smoothstep(0.22, 0.32, stripe) * smoothstep(0.42, 0.32, stripe);
  sandWithLines = mix(sandWithLines, p.lineLite, hlMask * 0.32);

  // Treble shimmer.
  float shimmer = lineMask * trbAmp * 0.35;
  sandWithLines += p.lineLite * shimmer * (0.5 + 0.5 * sin(uv.x * 45.0 + t * 6.0));

  // Crest highlight — thin bright rim at the dune top.
  float crest = smoothstep(0.012, 0.0, depth);
  sandWithLines += mix(p.sunHalo, vec3(1.0), 0.3) * crest * 0.45;

  return sandWithLines;
}

// Lotus silhouettes along the horizon. Same 3 positions, variant-tinted.
vec3 applyLotuses(vec3 col, vec2 uv, float t, float bassAmp, float aa, WorldParams p) {
  // Three fixed x positions.
  float xs[3];   xs[0] = -0.18; xs[1] =  0.16; xs[2] =  0.45;
  float rs[3];   rs[0] =  0.020; rs[1] = 0.026; rs[2] = 0.018;
  for (int i = 0; i < 3; i++) {
    float lx = xs[i];
    float lr = rs[i];
    float duneAtLx = duneHeight(lx, t, bassAmp);
    vec2 lc = vec2(lx, duneAtLx + lr * 0.55);
    float ld = length(uv - lc) - lr;
    float aboveDune = step(duneHeight(uv.x, t, bassAmp), uv.y);
    float lm = smoothstep(aa, -aa, ld) * aboveDune;
    col = mix(col, p.lotusCol, lm * 0.85);
  }
  return col;
}

// ===== Top-level scene sampler ============================================
// One call renders the whole desert under the given params. Used both for
// the base world and (per portal) for the alternate-timeline lens content.
vec3 sampleScene(vec2 uv, float t, float bassAmp, float midAmp, float trbAmp,
                 float aa, float sunPulse, WorldParams p) {
  vec3 col = evalSky(uv, p);
  col += evalSun(uv, sunPulse, p);
  col += evalSun2(uv, p);

  float horizonY = duneHeight(uv.x, t, bassAmp);
  col += evalStars(uv, t, horizonY, p);

  // Lotuses sit above the horizon.
  col = applyLotuses(col, uv, t, bassAmp, aa, p);

  // Sand body + contours below the horizon — replaces the sky entirely.
  if (uv.y < horizonY) {
    col = evalDunes(uv, t, bassAmp, trbAmp, horizonY, p);
  }

  // Optional final colour-dodge lift (golden variant). Bleached print look:
  //   c' = c / (1 - amt*c), clamped. Cheap and visually distinctive.
  if (p.dodgeAmt > 0.001) {
    vec3 lifted = col / max(1.0 - p.dodgeAmt * col, vec3(0.05));
    col = mix(col, clamp(lifted, 0.0, 1.5), 0.6);
  }

  return col;
}

// ===== Portal SDF helpers =================================================
float sdBox(vec2 p, vec2 center, vec2 halfSize) {
  vec2 d = abs(p - center) - halfSize;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  float t = u_time;
  float bassAmp = smoothstep(0.0, 1.0, u_bass);
  float midAmp  = smoothstep(0.0, 1.0, u_mid);
  float trbAmp  = smoothstep(0.0, 1.0, u_treble);
  float aa = 1.5 / min(u_resolution.x, u_resolution.y);

  // Slow sun pulse — time-driven first, bass adds a kick.
  float sunPulse = 0.5 + 0.5 * sin(t * 0.4) + 0.4 * bassAmp;

  // ---- Base sunset world -------------------------------------------------
  WorldParams sunset = sunsetParams();
  vec3 col = sampleScene(uv, t, bassAmp, midAmp, trbAmp, aa, sunPulse, sunset);

  // ---- Portal placements: independent Lissajous drift --------------------
  // All three portals stay roughly in the upper half / horizon band so the
  // composition reads. Audio modulates drift range and speed slightly.
  float driveSpeed = 1.0 + 0.35 * midAmp;
  float driveRange = 1.0 + 0.30 * bassAmp;

  // Portal 0 — left-leaning ellipse, slow.
  vec2 c0 = vec2(
    -0.32 + 0.14 * driveRange * sin(t * 0.18 * driveSpeed),
     0.06 + 0.05 * driveRange * cos(t * 0.27 * driveSpeed + 0.7)
  );
  // Portal 1 — center figure-eight (Lissajous 2:3).
  vec2 c1 = vec2(
     0.00 + 0.18 * driveRange * sin(t * 0.13 * driveSpeed + 1.1),
     0.10 + 0.06 * driveRange * sin(t * 0.21 * driveSpeed * 1.5 + 2.4)
  );
  // Portal 2 — right-leaning, faster, tighter.
  vec2 c2 = vec2(
     0.32 + 0.12 * driveRange * cos(t * 0.23 * driveSpeed + 2.0),
     0.05 + 0.04 * driveRange * sin(t * 0.31 * driveSpeed + 0.3)
  );

  // Per-portal width-breathing — tilts the obelisk feel without rotating the
  // contained scene (rotating the lens would break the "same sun position"
  // illusion).
  float h0w = 0.038 * (1.0 + 0.10 * sin(t * 0.55));
  float h1w = 0.046 * (1.0 + 0.08 * sin(t * 0.42 + 1.2) + 0.05 * midAmp);
  float h2w = 0.036 * (1.0 + 0.12 * sin(t * 0.63 + 2.5));
  vec2 h0 = vec2(h0w, 0.165);
  vec2 h1 = vec2(h1w, 0.205);
  vec2 h2 = vec2(h2w, 0.155);

  // Audio-pulsed rim brightness — same factor for all portals so they breathe
  // together even though they drift independently.
  float rimPulse = 0.6 + 0.4 * sin(t * 1.3) + 0.5 * bassAmp;

  // Portal 0 — NIGHT DUNE.
  {
    float d = sdBox(uv, c0, h0);
    float m = smoothstep(aa, -aa, d);
    if (m > 0.001) {
      WorldParams pp = nightParams();
      vec3 pc = sampleScene(uv, t, bassAmp, midAmp, trbAmp, aa, sunPulse, pp);
      // Glowing rim — cool blue-silver to match the night palette.
      float rimBand = smoothstep(aa * 3.0, aa, abs(d));   // 1 on the edge, 0 inside
      vec3 rimCol = vec3(0.55, 0.75, 1.00) * (0.9 + 0.6 * rimPulse);
      pc += rimCol * rimBand * 0.55;
      col = mix(col, pc, m);
    }
  }
  // Portal 1 — GOLDEN HOUR.
  {
    float d = sdBox(uv, c1, h1);
    float m = smoothstep(aa, -aa, d);
    if (m > 0.001) {
      WorldParams pp = goldenParams();
      vec3 pc = sampleScene(uv, t, bassAmp, midAmp, trbAmp, aa, sunPulse, pp);
      float rimBand = smoothstep(aa * 3.0, aa, abs(d));
      vec3 rimCol = vec3(1.00, 0.75, 0.30) * (0.9 + 0.6 * rimPulse);
      pc += rimCol * rimBand * 0.65;
      col = mix(col, pc, m);
    }
  }
  // Portal 2 — ALIEN GALAXY.
  {
    float d = sdBox(uv, c2, h2);
    float m = smoothstep(aa, -aa, d);
    if (m > 0.001) {
      WorldParams pp = alienParams();
      vec3 pc = sampleScene(uv, t, bassAmp, midAmp, trbAmp, aa, sunPulse, pp);
      float rimBand = smoothstep(aa * 3.0, aa, abs(d));
      vec3 rimCol = vec3(0.85, 0.30, 0.90) * (0.9 + 0.6 * rimPulse);
      pc += rimCol * rimBand * 0.60;
      col = mix(col, pc, m);
    }
  }

  // ---- Risograph / vintage finish ----------------------------------------
  float grainSlot = floor(t * 24.0);
  float grain = hash21(gl_FragCoord.xy + grainSlot * 1.31) - 0.5;
  col += vec3(0.030, 0.022, 0.018) * grain;

  // Gentle banding/posterization.
  col = floor(col * 32.0 + 0.5) / 32.0;

  // Soft vignette toward corners.
  float vig = smoothstep(1.10, 0.30, length(uv));
  col *= mix(0.80, 1.0, vig);

  // Tonemap so bass-driven sun bloom never blows to white.
  col = col / (1.0 + 0.55 * col);

  // Lift blacks toward a warm dark — printed-paper feel.
  col = max(col, vec3(0.022, 0.018, 0.026));

  outColor = vec4(col, 1.0);
}
