// crazy-kid: THE KID IN THE BACK GOING ABSOLUTELY UNHINGED at a concert.
//
// A white stick figure in dead center who:
//   - Bobs/jitters on the beat (head and torso translate with bass + noise).
//   - Has OSCILLOSCOPE ARMS — left and right "arm" lines are FFT-history traces
//     traveling outward from the shoulders, so each arm is a live waveform.
//   - Breakdances on the floor — both legs are rotating rods sweeping windmill
//     arcs around the hips, angles driven by u_time + u_bass kicks. Occasional
//     headspin flips the whole figure upside-down for a beat.
//   - Radiates an FFT AURA: N rainbow rays out of his chest, each ray's length
//     and brightness = sampleFFT(angle->freq). Looks like a Sonic-the-Hedgehog
//     beat-sync explosion.
//   - Drops SHOCKWAVE rings on hard bass hits (expanding circles, fade with age).
//   - Confetti/spark particles popping all over the screen on treble.

// ---- Geometry constants ----
const float HEAD_R     = 0.055;   // head radius in normalized units
const float TORSO_LEN  = 0.18;    // shoulder -> hip
const float LIMB_LEN   = 0.22;    // arm/leg length
const float STROKE     = 0.012;   // stick figure line thickness

const int   N_RAYS     = 32;      // FFT aura rays around the body
const int   N_SHOCK    = 4;       // shockwave rings
const int   N_OSC_SEG  = 24;      // oscilloscope arm segments per arm

// Signed-distance helpers --------------------------------------------------

float sdCircle(vec2 p, float r) { return length(p) - r; }

// Distance to capsule from a..b with radius r.
float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}

// Soft fill from an SDF: 1 inside, 0 outside, soft edge of width w.
float fill(float d, float w) {
    return 1.0 - smoothstep(0.0, w, d);
}

// Glow falloff for an SDF — used to bloom the figure outline.
float glow(float d, float radius) {
    return exp(-max(d, 0.0) / max(radius, 1e-4));
}

// Hash for confetti.
float hash12(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p.yx + 19.19);
    return fract(p.x * p.y);
}

void main() {
    // Centered, aspect-corrected coords. y-up. Range roughly [-0.5..0.5] vertically.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

    // Pixel-stable AA width for SDF fills — ~1.5 px in our normalized space.
    float aa = 1.6 / min(u_resolution.x, u_resolution.y);

    // ---- Background: dark with subtle low-freq pulse so it never goes dead ----
    float bgPulse = 0.5 + 0.5 * sin(u_time * 0.7);
    vec3 bg = mix(vec3(0.02, 0.01, 0.05), vec3(0.05, 0.02, 0.10), bgPulse);
    bg += vec3(0.20, 0.05, 0.35) * u_bass * smoothstep(0.9, 0.0, length(uv));
    vec3 col = bg;

    // ---- Hyped beat clock ----
    // A jitter timer that ticks faster with volume; used for body shake.
    float jitterT = u_time * (8.0 + 18.0 * u_volume);
    vec2  jitter  = vec2(
        sin(jitterT * 1.3 + u_bass * 7.0),
        cos(jitterT * 1.7 + u_mid  * 5.0)
    ) * (0.004 + 0.020 * u_bass);

    // ---- Headspin flip: occasionally invert the world so he's on his head ----
    // Trigger ~once every 6 seconds, hold for ~0.6s. Smooth in/out so he tips.
    float spinPhase = mod(u_time, 6.0);
    float spinning  = smoothstep(0.05, 0.25, spinPhase) * (1.0 - smoothstep(0.5, 0.9, spinPhase));
    // While spinning, flip vertical and add roll spin around chest.
    vec2 figUV = uv;
    float rollAngle = spinning * (u_time * 12.0); // dizzy spin
    figUV = rot2d(rollAngle) * figUV;

    // ---- Body anchor positions ----
    // Hip stays near floor (y ~= -0.25). On bass kick the torso compresses
    // (hip rises slightly, head dips) — squash & stretch.
    float bassKick = pow(u_bass, 1.6);
    float bodyBob  = -0.04 * bassKick + 0.015 * sin(u_time * 4.0 + u_bass * 6.0);

    vec2 hip      = vec2(0.0, -0.22 + bodyBob) + jitter;
    vec2 shoulder = hip + vec2(0.0, TORSO_LEN * (1.0 - 0.18 * bassKick));
    vec2 head     = shoulder + vec2(0.025 * sin(u_time * 9.0 + u_mid * 4.0),
                                    HEAD_R + 0.025);

    // Apply headspin flip: rotate everything around the chest.
    vec2 chest = mix(hip, shoulder, 0.5);
    if (spinning > 0.001) {
        // Tip the body around the chest; full upside down at peak.
        float tip = spinning * PI;
        mat2 R = rot2d(tip);
        hip      = chest + R * (hip      - chest);
        shoulder = chest + R * (shoulder - chest);
        head     = chest + R * (head     - chest);
    }

    // ---- FFT AURA: N rainbow rays radiating from the chest ---------------
    // Convert pixel angle to a frequency bin around the body. Length & glow
    // proportional to that bin's amplitude.
    {
        vec2 q = figUV - chest;
        float r = length(q);
        float ang = atan(q.y, q.x);                   // -PI..PI
        float ang01 = (ang / TAU) + 0.5;              // 0..1

        // Quantize angle into N_RAYS sectors and find local-bin coords.
        float slot   = ang01 * float(N_RAYS);
        float sIdx   = floor(slot);
        float sFrac  = slot - sIdx;                   // 0..1 within sector

        // Map sector -> log-spaced freq so bass dominates a few wide rays
        // and treble peppers narrow ones.
        float t = sIdx / float(N_RAYS - 1);
        float freq = pow(2.0, mix(-7.0, 0.0, t));
        float amp  = sampleFFT(clamp(freq, 0.0, 1.0));

        // Sectoral mask: stripe down the middle of each sector with soft edges.
        float stripe = smoothstep(0.5, 0.42, abs(sFrac - 0.5));

        // Radial reach: amp determines how far the ray extends from chest.
        float reach = 0.10 + 0.55 * pow(amp, 0.85);
        float radial = smoothstep(reach, 0.04, r) * smoothstep(0.045, 0.08, r);

        // Color: rainbow around the body; brighter on stronger bins.
        vec3 rayCol = palette(
            t + 0.15 * u_time + 0.2 * u_mid,
            vec3(0.55, 0.45, 0.55),
            vec3(0.55, 0.55, 0.55),
            vec3(1.00, 1.00, 1.00),
            vec3(0.00, 0.33, 0.67)
        );

        float ray = stripe * radial * (0.6 + 1.6 * amp);
        col += rayCol * ray;

        // Subtle rim halo around the chest, treble-modulated, so even quiet
        // moments have a faint glow ring.
        float halo = exp(-pow((r - 0.08) / 0.04, 2.0)) * (0.15 + 1.0 * u_treble);
        col += rayCol * halo * 0.25;
    }

    // ---- SHOCKWAVE rings on bass hits ------------------------------------
    // Each ring is a phase offset; at any time we draw N_SHOCK staggered
    // expanding rings. Bass pumps their brightness; older = bigger & dimmer.
    for (int i = 0; i < N_SHOCK; i++) {
        float phase = fract(u_time * 0.9 + float(i) / float(N_SHOCK));
        float radius = phase * 1.1;
        float thickness = 0.008 + 0.04 * (1.0 - phase);
        float d = abs(length(figUV - chest) - radius);
        float ring = smoothstep(thickness, 0.0, d);
        float fade = (1.0 - phase) * (0.25 + 1.5 * u_bass);
        // Cycle hue per ring index for variety.
        vec3 ringCol = palette(
            float(i) * 0.27 + u_time * 0.2,
            vec3(0.5), vec3(0.5), vec3(1.0),
            vec3(0.0, 0.33, 0.67)
        );
        col += ringCol * ring * fade;
    }

    // ---- Confetti / spark particles on treble ----------------------------
    // Tile screen into a 30x18 grid; each cell flickers with hash + treble.
    {
        vec2 grid = figUV * vec2(28.0, 18.0);
        vec2 cell = floor(grid);
        vec2 f    = fract(grid) - 0.5;
        float h   = hash12(cell + floor(u_time * 14.0));
        float spark = step(0.985 - 0.5 * u_treble, h);
        float dotMask = smoothstep(0.18, 0.0, length(f));
        vec3 sparkCol = palette(
            h + u_time * 0.5,
            vec3(0.6), vec3(0.5), vec3(1.0),
            vec3(0.1, 0.4, 0.7)
        );
        col += sparkCol * spark * dotMask * (0.4 + 1.2 * u_treble);
    }

    // ---- The stick figure itself -----------------------------------------
    // Drawn in white-ish on top of the chaos. Built from SDFs we min together.

    // 1) Head — circle.
    float dHead = sdCircle(figUV - head, HEAD_R);

    // 2) Torso — capsule shoulder->hip.
    float dTorso = sdCapsule(figUV, shoulder, hip, STROKE);

    float dBody = min(dHead, dTorso);

    // 3) BREAKDANCE LEGS — two rods from the hip that go from chill bob to
    // full windmill on bass. We build a SMOOTHED bass envelope by averaging
    // a handful of recent FFT-history rows so leg motion has inertia and
    // doesn't jitter frame-to-frame. Then envelope drives BOTH speed and
    // angular amplitude: quiet = slow + small swing, kick = fast + huge sweep.
    float bassEnv = 0.0;
    bassEnv += sampleFFTHistory(0.02, 0.00);
    bassEnv += sampleFFTHistory(0.02, 0.04);
    bassEnv += sampleFFTHistory(0.02, 0.08);
    bassEnv += sampleFFTHistory(0.02, 0.14);
    bassEnv += sampleFFTHistory(0.02, 0.22);
    bassEnv *= 0.2;
    // Mix instantaneous bassKick on top so the SNAP into action stays sharp,
    // but the envelope dominates the decay (inertia coming back to chill).
    float legDrive = clamp(max(bassEnv * 1.4, bassKick), 0.0, 1.4);

    // Speed: tiny baseline so silent state still bobs lazily, huge on kicks.
    float legSpeed = 0.6 + 1.2 * u_volume + 9.0 * legDrive;
    // Use a separate accumulator-style phase: integrate speed over time so
    // changes feel continuous (no phase pop). Approx via time*speed since
    // legSpeed is smooth — fine in practice.
    float legPhase = u_time * legSpeed;

    // Angular amplitude: at rest legs barely rock (~0.25 rad ≈ 14°). On a
    // big kick they swing through near-full rotation (windmill).
    float legAmp = 0.25 + 2.9 * legDrive;
    // Spread between the two legs widens with the kick — sitting/grounded
    // when quiet, flailing wide on hits.
    float legSpread = 0.35 + 0.9 * legDrive;

    // Base "down" angle for each leg — they hang from the hip when chill.
    float baseAng1 = -PI * 0.5 - legSpread;   // down-left
    float baseAng2 = -PI * 0.5 + legSpread;   // down-right

    // Leg 1: oscillate around the down-left base; on big kicks legAmp >= PI
    // so the sin() drives a full sweep => windmill.
    float a1 = baseAng1 + legAmp * sin(legPhase);
    vec2  knee1 = hip + vec2(cos(a1), sin(a1)) * (LIMB_LEN * 0.55);
    // Knee bend follows the same drive so it relaxes with the music.
    float bend1 = (0.15 + 0.55 * legDrive) * sin(legPhase * 1.7 + 1.2);
    vec2  perp1 = vec2(-sin(a1), cos(a1));
    vec2  foot1 = knee1 + (vec2(cos(a1), sin(a1)) + perp1 * bend1) * (LIMB_LEN * 0.55);

    // Leg 2: counter-phase so the two legs feel like a pedal/breakdance pair.
    float a2 = baseAng2 + legAmp * sin(-legPhase * 0.85 + PI * 0.6);
    vec2  knee2 = hip + vec2(cos(a2), sin(a2)) * (LIMB_LEN * 0.55);
    float bend2 = (0.15 + 0.55 * legDrive) * cos(legPhase * 1.4);
    vec2  perp2 = vec2(-sin(a2), cos(a2));
    vec2  foot2 = knee2 + (vec2(cos(a2), sin(a2)) + perp2 * bend2) * (LIMB_LEN * 0.55);

    float dLeg1 = min(
        sdCapsule(figUV, hip,   knee1, STROKE),
        sdCapsule(figUV, knee1, foot1, STROKE)
    );
    float dLeg2 = min(
        sdCapsule(figUV, hip,   knee2, STROKE),
        sdCapsule(figUV, knee2, foot2, STROKE)
    );
    // Tiny "shoes" — slightly fatter circle at each foot.
    float dShoe1 = sdCircle(figUV - foot1, STROKE * 1.8);
    float dShoe2 = sdCircle(figUV - foot2, STROKE * 1.8);

    dBody = min(dBody, min(min(dLeg1, dLeg2), min(dShoe1, dShoe2)));

    // 4) OSCILLOSCOPE ARMS — each arm is a polyline of N_OSC_SEG segments
    // from the shoulder to a "hand," but each segment's transverse offset is
    // sampled from the FFT (or FFT history) so the arm reads as a live trace.
    // We compute a per-pixel distance to the polyline by taking the min over
    // segments. N_OSC_SEG is constant so the loop unrolls cleanly.
    //
    // Arm direction: roughly horizontal but tilted upward when waving. The
    // tilt angle itself jitters with u_mid so the kid is "throwing his hands".
    float armTilt = 0.6 + 0.5 * sin(u_time * 3.3 + u_mid * 5.0);

    // Right arm: shoulder out to the right, slightly up.
    vec2 armDirR = vec2( cos(armTilt),  sin(armTilt));
    // Left arm:  shoulder out to the left, slightly up — mirrored, phase-shifted.
    vec2 armDirL = vec2(-cos(armTilt + 0.4),  sin(armTilt + 0.4));

    // Perpendiculars (unit) for waveform deflection.
    vec2 perpR = vec2(-armDirR.y, armDirR.x);
    vec2 perpL = vec2(-armDirL.y, armDirL.x);

    // ---- Audio energy: "is the music poppin'?" --------------------------
    // Weighted blend of bands; bass carries the punch, mid carries the body,
    // treble carries the sparkle. Clamp so spikes can't run away.
    float energy = clamp(0.55 * u_bass + 0.35 * u_mid + 0.45 * u_treble + 0.25 * u_volume, 0.0, 1.4);

    // Pump: a sine that pulses faster + harder with energy so the arms punch
    // outward and snap back instead of just being statically longer.
    float pumpRate = 6.0 + 10.0 * energy;
    float pump     = 0.5 + 0.5 * sin(u_time * pumpRate);
    // Reach multiplier on LIMB_LEN. At quiet, ~1.0 (baseline). Loud peaks
    // can push past 2x — full air-punch extension.
    float reach    = 1.0 + (0.25 + 1.20 * energy) * pump * smoothstep(0.05, 0.6, energy)
                         + 0.10 * energy;
    float reachR   = reach;
    float reachL   = reach * (0.95 + 0.10 * sin(u_time * pumpRate * 0.83 + 1.7)); // slight phase split

    // Wiggle amplitude — gentle squiggle when quiet, absolute thrashing when loud.
    // Baseline preserved so silence still wobbles; energy term goes wild.
    float waveAmp = 0.04 + 0.08 * u_volume + 0.55 * pow(energy, 1.3);

    // Gate for secondary "radiation" wiggles shedding off the arms. Only fires
    // when the kid is genuinely hyped, fades out smoothly otherwise.
    float radGate = smoothstep(0.45, 0.95, energy);

    float dArmR = 1e3;
    float dArmL = 1e3;
    // Distance accumulators for the radiation wiggles (drawn separately as a glow,
    // not merged into the main figure SDF — they're "energy", not anatomy).
    float dRadR = 1e3;
    float dRadL = 1e3;

    // Build polyline points and accumulate min-distance to segments.
    // We can't store an array of varying length, so we keep "previous point"
    // outside and step through.
    vec2 prevR = shoulder;
    vec2 prevL = shoulder;
    // Radiation traces: two parallel offset traces per arm (above & below the
    // arm path), kept as their own previous-point accumulators.
    vec2 prevRadRa = shoulder;
    vec2 prevRadRb = shoulder;
    vec2 prevRadLa = shoulder;
    vec2 prevRadLb = shoulder;

    for (int i = 1; i <= N_OSC_SEG; i++) {
        float t  = float(i) / float(N_OSC_SEG);     // 0..1 along arm

        // Sample the FFT at a frequency that moves along the arm.
        // Use FFT history so the trace appears to *travel* outward over time
        // (newer near shoulder, older at the hand).
        float depth = t;                            // 0 at shoulder = now
        float freqR = mix(0.02, 0.55, t);           // bass->mid sweep
        float freqL = mix(0.05, 0.75, t);           // bass->treble sweep
        float ampR = sampleFFTHistory(freqR, depth) - 0.35;
        float ampL = sampleFFTHistory(freqL, depth) - 0.35;

        // Add a slow sine so silence still wiggles a little.
        ampR += 0.25 * sin(u_time * 6.0 + t * 18.0);
        ampL += 0.25 * cos(u_time * 7.0 + t * 18.0 + 1.3);

        vec2 pR = shoulder + armDirR * (LIMB_LEN * reachR * t) + perpR * (ampR * waveAmp);
        vec2 pL = shoulder + armDirL * (LIMB_LEN * reachL * t) + perpL * (ampL * waveAmp);

        dArmR = min(dArmR, sdCapsule(figUV, prevR, pR, STROKE * 0.7));
        dArmL = min(dArmL, sdCapsule(figUV, prevL, pL, STROKE * 0.7));

        prevR = pR;
        prevL = pL;

        // ---- Radiation wiggles: secondary traces fired off the arms -----
        // Offset perpendicularly from the arm centerline, with their own
        // higher-frequency sine so they read as crackling overflow energy.
        // Distance-fade: stronger near the hand, quieter near the shoulder
        // (energy "sheds" outward off the tips).
        float distFade = smoothstep(0.05, 0.85, t);
        float radOff   = (0.045 + 0.075 * energy) * distFade;
        // Secondary wiggle rides at higher frequency, modulated by treble for
        // that crackly sparkle. Phase-detuned per arm so they don't sync up.
        float radWigR  = sin(u_time * (22.0 + 30.0 * energy) + t * 42.0)
                       * (0.018 + 0.060 * energy);
        float radWigL  = cos(u_time * (24.0 + 28.0 * energy) + t * 38.0 + 0.7)
                       * (0.018 + 0.060 * energy);

        // Two offset trails per arm (a = +perp side, b = -perp side).
        vec2 pRadRa = pR + perpR * ( radOff + radWigR);
        vec2 pRadRb = pR + perpR * (-radOff + radWigR * 0.6);
        vec2 pRadLa = pL + perpL * ( radOff + radWigL);
        vec2 pRadLb = pL + perpL * (-radOff + radWigL * 0.6);

        dRadR = min(dRadR, sdCapsule(figUV, prevRadRa, pRadRa, STROKE * 0.45));
        dRadR = min(dRadR, sdCapsule(figUV, prevRadRb, pRadRb, STROKE * 0.45));
        dRadL = min(dRadL, sdCapsule(figUV, prevRadLa, pRadLa, STROKE * 0.45));
        dRadL = min(dRadL, sdCapsule(figUV, prevRadLb, pRadLb, STROKE * 0.45));

        prevRadRa = pRadRa;
        prevRadRb = pRadRb;
        prevRadLa = pRadLa;
        prevRadLb = pRadLb;
    }

    // ---- Composite the figure --------------------------------------------
    // Body in white, arms in electric color so the oscilloscope reads as
    // signal vs. anatomy.
    float bodyMask = fill(dBody, aa);
    float bodyGlow = glow(dBody, 0.025) * 0.6;

    vec3 bodyCol = vec3(1.0);
    col = mix(col, bodyCol, bodyMask);
    col += bodyCol * bodyGlow * (0.25 + 0.4 * u_bass);

    // Oscilloscope arms — cyan/magenta neon traces.
    float armRMask = fill(dArmR, aa);
    float armLMask = fill(dArmL, aa);
    float armRGlow = glow(dArmR, 0.018);
    float armLGlow = glow(dArmL, 0.018);

    vec3 armRCol = vec3(0.20, 1.00, 1.30);   // cyan-ish, slightly HDR
    vec3 armLCol = vec3(1.30, 0.30, 1.00);   // magenta-ish

    col = mix(col, armRCol, armRMask);
    col = mix(col, armLCol, armLMask);
    col += armRCol * armRGlow * (0.5 + 0.8 * u_treble);
    col += armLCol * armLGlow * (0.5 + 0.8 * u_treble);

    // Radiation wiggles — secondary traces shedding energy off the arms.
    // Gated by radGate so they only appear when the music is genuinely poppin'.
    // Drawn thinner and brighter-glow than the arms so they read as sparks of
    // overflow signal rather than additional limbs.
    if (radGate > 0.001) {
        float radRMask = fill(dRadR, aa * 1.2) * radGate;
        float radLMask = fill(dRadL, aa * 1.2) * radGate;
        float radRGlow = glow(dRadR, 0.022) * radGate;
        float radLGlow = glow(dRadL, 0.022) * radGate;

        // Lean colors slightly off the arm hue so the spark reads as a
        // harmonic, not just a duplicate line.
        vec3 radRCol = vec3(0.55, 1.30, 1.10);  // teal-tinted cyan
        vec3 radLCol = vec3(1.30, 0.55, 1.30);  // pink-tinted magenta

        col += radRCol * radRMask * (0.7 + 0.5 * energy);
        col += radLCol * radLMask * (0.7 + 0.5 * energy);
        col += radRCol * radRGlow * (0.6 + 1.4 * energy);
        col += radLCol * radLGlow * (0.6 + 1.4 * energy);
    }

    // Eyes — two tiny dark dots on the head so he reads as a face.
    {
        vec2 eyeOff = vec2(HEAD_R * 0.35, HEAD_R * 0.15);
        float dE1 = sdCircle(figUV - (head + vec2(-eyeOff.x, eyeOff.y)), HEAD_R * 0.12);
        float dE2 = sdCircle(figUV - (head + vec2( eyeOff.x, eyeOff.y)), HEAD_R * 0.12);
        float eyeMask = max(fill(dE1, aa), fill(dE2, aa));
        col = mix(col, vec3(0.05, 0.0, 0.1), eyeMask);
    }

    // Mouth: snaps from a flat ":|" line into a gaping ":O" on bass hits.
    // Driven by bassKick so it syncs with the shockwave rings. We interpolate
    // width and height independently — at rest the ellipse is wide & razor-thin
    // (reads as a line); on a hit it pulls in horizontally and balloons
    // vertically into a round hole. Color is near-black to punch through the
    // white head so the gape is unmistakable.
    {
        // gape: 0 = neutral :|, 1 = full :O. Slight ease so small bass barely
        // cracks the lips; punchy bass slams it open.
        float gape = smoothstep(0.15, 0.85, bassKick);

        vec2 mp = figUV - (head + vec2(0.0, -HEAD_R * 0.35));
        float mouthW = HEAD_R * mix(0.50, 0.32, gape);   // narrows as it rounds
        float mouthH = HEAD_R * mix(0.04, 0.32, gape);   // thin line -> tall O
        float dM = length(mp / vec2(mouthW, mouthH)) - 1.0;
        // Multiply by min radius so the SDF gradient is in world units (stable AA).
        float mouthMask = fill(dM * min(mouthW, mouthH), aa);
        // Cut a dark hole. Darker the wider the gape so :O reads as a void,
        // while the resting :| stays a soft dark line.
        vec3 mouthCol = mix(vec3(0.04, 0.02, 0.06), vec3(0.0), gape);
        col = mix(col, mouthCol, mouthMask);
    }

    // ---- Floor line — subtle horizon so the breakdancing reads as "ground" ----
    {
        float floorY = -0.30;
        float dFloor = abs(uv.y - floorY);
        float floorLine = smoothstep(0.004, 0.0, dFloor);
        // Floor pulses with bass.
        col += vec3(0.15, 0.40, 0.85) * floorLine * (0.25 + 0.9 * u_bass);
    }

    // ---- Vignette + tonemap ----------------------------------------------
    float vig = smoothstep(1.2, 0.25, length(uv));
    col *= mix(0.55, 1.0, vig);
    col = col / (1.0 + col);

    outColor = vec4(col, 1.0);
}
