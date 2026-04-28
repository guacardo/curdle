// sf-lidar: USGS-style aerial LIDAR topo of San Francisco.
// Top-down view of a height field that is half "chipset" (hard quantized grid
// cells = city blocks, rooftops, courtyards) and half "rolling hills" (smooth
// FBM). Equal-elevation iso-lines are drawn as tight zebra stripes packed
// close on slopes and spread on flats. Color ramp green→yellow→red runs over
// elevation, green-dominant.
//
// Audio hook: bass warps the hills AND compresses the contour spacing so the
// stripes literally "breathe". Mids shift the chipset boundaries and add
// medium-scale relief. Treble jitters fine block edges and brightens contours.
// Slow drift on u_time keeps motion alive when silent.

// ---- Layout knobs ----
// World units per screen height. Bigger = denser map.
const float WORLD_SCALE   = 6.5;
// Block grid frequency (cells per world unit). 3.0 ≈ ~20 blocks across screen.
const float BLOCK_FREQ    = 3.0;
// Plateau quantization steps for the urban part. Higher = more distinct rooftops.
const float PLATEAU_LEVELS = 7.0;
// Base contour density (iso-lines per unit elevation). Bass modulates this.
const float CONTOUR_FREQ_BASE = 60.0;

// Voronoi-ish: jittered grid where each cell has a slight per-cell offset and
// a per-cell quantized "rooftop" height. The cell boundaries are crisp because
// we evaluate `step()` against the exact cell border, so adjacent cells stay
// at different flat plateaus — that's the chipset/circuit-board feel.
//
// Returns vec2(plateauHeight, edgeProximity). edgeProximity ∈ [0,1] is high
// at cell borders so we can ink them. We compute it by measuring distance to
// the nearest cell border in cell-local coordinates.
vec2 cityBlocks(vec2 p, float jitterAmt, float edgeJitter) {
  vec2 cell = floor(p);
  vec2 f    = fract(p);

  // Per-cell hash → plateau height + slight border perturbation. This makes
  // some "blocks" larger than others (a courtyard swallowing a neighbor)
  // without breaking the orthogonal grid feel.
  float hCell = hash21(cell);
  float hN    = hash21(cell + vec2(1.0, 0.0));
  float hE    = hash21(cell + vec2(0.0, 1.0));

  // Quantize to plateau levels. Treble-driven jitter wiggles the assignment
  // (passed in via `edgeJitter`) so rooftops occasionally swap to a new tier.
  float raw   = hCell + edgeJitter * (hash21(cell * 1.7) - 0.5);
  float plateau = floor(raw * PLATEAU_LEVELS) / PLATEAU_LEVELS;

  // Cell-local edges with a tiny per-side offset so borders don't form a
  // perfect lattice (more "block boundaries" feel). jitterAmt ≪ 0.5.
  float ox = (hN - 0.5) * jitterAmt;
  float oy = (hE - 0.5) * jitterAmt;
  vec2 d = min(f - vec2(ox, oy), vec2(1.0) - f + vec2(ox, oy));
  float edgeDist = min(d.x, d.y);                 // 0 at border, 0.5 at cell center
  float edgeProx = 1.0 - smoothstep(0.0, 0.05, edgeDist);

  return vec2(plateau, edgeProx);
}

// Smooth hills: low-frequency FBM. Bass warps it by injecting a low-freq
// displacement so the "hills" surge and recede with the kick.
float hills(vec2 p, float bassWarp) {
  vec2 warp = vec2(
    fbm(p * 0.7 + vec2( 1.3, -2.1)),
    fbm(p * 0.7 + vec2(-4.7,  3.2))
  );
  // Bass pushes the warp amplitude — at peaks the hills literally bulge.
  p += (warp - 0.5) * (0.6 + 1.4 * bassWarp);
  return fbm(p * 0.55);
}

void main() {
  // Centered, aspect-correct UV in [-1,1]-ish.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // World position. Slow pan so silent screen still drifts; tiny bass shove.
  vec2 panDir = vec2(cos(u_time * 0.04), sin(u_time * 0.031));
  vec2 worldP = uv * WORLD_SCALE + panDir * (1.2 + 0.6 * u_bass) * u_time * 0.18;

  // ---- Build the elevation field ----
  // Bass warps hills; mids modulate block grid scale (cells expand/contract).
  float blockScale = BLOCK_FREQ * (1.0 + 0.10 * u_mid);
  // Treble adds fine boundary jitter; capped so it stays subtle.
  float blockJit   = 0.06 + 0.10 * u_treble;
  float edgeJit    = 0.25 * smoothstep(0.0, 0.7, u_treble);

  vec2  blocks   = cityBlocks(worldP * blockScale, blockJit, edgeJit);
  float plateau  = blocks.x;          // 0..1 quantized rooftop
  float edgeProx = blocks.y;          // 0..1 at block borders

  float hillH    = hills(worldP, u_bass);   // 0..1-ish smooth field

  // Mask: where there's "city" vs where there's "wild hills". A second, very
  // low-freq FBM partitions the map. Mids bias the threshold so during
  // verses the city expands and during drops the hills swallow more area.
  float urbanMask = smoothstep(0.42, 0.58,
                               fbm(worldP * 0.15 + vec2(7.7, -3.3))
                               + 0.06 * u_mid);

  // Combined elevation. Urban contribution is the *plateau* (flat tops); rural
  // contribution is the smooth hills. Plateaus already span 0..1, hills too —
  // we mix and add a subtle global tilt so contours read as a coherent map.
  float elev = mix(hillH, plateau * 0.85 + 0.05 * hillH, urbanMask);
  elev += 0.15 * fbm(worldP * 1.6);   // medium-scale roughness everywhere

  // ---- Slope (for stripe-spacing realism + color hot-spotting) ----
  // Two-sample finite difference on `elev` is too expensive (would need to
  // re-evaluate cityBlocks/hills). Use fwidth() as a cheap proxy — equivalent
  // to ‖∇elev‖ in screen space, which is exactly what governs how close the
  // contour stripes pack visually.
  float slope = fwidth(elev) * 80.0;
  slope = clamp(slope, 0.0, 1.0);

  // ---- Contour stripes ----
  // Spacing breathes with bass: density rises on the kick, then relaxes.
  // Mid pushes a phase offset so the bands appear to "scroll" through tiers.
  float contourFreq = CONTOUR_FREQ_BASE * (1.0 + 0.55 * u_bass);
  float phase       = u_time * 0.18 + 0.6 * u_mid;
  float stripeArg   = (elev + phase * 0.012) * contourFreq;

  // Distance to the nearest iso-line, in stripe-space. Use fwidth for crisp
  // ~1px lines that stay 1-2px regardless of slope (matches real topo maps).
  float w  = fwidth(stripeArg) * 1.2;
  float d  = abs(fract(stripeArg) - 0.5);   // 0 right ON the line, 0.5 mid-band
  // Lines: bright when d≈0. Invert + smoothstep for crisp 1-2px width.
  float contour = 1.0 - smoothstep(0.0, w, d - 0.005);

  // Every 5th contour line drawn thicker — index lines on a real topo map.
  // We re-stride stripeArg by /5 and draw a wider iso-line on each integer.
  float idxBand = 1.0 - smoothstep(0.0, w * 1.1,
                                    abs(fract(stripeArg / 5.0) - 0.5) - 0.48);

  // ---- Color ramp: green-dominant, yellow mid, red high ----
  // Drive base color from elevation. Hand-mixed gradient (saturated greens
  // dominate the lower 60% of the range, yellow ~70%, red top 90%+).
  vec3 cLow  = vec3(0.10, 0.55, 0.18);   // deep field green
  vec3 cMid1 = vec3(0.45, 0.78, 0.18);   // grass-leaning lime
  vec3 cMid2 = vec3(0.95, 0.85, 0.18);   // saturated yellow
  vec3 cHigh = vec3(0.92, 0.32, 0.14);   // hot red-orange

  // Two-segment ramp so green stays dominant.
  float t = clamp(elev, 0.0, 1.0);
  vec3 col;
  if (t < 0.55) {
    col = mix(cLow, cMid1, smoothstep(0.0, 0.55, t));
  } else if (t < 0.78) {
    col = mix(cMid1, cMid2, smoothstep(0.55, 0.78, t));
  } else {
    col = mix(cMid2, cHigh, smoothstep(0.78, 1.0, t));
  }

  // Slope hot-spotting: steep regions push toward red regardless of elevation.
  // This matches how real LIDAR colorizes by "dz/dx" not just z. Subtle.
  col = mix(col, mix(col, cHigh, 0.55), smoothstep(0.45, 1.0, slope));

  // Faint within-plateau shading inside city blocks so flat tops don't read
  // as totally dead — a touch of self-shadow toward the block edge.
  float urbanShade = mix(1.0, 0.88 + 0.12 * (1.0 - edgeProx), urbanMask);
  col *= urbanShade;

  // ---- Ink the chipset boundaries ----
  // Hard, dark borders between adjacent city plateaus. Only inside urbanMask.
  float blockEdge = edgeProx * urbanMask;
  // Thin → use smoothstep against a tight threshold.
  float inkLine = smoothstep(0.55, 0.95, blockEdge);
  col = mix(col, col * 0.18, inkLine);

  // ---- Lay down contour stripes ----
  // Stripes are slightly darker than the underlying color (carved into the
  // map) — except on index lines (every 5th), which get a brighter rim.
  vec3 contourCol = col * 0.18;                 // dark engraving
  col = mix(col, contourCol, contour * 0.85);

  // Index lines: ink them harder + slight warm push so they read like the
  // "100m" lines on a real topo. Treble brightens them so highs sparkle.
  vec3 idxCol = mix(vec3(0.05, 0.02, 0.0), vec3(0.20, 0.05, 0.0),
                    smoothstep(0.0, 0.6, u_treble));
  col = mix(col, idxCol, idxBand * 0.9);

  // ---- Compass / scan flourish ----
  // Faint moving "scan bar" — a soft vertical band sweeping across — sells
  // the "live LIDAR readout" vibe. Driven by volume so it disappears in
  // silence rather than being a constant element.
  float scanX = fract(u_time * 0.07);
  float scanD = abs(uv.x * 0.5 + 0.5 - scanX);
  float scan  = exp(-scanD * 60.0) * smoothstep(0.05, 0.4, u_volume);
  col += vec3(0.6, 0.95, 0.7) * scan * 0.18;

  // ---- Bass flash on the highest-elevation regions ----
  // Reads as the "peaks lighting up" — Twin Peaks blowing out on the kick.
  float peakMask = smoothstep(0.72, 1.0, elev);
  col += vec3(0.6, 0.18, 0.05) * peakMask * pow(u_bass, 2.0) * 0.55;

  // Subtle vignette so the eye lands center.
  float vig = smoothstep(1.25, 0.25, length(uv));
  col *= mix(0.78, 1.0, vig);

  // Tonemap so bass spikes don't clip to white.
  col = col / (1.0 + col * 0.85);

  outColor = vec4(col, 1.0);
}
