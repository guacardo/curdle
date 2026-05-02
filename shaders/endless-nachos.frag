// endless-nachos: a forever-zoom INTO a heaped pile of tortilla chips.
// Triangle chips overlap one another in stacks, jalapeño rings spin on top,
// splattered-paint sour cream + refried beans + hot sauce, beef chunks. As
// the camera dives in, when a single chip grows large enough to dominate the
// screen center, smaller chips fractally bloom across its surface. You will
// never reach the bottom. There is no bottom. Only nachos.
//
// Core trick: log-space tiling. TWO octaves separated by a fixed zoomFactor.
// We descend by *shrinking* tile coords over time so small features grow
// toward us. After one cycle the world has zoomed in by exactly zoomFactor —
// bit-identical to the start. Seamless infinite descent. The plate background
// is chip-colored so the wrap point is invisible.
//
// Recursion: smaller octave is GATED two ways. Per-pixel: only inside a
// parent chip mask. Globally: only when SOME parent chip is dominating the
// screen center. No dominant chip → no recursion → reads as a normal pile.
//
// PERF PASS: cuts cost ~3-4x.
//  - CHIPS_PER_CELL 2 → 1 (3x3 overlap still reads as a heap).
//  - Layer B only evaluated in last 25% of cycle (uniform branch).
//  - Sub-chip recursion only evaluated when centerDom > 0.01 (uniform branch).
//  - splatPaint fbm calls (16 hashes ea) → single vnoise (4 hashes).
//  - Beef warp fbm → single vnoise.
//  - Condiment neighborhood reduced to 1x1 (radii stay <0.5 cell).
//  - Per-cell hashes computed lazily inside their gating branches.

// ---- SDFs -------------------------------------------------------------------

// Equilateral triangle pointing up, circumradius ~r. Rounded by `round`.
float sdTriangle(vec2 p, float r, float round_) {
  const float k = 1.7320508;            // sqrt(3)
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y) - round_;
}

float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

// ---- Parent-chip SDF probe --------------------------------------------------
// "Is this point inside SOME chip from the parent layer?" Single chip per cell
// now (matches CHIPS_PER_CELL=1). 1x1 probe — chips don't extend past ~0.5
// cells.
float parentChipSDF(vec2 p, float cellID) {
  vec2 cell = floor(p);
  vec2 lp   = fract(p) - 0.5;
  vec2 id   = cell;
  float h0 = hash21(id + cellID * 17.13);
  float h1 = hash21(id + cellID * 17.13 + 7.7);
  float h2 = hash21(id + cellID * 17.13 + 19.3);
  float h3 = hash21(id + cellID * 17.13 + 31.1);
  vec2 chipOff = vec2(h0 - 0.5, h1 - 0.5) * 0.85;
  float chipR  = mix(0.50, 0.78, h2);
  float rot    = (h3 - 0.5) * TAU;
  vec2 cp      = rot2d(rot) * (lp - chipOff);
  return sdTriangle(cp, chipR, 0.04);
}

// ---- Ground-beef chunks -----------------------------------------------------
// Sparse warped-circle blobs. Returns premultiplied RGBA.
vec4 beefChunks(vec2 p) {
  vec2 cell = floor(p);
  vec2 f    = fract(p) - 0.5;
  vec4 acc = vec4(0.0);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 off = vec2(float(ox), float(oy));
      vec2 id  = cell + off;
      // Sparsity gate FIRST — skip all SDF/noise math when no chunk in cell.
      float hb = hash21(id + 91.7);
      if (hb < 0.85) continue;
      vec2 lp  = f - off;
      float h0 = hash21(id + 113.3);
      float h1 = hash21(id + 217.1);
      float h2 = hash21(id + 311.9);
      vec2 bOff = vec2(h0 - 0.5, h1 - 0.5) * 0.7;
      float bR  = mix(0.04, 0.09, h2);
      // Single value-noise warp (was fbm × 2 = 32 hashes; now 8). Good enough
      // for the crumbly silhouette read.
      vec2 q = (lp - bOff);
      float warp = vnoise(q * 8.0 + id) - 0.5;
      float dB = length(q) - bR + warp * 0.04;
      // Two overlapping bumps for "chunk" feel.
      vec2 bOff2 = bOff + vec2(h2 - 0.5, h0 - 0.5) * bR * 1.3;
      float warp2 = vnoise(q * 7.0 - id) - 0.5;
      float dB2 = length(lp - bOff2) - bR * 0.7 + warp2 * 0.04;
      float d = smin(dB, dB2, 0.02);
      float cov = smoothstep(0.008, -0.008, d);
      // Lighter highlight on top-left of chunk.
      float hi = smoothstep(0.0, -0.04, length(lp - bOff - vec2(-0.015, 0.02)) - bR * 0.4);
      vec3 beefBase = vec3(0.45, 0.25, 0.10);
      vec3 beefHi   = vec3(0.62, 0.38, 0.18);
      vec3 col = mix(beefBase, beefHi, hi * 0.7);
      vec4 c = vec4(col * cov, cov);
      acc.rgb = mix(acc.rgb, c.rgb / max(c.a, 1e-4), c.a * (1.0 - acc.a));
      acc.a   = acc.a + c.a * (1.0 - acc.a);
    }
  }
  return acc;
}

// ---- Splattered-paint condiment renderer ------------------------------------
// Draws an elongated value-noise-warped main blob (acrylic-paint stroke),
// satellite specks around it, and a 3D shine: bright specular highlight on the
// upper-left + soft inner shadow on the lower-right edge to suggest paint
// thickness sitting on the chip. Returns premultiplied RGBA.
//
// Single vnoise tap per blob (was 2× fbm = 32 hashes; now 4) — enough for
// jagged irregular paint edges, fbm was overkill for decorative warp.
vec4 splatPaint(vec2 lp, vec2 ofs, float sR, float aspect, float ang,
                vec3 baseCol, vec3 hiCol, vec2 chash) {
  vec2 q = lp - ofs;
  // Rotate into blob-local frame: x along long axis, y perpendicular.
  vec2 qr = rot2d(-ang) * q;
  // Anisotropic squash — divide x by aspect so the unit "circle" becomes an
  // ellipse with long axis along x.
  vec2 qa = vec2(qr.x / aspect, qr.y);
  // Single value-noise tap, seeded by per-cell hash so every splat has a
  // unique jagged silhouette.
  float warp = vnoise(qa * 7.0 + chash * 11.7) - 0.5;
  float dMain = length(qa) - sR + warp * sR * 1.10;

  // Wider AA falloff softens the silhouette so the edge feathers into the
  // chip below — irregular paint, not a hard outline.
  float cov = smoothstep(0.025, -0.025, dMain);

  // Satellite specks — 5 tiny dots in a ring around the blob.
  float dotsCov = 0.0;
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    float dh0 = hash21(chash + fk * 13.7 + 71.3);
    float dh1 = hash21(chash + fk * 13.7 + 89.1);
    float dh2 = hash21(chash + fk * 13.7 + 103.5);
    float a = dh0 * TAU;
    float rad = sR * mix(1.4, 2.6, dh1) * mix(1.0, aspect * 0.7, 0.4);
    vec2 dotPos = ofs + rot2d(ang) * (vec2(cos(a), sin(a)) * rad * vec2(aspect * 0.6, 1.0));
    float dotR  = sR * mix(0.06, 0.16, dh2);
    float dDot  = sdCircle(lp - dotPos, dotR);
    dotsCov = max(dotsCov, smoothstep(0.006, -0.006, dDot));
  }

  // Combined coverage (specks join the silhouette).
  float totalCov = max(cov, dotsCov);

  // ---- 3D shine ------------------------------------------------------------
  // Specular highlight: small bright spot offset toward upper-left of the
  // blob (in blob-local frame).
  vec2 hiCenter = vec2(-0.35, 0.35) * sR;     // upper-left in blob frame
  float dHi = length(qa - hiCenter) - sR * 0.28;
  float hiCov = smoothstep(0.04, -0.03, dHi);
  vec3 sheen = mix(hiCol, vec3(1.0), 0.55);

  // Inner shadow on the lower-right edge.
  float lowerRight = clamp(dot(normalize(qr + 1e-4), vec2(0.707, -0.707)), 0.0, 1.0);
  float edgeBand = smoothstep(0.0, -0.04, dMain) * smoothstep(-0.07, -0.02, dMain);
  float shadeAmt = edgeBand * lowerRight * 0.55;

  vec3 col = baseCol;
  col = mix(col, col * 0.55, shadeAmt);
  col = mix(col, sheen, hiCov * 0.85);

  return vec4(col * totalCov, totalCov);
}

// ---- One layer of nacho-pile ------------------------------------------------
// Returns premultiplied RGBA: rgb is color * coverage, a is coverage.
// `cellID` lets each layer use a different per-cell hash so octaves don't
// stack identical chips on top of each other.
// `bouncePulse` is a 0..1 audio-driven scale pulse on jalapeño size (the only
// remaining audio coupling — spin is now per-cell hashed, not audio-driven).
//
// Each cell hosts ONE chip + (sparsely) condiments. The 3x3 chip neighborhood
// already produces 9 overlapping chips per pixel — plenty of pile density.
// Condiments use a 1x1 sample (radii kept <0.5 cell so silhouettes don't pop
// at boundaries).
vec4 nachoLayer(vec2 p, float cellID, float bouncePulse) {
  vec2 cell = floor(p);
  vec2 f    = fract(p) - 0.5;          // local in [-0.5, 0.5]

  vec4 acc = vec4(0.0);

  // ---- 3x3 chip neighborhood ------------------------------------------------
  // Chips can spill across cell boundaries (radius up to 0.78 + offset 0.425
  // ≈ 1.2 cells), so 3x3 is required.
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 off = vec2(float(ox), float(oy));
      vec2 id  = cell + off;
      vec2 lp  = f - off;

      // Only the 3 hashes needed for this single chip.
      float c0 = hash21(id + cellID * 17.13);
      float c1 = hash21(id + cellID * 17.13 + 7.7);
      float c2 = hash21(id + cellID * 17.13 + 19.3);
      float c3 = hash21(id + cellID * 17.13 + 31.1);

      vec2  chipOff = vec2(c0 - 0.5, c1 - 0.5) * 0.85;
      float chipR   = mix(0.50, 0.78, c2);
      float rot     = (c3 - 0.5) * TAU;
      vec2  cp      = rot2d(rot) * (lp - chipOff);
      float dChip   = sdTriangle(cp, chipR, 0.04);

      // Drop shadow for this chip.
      vec2  spOff   = vec2(0.05, -0.05);
      float dShadow = sdTriangle(rot2d(rot) * (lp - chipOff - spOff), chipR, 0.04);
      float shadow  = smoothstep(0.06, -0.01, dShadow) * 0.55;

      float grain   = 0.88 + 0.12 * hash21(cp * 27.3 + id);
      vec3  chipMid = vec3(0.96, 0.74, 0.32);
      vec3  chipEdge= vec3(0.78, 0.38, 0.10);
      float rim     = smoothstep(-0.02, -0.10, dChip);
      float speckle = step(0.92, hash21(cp * 33.7));
      vec3  chipCol = mix(chipEdge, chipMid, rim) * grain;
      chipCol = mix(chipCol, chipCol * 0.78, speckle * rim * 0.6);

      float chipCov = smoothstep(0.010, -0.010, dChip);

      vec4 chipsAcc = vec4(0.0);
      chipsAcc.rgb = mix(chipsAcc.rgb, chipsAcc.rgb * (1.0 - shadow), shadow);
      chipsAcc.a   = max(chipsAcc.a, shadow * 0.6);
      chipsAcc.rgb = mix(chipsAcc.rgb, chipCol, chipCov);
      chipsAcc.a   = max(chipsAcc.a, chipCov);

      // Composite this neighbor's chip into the layer accumulator.
      acc.rgb = mix(acc.rgb, chipsAcc.rgb, chipsAcc.a * (1.0 - acc.a));
      acc.a   = acc.a + chipsAcc.a * (1.0 - acc.a);
    }
  }

  // ---- Condiments + jalapeño: 1x1 sample (own cell only) -------------------
  // Splat radii peak at sR≈0.224 (sour cream: 0.16*1.4) with offset 0.4 →
  // worst-case extent ≈ 0.62 from cell center; specks add a bit more (~2.6×
  // sR ≈ 0.58 from blob center). For typical params they stay within ±0.5
  // and are crisp; rare overshoots feather softly via the AA falloff.
  {
    vec2 id = cell;
    vec2 lp = f;

    float h0 = hash21(id + cellID * 17.13);
    float h1 = hash21(id + cellID * 17.13 + 7.7);
    float h2 = hash21(id + cellID * 17.13 + 19.3);
    float h3 = hash21(id + cellID * 17.13 + 31.1);
    float h4 = hash21(id + cellID * 17.13 + 53.9);

    // ---- Jalapeño — only some cells ---------------------------------------
    vec4 jal = vec4(0.0);
    if (h4 > 0.30) {
      vec2 jOff = vec2(h1 - 0.5, h0 - 0.5) * 0.45;
      float bouncePhase = 0.5 + 0.5 * sin(u_time * 6.0 + h2 * TAU);
      float perCellPulse = mix(0.5, 1.0, bouncePhase) * bouncePulse;
      float jScale = 0.8 + 0.4 * clamp(perCellPulse, 0.0, 1.0);
      float jR  = mix(0.10, 0.16, h2) * jScale;
      float rateMag  = mix(0.524, 1.047, h3);
      float spinDir  = (h0 > 0.5) ? 1.0 : -1.0;
      float spinRate = spinDir * rateMag;
      float spinAng  = u_time * spinRate + h0 * TAU;
      vec2 jp = rot2d(spinAng) * (lp - jOff);

      float dRing  = abs(sdCircle(jp, jR)) - 0.025;
      float ringCov = smoothstep(0.010, -0.010, dRing);
      float fleshCov = smoothstep(0.010, -0.010, sdCircle(jp, jR - 0.025));

      float spokeCount = floor(4.0 + h2 * 3.0);
      float angA = atan(jp.y, jp.x);
      float spokeWave = cos(angA * spokeCount);
      float spokeLine = smoothstep(0.92, 0.99, spokeWave);
      float rNorm = length(jp) / max(jR, 1e-4);
      float spokeBand = smoothstep(0.15, 0.25, rNorm) * (1.0 - smoothstep(0.80, 0.95, rNorm));
      float spokeCov = spokeLine * spokeBand * fleshCov;

      vec2 seedPos = vec2(h3 - 0.5, h0 - 0.5) * jR * 0.4;
      float dSeedDot = sdCircle(jp - seedPos, jR * 0.10);
      float seedCov = smoothstep(0.008, -0.008, dSeedDot);

      vec3 ringCol  = vec3(0.30, 1.00, 0.25);
      vec3 fleshCol = vec3(0.78, 1.00, 0.55);
      vec3 spokeCol = vec3(0.15, 0.55, 0.12);
      vec3 seedCol  = vec3(0.95, 0.95, 0.78);

      vec3 jc = fleshCol;
      float jcov = fleshCov;
      jc = mix(jc, spokeCol, spokeCov);
      jc = mix(jc, ringCol, ringCov);
      jcov = max(jcov, ringCov);
      jc = mix(jc, seedCol, seedCov);
      jcov = max(jcov, seedCov);
      jal = vec4(jc * jcov, jcov);
    }

    // ---- Sour cream ------------------------------------------------------
    vec4 cream = vec4(0.0);
    if (h2 > 0.78) {
      vec2 sOff = vec2(h3 - 0.5, h4 - 0.5) * 0.4;
      float sR  = mix(0.10, 0.16, h1) * 1.4;
      float aspect = mix(2.0, 2.6, h0);
      float angC = h3 * TAU;
      vec3 baseCol = vec3(0.97, 0.97, 0.95);
      vec3 hiCol   = vec3(1.0, 1.0, 1.0);
      cream = splatPaint(lp, sOff, sR, aspect, angC, baseCol, hiCol,
                         id + cellID * 17.13);
    }

    // ---- Refried beans ---------------------------------------------------
    vec4 beans = vec4(0.0);
    if (h0 > 0.75) {
      vec2 bOff = vec2(h2 - 0.5, h1 - 0.5) * 0.45;
      float bR  = mix(0.10, 0.16, h4) * 1.4 * 0.6;
      float aspect = mix(1.6, 2.2, h3);
      float angB = h1 * TAU + 1.3;
      vec3 baseCol = vec3(0.42, 0.22, 0.08);
      vec3 hiCol   = vec3(0.55, 0.32, 0.14);
      beans = splatPaint(lp, bOff, bR, aspect, angB, baseCol, hiCol,
                         id + cellID * 17.13 + 211.7);
    }

    // ---- Hot sauce -------------------------------------------------------
    vec4 hotsauce = vec4(0.0);
    if (h1 > 0.78) {
      vec2 hOff = vec2(h0 - 0.5, h3 - 0.5) * 0.5;
      float hR  = mix(0.08, 0.13, h2) * 1.4 * 0.55;
      float aspect = mix(2.8, 3.4, h4);
      float angH = h0 * TAU - 0.7;
      vec3 baseCol = vec3(0.92, 0.18, 0.05);
      vec3 hiCol   = vec3(1.0, 0.45, 0.15);
      hotsauce = splatPaint(lp, hOff, hR, aspect, angH, baseCol, hiCol,
                            id + cellID * 17.13 + 421.3);
    }

    // Composite condiments over the chip stack.
    acc.rgb = mix(acc.rgb, jal.rgb / max(jal.a, 1e-4), jal.a);
    acc.a   = max(acc.a, jal.a);
    acc.rgb = mix(acc.rgb, beans.rgb / max(beans.a, 1e-4), beans.a);
    acc.a   = max(acc.a, beans.a);
    acc.rgb = mix(acc.rgb, cream.rgb / max(cream.a, 1e-4), cream.a);
    acc.a   = max(acc.a, cream.a);
    acc.rgb = mix(acc.rgb, hotsauce.rgb / max(hotsauce.a, 1e-4), hotsauce.a);
    acc.a   = max(acc.a, hotsauce.a);
  }

  return acc;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Endless dive INTO the plate -----------------------------------------
  float diveSpeed = 0.18;
  float dive      = u_time * diveSpeed;

  const float ZOOM_FACTOR = 3.0;
  float cyc   = fract(dive);
  float scale = exp(-cyc * log(ZOOM_FACTOR));

  float rotDrift = 0.08 * sin(u_time * 0.13) + dive * 0.05;

  // ---- Wrap-pair coords -----------------------------------------------------
  float baseRot = rotDrift;
  vec2 pMainA = rot2d(baseRot - 0.13) * uv * scale * 4.0;
  vec2 pMainB = rot2d(baseRot - 0.13) * uv * scale * 4.0 * ZOOM_FACTOR;
  vec2 pSub   = rot2d(baseRot + 0.21) * uv * scale * 4.0 * ZOOM_FACTOR * ZOOM_FACTOR;

  // ---- Late-window crossfade -----------------------------------------------
  // For cyc<0.75: only A renders. For cyc>=0.75: smoothly crossfade to B.
  // At cyc=1, B's content == A's content at next cyc=0 (same hashes, same
  // base scale), so the swap is still bit-identical.
  float wB = smoothstep(0.75, 1.0, cyc);
  float wA = 1.0 - wB;

  // ---- Audio coupling -------------------------------------------------------
  float bouncePulse = smoothstep(0.15, 0.85, u_bass);

  // Layer A is always evaluated.
  vec4 layerMainA = nachoLayer(pMainA, 2.0, bouncePulse);

  // Layer B is only evaluated in the crossfade window — saves a full
  // nachoLayer call on ~75% of frames. Branch is fragment-coherent (cyc is
  // a uniform-like value, identical across the screen).
  vec4 layerMainB = vec4(0.0);
  float sdfParentB = 1e3;
  if (cyc > 0.75) {
    layerMainB = nachoLayer(pMainB, 2.0, bouncePulse);
    sdfParentB = parentChipSDF(pMainB, 2.0);
  }

  // ---- Center dominance probe (uniform across screen) ----------------------
  // Sampled at uv=0 so every fragment computes the same value — the GPU's
  // dynamic-uniform branching keeps the cost ~free.
  float centerDom = smoothstep(0.0, -0.18, parentChipSDF(vec2(0.0), 2.0));

  // ---- Sub-chip recursion (only when a parent dominates the center) --------
  // Most of the time no chip is centered → skip the entire sub-layer call
  // AND the per-pixel mask probe. This is the biggest win.
  vec4 layerSub = vec4(0.0);
  float maskSub = 0.0;
  if (centerDom > 0.01) {
    layerSub = nachoLayer(pSub, 1.0, bouncePulse);
    float sdfParentA = parentChipSDF(pMainA, 2.0);
    float maskA = smoothstep(0.0, -0.05, sdfParentA);
    float maskB = (cyc > 0.75) ? smoothstep(0.0, -0.05, sdfParentB) : maskA;
    maskSub = mix(maskA, maskB, wB);
  }

  // ---- Plate background ----------------------------------------------------
  vec3 chipBg = vec3(0.96, 0.74, 0.32);
  float plateN = vnoise(uv * 5.0 + u_time * 0.05);
  vec3 plateCol = chipBg * (0.92 + 0.10 * plateN);

  // ---- Beef ----------------------------------------------------------------
  vec2 beefCoords = mix(pMainA, pMainB, wB) * 1.7;
  vec4 beef = beefChunks(beefCoords);
  beef *= (1.0 - maskSub * 0.85);

  // ---- Composite -----------------------------------------------------------
  vec3 col = plateCol;
  col = mix(col, beef.rgb / max(beef.a, 1e-4), beef.a);
  col = mix(col, layerMainA.rgb / max(layerMainA.a, 1e-4), layerMainA.a * wA);
  col = mix(col, layerMainB.rgb / max(layerMainB.a, 1e-4), layerMainB.a * wB);
  col = mix(col, layerSub.rgb / max(layerSub.a, 1e-4),
            layerSub.a * maskSub * centerDom);

  // Radial darkening focuses attention on the dive center.
  float r = length(uv);
  float radialPull = smoothstep(0.0, 1.2, r);
  col *= 1.0 - 0.20 * radialPull;

  // Warm vignette.
  float vig = smoothstep(1.30, 0.30, r);
  col = mix(col * vec3(0.55, 0.35, 0.15), col, vig);

  // Tonemap.
  col = col / (1.0 + 0.55 * col);

  // Lift blacks toward warm brown.
  col = max(col, vec3(0.05, 0.025, 0.01));

  outColor = vec4(col, 1.0);
}
