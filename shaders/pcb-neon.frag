// pcb-neon: a printed circuit board being routed *live* by five concurrent
// pathfinding agents. Deep violet-blue substrate, rectilinear traces in three
// discrete neon hues (green / yellow / sodium-orange). Each frame the visible
// network is the union of five expanding wavefronts: cells light up in the
// order they would have been discovered by a BFS / A* exploring outward from
// each seed. Recently-discovered cells glow F-Zero hot, then settle to a dim
// completed-trace baseline. No big radial pulse — the *growth itself* is the
// spectacle, and the camera pulls way back to reveal a sprawling board.
//
// Construction:
//   - The screen is a coarse grid. Each cell still hashes to an L-shaped
//     trace orientation, BUT each cell is also "owned" by exactly one of five
//     concurrent search seeds (whichever seed it's closest to in Manhattan
//     distance). Five seeds — only three hues; multiple seeds can share a hue
//     so the palette stays a clean triad while the network sprawls faster.
//   - Per-cell discovery time = Manhattan distance from owning seed scaled by
//     the seed's exploration speed, plus a small hash jitter so the wavefront
//     isn't a clean diamond — it looks like a maze-carver branching out.
//   - A cell is *visible* only when current frontier > its discoveryTime.
//   - Recently-discovered cells (within ~5% of frontier) glow hyper-bright;
//     intensity then decays exponentially to the completed-trace baseline.
//   - Seeds re-roll every EPOCH_SECONDS, the camera snaps back to zoomed-in,
//     and the whole sprawl re-grows outward.
//   - Chips/vias punctuate the board on a coarser grid. A component only
//     reveals once *its* cell has been discovered. Chips have animated
//     scanlines, blinky LEDs, and rare reboot flashes — they read as alive.
//
// Audio:
//   - Bass: briefly boosts frontier expansion speed — the routing accelerates
//     on the kick, racing outward across the now-much-bigger visible board.
//   - Volume + mid: more electrons, longer vapor trails on freshly-grown paths,
//     stronger chip body breathing.
//   - Per-cell FFT bin gate: each trace listens to its hashed bin; loud bins
//     keep their cores brighter even after the recency glow fades.
//   - Treble: random pads/vias flash white-hot; chip reboot flashes gated by
//     treble peaks.

// ---------- SDF primitives ----------

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Distance to a parameterized point on the L-path, plus the t along the path.
// Returns (distance, tNearest) where tNearest is normalized arclength along a→corner→b.
vec2 sdLPath(vec2 p, vec2 a, vec2 corner, vec2 b) {
  float d1 = sdSegment(p, a, corner);
  float d2 = sdSegment(p, corner, b);
  float L1 = length(corner - a);
  float L2 = length(b - corner);
  float Lt = max(L1 + L2, 1e-4);
  vec2 a1 = corner - a;
  float t1 = clamp(dot(p - a, a1) / max(dot(a1, a1), 1e-6), 0.0, 1.0);
  vec2 a2 = b - corner;
  float t2 = clamp(dot(p - corner, a2) / max(dot(a2, a2), 1e-6), 0.0, 1.0);
  if (d1 <= d2) {
    return vec2(d1, (t1 * L1) / Lt);
  } else {
    return vec2(d2, (L1 + t2 * L2) / Lt);
  }
}

// ---------- exploration cycle helpers ----------

// One "epoch" = one re-seed cycle. Fixed cadence so the BFS frontier never
// rewinds mid-frame. Bass coupling lives in frontier speed, not the clock.
// Shortened from 6s → 5s because the camera pulls way back now and the larger
// visible area would otherwise feel slow to fill.
#define EPOCH_SECONDS 5.0
#define NUM_SEEDS 5
float epochIdOf(float t)    { return floor(t / EPOCH_SECONDS); }
float epochStartOf(float e) { return e * EPOCH_SECONDS; }

// Five seed cell IDs for the given epoch.
// Domain: integer cell coordinates within roughly [-halfSpan, halfSpan].
void seedsForEpoch(float epoch, float halfSpan,
                   out vec2 s0, out vec2 s1, out vec2 s2, out vec2 s3, out vec2 s4) {
  vec2 e = vec2(epoch, epoch * 1.731);
  s0 = floor(vec2(hash21(e + 11.1), hash21(e + 22.2)) * 2.0 * halfSpan - halfSpan);
  s1 = floor(vec2(hash21(e + 33.3), hash21(e + 44.4)) * 2.0 * halfSpan - halfSpan);
  s2 = floor(vec2(hash21(e + 55.5), hash21(e + 66.6)) * 2.0 * halfSpan - halfSpan);
  s3 = floor(vec2(hash21(e + 77.7), hash21(e + 88.8)) * 2.0 * halfSpan - halfSpan);
  s4 = floor(vec2(hash21(e + 99.9), hash21(e + 13.7)) * 2.0 * halfSpan - halfSpan);
}

// Manhattan distance — the natural BFS step metric on a grid.
float manhattan(vec2 a, vec2 b) {
  vec2 d = abs(a - b);
  return d.x + d.y;
}

// Resolve owning seed (out of 5) for a cell. Returns discTime + hueId (0..2).
// Five seeds map to three hues: 0,1,2,0,1 — so two hues get an extra agent and
// the triad still reads cleanly.
void ownerOf(vec2 cellPos,
             vec2 s0, vec2 s1, vec2 s2, vec2 s3, vec2 s4,
             float jitterBase,
             out float discTime, out float hueId) {
  float dm0 = manhattan(cellPos, s0) + jitterBase;
  float dm1 = manhattan(cellPos, s1) + hash21(cellPos + 9.13)  * 0.9;
  float dm2 = manhattan(cellPos, s2) + hash21(cellPos + 71.7)  * 0.9;
  float dm3 = manhattan(cellPos, s3) + hash21(cellPos + 27.41) * 0.9;
  float dm4 = manhattan(cellPos, s4) + hash21(cellPos + 53.19) * 0.9;
  float bestD = dm0;
  float bestH = 0.0;
  if (dm1 < bestD) { bestD = dm1; bestH = 1.0; }
  if (dm2 < bestD) { bestD = dm2; bestH = 2.0; }
  if (dm3 < bestD) { bestD = dm3; bestH = 0.0; } // seed 3 reuses hue 0
  if (dm4 < bestD) { bestD = dm4; bestH = 1.0; } // seed 4 reuses hue 1
  discTime = bestD;
  hueId = bestH;
}

void main() {
  vec2 res  = u_resolution;
  vec2 frag = gl_FragCoord.xy;
  vec2 rawUV = (frag - 0.5 * res) / min(res.x, res.y);

  // ---------- exploration state (need epoch first for camera) ----------
  // Time inside the current epoch — the "frontier clock".
  float epoch    = epochIdOf(u_time);
  float epochT0  = epochStartOf(epoch);
  float localT   = max(u_time - epochT0, 0.0);
  float epochFrac = clamp(localT / EPOCH_SECONDS, 0.0, 1.0);
  // Frontier sprints harder now: ~12 cells/sec base, +22 with bass. Combined
  // with the wider zoom-out range, this means the network *races* to fill the
  // bigger visible board within a single epoch.
  float frontierSpeed = 12.0 + 22.0 * pow(u_bass, 1.6);
  float frontier = localT * frontierSpeed;

  // Five concurrent seeds. Halfspan widened from 8 → 14 cells so seeds can
  // spread across the much larger visible region at min zoom without all
  // bunching near the center.
  vec2 seed0, seed1, seed2, seed3, seed4;
  seedsForEpoch(epoch, 14.0, seed0, seed1, seed2, seed3, seed4);

  // ---------- CAMERA TRANSFORM ----------
  // Continuous slow rotation — does NOT reset on epoch flips.
  float camAngle = u_time * 0.035;
  mat2 camRot = rot2d(camAngle);

  // Zoom: starts tight on the seed area (1.5x in) and pulls way out as the BFS
  // frontier expands, ending at 0.18x to reveal the full sprawl. Zoom-out
  // shape is steeper now (pow 0.55) so the pull-back happens earlier in the
  // epoch — by mid-epoch we're already wide. Reset is a hard cut back to
  // zoomed-in (matches the seed re-roll snap), which reads as a deliberate
  // "new chip" beat.
  float zoomCurve = pow(epochFrac, 0.55);
  float zoom = mix(1.5, 0.18, zoomCurve);

  // Pan: bias toward seed centroid at epoch start, then drift.
  float cellScale = 9.0;
  vec2 seedCentroid = (seed0 + seed1 + seed2 + seed3 + seed4) / float(NUM_SEEDS) / cellScale;
  float followW = (1.0 - smoothstep(0.0, 0.40, epochFrac)) * 0.8;
  vec2 driftPan = vec2(
    sin(u_time * 0.11 + 1.3) * 0.18,
    cos(u_time * 0.083 + 0.7) * 0.13
  );
  vec2 pan = mix(driftPan, seedCentroid, followW);

  vec2 uv = camRot * rawUV / zoom + pan;

  // Cell scale: how many trace cells fit across the short axis. Higher = denser.
  vec2 gp     = uv * cellScale;
  vec2 cellId = floor(gp);
  vec2 cellUV = fract(gp) - 0.5;

  // ---------- TRACE NETWORK ----------
  float traceD       = 1e3;
  float traceHueId   = 0.0;
  float traceBin     = 0.0;
  float traceT       = 0.0;
  float traceLen     = 1.0;
  float traceRecency = 0.0;
  float traceDiscDelta = 0.0;
  vec2  traceCellId  = cellId;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nId   = cellId + vec2(float(i), float(j));
      vec2 local = cellUV - vec2(float(i), float(j));

      float h0 = hash21(nId + 17.13);
      float h1 = hash21(nId + 91.77);
      float h2 = hash21(nId + 43.51);
      float hJ = hash21(nId + 5.55);

      vec2 N = vec2( 0.0,  0.5);
      vec2 S = vec2( 0.0, -0.5);
      vec2 E = vec2( 0.5,  0.0);
      vec2 W = vec2(-0.5,  0.0);

      vec2 a, b;
      float orient = floor(h0 * 6.0);
      if (orient < 0.5)      { a = N; b = E; }
      else if (orient < 1.5) { a = N; b = W; }
      else if (orient < 2.5) { a = S; b = E; }
      else if (orient < 3.5) { a = S; b = W; }
      else if (orient < 4.5) { a = N; b = S; }
      else                   { a = E; b = W; }

      vec2 corner = vec2(b.x, a.y);
      if (orient >= 4.0) corner = (a + b) * 0.5;

      vec2 dt = sdLPath(local, a, corner, b);
      float d = dt.x;

      float deadKill = step(0.95, h2);
      d = mix(d, 1e3, deadKill);

      // BFS-style discovery time across all five seeds.
      float discTime;
      float hueId;
      ownerOf(nId, seed0, seed1, seed2, seed3, seed4, hJ * 0.9, discTime, hueId);

      float discDelta = frontier - discTime;
      if (discDelta <= 0.0) {
        d = 1e3;
      }

      if (d < traceD) {
        traceD       = d;
        traceHueId   = hueId;
        traceBin     = fract(h0 * 7.31 + h1);
        traceT       = dt.y;
        float L1 = length(corner - a);
        float L2 = length(b - corner);
        traceLen = max(L1 + L2, 1e-4);
        traceCellId    = nId;
        traceDiscDelta = discDelta;
        traceRecency = clamp(discDelta / 6.0, 0.0, 1.0);
      }
    }
  }

  // ---------- COMPONENTS (chips + vias) on a coarser grid ----------
  float compScale = 2.5;
  vec2 cp     = uv * compScale;
  vec2 compId = floor(cp);
  vec2 compUV = fract(cp) - 0.5;

  float chipMask = 0.0;
  float chipPin  = 0.0;
  float chipHueId= 0.0;
  float chipBin  = 0.0;
  float chipRecency = 1.0;
  float chipDiscovered = 0.0;
  float chipScan = 0.0;     // moving scanline / activity bar inside chip
  float chipLed  = 0.0;     // blinking LED dots inside chip
  float chipPulse = 1.0;    // per-chip brightness breathing factor
  float chipReboot = 0.0;   // rare white-flash event
  vec2  chipNId  = vec2(0.0);

  float viaMask = 0.0;
  float viaRing = 0.0;
  float viaHueId= 0.0;
  float viaRecency = 1.0;
  float viaDiscovered = 0.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nId   = compId + vec2(float(i), float(j));
      vec2 local = compUV - vec2(float(i), float(j));

      float h0 = hash21(nId + 7.7);
      float h1 = hash21(nId + 31.4);
      float h2 = hash21(nId + 88.1);
      float h3 = hash21(nId + 2.19);
      float h4 = hash21(nId + 64.07);

      // Components inherit the discovery time of their underlying coarse cell.
      float coarseToFine = cellScale / compScale;
      vec2 fineId = nId * coarseToFine;
      float compDisc;
      float compHue;
      ownerOf(fineId, seed0, seed1, seed2, seed3, seed4, h2 * 1.5, compDisc, compHue);
      float compDelta = frontier - compDisc;
      float compRec   = clamp(compDelta / 6.0, 0.0, 1.0);
      float compVis   = step(0.0, compDelta);

      // Chip: density bumped from ~18% → ~35% of coarse cells (h0 > 0.65).
      // The user specifically called out the chip-altering-paths interaction
      // as the standout element, so we lean in.
      if (h0 > 0.65 && compVis > 0.5) {
        // Three variants now: square SOIC, wide SOIC, and a taller DIP-style
        // package. h1 picks the kind.
        float kind = h1;          // 0..1 selector
        bool wide = kind > 0.33 && kind < 0.66;
        bool dip  = kind >= 0.66; // DIP: bigger, two pin rows
        vec2 sz;
        if (dip)       sz = vec2(0.34, 0.20);
        else if (wide) sz = vec2(0.30, 0.16);
        else           sz = vec2(0.20, 0.20);
        vec2 off = (vec2(h1, h2) - 0.5) * 0.16;
        float dBox = sdBox(local - off, sz);
        float body = smoothstep(0.012, 0.0, dBox);
        if (body > chipMask) {
          chipMask = body;
          chipHueId = compHue;
          chipBin = fract(h1 * 5.7);
          chipRecency = compRec;
          chipDiscovered = 1.0;
          chipNId = nId;

          // --- per-chip animated internals ---
          // Local coords inside the chip body, normalized to [-1, 1] across
          // each axis so scan/LED logic doesn't depend on chip variant size.
          vec2 inner = (local - off) / sz; // ~[-1, 1] inside body

          // Scanline: a thin horizontal band sweeping top→bottom on a
          // per-chip phase. Period 1.4–2.6s, hash-jittered per cell.
          float scanRate = 0.55 + 0.7 * h3;            // Hz-ish
          float scanPhase = h4 * TAU;
          float scanY = -1.0 + 2.0 * fract(u_time * scanRate + scanPhase);
          // Soft band, ~0.25 of body height tall.
          float scanBand = exp(-pow((inner.y - scanY) * 6.0, 2.0));
          // Confine to chip interior horizontally with a soft margin.
          float scanInside = smoothstep(1.0, 0.85, abs(inner.x));
          chipScan = max(chipScan, scanBand * scanInside);

          // LEDs: 3 tiny dots along the chip's long axis, each with its own
          // blink phase. Position them in a row near the top of the chip.
          float ledBlink = 0.0;
          // Unrolled — only 3 LEDs, cheap.
          {
            float p0 = 0.45 + 0.55 * sin(u_time * (2.1 + h3 * 1.7) + h4 * 6.0);
            vec2 ledPos = vec2(-0.55, 0.45);
            float r = length((inner - ledPos) * vec2(1.0, sz.x / sz.y));
            ledBlink += smoothstep(0.07, 0.02, r) * smoothstep(0.0, 0.7, p0);
          }
          {
            float p1 = 0.45 + 0.55 * sin(u_time * (2.7 + h4 * 1.3) + h3 * 5.0 + 1.7);
            vec2 ledPos = vec2(0.0, 0.45);
            float r = length((inner - ledPos) * vec2(1.0, sz.x / sz.y));
            ledBlink += smoothstep(0.07, 0.02, r) * smoothstep(0.0, 0.7, p1);
          }
          {
            float p2 = 0.45 + 0.55 * sin(u_time * (3.4 + h3 * h4 * 2.1) + 3.1);
            vec2 ledPos = vec2(0.55, 0.45);
            float r = length((inner - ledPos) * vec2(1.0, sz.x / sz.y));
            ledBlink += smoothstep(0.07, 0.02, r) * smoothstep(0.0, 0.7, p2);
          }
          chipLed = max(chipLed, ledBlink);

          // Breathing pulse: each chip oscillates at ~0.6–1.4 Hz, phased.
          float pulseRate = 0.6 + 0.8 * h3;
          chipPulse = 0.85 + 0.30 * sin(u_time * pulseRate * TAU + h4 * TAU)
                          + 0.20 * u_mid;

          // Reboot flash: rare, hash-gated, retriggered every ~0.6s window
          // and biased by treble so it punctuates on cymbals/snares.
          float rebootSlot = floor(u_time * 1.6);
          float rebootRoll = hash21(nId + rebootSlot * 0.731);
          float gate = step(0.985 - 0.05 * u_treble, rebootRoll);
          // Decay within the slot so the flash is a quick blip.
          float slotPhase = fract(u_time * 1.6);
          float decay = exp(-slotPhase * 8.0);
          chipReboot = max(chipReboot, gate * decay);
        }

        // Pin teeth on edges (DIP gets pins on the long sides too).
        vec2 pinP = local - off;
        float pinSpacing = 0.045;
        // Long-axis pins (always present).
        float pinAxisL = wide || dip ? pinP.x : pinP.y;
        float pinPerpL = wide || dip ? pinP.y : pinP.x;
        float pinStripeL = abs(fract(pinAxisL / pinSpacing) - 0.5);
        float pinEdgeL = (wide || dip)
            ? abs(abs(pinPerpL) - sz.y)
            : abs(abs(pinPerpL) - sz.x);
        float pinBandL = smoothstep(0.020, 0.0, pinEdgeL);
        float pinTeethL = smoothstep(0.32, 0.20, pinStripeL);
        float pinAxisRangeL = (wide || dip)
            ? smoothstep(sz.x + 0.02, sz.x - 0.005, abs(pinAxisL))
            : smoothstep(sz.y + 0.02, sz.y - 0.005, abs(pinAxisL));
        float pin = pinBandL * pinTeethL * pinAxisRangeL;
        chipPin = max(chipPin, pin);
      }

      // Via: ~30% of coarse cells.
      if (h0 < 0.30 && compVis > 0.5) {
        vec2 vOff = (vec2(h1, h2) - 0.5) * 0.30;
        float r = length(local - vOff);
        float outerR = smoothstep(0.045, 0.038, r);
        float innerR = smoothstep(0.022, 0.018, r);
        float ring = outerR - innerR;
        float dot_ = innerR;
        if (ring + dot_ > viaMask + viaRing) {
          viaMask = dot_;
          viaRing = ring;
          viaHueId = compHue;
          viaRecency = compRec;
          viaDiscovered = 1.0;
        }
      }
    }
  }

  // ---------- shared triadic palette (green / yellow / orange biased) ----------
  float baseHue = triadHue(0.30);
  vec3 hueA = hsl2rgb(fract(baseHue),                0.95, 0.55);
  vec3 hueB = hsl2rgb(fract(baseHue - 0.18),         1.00, 0.58);
  vec3 hueC = hsl2rgb(fract(baseHue - 0.32),         1.00, 0.55);
  vec3 traceColor = (traceHueId < 0.5) ? hueA : (traceHueId < 1.5 ? hueB : hueC);
  vec3 chipColor  = (chipHueId  < 0.5) ? hueA : (chipHueId  < 1.5 ? hueB : hueC);
  vec3 viaColor   = (viaHueId   < 0.5) ? hueA : (viaHueId   < 1.5 ? hueB : hueC);

  // ---------- audio gating per trace ----------
  float fftAtTrace = sampleFFT(traceBin);
  float fftAtChip  = sampleFFT(chipBin);
  float energy = clamp(0.5 * u_volume + 0.7 * u_bass + 0.4 * u_mid, 0.0, 1.5);

  // ---------- trace mask (crisp core + soft halo) ----------
  float freshness = 1.0 - traceRecency;
  float frontierGlow = pow(freshness, 1.6);

  // AA scaled by zoom: at min zoom one cell maps to fewer pixels, so screen-
  // space derivatives shrink the apparent line. Floor the smoothstep edge so
  // traces stay visible when we're zoomed all the way out.
  float aa = max(fwidth(traceD) * 1.2, 0.0015);
  float traceWidth = 0.045 + 0.025 * frontierGlow + 0.015 * fftAtTrace;
  float traceCore  = 1.0 - smoothstep(traceWidth - aa, traceWidth + aa, traceD);

  float haloRadius = 0.12 + 0.18 * frontierGlow;
  float traceHalo  = pow(1.0 - smoothstep(0.0, haloRadius, traceD), 2.4);

  float settledActiv = 0.30 + 0.85 * fftAtTrace + 0.30 * energy;
  float traceActiv = mix(settledActiv, 2.0, frontierGlow);
  float discoveredMask = step(0.001, traceDiscDelta);
  traceActiv *= discoveredMask;

  traceCore *= traceActiv;
  traceHalo *= traceActiv * 0.7;

  // ---------- electrons ----------
  float spawnCount = 1.0 + floor(2.0 * energy + 3.0 * fftAtTrace + 3.0 * frontierGlow);
  float speed      = 0.45 + 1.6 * energy + 1.2 * frontierGlow;
  float electronGlow = 0.0;
  for (int e = 0; e < 5; e++) {
    float ef = float(e);
    if (ef >= spawnCount) break;
    float phase = hash21(traceCellId + ef * 13.71 + 1.3);
    float dir   = (hash21(traceCellId + ef * 7.7) > 0.5) ? 1.0 : -1.0;
    float s     = fract(phase + dir * u_time * speed * (0.5 / max(traceLen, 0.2)));
    float dT = traceT - s;
    dT = dT - floor(dT + 0.5);
    float along = abs(dT) * traceLen;
    float dist2 = along * along + traceD * traceD * 4.0;
    float head = exp(-dist2 * 320.0);
    float trailLen = mix(22.0, 8.0, frontierGlow);
    float trailSide = (dT * dir < 0.0) ? 1.0 : 0.0;
    float trail = exp(-along * trailLen) * exp(-traceD * traceD * 600.0) * trailSide;
    electronGlow += head + (0.55 + 0.8 * frontierGlow) * trail;
  }
  electronGlow *= step(traceD, 0.30) * (0.4 + 1.4 * traceActiv) * discoveredMask;

  // ---------- COMPOSE ----------
  vec3 deepBlue   = vec3(0.020, 0.030, 0.085);
  vec3 deepViolet = vec3(0.060, 0.020, 0.110);
  vec3 board = mix(deepBlue, deepViolet, smoothstep(-0.6, 0.6, uv.y));
  float vig = smoothstep(1.15, 0.20, length(rawUV));
  board *= mix(0.45, 1.0, vig);
  float grain = vnoise(uv * 80.0 + u_time * 0.05) - 0.5;
  board += vec3(0.015, 0.010, 0.025) * grain;

  vec3 col = board;

  // Trace halo first (under the core).
  col += traceColor * traceHalo * (0.55 + 1.4 * frontierGlow);

  // Trace core.
  vec3 coreColor = mix(traceColor, vec3(1.0), 0.35 * frontierGlow);
  col = mix(col, coreColor * (1.0 + 0.8 * frontierGlow), traceCore);

  // Chips: dark silicon body with neon outline + animated internals.
  if (chipMask > 0.001 && chipDiscovered > 0.5) {
    float chipFresh = 1.0 - chipRecency;
    // Body breathes via chipPulse; floor it so it never goes fully dark.
    float bodyLift = max(chipPulse, 0.55);
    vec3 chipBody = vec3(0.015, 0.018, 0.030)
                  + chipColor * (0.04 + 0.25 * chipFresh) * bodyLift;
    col = mix(col, chipBody, chipMask);
    // Pins.
    col += chipColor * chipPin
         * (0.7 + 1.2 * u_treble + 0.5 * fftAtChip + 0.9 * chipFresh)
         * bodyLift;
    // Tiny FFT body wash (kept).
    col += chipColor * chipMask * fftAtChip * 0.35;
    // Internal scanline — bright streak inside the body, in chip's hue.
    col += chipColor * chipMask * chipScan * (0.55 + 0.6 * u_mid);
    // LEDs — mostly white-hot dots tinted with chip hue.
    vec3 ledColor = mix(vec3(1.0), chipColor, 0.35);
    col += ledColor * chipMask * chipLed * (0.9 + 0.8 * u_mid);
    // White-hot pop on the frame the chip is discovered.
    col += vec3(1.0) * chipMask * pow(chipFresh, 4.0) * 0.6;
    // Reboot flash — sparse white blast across the whole chip body.
    col += vec3(1.0) * chipMask * chipReboot * 0.8;
  }

  // Vias: ringed circle with bright center.
  if ((viaMask + viaRing) > 0.001 && viaDiscovered > 0.5) {
    float viaFresh = 1.0 - viaRecency;
    col += viaColor * viaRing * (0.85 + 1.2 * viaFresh);
    col += viaColor * viaMask * (0.7 + 0.9 * u_treble + 1.5 * viaFresh);
    float viaFlash = step(0.92, hash21(floor(uv * compScale) + floor(u_time * 6.0)));
    col += vec3(1.0) * viaMask * viaFlash * u_treble * 0.8;
  }

  // Electrons.
  vec3 electronColor = mix(traceColor, vec3(1.0), 0.35 + 0.3 * frontierGlow);
  col += electronColor * electronGlow * (0.9 + 0.6 * energy);

  // Subtle global lift on bass.
  col *= 1.0 + 0.08 * pow(u_bass, 1.6);

  // Tonemap so the white-hot frontier doesn't clip.
  col = col / (1.0 + 0.85 * col);

  // Final vignette.
  col *= mix(0.55, 1.05, vig);

  outColor = vec4(col, 1.0);
}
