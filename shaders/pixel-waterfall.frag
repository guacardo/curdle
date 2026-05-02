// pixel-waterfall: a chunky-pixel curtain of falling water.
// - Screen quantized into ~140-wide pixel cells; hard pixel edges, no AA.
// - 13 continuous vertical streams spread across the width — always present.
// - One shared global sin-wobble sways every column the same way (wind).
// - 4-tone cel palette: deep teal -> mid blue -> bright cyan -> near-white foam.
// - Misty headwater band at the top; foamy splash basin at the bottom.
// - Bass thickens stream columns and accelerates the fall speed.
// - Treble seeds bright sparkle pixels through the spray.

#define PIXEL_W       140.0   // grid width in chunky pixels
#define STREAM_COUNT  13.0    // continuous columns across the width
#define MIST_TOP      0.88    // pixC.y/pxH above this = headwater mist band
#define BASIN_BOT     0.18    // pixC.y/pxH below this = splash basin

// Fixed 4-tone water palette. Indexed 0..3 = shadow -> highlight -> foam.
vec3 waterTone(int k) {
  if (k <= 0) return vec3(0.04, 0.16, 0.28);   // deep teal (shadow)
  if (k == 1) return vec3(0.10, 0.38, 0.62);   // mid blue
  if (k == 2) return vec3(0.45, 0.85, 0.95);   // bright cyan (highlight)
  return            vec3(0.92, 0.98, 1.00);    // near-white foam
}

// Shared global wobble — same horizontal offset applied to every column.
// Two-frequency sin so the sway feels organic rather than metronomic.
float windWobble(float yGrid, float t) {
  float a = sin(t * 1.30 + yGrid * 0.18);
  float b = sin(t * 0.55 + yGrid * 0.07 + 1.7);
  return 0.85 * a + 0.55 * b;   // grid-pixel units of horizontal sway
}

void main() {
  vec2 res = u_resolution;
  float aspect = res.x / res.y;

  // 1) Quantize into chunky square pixels.
  vec2 cell = res / PIXEL_W;
  vec2 pix  = floor(gl_FragCoord.xy / cell.x);
  vec2 pixC = pix + 0.5;
  float pxH = PIXEL_W / aspect;

  // Normalized-ish coords used for banding/zones.
  float ny = pixC.y / pxH;        // 0 = bottom, 1ish = top
  float nx = pixC.x / PIXEL_W;

  // 2) Background — deep cool gradient (rocks behind the falls).
  vec3 col = mix(vec3(0.02, 0.05, 0.10), vec3(0.05, 0.10, 0.18), ny);

  // 3) Bass-modulated fall speed and column thickness.
  float fallSpeed = 18.0 + 22.0 * u_bass;     // grid-pixels per second
  float baseHalfW = 1.6 + 1.6 * u_bass;       // half-width of each column in pixels

  // 4) Shared wind wobble for this row. Y dependence makes the curtain
  //    ripple top-to-bottom rather than sliding rigidly.
  float wob = windWobble(pixC.y, u_time);

  // 5) For each chunky pixel, find the nearest stream column and decide if
  //    we're inside it. Columns are evenly spaced; centers shifted by `wob`.
  float streamSpacing = PIXEL_W / STREAM_COUNT;
  // Stream index whose center is closest to this x (after subtracting wobble).
  float xRel    = pixC.x - wob;
  float si      = floor(xRel / streamSpacing);
  float centerX = (si + 0.5) * streamSpacing + wob;
  float dx      = abs(pixC.x - centerX);

  // Per-stream tiny thickness variance — keeps columns looking hand-drawn,
  // but they're still continuous (no spawn/despawn).
  float thickJitter = 0.6 * (hash21(vec2(si, 3.0)) - 0.5);
  float halfW = baseHalfW + thickJitter;

  // Inside-column mask (hard edge).
  float inCol = step(dx, halfW);

  // 6) Vertical scrolling streaks within each column to imply downward flow.
  //    Use a per-column phase offset so streaks don't all line up horizontally.
  float colPhase  = hash21(vec2(si, 17.0)) * 50.0;
  float yScroll   = pixC.y + u_time * fallSpeed + colPhase;
  // Hash at chunky-pixel resolution along the column for a discrete streak pattern.
  float streakRow = floor(yScroll);
  float streakH   = hash21(vec2(si, streakRow));
  // Two thresholds = two brightness tiers within the column.
  float midStreak  = step(0.55, streakH);
  float highStreak = step(0.86, streakH);

  // Edge of the column (outermost pixel ring) reads as the shadow tone.
  float edgeMask = step(halfW - 0.6, dx);   // 1 only on the outer pixel of the column

  // 7) Resolve cel-shaded tone index for this pixel inside a column.
  //    Default = mid blue (1). Streaks bump to cyan (2) or foam (3). Edge = teal (0).
  int tone = 1;
  if (highStreak > 0.5) tone = 3;
  else if (midStreak > 0.5) tone = 2;
  if (edgeMask > 0.5) tone = 0;

  vec3 streamCol = waterTone(tone);
  col = mix(col, streamCol, inCol);

  // 8) Misty headwater band at the top — a softly lit zone where streams emerge.
  //    "Soft" in tone, not in edges: we just bias more pixels toward the mid/cyan
  //    tones via a hashed dither so the band reads as foamy spray.
  float mistZone = step(MIST_TOP, ny);
  if (mistZone > 0.5) {
    float mistHash = hash21(pix + vec2(floor(u_time * 6.0) * 0.13, 0.0));
    // Dither: most pixels = mid blue, some = cyan, a few = foam, rare = teal shadow.
    int mtone = 1;
    if (mistHash > 0.93) mtone = 3;
    else if (mistHash > 0.70) mtone = 2;
    else if (mistHash < 0.18) mtone = 0;
    // Mist fills the band uniformly — independent of column membership.
    col = waterTone(mtone);
  }

  // 9) Foamy splash basin at the bottom — scattered foam specks where streams hit.
  //    Density peaks near the floor and falls off upward through the basin.
  float basinZone = step(ny, BASIN_BOT);
  if (basinZone > 0.5) {
    float depth = ny / BASIN_BOT;            // 1 at top of basin, 0 at floor
    // Animate splash specks with a coarse time slot so they twitch like droplets.
    float splashSlot = floor(u_time * 8.0);
    float h = hash21(pix + vec2(splashSlot * 1.7, 0.0));
    // Threshold: dense foam at the floor, sparse near the top of the basin.
    float foamThresh = mix(0.55, 0.92, depth);
    float foamOn  = step(foamThresh, h);
    float midOn   = step(foamThresh - 0.18, h) * (1.0 - foamOn);

    // Base of the basin is a flat mid-blue pool.
    vec3 basinBase = waterTone(1);
    // A thin teal shadow line at the very top of the basin sells the waterline.
    float waterline = step(BASIN_BOT - 0.012, ny);
    if (waterline > 0.5) basinBase = waterTone(0);

    vec3 specks = waterTone(3) * foamOn + waterTone(2) * midOn;
    col = basinBase + specks;
    // Specks override base where present (hard edges).
    if (foamOn > 0.5) col = waterTone(3);
    else if (midOn > 0.5) col = waterTone(2);
  }

  // 10) Treble sparkle pixels — bright white specks scattered through the spray
  //     (mostly in the upper two-thirds where columns are visible). Re-seeded
  //     every ~0.13s so they twinkle.
  float sparkSlot = floor(u_time / 0.13);
  float sparkH    = hash21(pix + vec2(sparkSlot * 7.31, 11.0));
  float sparkBias = smoothstep(0.05, 0.5, ny);   // fewer at the very bottom
  float sparkOn   = step(1.0 - 0.05 * u_treble, sparkH) * sparkBias;
  if (sparkOn > 0.5) col = waterTone(3);

  // 11) Subtle vignette — keep eyes centered on the curtain.
  vec2 vUv = vec2(nx, ny) - 0.5;
  float vig = smoothstep(0.95, 0.30, length(vUv));
  col *= mix(0.78, 1.0, vig);

  outColor = vec4(col, 1.0);
}
