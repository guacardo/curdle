// pixel-fireworks: chunky 8-bit fireworks launched from the bottom of the screen.
// - Screen is quantized into ~120-wide pixel cells; everything snaps to that grid.
// - Time is sliced into "slots". Each slot is a deterministic firework: hashed
//   launch x, color seed, peak height, peak time. No frame-to-frame state.
// - Bass widens how many concurrent slots fire (more simultaneous fireworks).
// - Treble seeds random sparkle pixels across the sky.
// - Each firework: rising trail -> bright peak flash -> radial chunky starburst
//   that falls under gravity and fades to black.

#define PIXEL_W       120.0   // grid width in chunky pixels
#define SLOT_LEN      0.65    // seconds per firework slot
#define LIFETIME      2.4     // seconds a firework stays visible after launch
#define RISE_TIME     0.9     // seconds from launch to peak
#define SPARK_COUNT   16      // chunky shards per explosion (must be const)
#define MAX_SLOTS     8       // simultaneous slots to evaluate per pixel

// Deterministic per-slot data, all derived from the integer slot index.
struct Firework {
  float startT;   // launch time
  vec2  launch;   // launch position in "pixel grid" coords
  float peakY;    // peak y in pixel grid
  float hue;      // 0..1 palette seed
  float live;   // 0 or 1 — whether this slot fires at all
};

// 3-color pixel-art palette per firework, picked from hue seed.
void pickPalette(float hue, out vec3 c0, out vec3 c1, out vec3 c2) {
  // Three saturated cores, each with a hot/mid/cool ramp.
  if (hue < 0.25) {              // gold/red
    c0 = vec3(1.00, 0.95, 0.55);
    c1 = vec3(1.00, 0.55, 0.15);
    c2 = vec3(0.70, 0.10, 0.10);
  } else if (hue < 0.50) {       // cyan/blue
    c0 = vec3(0.85, 0.98, 1.00);
    c1 = vec3(0.30, 0.70, 1.00);
    c2 = vec3(0.10, 0.20, 0.70);
  } else if (hue < 0.75) {       // magenta/pink
    c0 = vec3(1.00, 0.90, 1.00);
    c1 = vec3(1.00, 0.35, 0.85);
    c2 = vec3(0.55, 0.10, 0.55);
  } else {                       // green/lime
    c0 = vec3(0.90, 1.00, 0.75);
    c1 = vec3(0.45, 0.95, 0.30);
    c2 = vec3(0.10, 0.55, 0.20);
  }
}

// Evaluate the deterministic firework for slot index i.
Firework getFirework(float i, float aspect, float intensity) {
  Firework fw;
  fw.startT = i * SLOT_LEN;
  // Per-slot hashes — distinct seeds so x/y/hue/live aren't correlated.
  float hx   = hash21(vec2(i, 11.0));
  float hy   = hash21(vec2(i, 27.0));
  float hh   = hash21(vec2(i, 53.0));
  float ha   = hash21(vec2(i, 91.0));
  // Launch from somewhere along the bottom. Pixel grid units: width = PIXEL_W,
  // height = PIXEL_W / aspect.
  float pxH = PIXEL_W / aspect;
  fw.launch = vec2(mix(8.0, PIXEL_W - 8.0, hx), 0.0);
  fw.peakY  = mix(0.55, 0.85, hy) * pxH;
  fw.hue    = hh;
  // Bass-driven activity: louder bass => more slots survive the threshold.
  // intensity ~ 0.35 quiet, ~0.95 loud.
  fw.live = step(ha, intensity);
  return fw;
}

void main() {
  vec2 res = u_resolution;
  float aspect = res.x / res.y;

  // 1) Quantize the framebuffer into chunky pixels. Everything below uses
  //    `pix` (integer-ish pixel coordinates in a PIXEL_W-wide grid).
  vec2 cell  = res / PIXEL_W;             // size of one chunky pixel in fragments
  vec2 pix   = floor(gl_FragCoord.xy / cell.x); // square pixels => use cell.x for both
  vec2 pixC  = pix + 0.5;                  // pixel center in grid coords
  float pxH  = PIXEL_W / aspect;

  // 2) Dark background with a subtle vertical gradient (navy -> near-black).
  float bgGrad = pixC.y / pxH;
  vec3 col = mix(vec3(0.02, 0.03, 0.06), vec3(0.00, 0.00, 0.02), bgGrad);

  // 3) Twinkling background "stars" — sparse hashed pixels, slow blink.
  float starHash = hash21(pix * 1.0);
  float starOn   = step(0.997, starHash);
  float starBlink = 0.5 + 0.5 * sin(u_time * 2.3 + starHash * 40.0);
  col += vec3(0.25, 0.28, 0.35) * starOn * starBlink * 0.6;

  // 4) Treble sparkles — extra bright random pixels biased toward the upper
  //    half of the sky. Re-seeded every ~0.18s so they twitch.
  float sparkSlot = floor(u_time / 0.18);
  float sparkH    = hash21(pix + vec2(sparkSlot * 7.31, 0.0));
  float sparkBias = smoothstep(0.0, 0.7, pixC.y / pxH);
  float sparkOn   = step(1.0 - 0.04 * u_treble, sparkH) * sparkBias;
  col += vec3(1.0, 0.95, 0.85) * sparkOn;

  // 5) Audio "intensity" controls how many concurrent fireworks fire.
  //    Quiet => ~35% of slots live. Bass-heavy => ~95%.
  float intensity = 0.35 + 0.6 * pow(u_bass, 0.8);

  // 6) Evaluate the MAX_SLOTS slots whose lifetimes could overlap "now".
  //    A firework lives LIFETIME seconds, so we look back ceil(LIFETIME/SLOT_LEN)
  //    slots from the current one.
  float nowSlot = floor(u_time / SLOT_LEN);

  for (int s = 0; s < MAX_SLOTS; s++) {
    float slotIdx = nowSlot - float(s);
    if (slotIdx < 0.0) continue;

    Firework fw = getFirework(slotIdx, aspect, intensity);
    if (fw.live < 0.5) continue;

    float age = u_time - fw.startT;
    if (age < 0.0 || age > LIFETIME) continue;

    vec3 c0, c1, c2;
    pickPalette(fw.hue, c0, c1, c2);

    // --- Phase A: rising trail (0 .. RISE_TIME) -----------------------------
    if (age < RISE_TIME) {
      // Ballistic-ish rise: ease-out so it slows near the apex.
      float r = age / RISE_TIME;
      float ease = 1.0 - (1.0 - r) * (1.0 - r);
      vec2 rocketPos = vec2(fw.launch.x, mix(0.0, fw.peakY, ease));

      // Light up a short trail of pixels behind the rocket head.
      // Manhattan-y distance in grid units; head is brightest, tail dims.
      float dx = abs(pixC.x - rocketPos.x);
      float dy = pixC.y - rocketPos.y; // positive = below the head (the trail)
      // The rocket head: a 1-pixel square.
      float head = step(dx, 0.6) * step(abs(dy), 0.6);
      // Trail: pixels directly below the head, fading with distance.
      float trailLen = mix(2.0, 6.0, r);
      float trail = step(dx, 0.6) * step(0.0, dy) * step(dy, trailLen);
      float trailFade = 1.0 - clamp(dy / trailLen, 0.0, 1.0);

      // Slight horizontal flicker on the trail for sparks.
      float flick = hash21(vec2(pix.x, floor(u_time * 30.0) + slotIdx));
      float spark = step(0.85, flick) * step(dx, 1.6) * step(0.0, dy) * step(dy, 3.0);

      vec3 trailCol = mix(c2, c1, trailFade) * trail * trailFade;
      vec3 headCol  = c0 * head;
      vec3 sparkCol = c0 * spark * 0.5;

      col += trailCol + headCol + sparkCol;
      continue;
    }

    // --- Phase B: explosion (RISE_TIME .. LIFETIME) -------------------------
    float eAge = age - RISE_TIME;       // seconds since detonation
    float eDur = LIFETIME - RISE_TIME;  // total explosion lifetime
    float eT   = eAge / eDur;            // 0..1 normalized

    // Brief peak flash: a fat bright pixel right when it pops.
    float flashAge = eAge / 0.12;
    if (flashAge < 1.0) {
      float fdx = abs(pixC.x - fw.launch.x);
      float fdy = abs(pixC.y - fw.peakY);
      float flash = step(max(fdx, fdy), 1.5) * (1.0 - flashAge);
      col += c0 * flash * 1.4;
    }

    // Starburst: SPARK_COUNT shards launched radially from the burst point.
    // Each shard's position = peak + dir * v * t + 0.5 * gravity * t^2.
    // We accumulate the brightest contribution rather than blending.
    vec3  burstCol = vec3(0.0);
    float burstAlpha = 0.0;

    // Per-burst speed scaled slightly by bass at launch — louder = bigger pop.
    float bassAtLaunch = 0.6 + 0.6 * u_bass;
    float baseSpeed = mix(14.0, 22.0, hash21(vec2(slotIdx, 7.0))) * bassAtLaunch;

    for (int k = 0; k < SPARK_COUNT; k++) {
      float ki = float(k);
      // Even angular distribution + per-shard jitter so it's not perfectly symmetric.
      float jitter = hash21(vec2(slotIdx, ki * 3.7)) - 0.5;
      float ang = (ki / float(SPARK_COUNT)) * TAU + jitter * 0.35;
      // Per-shard speed variance.
      float sp = baseSpeed * mix(0.7, 1.15, hash21(vec2(slotIdx + 13.0, ki)));
      vec2 dir = vec2(cos(ang), sin(ang));
      // Gravity in grid units/sec^2 (negative y = down). pxH-scaled so it
      // looks consistent regardless of resolution.
      vec2 gravity = vec2(0.0, -22.0);

      vec2 sparkPos = vec2(fw.launch.x, fw.peakY)
                    + dir * sp * eAge
                    + 0.5 * gravity * eAge * eAge;

      // Per-shard fade: alive for full eDur, with an ease-out so they linger.
      float life = 1.0 - eT;
      // Skip dead/offscreen shards by zeroing their contribution.
      if (life <= 0.0) continue;

      // Chunky-pixel shard: 1-pixel square at sparkPos.
      float ddx = abs(pixC.x - sparkPos.x);
      float ddy = abs(pixC.y - sparkPos.y);
      float hit = step(max(ddx, ddy), 0.6);

      // Color ramp over life: hot core -> mid -> cool tail.
      vec3 shardCol = mix(c2, c1, smoothstep(0.0, 0.5, life));
      shardCol      = mix(shardCol, c0, smoothstep(0.5, 1.0, life));

      // Brightness: fade with life^1.5, plus a quick initial burst boost.
      float bright = pow(life, 1.5) * (0.7 + 0.6 * smoothstep(1.0, 0.7, life));

      float contrib = hit * bright;
      if (contrib > burstAlpha) {
        burstAlpha = contrib;
        burstCol   = shardCol;
      }
    }

    col += burstCol * burstAlpha;

    // Faint smoke/glow ring around the burst for the first ~0.4s — a soft
    // chunky halo that helps the explosion read against the dark sky.
    if (eAge < 0.4) {
      float ringR = mix(2.0, 7.0, eAge / 0.4);
      float dRing = max(abs(pixC.x - fw.launch.x), abs(pixC.y - fw.peakY));
      float ring  = step(ringR - 0.6, dRing) * step(dRing, ringR + 0.6);
      float ringFade = 1.0 - eAge / 0.4;
      col += c1 * ring * ringFade * 0.25;
    }
  }

  // 7) Bottom-edge ambient glow — a faint reminder of where launches come from.
  float bottomGlow = smoothstep(0.0, 0.15, 1.0 - pixC.y / pxH);
  col += vec3(0.08, 0.05, 0.12) * bottomGlow * (0.4 + 0.6 * u_bass);

  // 8) Subtle vignette so the corners don't compete with the action.
  vec2 vUv = pixC / vec2(PIXEL_W, pxH) - 0.5;
  float vig = smoothstep(0.95, 0.35, length(vUv));
  col *= mix(0.7, 1.0, vig);

  // 9) Tonemap so peak flashes / overlapping bursts don't clip to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
