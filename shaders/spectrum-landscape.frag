// spectrum-landscape: 3D DISCO DANCE FLOOR.
// A perspective grid of square tiles lying flat on the floor, viewed from a low
// camera looking forward. Each tile is one (frequency × time) pair and pops a
// vertical column upward proportional to its FFT magnitude. The vanishing point
// sits at screen center on the horizon line. Newer audio lives in the front row;
// older audio rolls back toward the horizon as time advances.
// Above the horizon (screen Y = 0.5): a slow rotating fbm nebula.

// ---- Camera & projection ----
// Pinhole. Camera at world (0, CAMERA_H, 0) looking forward (tiles at +Z).
// Floor at worldY=0 sits below the camera, projecting *below* the horizon.
//   screenX = worldX / worldZ * FOCAL * 0.5 + 0.5
//   screenY = HORIZON - (CAMERA_H - worldY) / worldZ * FOCAL * 0.5
// At worldY=0 -> screenY < HORIZON. At worldY=CAMERA_H -> screenY = HORIZON
// (vanishing). Vanishing point lives at exactly screen center.
// Camera dropped + FOV widened so the near rows are huge and bleed off the
// bottom edge — synthwave-grid feel where the foreground crops past the
// viewport and the whole grid rushes toward a low horizon.
const float CAMERA_H = 0.62;    // camera height above the floor (was 1.0)
const float FOCAL    = 0.85;    // smaller = wider FOV (was 1.2)
const float HORIZON  = 0.52;    // horizon slightly above center

// ---- Floor / cell grid ----
// 32 freq columns × 32 time rows. Visible gaps so it reads as discrete tiles.
// Row depth grows GEOMETRICALLY (not linearly): near rows are chunky squares,
// far rows stretch deep into Z so the carpet reaches the horizon without
// blowing up the per-fragment loop count. The cell *width* on screen still
// shrinks naturally with 1/Z, so distant rows merge into the horizon haze
// instead of ending in a hard cutoff line.
//
// Z layout: zFront(r) = Z_NEAR * pow(Z_GROWTH, r). With Z_NEAR=0.42 and
// Z_GROWTH=1.165, r=31 lands at ~52 world units — projected dyHorizon at
// that depth is ~0.005 of screen height, i.e. effectively the horizon line.
const int   K_FREQ   = 32;
const int   K_TIME   = 32;
const float CELL_W   = 0.075;   // tile width in world units (X) — fixed
const float GAP      = 0.16;    // fraction of cell that is gap
const float Z_NEAR   = 0.42;    // front-row Z front edge
const float Z_GROWTH = 1.165;   // each row's Z extent multiplied by this

// Hard ceiling on column height. Pushed ~5x so loud peaks reach ~60-70% of
// screen height. Note: when barH > CAMERA_H, the column TOP rises ABOVE the
// horizon line — the math still works (dyHorizon flips sign and we rely on
// the side/front faces to cover the visible region). To keep things sane we
// only allow the apex to climb modestly past the horizon.
const float MAX_BAR_H = 2.2 * CAMERA_H;

// ---- Log-frequency mapping (7 octaves) ----
// Column k maps to freq01 = pow(2, mix(-7, 0, k/(K-1))). k=0 -> 1/128,
// k=K-1 -> 1.0. Each octave gets ~equal screen width. Skip lowest sub-bass
// bins (DC garbage) by floor-clamping.
const float MIN_FREQ01 = 4.0 / 512.0;

float colFreq(float k) {
  float t = k / float(K_FREQ - 1);
  float f = pow(2.0, mix(-7.0, 0.0, t));
  return max(f, MIN_FREQ01);
}

// Geometric Z layout. Row r occupies [zFront(r), zFront(r+1)].
// Closed-form: zFront(r) = Z_NEAR * pow(Z_GROWTH, r).
float rowZFront(float r) { return Z_NEAR * pow(Z_GROWTH, r); }
float rowZBack (float r) { return Z_NEAR * pow(Z_GROWTH, r + 1.0); }
// Total Z extent of the grid (front of row 0 → back of last row).
float gridZFar() { return Z_NEAR * pow(Z_GROWTH, float(K_TIME)); }

// Color a column by frequency band using the IQ cosine palette.
// Coefficients were chosen so the cosine sweep from t=0 → t=1 lands on:
//   bass (t≈0.0) → deep magenta / hot pink / orange
//   mid  (t≈0.5) → electric lime / acid yellow
//   treb (t≈1.0) → icy cyan / electric violet / white
// `heightBoost` (0..1) shifts hue further around the apex color and bumps
// saturation, so taller columns read as more electric.
vec3 bandColor(float freq01, float heightBoost) {
  // Position by log-frequency (matches the column-index spacing).
  float lf = log2(max(freq01, 1.0/512.0)) / 7.0 + 1.0; // ~0..1

  // IQ palette parameters. (a,b) = bias + amplitude; (c,d) shape the cycle
  // across t ∈ [0,1]. Picked by hand to span warm→acid→icy in one revolution.
  vec3 a = vec3(0.55, 0.45, 0.60);
  vec3 b = vec3(0.50, 0.50, 0.55);
  vec3 c = vec3(1.00, 1.05, 0.90);
  vec3 d = vec3(0.92, 0.25, 0.55);

  // Slow per-frame drift + apex-color push from height.
  float t = lf + 0.04 * sin(u_time * 0.20 + lf * 3.0) + 0.10 * heightBoost;
  vec3 base = palette(t, a, b, c, d);

  // Re-saturate toward the chroma peak so taller bars get more vivid.
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  base = mix(vec3(lum), base, 1.0 + 0.45 * heightBoost);
  return clamp(base, 0.0, 2.0);
}

// Music-change detector for sky hue shift.
float changeEnergy() {
  float past = 0.0;
  past += sampleFFTHistory(0.10, 0.25);
  past += sampleFFTHistory(0.10, 0.55);
  past += sampleFFTHistory(0.45, 0.40);
  past += sampleFFTHistory(0.45, 0.80);
  past += sampleFFTHistory(0.80, 0.30);
  past += sampleFFTHistory(0.80, 0.70);
  past *= 1.0 / 6.0;
  float now = (u_bass + u_mid + u_treble) / 3.0;
  return abs(now - past);
}

void main() {
  vec2 suv = v_uv;
  vec3 col;

  // ===================== SKY (above horizon) =====================
  // Four parallax cloud layers, each its own fbm, each rotating about screen
  // center at a different rate. Back layers are broad/slow; front layers are
  // fine/fast. Composited back-to-front with alpha-over for a sense of depth.
  // Palette anchors orange (warm coral) against deep navy with a dusky-violet
  // mid-cycle accent — slightly-off complementary so it reads as "two vibes
  // that get along." Global hue shift driven by changeEnergy() reacts to
  // transients across ALL layers in unison.
  vec2 skyUV = vec2(suv.x - 0.5, suv.y - HORIZON);
  skyUV.x *= 1.6;

  float chg = changeEnergy();
  float hueShift = clamp(chg * 3.5, 0.0, 1.2);
  float baseHue = u_time * 0.015;

  // IQ palette coefficients: t=0 -> warm coral-orange (~#FF8042),
  // t=0.5 -> deep teal-leaning navy (~#1A3B9C-ish darkened), t~0.25 -> dusky violet accent.
  const vec3 PAL_A = vec3(0.55, 0.36, 0.32);
  const vec3 PAL_B = vec3(0.45, 0.22, 0.30);
  const vec3 PAL_C = vec3(1.00, 1.00, 1.00);
  vec3 palD = vec3(0.00, 0.15, 0.55) + vec3(hueShift * 0.35);

  // Layer scales and per-layer rotation rates (rad/sec). Back layer slowest,
  // front layer fastest — gives parallax.
  const float SCL0 = 1.0,  ROT0 = 0.015;  // back
  const float SCL1 = 1.6,  ROT1 = 0.035;
  const float SCL2 = 2.4,  ROT2 = 0.060;
  const float SCL3 = 3.6,  ROT3 = 0.095;  // front

  // ---- Back layer (broad slow nebula, fully opaque base) ----
  vec2 sw0 = rot2d(u_time * ROT0) * skyUV;
  float c0 = fbm(sw0 * SCL0 + vec2(0.0, u_time * 0.03));
  vec3 sky = palette(c0 * 0.55 + baseHue + hueShift,        PAL_A, PAL_B, PAL_C, palD);
  // Slight darkening with vertical gradient to push depth.
  float vGrad = smoothstep(0.0, 0.6, suv.y - HORIZON);
  sky *= mix(0.78, 1.05, vGrad);

  // ---- Layer 1 (mid-back) ----
  vec2 sw1 = rot2d(u_time * ROT1) * skyUV;
  float c1 = fbm(sw1 * SCL1 + vec2(2.7, -u_time * 0.05));
  vec3 lay1 = palette(c1 * 0.7 + baseHue + hueShift + 0.08, PAL_A, PAL_B, PAL_C, palD);
  float a1 = smoothstep(0.42, 0.78, c1) * 0.65;
  sky = mix(sky, lay1, a1);

  // ---- Layer 2 (mid-front wisps) ----
  vec2 sw2 = rot2d(u_time * ROT2) * skyUV;
  float c2 = fbm(sw2 * SCL2 + vec2(-5.1, u_time * 0.08));
  vec3 lay2 = palette(c2 * 0.85 + baseHue + hueShift + 0.18, PAL_A, PAL_B, PAL_C, palD);
  float a2 = smoothstep(0.50, 0.82, c2) * 0.55;
  sky = mix(sky, lay2, a2);

  // ---- Layer 3 (front fine wisps, fastest) ----
  vec2 sw3 = rot2d(u_time * ROT3) * skyUV;
  float c3 = fbm(sw3 * SCL3 + vec2(8.3, -u_time * 0.12));
  vec3 lay3 = palette(c3 * 1.0 + baseHue + hueShift + 0.32,  PAL_A, PAL_B, PAL_C, palD);
  float a3 = smoothstep(0.55, 0.85, c3) * 0.50;
  sky = mix(sky, lay3, a3);

  // Soft horizon glow at the seam — pulled toward the warm end of the palette.
  float skyGlow = exp(-abs(suv.y - HORIZON) * 28.0);
  sky += vec3(0.55, 0.30, 0.18) * skyGlow * (0.4 + 0.6 * u_volume);

  col = sky;

  // ===================== FLOOR BASE TILE TEXTURE =====================
  // Below the horizon, paint the empty floor with cell gridlines so the
  // perspective reads even where columns are short.
  bool belowHorizon = suv.y < HORIZON - 0.0005;
  if (belowHorizon) {
    float dyF   = HORIZON - suv.y;
    float fZ    = (CAMERA_H * FOCAL * 0.5) / max(dyF, 1e-4);
    float fX    = (suv.x - 0.5) * 2.0 * fZ / FOCAL;

    // Distance fade — log-Z so the geometric row layout fades evenly. At the
    // back, the floor blends into the same haze color the columns dissolve
    // into, killing any visible horizon-cutoff line.
    float zFar = gridZFar();
    float zT   = clamp(log2(max(fZ / Z_NEAR, 1.0)) /
                       log2(max(zFar / Z_NEAR, 1.0001)), 0.0, 1.0);
    vec3 floorNear = vec3(0.04, 0.02, 0.08);
    vec3 floorFar  = vec3(0.10, 0.08, 0.22); // matches column haze
    vec3 floorBase = mix(floorNear, floorFar, pow(zT, 0.65));
    col = floorBase;

    // Only draw gridlines INSIDE the dance-floor footprint.
    float gridXmax = float(K_FREQ) * CELL_W * 0.5;
    bool insideFloor = (fZ >= Z_NEAR) && (fZ <= zFar) && (abs(fX) <= gridXmax);
    if (insideFloor) {
      // X tile boundaries are uniform every CELL_W. Z boundaries follow the
      // geometric layout: log2(z/Z_NEAR)/log2(Z_GROWTH) is integer at each row.
      float gx = abs(fract((fX + gridXmax) / CELL_W) - 0.5);
      float zRow = log2(fZ / Z_NEAR) / log2(Z_GROWTH);
      float gz = abs(fract(zRow) - 0.5);
      float lwx = fwidth((fX + gridXmax) / CELL_W) * 1.4;
      float lwz = fwidth(zRow) * 1.4;
      float lx = 1.0 - smoothstep(0.0, lwx, gx);
      float lz = 1.0 - smoothstep(0.0, lwz, gz);
      float gridLine = max(lx, lz) * (1.0 - zT) * 0.30;
      col += vec3(0.35, 0.25, 0.65) * gridLine;
    }
  }

  // ===================== COLUMNS =====================
  // Per-fragment strategy: walk all 32 ROWS (Z slices) back-to-front.
  // For each row we test THREE faces of (potentially distinct) columns:
  //   TOP    — face at world (x in cell, y=barH, z in [zF,zB])
  //   FRONT  — face at world (x in cell, y in [0,barH], z = zF)
  //   SIDE   — face at fixed X (right edge for cells left-of-camera, left
  //            edge for cells right-of-camera), y in [0,barH], z in [zF,zB]
  //
  // The TOP/FRONT tests use the cell identified by xFront (the column whose
  // footprint contains the ray at zF). The SIDE test identifies a separate
  // candidate cell whose visible side-edge plane the ray would intersect at
  // mid-row depth (because a fragment in the inter-cell gap is often a side
  // face of the neighbor, not a front face).

  float halfGridX = float(K_FREQ) * CELL_W * 0.5;
  float dyHorizon = HORIZON - suv.y; // can be negative (above horizon)
  float kx        = (suv.x - 0.5) * 2.0 / FOCAL; // worldX = kx * worldZ along ray

  // Optional whole-floor flash on hard bass transients.
  float bassFlash = smoothstep(0.78, 0.95, u_bass);

  float zFar = gridZFar();
  float logZSpan = log2(max(zFar / Z_NEAR, 1.0001));

  for (int r = K_TIME - 1; r >= 0; r--) {
    float rf = float(r);
    float zFront = rowZFront(rf);
    float zBack  = rowZBack(rf);
    float cellD  = zBack - zFront;          // this row's Z extent

    // Inset for gap so cells read as discrete tiles.
    float zF = zFront + cellD * GAP * 0.5;
    float zB = zBack  - cellD * GAP * 0.5;
    float zMid = 0.5 * (zF + zB);

    // depthNorm: 0 at front (now), ~1 at back (oldest in history).
    float depthNorm = rf / float(K_TIME - 1);

    // -------- Identify the X cell this fragment maps to in THIS row --------
    // Use the front-face X mapping (the part of the column actually facing camera).
    float xFront = (suv.x - 0.5) * 2.0 * zF / FOCAL;
    bool xInGrid = (xFront >= -halfGridX) && (xFront <= halfGridX);

    int   cIdx     = -1;
    float cellXc   = 0.0;
    float cellXleft  = 0.0;
    float cellXright = 0.0;
    float freq01   = 0.0;
    float barH     = 0.0;

    if (xInGrid) {
      float colF = (xFront + halfGridX) / CELL_W; // [0, K_FREQ]
      cIdx = int(floor(colF));
      if (cIdx < 0) cIdx = 0;
      if (cIdx > K_FREQ - 1) cIdx = K_FREQ - 1;
      float cf = float(cIdx);
      cellXc      = (cf + 0.5 - float(K_FREQ) * 0.5) * CELL_W;
      cellXleft   = cellXc - CELL_W * 0.5 + CELL_W * GAP * 0.5;
      cellXright  = cellXc + CELL_W * 0.5 - CELL_W * GAP * 0.5;
      freq01 = colFreq(cf);
      float amp = sampleFFTHistory(freq01, depthNorm);
      // Soft FFT->height curve: pow(amp, 1.4) keeps quiet quiet, makes loud
      // climb without slamming the ceiling on every transient. Mild bass
      // boost so kicks pop. Hard-clamped at MAX_BAR_H.
      float boost = mix(1.15, 0.90, freq01);
      barH = clamp(pow(amp, 1.4) * boost * MAX_BAR_H, 0.0, MAX_BAR_H);
    }

    // ---- Test TOP face ----
    // Works above horizon too: when barH > CAMERA_H, (CAMERA_H-barH) and
    // dyHorizon both flip sign, so zTop stays positive.
    bool isTop = false;
    float topApex = 0.0;  // 1 at front edge, 0 at back edge
    float topCenter = 0.0;
    if (xInGrid && barH > 1e-4 && abs(dyHorizon) > 1e-4) {
      float zTop = (CAMERA_H - barH) * FOCAL * 0.5 / dyHorizon;
      if (zTop > 0.0 && zTop >= zF && zTop <= zB) {
        float xTop = (suv.x - 0.5) * 2.0 * zTop / FOCAL;
        if (xTop >= cellXleft && xTop <= cellXright) {
          isTop = true;
          topApex = 1.0 - (zTop - zF) / max(zB - zF, 1e-4);
          topCenter = 1.0 - abs(xTop - cellXc) / (CELL_W * 0.5);
        }
      }
    }

    // ---- Test FRONT face ----
    bool isFront = false;
    float frontTopness = 0.0;
    if (xInGrid && barH > 1e-4 && !isTop) {
      float yFront = CAMERA_H - dyHorizon * zF * 2.0 / FOCAL;
      if (yFront >= 0.0 && yFront <= barH &&
          xFront >= cellXleft && xFront <= cellXright) {
        isFront = true;
        frontTopness = yFront / max(barH, 1e-4);
      }
    }

    // ---- Test SIDE face ----
    // Identify a candidate column whose visible side edge the ray most
    // plausibly intersects at this row's mid-depth. suv.x>0.5 → ray points
    // to +X → can only see LEFT faces of columns at cellXc>0. suv.x<0.5 →
    // sees RIGHT faces of columns at cellXc<0.
    bool isSide = false;
    float sideTopness = 0.0;
    float sideZness   = 0.0;
    int   sIdx        = -1;
    float sideCellXc  = 0.0;
    float sideFreq01  = 0.0;
    float sideBarH    = 0.0;
    bool  sideIsRight = false; // right face (column to left of camera)

    if (!isTop && !isFront && abs(kx) > 1e-4) {
      float xMid = kx * zMid;
      // Direction of the visible side face:
      sideIsRight = (suv.x < 0.5); // looking left → see right faces of left cells
      // Candidate cell-center that puts its visible side edge at xMid.
      float candCellXc = sideIsRight ? (xMid - CELL_W * 0.5 + CELL_W * GAP * 0.5)
                                     : (xMid + CELL_W * 0.5 - CELL_W * GAP * 0.5);
      float candIdxF = (candCellXc + halfGridX) / CELL_W - 0.5;
      sIdx = int(floor(candIdxF + 0.5));
      if (sIdx >= 0 && sIdx <= K_FREQ - 1) {
        float sf = float(sIdx);
        sideCellXc = (sf + 0.5 - float(K_FREQ) * 0.5) * CELL_W;
        // Only show side if column is meaningfully off-axis (instructions:
        // columns within ±W/2 of center show no side face).
        bool offAxisOK = sideIsRight ? (sideCellXc < -CELL_W * 0.5)
                                     : (sideCellXc >  CELL_W * 0.5);
        if (offAxisOK) {
          // Side-face plane X (with the gap inset).
          float sideX = sideIsRight ? (sideCellXc + CELL_W * 0.5 - CELL_W * GAP * 0.5)
                                    : (sideCellXc - CELL_W * 0.5 + CELL_W * GAP * 0.5);
          // Sign sanity: ray must actually reach sideX with positive Z.
          float zHit = sideX / kx; // worldZ where ray crosses side plane
          if (zHit > 0.0 && zHit >= zF && zHit <= zB) {
            // Resolve this column's bar height (independent of cIdx).
            sideFreq01 = colFreq(sf);
            float sAmp = sampleFFTHistory(sideFreq01, depthNorm);
            float sBoost = mix(1.15, 0.90, sideFreq01);
            sideBarH = clamp(pow(sAmp, 1.4) * sBoost * MAX_BAR_H, 0.0, MAX_BAR_H);
            if (sideBarH > 1e-4) {
              float yHit = CAMERA_H - dyHorizon * zHit * 2.0 / FOCAL;
              if (yHit >= 0.0 && yHit <= sideBarH) {
                isSide = true;
                sideTopness = yHit / max(sideBarH, 1e-4);
                sideZness   = (zHit - zF) / max(zB - zF, 1e-4); // 0 at front, 1 at back
              }
            }
          }
        }
      }
    }

    if (!isTop && !isFront && !isSide) continue;

    // ---------------- Shade ----------------
    // Tron strategy:
    //   - "edgeMask" is 1 along face boundaries (the wireframe), 0 inside.
    //   - Interior fill paints with low alpha so overlapping bars blend their
    //     colors back into the floor + sky already in `col`.
    //   - Edges paint at full alpha — opaque outline.
    // Pick the right column's freq + height for the active face.
    float useFreq = isSide ? sideFreq01 : freq01;
    float useBar  = isSide ? sideBarH   : barH;
    float heightT = useBar / MAX_BAR_H;
    vec3 baseCol = bandColor(useFreq, heightT);
    float zForFog = isSide ? (zF + sideZness * (zB - zF)) : zF;
    // Log-Z fog so the geometric row spacing fades evenly across screen.
    float fog = clamp(log2(max(zForFog / Z_NEAR, 1.0)) / logZSpan, 0.0, 1.0);
    // Curve so the back ~40% of rows dissolve hard into haze (no cutoff line).
    fog = pow(fog, 0.75);

    // Edge thickness in face-local UV. Use fwidth on screen-space gradient of
    // a representative face coord so the wireframe stays roughly constant
    // pixel-width regardless of depth.
    float edgeMask = 0.0;
    // Face-local coords (u along width-axis 0..1, v along height-axis 0..1).
    float fu = 0.0, fv = 0.0;
    float fuw = 0.002, fvw = 0.002;

    vec3 fillCol;     // interior color
    vec3 edgeCol;     // wireframe color (brighter, hotter)
    float fillAlpha;  // interior opacity (translucent)

    if (isTop) {
      // Top face: u across cell-X (cellXleft..cellXright), v across depth (zF..zB).
      // Recover the world hit point for the top.
      float zTop = (CAMERA_H - barH) * FOCAL * 0.5 / dyHorizon;
      float xTop = (suv.x - 0.5) * 2.0 * zTop / FOCAL;
      fu = (xTop - cellXleft) / max(cellXright - cellXleft, 1e-4);
      fv = (zTop - zF) / max(zB - zF, 1e-4);
      fuw = fwidth(fu) * 1.4;
      fvw = fwidth(fv) * 1.4;

      // Top face is dim (drop the chalky white cap entirely). Slight darken
      // toward the back of the cell for shape readability.
      fillCol = baseCol * (0.55 + 0.20 * topApex);
      // Hot edge color: pull the chroma further around the palette so the
      // wireframe glows like a neon outline.
      edgeCol = bandColor(useFreq, min(heightT + 0.35, 1.0)) * 1.85;
      fillAlpha = 0.50;
    } else if (isSide) {
      // Side face: u across depth (zF..zB), v across height (0..sideBarH).
      fu = sideZness;                                     // 0 at front, 1 at back
      fv = sideTopness;                                   // 0 at base, 1 at top
      fuw = fwidth(fu) * 1.4;
      fvw = fwidth(fv) * 1.4;

      // Side fill is the band color, dimmed; vertical gradient = AO.
      fillCol = baseCol * (0.42 + 0.30 * sideTopness);
      edgeCol = bandColor(useFreq, min(heightT + 0.30, 1.0)) * 1.65;
      fillAlpha = 0.55;
    } else {
      // Front face: u across cellX (cellXleft..cellXright), v across height.
      fu = (xFront - cellXleft) / max(cellXright - cellXleft, 1e-4);
      fv = frontTopness;
      fuw = fwidth(fu) * 1.4;
      fvw = fwidth(fv) * 1.4;

      // Front is the most shadowed; darker fill so light leaks through it.
      fillCol = baseCol * (0.32 + 0.32 * frontTopness);
      edgeCol = bandColor(useFreq, min(heightT + 0.40, 1.0)) * 1.95;
      fillAlpha = 0.60;
    }

    // Edge = within fuw of u={0,1} OR within fvw of v={0,1}.
    float eU = 1.0 - smoothstep(0.0, fuw, min(fu, 1.0 - fu));
    float eV = 1.0 - smoothstep(0.0, fvw, min(fv, 1.0 - fv));
    edgeMask = clamp(max(eU, eV), 0.0, 1.0);

    // Edges always glow (not subject to face-shadow).
    // Quieter columns get thinner, softer edges; loud ones get hotter.
    float edgeBoost = 0.55 + 0.85 * heightT;
    edgeCol *= edgeBoost;

    // Distance fog: at the back of the grid, fill and edge fully dissolve into
    // the horizon haze color so the carpet has no visible cutoff line.
    vec3 hazeCol = vec3(0.10, 0.08, 0.22);
    fillCol *= mix(1.0, 0.18, fog);
    fillCol  = mix(fillCol, hazeCol, fog * 0.92);
    edgeCol *= mix(1.0, 0.30, fog);
    edgeCol  = mix(edgeCol, hazeCol, fog * 0.85);

    // Whole-floor bass pulse + transient cool-tint flash (fill only).
    fillCol *= 1.0 + 0.22 * u_bass;
    fillCol  = mix(fillCol, fillCol * vec3(0.55, 0.85, 1.55), bassFlash * 0.35);

    // Composite over the existing `col` (sky/floor/farther bars). Edge wins
    // with full opacity; interior is semi-transparent so overlapping columns
    // blend their colors.
    vec3 faceCol = mix(fillCol, edgeCol, edgeMask);
    float faceAlpha = mix(fillAlpha, 1.0, edgeMask);
    // Edges of distant bars shouldn't stay 100% opaque — let fog dissolve them
    // all the way to invisible at the horizon, no hard cutoff line.
    faceAlpha *= 1.0 - smoothstep(0.65, 1.0, fog);
    col = mix(col, faceCol, faceAlpha);
  }

  // Subtle horizon stripe at the seam.
  float horizonStripe = exp(-abs(suv.y - HORIZON) * 240.0);
  col += vec3(0.30, 0.25, 0.55) * horizonStripe * 0.55;

  // Vignette to keep gaze centered.
  vec2 vuv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float vig = smoothstep(1.3, 0.3, length(vuv));
  col *= mix(0.78, 1.0, vig);

  // Tonemap so bass peaks don't clip to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
