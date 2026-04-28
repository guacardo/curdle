// spectrum-fisheye: spectrum-landscape with a wraparound fisheye POV and a
// rotating triadic palette. Two changes from spectrum-landscape:
//
//   1) FISHEYE WRAP. We pre-distort screen UVs with a strong barrel warp
//      before running the existing perspective raymarch. The column field
//      (originally a conveyor receding straight ahead) now appears to curve
//      around the viewer — the strips at the edges of the screen bend toward
//      the camera as if the viewer is inside a panoramic strip of bars.
//      Approach choice: screen-space warp instead of restructuring world
//      geometry. The face-by-face intersection logic (TOP/FRONT/SIDE) and the
//      conveyor's frozen FFT snapshots survive verbatim — only `suv` changes.
//
//   2) ROTATING TRIAD. The IQ-cosine rainbow that colored bars by frequency
//      is replaced by a 3-color triad (hues 120° apart in HSL). The triad
//      slowly rotates around the wheel (~45s per revolution). Bars in the
//      bass third get hue θ; mid third get θ+120°; treble third get θ+240°,
//      with smoothstep crossfades between bands. Brightness/saturation still
//      respond to height, but the screen never shows more than ~3 hues at once.

// ===== Camera & projection ===== (unchanged)
const float CAMERA_H = 0.62;
const float FOCAL    = 0.85;
const float HORIZON  = 0.52;

// ===== Floor / cell grid ===== (unchanged)
const int   K_FREQ   = 32;
const int   K_TIME   = 32;
const float CELL_W   = 0.075;
const float GAP      = 0.16;
const float Z_NEAR   = 0.42;
const float Z_GROWTH = 1.165;

// ===== Strip conveyor ===== (unchanged)
const float HIST_SECONDS   = 1.0;
const float STRIP_INTERVAL = HIST_SECONDS / float(K_TIME);

const float MAX_BAR_H = 2.2 * CAMERA_H;

// ===== Log-frequency mapping ===== (unchanged)
const float MIN_FREQ01 = 4.0 / 512.0;

float colFreq(float k) {
  float t = k / float(K_FREQ - 1);
  float f = pow(2.0, mix(-7.0, 0.0, t));
  return max(f, MIN_FREQ01);
}

float rowZFront(float r) { return Z_NEAR * pow(Z_GROWTH, r); }
float rowZBack (float r) { return Z_NEAR * pow(Z_GROWTH, r + 1.0); }
float gridZFar() { return Z_NEAR * pow(Z_GROWTH, float(K_TIME)); }

// ===== Triadic palette =====
// hsl2rgb / triadHue live in common.glsl. bandColor stays here because the
// log-frequency band weighting (with tail boosts at the extremes) is specific
// to the bar-by-frequency layout of this shader.
//
// Pick a triad color for a (frequency, height) pair.
//   freq01 ∈ [0,1] decides which of the 3 hue slots dominates.
//   heightBoost ∈ [0,1] re-saturates and brightens loud bars.
vec3 bandColor(float freq01, float heightBoost) {
  float lf = log2(max(freq01, 1.0/512.0)) / 7.0 + 1.0; // 0..1, log-frequency

  // Triad rotates ~once per 45s. Phase chosen so a fresh start lands warm.
  float baseHue = triadHue(0.06);

  // Triad weights — three smooth bumps centered at lf=1/6, 1/2, 5/6.
  // Using smoothstep-difference bumps so transitions are soft, never hard.
  float w0 = smoothstep(0.00, 0.34, lf) * (1.0 - smoothstep(0.34, 0.66, lf));
  float w2 = smoothstep(0.34, 0.66, lf) * (1.0 - smoothstep(0.66, 1.00, lf));
  float w1 = smoothstep(0.66, 1.00, lf);
  // Add tail weights at the extremes so bass and treble keep a clear identity.
  w0 += 1.0 - smoothstep(0.00, 0.18, lf);
  w1 += smoothstep(0.82, 1.00, lf) * 0.7;
  // Renormalize.
  float wSum = max(w0 + w2 + w1, 1e-4);
  w0 /= wSum; w2 /= wSum; w1 /= wSum;

  // Three hues at 120° apart.
  float h0 = baseHue;
  float h1 = fract(baseHue + 1.0 / 3.0);
  float h2 = fract(baseHue + 2.0 / 3.0);

  // Saturation/lightness react to height — taller columns get more vivid.
  float sat = clamp(0.65 + 0.30 * heightBoost, 0.0, 1.0);
  float lit = clamp(0.46 + 0.18 * heightBoost, 0.0, 1.0);

  vec3 c0 = hsl2rgb(h0, sat, lit);
  vec3 c1 = hsl2rgb(h1, sat, lit);
  vec3 c2 = hsl2rgb(h2, sat, lit);

  vec3 base = c0 * w0 + c2 * w2 + c1 * w1;
  return clamp(base, 0.0, 2.0);
}

// Sky hue shift on transients (unchanged).
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

// ===== Fisheye warp =====
// Apply a barrel distortion to centered UVs around the horizon. Strength
// chosen so the screen edges genuinely curve — at |r|=1 the radial position
// is pulled inward by ~35%, which makes the "world" at the screen edge
// sample world-space columns from a much larger angular range.
//   wrap = how aggressively the edges curve. >0 → barrel (edges pulled in,
//          equivalent to FOV widening with curvature).
// Operates around (0.5, HORIZON) so the floor's vanishing point is the
// optical center — the bar field wraps around that point, not the middle of
// the screen. We also slightly squash X first so the "panoramic strip"
// reads as a wide arc rather than a hemisphere.
vec2 fisheyeWarp(vec2 suv) {
  vec2 c = vec2(0.5, HORIZON);
  vec2 d = suv - c;
  d.x /= 1.15;                                    // slight horizontal squash before warp
  float r = length(d * vec2(1.0, 1.6));           // slightly weight Y so the floor curves too
  // Strong barrel: r' = r * (1 + k*r^2). With k≈0.65 the unit circle pulls
  // sharply inward, simulating a fisheye lens. We invert it so warped UVs
  // sample SOURCE coords from a wider angle (i.e. squeeze world into screen).
  float k = 0.95;
  float warped = r / (1.0 + k * r * r);
  // Rebuild displacement vector at the new radius (preserving direction).
  vec2 dir = (r > 1e-5) ? d / r : vec2(0.0);
  vec2 d2 = dir * warped;
  return c + d2;
}

void main() {
  // ===== FISHEYE: warp screen UVs once at the top =====
  // Everything downstream uses `suv` as if it were the original screen coord.
  // The conveyor / face math operates in this warped space, so the bar field
  // appears to wrap around the viewer.
  vec2 rawUV = v_uv;
  vec2 suv = fisheyeWarp(rawUV);
  vec3 col;

  // ===================== SKY ===================== (unchanged structure)
  vec2 skyUV = vec2(suv.x - 0.5, suv.y - HORIZON);
  skyUV.x *= 1.6;

  float chg = changeEnergy();
  float hueShift = clamp(chg * 3.5, 0.0, 1.2);
  float baseHue = u_time * 0.015;

  const vec3 PAL_A = vec3(0.55, 0.36, 0.32);
  const vec3 PAL_B = vec3(0.45, 0.22, 0.30);
  const vec3 PAL_C = vec3(1.00, 1.00, 1.00);
  vec3 palD = vec3(0.00, 0.15, 0.55) + vec3(hueShift * 0.35);

  const float SCL0 = 1.0,  ROT0 = 0.015;
  const float SCL1 = 1.6,  ROT1 = 0.035;
  const float SCL2 = 2.4,  ROT2 = 0.060;
  const float SCL3 = 3.6,  ROT3 = 0.095;

  vec2 sw0 = rot2d(u_time * ROT0) * skyUV;
  float c0 = fbm(sw0 * SCL0 + vec2(0.0, u_time * 0.03));
  vec3 sky = palette(c0 * 0.55 + baseHue + hueShift,        PAL_A, PAL_B, PAL_C, palD);
  float vGrad = smoothstep(0.0, 0.6, suv.y - HORIZON);
  sky *= mix(0.78, 1.05, vGrad);

  vec2 sw1 = rot2d(u_time * ROT1) * skyUV;
  float c1 = fbm(sw1 * SCL1 + vec2(2.7, -u_time * 0.05));
  vec3 lay1 = palette(c1 * 0.7 + baseHue + hueShift + 0.08, PAL_A, PAL_B, PAL_C, palD);
  float a1 = smoothstep(0.42, 0.78, c1) * 0.65;
  sky = mix(sky, lay1, a1);

  vec2 sw2 = rot2d(u_time * ROT2) * skyUV;
  float c2 = fbm(sw2 * SCL2 + vec2(-5.1, u_time * 0.08));
  vec3 lay2 = palette(c2 * 0.85 + baseHue + hueShift + 0.18, PAL_A, PAL_B, PAL_C, palD);
  float a2 = smoothstep(0.50, 0.82, c2) * 0.55;
  sky = mix(sky, lay2, a2);

  vec2 sw3 = rot2d(u_time * ROT3) * skyUV;
  float c3 = fbm(sw3 * SCL3 + vec2(8.3, -u_time * 0.12));
  vec3 lay3 = palette(c3 * 1.0 + baseHue + hueShift + 0.32,  PAL_A, PAL_B, PAL_C, palD);
  float a3 = smoothstep(0.55, 0.85, c3) * 0.50;
  sky = mix(sky, lay3, a3);

  float skyGlow = exp(-abs(suv.y - HORIZON) * 28.0);
  sky += vec3(0.55, 0.30, 0.18) * skyGlow * (0.4 + 0.6 * u_volume);

  col = sky;

  // ===================== FLOOR BASE TILE TEXTURE =====================
  bool belowHorizon = suv.y < HORIZON - 0.0005;
  if (belowHorizon) {
    float dyF   = HORIZON - suv.y;
    float fZ    = (CAMERA_H * FOCAL * 0.5) / max(dyF, 1e-4);
    float fX    = (suv.x - 0.5) * 2.0 * fZ / FOCAL;

    float zFar = gridZFar();
    float zT   = clamp(log2(max(fZ / Z_NEAR, 1.0)) /
                       log2(max(zFar / Z_NEAR, 1.0001)), 0.0, 1.0);
    vec3 floorNear = vec3(0.04, 0.02, 0.08);
    vec3 floorFar  = vec3(0.10, 0.08, 0.22);
    vec3 floorBase = mix(floorNear, floorFar, pow(zT, 0.65));
    col = floorBase;

    float gridXmax = float(K_FREQ) * CELL_W * 0.5;
    bool insideFloor = (fZ >= Z_NEAR) && (fZ <= zFar) && (abs(fX) <= gridXmax);
    if (insideFloor) {
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

  // ===================== STRIPS (CONVEYOR BELT) =====================
  float halfGridX = float(K_FREQ) * CELL_W * 0.5;
  float dyHorizon = HORIZON - suv.y;
  float kx        = (suv.x - 0.5) * 2.0 / FOCAL;

  float bassFlash = smoothstep(0.78, 0.95, u_bass);

  float zFar = gridZFar();
  float logZSpan = log2(max(zFar / Z_NEAR, 1.0001));

  float phi = fract(u_time / STRIP_INTERVAL);

  for (int r = K_TIME - 1; r >= 0; r--) {
    float rf = float(r) + phi;
    float zFront = rowZFront(rf);
    float zBack  = rowZBack(rf);
    float cellD  = zBack - zFront;

    float zF = zFront + cellD * GAP * 0.5;
    float zB = zBack  - cellD * GAP * 0.5;
    float zMid = 0.5 * (zF + zB);

    float depthNorm = clamp(rf * STRIP_INTERVAL / HIST_SECONDS, 0.0, 1.0);

    float spawnFade = (r == 0) ? smoothstep(0.0, 0.85, phi) : 1.0;

    float xFront = (suv.x - 0.5) * 2.0 * zF / FOCAL;
    bool xInGrid = (xFront >= -halfGridX) && (xFront <= halfGridX);

    int   cIdx     = -1;
    float cellXc   = 0.0;
    float cellXleft  = 0.0;
    float cellXright = 0.0;
    float freq01   = 0.0;
    float barH     = 0.0;

    if (xInGrid) {
      float colF = (xFront + halfGridX) / CELL_W;
      cIdx = int(floor(colF));
      if (cIdx < 0) cIdx = 0;
      if (cIdx > K_FREQ - 1) cIdx = K_FREQ - 1;
      float cf = float(cIdx);
      cellXc      = (cf + 0.5 - float(K_FREQ) * 0.5) * CELL_W;
      cellXleft   = cellXc - CELL_W * 0.5 + CELL_W * GAP * 0.5;
      cellXright  = cellXc + CELL_W * 0.5 - CELL_W * GAP * 0.5;
      freq01 = colFreq(cf);
      float amp = sampleFFTHistory(freq01, depthNorm);
      float boost = mix(1.15, 0.90, freq01);
      barH = clamp(pow(amp, 1.4) * boost * MAX_BAR_H, 0.0, MAX_BAR_H);
    }

    bool isTop = false;
    float topApex = 0.0;
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

    bool isSide = false;
    float sideTopness = 0.0;
    float sideZness   = 0.0;
    int   sIdx        = -1;
    float sideCellXc  = 0.0;
    float sideFreq01  = 0.0;
    float sideBarH    = 0.0;
    bool  sideIsRight = false;

    if (!isTop && !isFront && abs(kx) > 1e-4) {
      float xMid = kx * zMid;
      sideIsRight = (suv.x < 0.5);
      float candCellXc = sideIsRight ? (xMid - CELL_W * 0.5 + CELL_W * GAP * 0.5)
                                     : (xMid + CELL_W * 0.5 - CELL_W * GAP * 0.5);
      float candIdxF = (candCellXc + halfGridX) / CELL_W - 0.5;
      sIdx = int(floor(candIdxF + 0.5));
      if (sIdx >= 0 && sIdx <= K_FREQ - 1) {
        float sf = float(sIdx);
        sideCellXc = (sf + 0.5 - float(K_FREQ) * 0.5) * CELL_W;
        bool offAxisOK = sideIsRight ? (sideCellXc < -CELL_W * 0.5)
                                     : (sideCellXc >  CELL_W * 0.5);
        if (offAxisOK) {
          float sideX = sideIsRight ? (sideCellXc + CELL_W * 0.5 - CELL_W * GAP * 0.5)
                                    : (sideCellXc - CELL_W * 0.5 + CELL_W * GAP * 0.5);
          float zHit = sideX / kx;
          if (zHit > 0.0 && zHit >= zF && zHit <= zB) {
            sideFreq01 = colFreq(sf);
            float sAmp = sampleFFTHistory(sideFreq01, depthNorm);
            float sBoost = mix(1.15, 0.90, sideFreq01);
            sideBarH = clamp(pow(sAmp, 1.4) * sBoost * MAX_BAR_H, 0.0, MAX_BAR_H);
            if (sideBarH > 1e-4) {
              float yHit = CAMERA_H - dyHorizon * zHit * 2.0 / FOCAL;
              if (yHit >= 0.0 && yHit <= sideBarH) {
                isSide = true;
                sideTopness = yHit / max(sideBarH, 1e-4);
                sideZness   = (zHit - zF) / max(zB - zF, 1e-4);
              }
            }
          }
        }
      }
    }

    if (!isTop && !isFront && !isSide) continue;

    float useFreq = isSide ? sideFreq01 : freq01;
    float useBar  = isSide ? sideBarH   : barH;
    float heightT = useBar / MAX_BAR_H;
    vec3 baseCol = bandColor(useFreq, heightT);
    float zForFog = isSide ? (zF + sideZness * (zB - zF)) : zF;
    float fog = clamp(log2(max(zForFog / Z_NEAR, 1.0)) / logZSpan, 0.0, 1.0);
    fog = pow(fog, 0.75);

    float edgeMask = 0.0;
    float fu = 0.0, fv = 0.0;
    float fuw = 0.002, fvw = 0.002;

    vec3 fillCol;
    vec3 edgeCol;
    float fillAlpha;

    if (isTop) {
      float zTop = (CAMERA_H - barH) * FOCAL * 0.5 / dyHorizon;
      float xTop = (suv.x - 0.5) * 2.0 * zTop / FOCAL;
      fu = (xTop - cellXleft) / max(cellXright - cellXleft, 1e-4);
      fv = (zTop - zF) / max(zB - zF, 1e-4);
      fuw = fwidth(fu) * 1.4;
      fvw = fwidth(fv) * 1.4;

      fillCol = baseCol * (0.55 + 0.20 * topApex);
      edgeCol = bandColor(useFreq, min(heightT + 0.35, 1.0)) * 1.85;
      fillAlpha = 0.50;
    } else if (isSide) {
      fu = sideZness;
      fv = sideTopness;
      fuw = fwidth(fu) * 1.4;
      fvw = fwidth(fv) * 1.4;

      fillCol = baseCol * (0.42 + 0.30 * sideTopness);
      edgeCol = bandColor(useFreq, min(heightT + 0.30, 1.0)) * 1.65;
      fillAlpha = 0.55;
    } else {
      fu = (xFront - cellXleft) / max(cellXright - cellXleft, 1e-4);
      fv = frontTopness;
      fuw = fwidth(fu) * 1.4;
      fvw = fwidth(fv) * 1.4;

      fillCol = baseCol * (0.32 + 0.32 * frontTopness);
      edgeCol = bandColor(useFreq, min(heightT + 0.40, 1.0)) * 1.95;
      fillAlpha = 0.60;
    }

    float eU = 1.0 - smoothstep(0.0, fuw, min(fu, 1.0 - fu));
    float eV = 1.0 - smoothstep(0.0, fvw, min(fv, 1.0 - fv));
    edgeMask = clamp(max(eU, eV), 0.0, 1.0);

    float edgeBoost = 0.55 + 0.85 * heightT;
    edgeCol *= edgeBoost;

    vec3 hazeCol = vec3(0.10, 0.08, 0.22);
    fillCol *= mix(1.0, 0.18, fog);
    fillCol  = mix(fillCol, hazeCol, fog * 0.92);
    edgeCol *= mix(1.0, 0.30, fog);
    edgeCol  = mix(edgeCol, hazeCol, fog * 0.85);

    fillCol *= 1.0 + 0.22 * u_bass;
    fillCol  = mix(fillCol, fillCol * vec3(0.55, 0.85, 1.55), bassFlash * 0.35);

    vec3 faceCol = mix(fillCol, edgeCol, edgeMask);
    float faceAlpha = mix(fillAlpha, 1.0, edgeMask);
    faceAlpha *= 1.0 - smoothstep(0.65, 1.0, fog);

    // Height→opacity (unchanged): short = solid, tall = translucent.
    float tallness = smoothstep(0.18, 0.95, heightT);
    float fillTrans = mix(1.0, 0.18, tallness);
    float edgeTrans = mix(1.0, 0.55, tallness);
    float heightAlpha = mix(fillTrans, edgeTrans, edgeMask);
    faceAlpha *= heightAlpha;

    faceAlpha *= spawnFade;

    col = mix(col, faceCol, faceAlpha);
  }

  // Subtle horizon stripe at the seam.
  float horizonStripe = exp(-abs(suv.y - HORIZON) * 240.0);
  col += vec3(0.30, 0.25, 0.55) * horizonStripe * 0.55;

  // ===== Fisheye corner mask =====
  // Strong barrel warp produces extreme stretching at the screen corners
  // (Jacobian explodes). Fade those regions toward the haze color so the
  // stretched bars dissolve into the same fog the conveyor-far horizon uses.
  // Computed in raw (un-warped) UV around the optical center.
  vec2 cornerD = (rawUV - vec2(0.5, HORIZON)) * vec2(1.0, 1.4);
  float cornerR = length(cornerD);
  float cornerFade = smoothstep(0.55, 0.95, cornerR);
  vec3 hazeEdge = vec3(0.10, 0.08, 0.22);
  col = mix(col, hazeEdge, cornerFade * 0.65);

  // Vignette in raw screen space (before warp) so it stays a clean oval.
  vec2 vuv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float vig = smoothstep(1.3, 0.3, length(vuv));
  col *= mix(0.78, 1.0, vig);

  // Tonemap so bass peaks don't clip to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
