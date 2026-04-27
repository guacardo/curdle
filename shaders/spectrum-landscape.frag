// spectrum-landscape: 3D waterfall spectrogram below a reactive nebulous sky.
// Lower half: a perspective grid of (frequency × time) bars. Bass hits appear
// in the front-left and "roll" toward the horizon over ~1s as new spectra push
// older ones back. Per-slice back-to-front composite (32 slices) — the classic
// stack-of-spectrum-profiles / mountain-range look.
// Upper half: domain-warped fbm cloud whose hue shifts when the music changes
// significantly (current bands diverge from a windowed mean of the FFT history).

// ---- Tunable constants ----
const int   NUM_SLICES   = 32;     // back-to-front Z iterations (compile-time const)
const float HORIZON_Y    = 0.5;    // screen Y of the horizon
const float CAMERA_H     = 0.35;   // camera height above ground in world units
const float NEAR_Z       = 0.42;   // closest slice — chosen so the front row's base sits
                                   // right at the bottom of the screen given CAMERA_H/FOV.
const float FAR_Z        = 8.0;    // farthest slice distance
const float GROUND_HALF  = 0.382;  // world half-width of the spectrum strip — equals NEAR_Z/f,
                                   // so all bins span the full screen width at NEAR_Z. Perspective
                                   // then tapers the strip toward the horizon for the classic look.
const float NUM_BINS     = 48.0;   // logical frequency columns

// Project a world-space (x, y, z) onto screen UV space, with horizon at HORIZON_Y.
// Returns vec2(screenU, screenV) in [0,1]. Simple pinhole; v_uv has y-up.
// Camera at (0, CAMERA_H, 0) looking down +Z; ground plane at y=0 lies *below*
// the camera, so it projects *below* the horizon (smaller suv.y).
vec2 projectWorld(vec3 wp) {
  // f controls vertical FOV. Larger f = narrower FOV / less foreshortening.
  float f = 1.1;
  float sx = (f * wp.x / wp.z) * 0.5 + 0.5;
  float sy = HORIZON_Y + (f * (wp.y - CAMERA_H) / wp.z) * 0.5;
  return vec2(sx, sy);
}

// Inverse: given screen (sx, sv) on the ground plane (y=0), recover world (x, z).
// Used only to detect which X-column a fragment "sits over" for the surface math.
vec2 unprojectGround(vec2 suv) {
  float f = 1.1;
  // Below horizon: dy = HORIZON_Y - suv.y is positive for ground fragments.
  float dy = HORIZON_Y - suv.y;
  // sy = HORIZON_Y + f*(0-CAMERA_H)/z * 0.5  =>  dy = f*CAMERA_H/(2z)  =>  z = f*CAMERA_H/(2 dy).
  float z = (f * CAMERA_H * 0.5) / max(dy, 1e-4);
  float x = ((suv.x - 0.5) * 2.0 * z) / f;
  return vec2(x, z);
}

// Music-change detector: how much do the *current* bands diverge from the
// past-second mean of the spectrum? Returns ~0 for steady music, spikes on
// drops/builds/transients.
float changeEnergy() {
  // Sample broadband history at four depths and average.
  float past = 0.0;
  past += sampleFFTHistory(0.10, 0.25);  // bass-ish
  past += sampleFFTHistory(0.10, 0.55);
  past += sampleFFTHistory(0.45, 0.40);  // mids
  past += sampleFFTHistory(0.45, 0.80);
  past += sampleFFTHistory(0.80, 0.30);  // treble
  past += sampleFFTHistory(0.80, 0.70);
  past *= 1.0 / 6.0;

  float now = (u_bass + u_mid + u_treble) / 3.0;
  return abs(now - past);
}

void main() {
  vec2 suv = v_uv;
  vec3 col;

  // --------- SKY (upper half) ---------
  // Always compute a sky color; ground will overwrite where bars are drawn.
  // Slowly rotating, domain-warped fbm cloud.
  vec2 skyUV = vec2(suv.x - 0.5, suv.y - HORIZON_Y);
  // Stretch horizontally a bit so clouds drift sideways more than they puff.
  skyUV.x *= 1.6;

  float st = u_time * 0.04;
  vec2 sw = skyUV;
  sw = rot2d(st * 0.2) * sw;
  vec2 sq = vec2(
    fbm(sw * 1.5 + vec2(0.0, st)),
    fbm(sw * 1.5 + vec2(4.7, -st * 0.7))
  );
  float cloud = fbm(sw * 2.2 + 1.4 * sq);

  // --- Significant-change hue shift ---
  // We accumulate a slowly-decaying "shift" driven by changeEnergy spikes,
  // so a single transient nudges the sky color and lingers a moment.
  // Without temporal state we approximate: use an envelope built from
  // u_time-modulated change magnitude. The change signal itself already has
  // history baked in via sampleFFTHistory, so a direct mapping reads as a
  // visible recolor on big shifts.
  float chg = changeEnergy();
  // Boost so subtle transients still register; clamp so spikes don't blow up.
  float hueShift = clamp(chg * 3.5, 0.0, 1.2);
  // A slow drift keeps the sky alive when nothing is happening.
  float baseHue = u_time * 0.015;

  vec3 sky = palette(
    cloud * 0.6 + baseHue + hueShift,
    vec3(0.18, 0.20, 0.32),                 // dark base — nebulous, not bright
    vec3(0.40, 0.35, 0.55),                 // amplitude
    vec3(1.00, 0.90, 1.10),                 // chroma cycle rates
    vec3(0.10 + hueShift * 0.4, 0.30, 0.65) // phase — shifts on change
  );
  // Gentle vertical falloff: deeper near horizon, fading toward the top.
  float vGrad = smoothstep(0.0, 0.6, suv.y - HORIZON_Y);
  sky *= mix(0.85, 1.15, vGrad);
  // Soft "horizon glow" right at the seam.
  float glow = exp(-abs(suv.y - HORIZON_Y) * 30.0);
  sky += vec3(0.25, 0.20, 0.40) * glow * (0.4 + 0.6 * u_volume);

  col = sky;

  // --------- GROUND PLANE BASE TINT (only below horizon) ---------
  // Compute floor color first; bar composite below may overwrite.
  bool belowHorizon = suv.y < HORIZON_Y;
  if (belowHorizon) {
    vec2 gp = unprojectGround(suv);
    float depthFog = clamp((gp.y - NEAR_Z) / (FAR_Z - NEAR_Z), 0.0, 1.0);
    vec3 ground = mix(vec3(0.06, 0.03, 0.12), vec3(0.02, 0.02, 0.06), depthFog);
    col = ground;

    // Subtle floor gridlines at fixed world Z/X spacing — texture between bar
    // rows so the perspective reads even where bars are short.
    float gz = abs(fract(gp.y * 1.5) - 0.5);
    float lwz = fwidth(gp.y * 1.5) * 1.2;
    float lz = 1.0 - smoothstep(0.0, lwz, gz);
    float gx = abs(fract(gp.x * 1.5) - 0.5);
    float lwx = fwidth(gp.x * 1.5) * 1.2;
    float lx = 1.0 - smoothstep(0.0, lwx, gx);
    float floorGrid = max(lz, lx) * (1.0 - depthFog) * 0.18;
    col += vec3(0.20, 0.18, 0.45) * floorGrid;
  }

  // --------- BAR COMPOSITE (runs for ALL fragments) ---------
  // Tall bars near camera can poke above the horizon and occlude the sky,
  // so we run this loop everywhere — early-outs handle off-screen cases.
  {
    // ---- Back-to-front slice composite ----
    // Iterate from the farthest slice (i=0) to the nearest (i=NUM_SLICES-1).
    // Each slice corresponds to one row of the FFT history (one moment in time).
    // Newer slices are drawn last and naturally "occlude" older ones.
    for (int i = 0; i < NUM_SLICES; i++) {
      float fi  = float(i);
      float fN  = float(NUM_SLICES - 1);
      // depth01: 1 = oldest (back), 0 = newest (front).
      float depth01 = 1.0 - fi / fN;

      // World-Z of this slice. Geometric spacing keeps far slices visually
      // distinguishable while the front rows stay chunky.
      float zMix = depth01;
      float worldZ = mix(NEAR_Z, FAR_Z, zMix);

      // Skip if this slice is behind/in-front of where this fragment maps.
      // We walk every slice though — branchless contribution below — because
      // a tall bar in a *back* slice can still cover this fragment if a closer
      // slice is short.

      // Determine which X-bin our fragment column corresponds to *at this Z*.
      // From projection: sx = (f * x / z) * 0.5 + 0.5  =>  x = (sx-0.5)*2*z/f.
      float worldX = (suv.x - 0.5) * 2.0 * worldZ / 1.1;

      // Bar X-spacing: GROUND_HALF wide at z=FAR_Z keeps bins compactly visible.
      // We map worldX to a bin index in [0, NUM_BINS).
      float colF = (worldX / GROUND_HALF) * (NUM_BINS * 0.5) + NUM_BINS * 0.5;
      // Off-grid columns (way left/right) contribute nothing.
      if (colF < 0.0 || colF >= NUM_BINS) continue;

      float colI = floor(colF);
      float colFrac = colF - colI;

      // Frequency for this column. Use a mild log-ish curve so bass takes more
      // columns than treble — feels natural for music.
      float freqLin = (colI + 0.5) / NUM_BINS;
      float freq = pow(freqLin, 1.6);

      // Sample amplitude from the FFT history at this column's frequency and
      // this slice's age. depth01: 1=oldest, 0=newest. sampleFFTHistory wants
      // depth=0 for now — perfect, our depth01 already matches.
      float amp = sampleFFTHistory(freq, depth01);

      // Bar height in world Y. Boost lows a bit so bass mountains read big.
      float boost = mix(1.4, 0.9, freqLin); // lows taller than highs
      float barH = amp * boost * 0.9;

      // Project the *top* of the bar to screen Y at this column's center X.
      // We don't need exact column-x for Y (height is constant across the
      // column's small X width), so use worldX for the column we're sampling.
      vec2 topScreen = projectWorld(vec3(worldX, barH, worldZ));
      float topY = topScreen.y;

      // The fragment is "covered" by this slice's bar iff:
      //   baseY <= suv.y <= topY  (y-up: baseY is low on screen, topY is high).
      vec2 baseScreen = projectWorld(vec3(worldX, 0.0, worldZ));
      float baseY = baseScreen.y;

      // suv.y above the bar's top -> not covered.
      if (suv.y > topY) continue;
      // suv.y below the bar's base -> occluded by closer ground (at this Z).
      if (suv.y < baseY - 0.001) continue;

      // Edge mask: dim the bar's sides slightly so adjacent columns read as
      // distinct cells. colFrac is 0 at the left edge, 1 at the right edge.
      float edgeX = min(colFrac, 1.0 - colFrac); // 0 at edges, 0.5 at center
      float colEdge = smoothstep(0.0, 0.06, edgeX);

      // Cool palette: deep purples/blues, brighter at peaks.
      // Hue indexed by frequency so bass bars are violet, treble bars cyan.
      vec3 barCol = palette(
        0.55 + freqLin * 0.25,
        vec3(0.20, 0.18, 0.40),
        vec3(0.30, 0.25, 0.45),
        vec3(0.80, 0.90, 1.20),
        vec3(0.10, 0.30, 0.55)
      );
      // Peak highlight: brighten the top edge of the bar (within ~1.5% of topY).
      // y-up: suv.y inside bar is < topY, so use (topY - suv.y) >= 0.
      float topGlow = 1.0 - smoothstep(0.0, 0.015, topY - suv.y);
      barCol += vec3(0.45, 0.55, 0.85) * topGlow * (0.5 + amp);

      // Atmospheric perspective: dim + blue-shift bars further back.
      float fog = clamp((worldZ - NEAR_Z) / (FAR_Z - NEAR_Z), 0.0, 1.0);
      barCol *= mix(1.0, 0.35, fog);
      barCol = mix(barCol, vec3(0.10, 0.10, 0.30), fog * 0.55);

      // Apply column-edge dimming (the vertical grid lines).
      barCol *= mix(0.55, 1.0, colEdge);

      // Z-row "grid line": brighten a thin band right at the front face of
      // the slice (where suv.y is near baseY). Reads as a horizontal grid
      // edge running across the bars. y-up: inside bar suv.y >= baseY.
      float zEdge = 1.0 - smoothstep(0.0, 0.008, suv.y - baseY);
      barCol += vec3(0.35, 0.30, 0.60) * zEdge * (1.0 - fog);

      // Overwrite (back-to-front: newer slices win).
      col = barCol;
    }

    // Subtle horizon stripe — a slightly brighter line where ground meets sky.
    float horizonStripe = exp(-abs(suv.y - HORIZON_Y) * 220.0);
    col += vec3(0.30, 0.28, 0.55) * horizonStripe * 0.6;
  }

  // Gentle vignette to keep gaze centered.
  vec2 vuv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float vig = smoothstep(1.3, 0.3, length(vuv));
  col *= mix(0.75, 1.0, vig);

  // Tonemap so bass peaks don't clip to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
