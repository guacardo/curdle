// pcb-zoom: an infinite zoom-out across a self-similar PCB. Manhattan-routed
// neon traces, vias and SOIC chips recede endlessly. Two overlapping
// scale-layers render at once — the inner layer (finer detail) fades to the
// outer layer (coarser detail) right as its features become sub-pixel, then
// the cycle restarts at a fresh scale. Because the structure is pseudo-random
// per integer-scale-step, you never see the seam.
//
// Math:
//   logZoom = u_time * speed     (continuously growing log-scale)
//   step    = floor(logZoom)     (integer zoom-octave we're inside)
//   frac    = fract(logZoom)     (0..1 progress through this octave)
// Two layers:
//   inner: scale = 2^(step + 0)     ← shrinks as frac→1
//   outer: scale = 2^(step + 1)     ← was sub-pixel, now becoming visible
// Crossfade by frac: inner fades out, outer fades in. Each layer carries its
// own per-octave RNG (`step` mixed into hashes) so the boards don't repeat.
//
// Audio:
//   - Bass: shoves the zoom rate so the recession surges on kicks.
//   - Mid:  body-pulses chips and trace cores.
//   - Treble: flickers vias and dusts random chips with white-hot reboot pops.
//   - Per-trace FFT bin: each trace listens to its hashed bin for core energy.

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

// Distance to an L-path a→corner→b plus normalized arclength of the closest
// point — used so electrons can ride the wire from one end to the other.
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
  if (d1 <= d2) return vec2(d1, (t1 * L1) / Lt);
  return vec2(d2, (L1 + t2 * L2) / Lt);
}

// ---------- one PCB layer ----------
// `uv` is layer-local (already scaled). `octave` is the integer log-zoom step
// — mixed into hashes so each octave is a different board. Returns three
// channels we composite outside: trace contribution, chip contribution, via
// contribution. Packed into one vec3 for convenience: (traceCoreActiv,
// haloActiv, chipBodyActiv). We also write trace hue/bin out via globals to
// keep the composite cheap.
//
// Returned via `outCol` is the *additive* neon contribution of this layer
// already coloured in the triad palette. Caller multiplies by the layer's
// crossfade weight and adds onto the substrate.

vec3 pcbLayer(vec2 uv, float octave, float baseHue, float layerFade) {
  // Per-octave constant offset so each octave looks like a different design.
  vec2 octShift = vec2(hash21(vec2(octave, 1.7)), hash21(vec2(octave, 9.3))) * 47.0;
  uv += octShift;

  // ---------- TRACE NETWORK ----------
  vec2 cellScale = vec2(9.0);
  vec2 gp     = uv * cellScale;
  vec2 cellId = floor(gp);
  vec2 cellUV = fract(gp) - 0.5;

  float traceD     = 1e3;
  float traceHueId = 0.0;
  float traceBin   = 0.0;
  float traceT     = 0.0;
  float traceLen   = 1.0;
  vec2  traceCellId = cellId;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nId   = cellId + vec2(float(i), float(j));
      vec2 local = cellUV - vec2(float(i), float(j));

      // Octave folded into the hash seeds — different boards per octave.
      float h0 = hash21(nId + 17.13 + octave * 3.71);
      float h1 = hash21(nId + 91.77 + octave * 5.13);
      float h2 = hash21(nId + 43.51 + octave * 2.07);

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

      // Kill ~5% of cells so the board has gaps (looks routed, not packed).
      float deadKill = step(0.95, h2);
      d = mix(d, 1e3, deadKill);

      if (d < traceD) {
        traceD     = d;
        traceHueId = floor(h1 * 3.0);     // 0,1,2 → triad slot
        traceBin   = fract(h0 * 7.31 + h1);
        traceT     = dt.y;
        float L1 = length(corner - a);
        float L2 = length(b - corner);
        traceLen = max(L1 + L2, 1e-4);
        traceCellId = nId;
      }
    }
  }

  // ---------- COMPONENTS (chips + vias) ----------
  float compScale = 2.5;
  vec2 cp     = uv * compScale;
  vec2 compId = floor(cp);
  vec2 compUV = fract(cp) - 0.5;

  float chipMask = 0.0;
  float chipPin  = 0.0;
  float chipHueId = 0.0;
  float chipBin   = 0.0;
  float chipScan  = 0.0;
  float chipLed   = 0.0;
  float chipPulse = 1.0;
  float chipReboot = 0.0;
  vec2  chipNId   = vec2(0.0);

  float viaMask = 0.0;
  float viaRing = 0.0;
  float viaHueId = 0.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 nId   = compId + vec2(float(i), float(j));
      vec2 local = compUV - vec2(float(i), float(j));

      float h0 = hash21(nId + 7.7  + octave * 4.41);
      float h1 = hash21(nId + 31.4 + octave * 8.27);
      float h2 = hash21(nId + 88.1 + octave * 1.93);
      float h3 = hash21(nId + 2.19 + octave * 6.55);
      float h4 = hash21(nId + 64.07 + octave * 0.97);

      // Chip: ~30% of coarse cells.
      if (h0 > 0.70) {
        float kind = h1;
        bool wide = kind > 0.33 && kind < 0.66;
        bool dip  = kind >= 0.66;
        vec2 sz;
        if (dip)       sz = vec2(0.34, 0.20);
        else if (wide) sz = vec2(0.30, 0.16);
        else           sz = vec2(0.20, 0.20);
        vec2 off = (vec2(h1, h2) - 0.5) * 0.16;
        float dBox = sdBox(local - off, sz);
        float body = smoothstep(0.012, 0.0, dBox);
        if (body > chipMask) {
          chipMask = body;
          chipHueId = floor(h2 * 3.0);
          chipBin = fract(h1 * 5.7);
          chipNId = nId;

          vec2 inner = (local - off) / sz;

          // Scanline.
          float scanRate = 0.55 + 0.7 * h3;
          float scanPhase = h4 * TAU;
          float scanY = -1.0 + 2.0 * fract(u_time * scanRate + scanPhase);
          float scanBand = exp(-pow((inner.y - scanY) * 6.0, 2.0));
          float scanInside = smoothstep(1.0, 0.85, abs(inner.x));
          chipScan = max(chipScan, scanBand * scanInside);

          // Three blinking LEDs.
          float ledBlink = 0.0;
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

          float pulseRate = 0.6 + 0.8 * h3;
          chipPulse = 0.85 + 0.30 * sin(u_time * pulseRate * TAU + h4 * TAU)
                          + 0.20 * u_mid;

          // Treble-gated reboot flash.
          float rebootSlot = floor(u_time * 1.6);
          float rebootRoll = hash21(nId + rebootSlot * 0.731 + octave * 0.5);
          float gate = step(0.985 - 0.05 * u_treble, rebootRoll);
          float slotPhase = fract(u_time * 1.6);
          float decay = exp(-slotPhase * 8.0);
          chipReboot = max(chipReboot, gate * decay);
        }

        // Pins.
        vec2 pinP = local - off;
        float pinSpacing = 0.045;
        float pinAxisL = (wide || dip) ? pinP.x : pinP.y;
        float pinPerpL = (wide || dip) ? pinP.y : pinP.x;
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

      // Via.
      if (h0 < 0.30) {
        vec2 vOff = (vec2(h1, h2) - 0.5) * 0.30;
        float r = length(local - vOff);
        float outerR = smoothstep(0.045, 0.038, r);
        float innerR = smoothstep(0.022, 0.018, r);
        float ring = outerR - innerR;
        float dot_ = innerR;
        if (ring + dot_ > viaMask + viaRing) {
          viaMask = dot_;
          viaRing = ring;
          viaHueId = floor(h1 * 3.0);
        }
      }
    }
  }

  // ---------- per-octave triad palette ----------
  // baseHue rotates globally (triadHue) so palette identity outlives an
  // octave; per-octave we just bias it slightly so adjacent octaves don't
  // look perfectly identical in colour.
  float octHueBias = 0.04 * fract(octave * 0.317);
  float h = fract(baseHue + octHueBias);
  vec3 hueA = hsl2rgb(fract(h),                0.95, 0.55);
  vec3 hueB = hsl2rgb(fract(h - 0.18),         1.00, 0.58);
  vec3 hueC = hsl2rgb(fract(h - 0.32),         1.00, 0.55);
  vec3 traceColor = (traceHueId < 0.5) ? hueA : (traceHueId < 1.5 ? hueB : hueC);
  vec3 chipColor  = (chipHueId  < 0.5) ? hueA : (chipHueId  < 1.5 ? hueB : hueC);
  vec3 viaColor   = (viaHueId   < 0.5) ? hueA : (viaHueId   < 1.5 ? hueB : hueC);

  // ---------- audio gating ----------
  float fftAtTrace = sampleFFT(traceBin);
  float fftAtChip  = sampleFFT(chipBin);
  float energy = clamp(0.5 * u_volume + 0.7 * u_bass + 0.4 * u_mid, 0.0, 1.5);

  // ---------- trace mask ----------
  // AA scaled by fwidth so the trace stays crisp at any zoom, but floor it so
  // it never collapses to a literal sub-pixel hairline (that's the layer's
  // job to fade out via `layerFade` instead of going jagged).
  float aa = max(fwidth(traceD) * 1.2, 0.0015);
  float traceWidth = 0.045 + 0.02 * fftAtTrace;
  float traceCore  = 1.0 - smoothstep(traceWidth - aa, traceWidth + aa, traceD);

  float haloRadius = 0.14;
  float traceHalo  = pow(1.0 - smoothstep(0.0, haloRadius, traceD), 2.4);

  float traceActiv = 0.55 + 1.1 * fftAtTrace + 0.35 * energy;

  traceCore *= traceActiv;
  traceHalo *= traceActiv * 0.5;

  // ---------- electrons (riding the wire) ----------
  float spawnCount = 1.0 + floor(2.0 * energy + 2.0 * fftAtTrace);
  float speed = 0.45 + 1.6 * energy;
  float electronGlow = 0.0;
  for (int e = 0; e < 4; e++) {
    float ef = float(e);
    if (ef >= spawnCount) break;
    // Octave mixed in so electron phases differ per layer — no synced ghosts.
    float phase = hash21(traceCellId + ef * 13.71 + 1.3 + octave * 0.41);
    float dir   = (hash21(traceCellId + ef * 7.7 + octave * 0.29) > 0.5) ? 1.0 : -1.0;
    float s     = fract(phase + dir * u_time * speed * (0.5 / max(traceLen, 0.2)));
    float dT = traceT - s;
    dT = dT - floor(dT + 0.5);
    float along = abs(dT) * traceLen;
    float dist2 = along * along + traceD * traceD * 4.0;
    float head = exp(-dist2 * 320.0);
    float trailSide = (dT * dir < 0.0) ? 1.0 : 0.0;
    float trail = exp(-along * 16.0) * exp(-traceD * traceD * 600.0) * trailSide;
    electronGlow += head + 0.55 * trail;
  }
  electronGlow *= step(traceD, 0.30) * (0.4 + 1.4 * traceActiv);

  // ---------- COMPOSE for this layer ----------
  vec3 col = vec3(0.0);

  // Trace halo (under core).
  col += traceColor * traceHalo * 0.9;

  // Trace core.
  vec3 coreColor = mix(traceColor, vec3(1.0), 0.25);
  col = mix(col, coreColor * 1.4, traceCore);

  // Chips.
  if (chipMask > 0.001) {
    float bodyLift = max(chipPulse, 0.55);
    vec3 chipBody = vec3(0.015, 0.018, 0.030)
                  + chipColor * 0.18 * bodyLift;
    col = mix(col, chipBody, chipMask * 0.85);
    col += chipColor * chipPin
         * (0.7 + 1.2 * u_treble + 0.5 * fftAtChip)
         * bodyLift;
    col += chipColor * chipMask * fftAtChip * 0.35;
    col += chipColor * chipMask * chipScan * (0.55 + 0.6 * u_mid);
    vec3 ledColor = mix(vec3(1.0), chipColor, 0.35);
    col += ledColor * chipMask * chipLed * (0.9 + 0.8 * u_mid);
    col += vec3(1.0) * chipMask * chipReboot * 0.8;
  }

  // Vias.
  if ((viaMask + viaRing) > 0.001) {
    col += viaColor * viaRing * 1.0;
    col += viaColor * viaMask * (0.7 + 0.9 * u_treble);
    float viaFlash = step(0.92, hash21(floor(uv * compScale) + floor(u_time * 6.0) + octave));
    col += vec3(1.0) * viaMask * viaFlash * u_treble * 0.8;
  }

  // Electrons.
  vec3 electronColor = mix(traceColor, vec3(1.0), 0.45);
  col += electronColor * electronGlow * 1.2;

  return col * layerFade;
}

void main() {
  vec2 res  = u_resolution;
  vec2 frag = gl_FragCoord.xy;
  vec2 rawUV = (frag - 0.5 * res) / min(res.x, res.y);

  // ---------- INFINITE LOG-ZOOM ----------
  // Zoom rate breathes with bass — kicks goose the recession forward, then it
  // settles back. Base rate is slow enough that one octave (one doubling of
  // scale) takes ~3.5s at rest, so the eye reads continuous travel into the
  // distance, not strobing.
  float zoomRate = 0.28 + 0.45 * pow(u_bass, 1.6);
  // Integrate so audio modulation never rewinds the clock — log zoom is
  // strictly monotonic, otherwise the crossfade would unwind backwards.
  // Since we don't have access to last-frame state, use u_time * average rate
  // and add a smoothed bass *offset* on top. The offset is bounded so it
  // never exceeds a half-octave of nudge.
  float logZoom = u_time * 0.28 + 0.35 * smoothstep(0.0, 1.0, u_bass);

  float octave  = floor(logZoom);
  float frac    = fract(logZoom);   // 0..1 progress through this octave

  // Slow continuous rotation so the recession feels like a drifting camera,
  // not a clinical orthographic dolly.
  float camAngle = u_time * 0.025;
  vec2 baseUV = rot2d(camAngle) * rawUV;

  // The two layers we'll cross-fade between.
  // Convention:
  //   layerNear = features at the CURRENT octave's scale (smaller as frac→1)
  //   layerFar  = features at the NEXT-up octave (larger; was sub-pixel a moment ago)
  //
  // Effective scaling: at frac=0 the near layer is at its "freshly large"
  // scale and the far layer is its replacement at half size. As frac→1, near
  // halves in size (becoming sub-pixel) while far doubles to fill its slot.
  // We reuse the SAME pcb pattern, only the per-layer scale and octave tag
  // differ. This is what makes the loop seamless.
  //
  // exp2(frac) goes 1→2 over the octave; dividing puts that into uv-scale.
  float zNear = exp2(frac);          // 1 → 2
  float zFar  = exp2(frac - 1.0);    // 0.5 → 1   (i.e. half the near scale)

  // Layer crossfade weights:
  //   near: full at frac=0, fades out near frac→1 (its features are < 1 px).
  //   far:  emerges from black around frac=0 (it was sub-pixel one octave ago).
  // Use smoothstep so the handoff lands exactly when the outgoing layer hits
  // ~half a cell per pixel, which is the aliasing threshold.
  float fadeNear = 1.0 - smoothstep(0.55, 1.0, frac);
  float fadeFar  = smoothstep(0.0, 0.45, frac);

  // Global rotating triad — same as pcb-neon, so palette identity is shared.
  float baseHue = triadHue(0.30);

  // Render the two layers. Each gets its own integer-octave tag so their
  // hashes (orientations, chip placements, etc.) are *different* PCBs — the
  // viewer perceives "the next board in the chain" rather than a re-scaled
  // version of the same board.
  vec3 layerA = pcbLayer(baseUV * zNear, octave,        baseHue, fadeNear);
  vec3 layerB = pcbLayer(baseUV * zFar,  octave + 1.0,  baseHue, fadeFar);

  // ---------- substrate ----------
  vec3 deepBlue   = vec3(0.020, 0.030, 0.085);
  vec3 deepViolet = vec3(0.060, 0.020, 0.110);
  vec3 board = mix(deepBlue, deepViolet, smoothstep(-0.6, 0.6, baseUV.y));
  float vig = smoothstep(1.15, 0.20, length(rawUV));
  board *= mix(0.45, 1.0, vig);
  // Grain advected by zoom so the substrate also "recedes" — sells the dolly.
  float grain = vnoise(baseUV * 80.0 * zNear + u_time * 0.05) - 0.5;
  board += vec3(0.015, 0.010, 0.025) * grain;

  // ---------- composite ----------
  vec3 col = board;
  col += layerA;
  col += layerB;

  // Subtle global lift on bass.
  col *= 1.0 + 0.08 * pow(u_bass, 1.6);

  // Tonemap so overlapping-layer brights don't clip during a hot crossfade.
  col = col / (1.0 + 0.85 * col);

  // Final vignette.
  col *= mix(0.55, 1.05, vig);

  outColor = vec4(col, 1.0);
}
