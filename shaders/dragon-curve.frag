// dragon-curve: the Heighway dragon, drawn segment-by-segment as a glowing
// neon polyline that *grows* out of the origin in time. Each segment is laid
// down by walking the L-system: at step k the turn is L or R depending on the
// bit just above the lowest set bit of k. The result is the unmistakable
// recursive L-shape of the dragon, not a generic squiggle.
//
// Four temporal layers stacked on screen:
//   - Live curve (full intensity, freshest segments hyper-bright at the tip).
//   - Three "ghost stamps" — copies of the curve at past beat moments, each
//     rotated/scaled/hue-shifted, fading with age. Since fragment shaders
//     can't accumulate state, we *resample the FFT history* at each ghost's
//     birth time to know how much energy to draw it with — bigger past beat
//     means brighter lingering ghost. Stamps slot every BEAT_PERIOD seconds
//     so the screen builds up a layered, drumpattern-locked echo pile.
//
// PERF: the L-system walk (heading + position update + turn lookup) is the
// expensive part — but it's identical regardless of which transformed pixel
// we're querying. So we run a SINGLE walk and, at each step, evaluate all 4
// layers' distances against the same segment endpoints in lockstep. Cuts
// heading math 4x vs running 4 separate walks.
//
// Audio coupling
//   - u_bass:   speeds curve growth + thickens the live trace + brightens the
//               most-recent ghost stamp's origin halo.
//   - u_treble: per-pixel sparkle dust on top of the canvas.
//   - u_mid:    drives the bloom halo radius around the live curve.
//   - sampleFFTHistory(0.05, t) at ghost birth time → that ghost's brightness.

// ---- Tuneables --------------------------------------------------------------
// 256 segments × 4 layers (1 live + 3 ghosts), shared loop = 256 iterations
// of (turn lookup + position update) + 4 segment SDF evals per iter.
#define MAX_SEGMENTS 256
#define BEAT_PERIOD  0.55        // seconds between ghost slots (~109 BPM)

// ---- L-system turn -----------------------------------------------------------
// Heighway dragon turn at 1-indexed step k. Classic identity:
//   turn(k) = ((((k & -k) << 1) & k) == 0) ? +1 : -1
// (+1 = left turn, -1 = right turn).
float dragonTurn(int k) {
  int low = k & -k;          // isolate lowest set bit
  int nxt = (low << 1) & k;  // bit just above it within k
  return (nxt == 0) ? 1.0 : -1.0;
}

// ---- Segment SDF -------------------------------------------------------------
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// ---- Pre-transform query helper ---------------------------------------------
// Each layer renders the dragon at a different rotation/scale around screen
// center. We bake those into the *query point* (not the curve) so we can
// reuse one curve walk for all layers. `worldScale` is shared — same dragon
// size, different framing.
//
// q = (rot * uv * scale) / worldScale + centroidShift
//   centroidShift centers the figure (dragon naturally grows into one quadrant).
vec2 queryPt(vec2 uv, float ang, float scale, float worldScale, vec2 centroidShift) {
  return (rot2d(ang) * uv * scale) / worldScale + centroidShift;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Growth animation (live curve length) ------------------------------
  // Curve grows monotonically from 0 → MAX_SEGMENTS over GROW_PERIOD seconds
  // and then plateaus at full length forever. The whole point is to watch
  // the self-similar Heighway structure emerge as the segment count crosses
  // each power of two (4 → 8 → 16 → 32 → 64 → 128 → 256), so we never reset.
  // Bass briefly accelerates the leading edge — the curve "lurches" forward
  // on kicks during the growth phase, then has no effect once full.
  float GROW_PERIOD = 140.0;
  float baseT = clamp(u_time / GROW_PERIOD, 0.0, 1.0);
  float eased = smoothstep(0.0, 1.0, baseT);
  float bassPush = 0.06 * pow(u_bass, 1.4);
  float liveLen = clamp(eased + bassPush, 0.0, 1.0) * float(MAX_SEGMENTS);

  // ---- Pass 1: bbox of currently-revealed segments -----------------------
  // The dragon's centroid changes a lot as it grows, so a constant offset
  // misses the figure during early/mid growth. Walk the curve once just to
  // find the live bbox; pass 2 (below) uses it for camera framing.
  vec2 lo = vec2( 1e9);
  vec2 hi = vec2(-1e9);
  {
    vec2 pPos = vec2(0.0);
    vec2 pDir = vec2(1.0, 0.0);
    lo = min(lo, pPos);
    hi = max(hi, pPos);
    for (int i = 1; i <= MAX_SEGMENTS; i++) {
      vec2 a = pPos;
      vec2 b = pPos + pDir;
      float rev = clamp(liveLen - float(i - 1), 0.0, 1.0);
      if (rev > 0.0) {
        vec2 bDraw = mix(a, b, rev);
        lo = min(lo, bDraw);
        hi = max(hi, bDraw);
      }
      pPos = b;
      float t = dragonTurn(i);
      pDir = vec2(-t * pDir.y, t * pDir.x);
    }
  }
  vec2 bboxSize = max(hi - lo, vec2(4.0));
  float aspect = u_resolution.x / u_resolution.y;
  // Fit the bbox into ~85% of the smaller viewport axis.
  float worldScale = 0.85 / max(bboxSize.y, bboxSize.x / aspect);
  // Camera target = bbox center (snap so per-frame jitter from `rev` clamping
  // doesn't show as wobble).
  vec2 centroidShift = 0.5 * (lo + hi);

  // ---- Triadic palette base (shared rotating hue) ------------------------
  float baseHue = triadHue(0.10);
  vec3 hueLive  = hsl2rgb(baseHue,                       1.0, 0.58);
  vec3 hueG0    = hsl2rgb(fract(baseHue + 1.0 / 3.0),    1.0, 0.55);
  vec3 hueG1    = hsl2rgb(fract(baseHue + 2.0 / 3.0),    1.0, 0.55);
  vec3 hueG2    = hsl2rgb(fract(baseHue + 1.0 / 6.0),    1.0, 0.50);

  // ---- Pre-transform query points for each layer -------------------------
  // Layer 0: live (no rotation, scale 1).
  // Layers 1-3: ghosts, each at a different rotation & scale around center.
  vec2 qLive = queryPt(uv,  0.00, 1.00, worldScale, centroidShift);
  vec2 qG0   = queryPt(uv,  0.18, 1.05, worldScale, centroidShift);
  vec2 qG1   = queryPt(uv, -0.34, 0.90, worldScale, centroidShift);
  vec2 qG2   = queryPt(uv,  0.55, 0.78, worldScale, centroidShift);

  // ---- Per-layer effective curve length ----------------------------------
  // Each ghost trails the live tip by a fixed lag so the echoes visibly read
  // as "earlier" snapshots — not just rotated copies of the present.
  float lenLive = liveLen;
  float lenG0   = max(liveLen -  8.0, 0.0);
  float lenG1   = max(liveLen - 18.0, 0.0);
  float lenG2   = max(liveLen - 32.0, 0.0);

  // ---- Best-distance + freshness accumulators per layer ------------------
  float dLive = 1e3, fLive = 0.0;
  float dG0   = 1e3;
  float dG1   = 1e3;
  float dG2   = 1e3;

  // ---- Shared L-system walk ----------------------------------------------
  // One pass advances heading once per segment; we evaluate all 4 query points
  // against each segment in the same iteration.
  vec2 pos = vec2(0.0);
  vec2 dir = vec2(1.0, 0.0);
  for (int i = 1; i <= MAX_SEGMENTS; i++) {
    vec2 a = pos;
    vec2 b = pos + dir;

    // Per-layer reveal: each layer has its own current length.
    float fi = float(i - 1);
    float revLive = clamp(lenLive - fi, 0.0, 1.0);
    float revG0   = clamp(lenG0   - fi, 0.0, 1.0);
    float revG1   = clamp(lenG1   - fi, 0.0, 1.0);
    float revG2   = clamp(lenG2   - fi, 0.0, 1.0);

    // Live (always evaluate the segment so the freshness logic stays accurate).
    if (revLive > 0.0) {
      vec2 bDraw = mix(a, b, revLive);
      float d = sdSegment(qLive, a, bDraw);
      if (d < dLive) {
        dLive = d;
        // Freshness: 1 at the live tip, fading over ~30 segments behind it.
        fLive = clamp(1.0 - (lenLive - float(i)) / 30.0, 0.0, 1.0);
      }
    }
    if (revG0 > 0.0) {
      vec2 bDraw = mix(a, b, revG0);
      dG0 = min(dG0, sdSegment(qG0, a, bDraw));
    }
    if (revG1 > 0.0) {
      vec2 bDraw = mix(a, b, revG1);
      dG1 = min(dG1, sdSegment(qG1, a, bDraw));
    }
    if (revG2 > 0.0) {
      vec2 bDraw = mix(a, b, revG2);
      dG2 = min(dG2, sdSegment(qG2, a, bDraw));
    }

    // Advance heading: turn applies AT the joint between segment i and i+1.
    pos = b;
    float t = dragonTurn(i);
    dir = vec2(-t * dir.y, t * dir.x);     // 90 deg rotation by sign(t)
  }

  // Distances were in dragon-local units; convert back to screen units.
  dLive *= worldScale;
  dG0   *= worldScale;
  dG1   *= worldScale;
  dG2   *= worldScale;

  // ---- Ghost intensities from FFT history --------------------------------
  // Each ghost was "stamped" k * BEAT_PERIOD seconds ago — read the bass
  // energy at that moment and use it as the ghost's brightness. A thumping
  // past kick leaves a brighter, longer-lived echo. The exp() decay layered
  // on top makes older stamps fade even when bass was loud throughout.
  float age0 = 1.0 * BEAT_PERIOD;
  float age1 = 2.0 * BEAT_PERIOD;
  float age2 = 3.0 * BEAT_PERIOD;
  float intG0 = pow(sampleFFTHistory(0.05, clamp(age0, 0.0, 1.0)), 1.4) * 0.85 * exp(-age0 * 1.20);
  float intG1 = pow(sampleFFTHistory(0.05, clamp(age1, 0.0, 1.0)), 1.4) * 0.65 * exp(-age1 * 1.00);
  float intG2 = pow(sampleFFTHistory(0.05, clamp(age2, 0.0, 1.0)), 1.4) * 0.50 * exp(-age2 * 0.85);

  // ---- Background --------------------------------------------------------
  vec3 bgDark   = vec3(0.030, 0.012, 0.060);
  vec3 bgLight  = vec3(0.075, 0.025, 0.110);
  float bgN = vnoise(uv * 3.0 + u_time * 0.04);
  vec3 col = mix(bgDark, bgLight, bgN);
  // Faint horizon glow tinted by current triad — keeps the screen alive in
  // silence and ties bg color to the live trace.
  float hor = exp(-pow(uv.y * 1.6, 2.0));
  col += hueLive * hor * 0.06;

  // ---- Treble sparkle dust (per-pixel) -----------------------------------
  float spark = hash21(gl_FragCoord.xy + floor(u_time * 18.0)) - 0.92;
  col += vec3(1.0) * max(spark, 0.0) * u_treble * 0.6;

  // ---- Composite ghosts (oldest first, so newest sits on top) ------------
  // Each ghost: thin core + soft halo, no per-segment freshness (they read as
  // settled echoes, not actively-drawing curves).
  // Ghost 2 (oldest).
  {
    float aa = max(fwidth(dG2), 0.0008);
    float w = 0.0028;
    float core = 1.0 - smoothstep(w - aa, w + aa, dG2);
    float halo = exp(-dG2 * dG2 / (0.08 * 0.08));
    col += (hueG2 * core * 1.2 + hueG2 * halo * 0.55) * intG2;
  }
  // Ghost 1.
  {
    float aa = max(fwidth(dG1), 0.0008);
    float w = 0.0030;
    float core = 1.0 - smoothstep(w - aa, w + aa, dG1);
    float halo = exp(-dG1 * dG1 / (0.07 * 0.07));
    col += (hueG1 * core * 1.2 + hueG1 * halo * 0.55) * intG1;
  }
  // Ghost 0 (most recent past beat).
  {
    float aa = max(fwidth(dG0), 0.0008);
    float w = 0.0035;
    float core = 1.0 - smoothstep(w - aa, w + aa, dG0);
    float halo = exp(-dG0 * dG0 / (0.06 * 0.06));
    col += (hueG0 * core * 1.2 + hueG0 * halo * 0.55) * intG0;
  }

  // ---- Composite live curve (on top, with tip white-hot) -----------------
  {
    float widthJitter = 0.0010 * u_treble;
    float w = 0.0050 + widthJitter;
    float aa = max(fwidth(dLive), 0.0008);
    float core = 1.0 - smoothstep(w - aa, w + aa, dLive);
    float haloR = mix(0.045, 0.085, u_mid);
    float halo = exp(-dLive * dLive / max(haloR * haloR, 1e-5));
    vec3 tipCol = mix(hueLive, vec3(1.0), 0.7);
    vec3 lit = mix(hueLive, tipCol, fLive);
    float liveBoost = 1.0 + 0.6 * u_bass;
    col += (lit * core * (1.0 + 1.5 * fLive) + hueLive * halo * 0.55) * liveBoost;
  }

  // ---- Origin spawn flash (early in cycle, lets you see the seed point) --
  vec2 originUV = uv;            // origin is at uv=0 by construction (centroid baked into qLive)
  // Actually: the origin in dragon-space is at -centroidShift after the inverse
  // transform, which maps to screen point: -centroidShift * worldScale (no rot).
  vec2 originScreen = -centroidShift * worldScale;
  float originGlow = exp(-dot(uv - originScreen, uv - originScreen) * 80.0);
  col += hueLive * originGlow * (0.25 + 0.6 * u_bass) * (1.0 - smoothstep(0.0, 0.15, baseT));

  // ---- Vignette ----------------------------------------------------------
  float r = length(uv);
  float vig = smoothstep(1.25, 0.20, r);
  col *= mix(0.45, 1.0, vig);

  // ---- Tonemap -----------------------------------------------------------
  col = col / (1.0 + 0.7 * col);

  // Lift blacks toward the bruise-purple so the canvas never reads as void.
  col = max(col, vec3(0.012, 0.005, 0.022));

  outColor = vec4(col, 1.0);
}
