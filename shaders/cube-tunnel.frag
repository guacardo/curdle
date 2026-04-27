// cube-tunnel: water-slide flythrough down a chunky neon Tron pipeline.
//
// Architecture (mash-up of tunnel.frag + spectrum-landscape.frag):
//   - Tunnel mechanics (polar coords, forward flight, rings flowing toward camera,
//     vanishing-point core, depth fog) — from tunnel.frag.
//   - Cube/column visual language (per-FFT-bin extruded boxes, wireframe edges
//     on translucent neon fill, bandColor palette) — from spectrum-landscape.frag.
//
// Each Z-slab of the tunnel is one ring of N_ANG cubes wrapping around angle θ.
// Ring index r picks a history depth (newer at front, older at back) so audio
// "flows toward the camera" the same way spectrum-landscape's rows do.
// Each cube's radial extrusion (how far it juts inward from the wall toward
// the tunnel center) is driven by sampleFFTHistory(angle-bin-freq, time-slice).
//
// Centerline twists via low-frequency sines on the depth coord -> water slide.
// Bass squeezes outer radius AND pops cube extrusion inward (kick lands twice).
// Whole ring spins around the forward axis at speed driven by volume + mid.
//
// Per-fragment we walk N_SLICE depth slabs back-to-front and composite faces
// alpha-over (newer/closer slabs on top). Each slab tests three faces of the
// chosen angular cube: INNER radial face, AZIMUTH (side) face, AXIAL (front-
// to-camera) face. Edges of any face glow as wireframe.

// ---- Geometry constants ----
const int   N_SLICE  = 24;     // depth slabs we march
const float N_ANG    = 24.0;   // angular cubes per ring
const float Z_NEAR   = 0.35;   // nearest slab front
const float Z_GROWTH = 1.13;   // slab depth grows geometrically (matches tunnel feel)
const float TUNNEL_R = 0.9;    // baseline outer radius (walls)
const float MAX_EXT  = 0.55;   // max inward extrusion of a cube (at full FFT)
const float CUBE_GAP = 0.18;   // fraction of azimuth/depth slot that is gap

float slabZFront(float r) { return Z_NEAR * pow(Z_GROWTH, r); }
float slabZBack (float r) { return Z_NEAR * pow(Z_GROWTH, r + 1.0); }

// Water-slide centerline: where the tunnel axis lives in (x,y) at depth z.
// Low-freq sines on z — slow enough to feel like banked turns, not jitter.
vec2 centerline(float z) {
    return vec2(
        0.42 * sin(z * 0.30 + u_time * 0.40),
        0.34 * cos(z * 0.25 + u_time * 0.30)
    );
}

// Derivative of centerline w.r.t. z — used for bank/roll into the turn.
vec2 centerlineD(float z) {
    return vec2(
        0.42 * 0.30 * cos(z * 0.30 + u_time * 0.40),
       -0.34 * 0.25 * sin(z * 0.25 + u_time * 0.30)
    );
}

// Frequency assigned to angular bin a (0..N_ANG-1). Log-spaced like
// spectrum-landscape so each octave gets fair representation around the ring.
float ringFreq(float a) {
    float t = a / (N_ANG - 1.0);
    float f = pow(2.0, mix(-7.0, 0.0, t));
    return max(f, 4.0 / 512.0);
}

// IQ palette — neon Tron chunks. Bass=hot magenta, mid=acid lime,
// treble=icy cyan. Same general space as spectrum-landscape's bandColor
// but biased cooler/more electric for the tunnel flight feel.
vec3 cubeColor(float freq01, float heightBoost) {
    float lf = log2(max(freq01, 1.0 / 512.0)) / 7.0 + 1.0;
    vec3 a = vec3(0.50, 0.45, 0.65);
    vec3 b = vec3(0.55, 0.50, 0.50);
    vec3 c = vec3(1.00, 1.10, 0.95);
    vec3 d = vec3(0.85, 0.30, 0.60);
    float t = lf + 0.05 * sin(u_time * 0.25 + lf * 2.5) + 0.10 * heightBoost;
    vec3 base = palette(t, a, b, c, d);
    float lum = dot(base, vec3(0.299, 0.587, 0.114));
    base = mix(vec3(lum), base, 1.0 + 0.50 * heightBoost);
    return clamp(base, 0.0, 2.5);
}

// Detect a sharp transient by comparing now vs ~0.4s ago — used to flip spin.
float transientSign() {
    float past = sampleFFTHistory(0.10, 0.40)
               + sampleFFTHistory(0.30, 0.40)
               + sampleFFTHistory(0.60, 0.40);
    past *= 1.0 / 3.0;
    float now = (u_bass + u_mid + u_treble) / 3.0;
    // Sign: positive when we're louder than recently, negative when quieter.
    return sign(now - past) * smoothstep(0.05, 0.25, abs(now - past));
}

void main() {
    // Centered, aspect-corrected screen coords. y-up.
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

    // Soft camera sway so silence still has life.
    uv -= vec2(sin(u_time * 0.31), cos(u_time * 0.27)) * 0.025;

    // ---- Forward-flight depth coord ----
    // For each slab we'll need a "z in world along travel direction." Forward
    // motion shifts that coordinate; bass briefly accelerates on a hit so the
    // tunnel "lurches" forward with the kick.
    float speed = 1.6 + 0.7 * u_volume + 1.5 * pow(u_bass, 1.6);
    float zCam  = u_time * speed;

    // ---- Ring spin ----
    // Whole tunnel rotates around the forward axis. Volume-driven base speed,
    // sign of recent-vs-past energy occasionally flips direction for variety.
    float spinDir = sign(sin(u_time * 0.13) + 0.5 * transientSign());
    if (spinDir == 0.0) spinDir = 1.0;
    float spin = (0.20 + 0.80 * u_volume + 0.40 * u_mid) * spinDir;
    float spinAngle = spin * u_time;

    // ---- Bank/roll based on local centerline curvature ----
    // The centerline is at z ~= 0 (camera position) — we bank by its derivative
    // there so the world tilts as we lean into a turn.
    vec2 cdAtCam = centerlineD(zCam);
    float bank   = 0.45 * cdAtCam.x;   // roll roughly with horizontal curvature
    vec2 viewUV  = rot2d(bank) * uv;

    // ---- Bass radius pump ----
    // Walls breathe — quiescent base + gentle sine + a sharp inward squeeze on bass.
    float breathe   = 1.0 + 0.04 * sin(u_time * 0.8);
    float radiusPump = breathe - 0.32 * pow(u_bass, 1.3);

    // Background sky behind the tunnel mouth — deep navy with a warm vanishing core.
    // Set early so closer slabs composite over it.
    float r0 = length(viewUV);
    vec3 col = mix(vec3(0.04, 0.03, 0.10), vec3(0.07, 0.06, 0.18),
                   smoothstep(0.0, 1.0, r0));

    // Bright vanishing-point core ("light at the end of the tunnel").
    float core = smoothstep(0.42, 0.0, r0);
    col += vec3(1.10, 0.85, 0.55) * core * (0.35 + 1.4 * u_bass);
    col += vec3(0.30, 0.55, 1.10) * smoothstep(0.18, 0.0, r0) * (0.4 + 0.6 * u_treble);

    // ---- Treble shimmer dust along the barrel axis (subtle) ----
    float trebleDust = sampleFFT(0.65 + 0.30 * r0) * u_treble;
    col += vec3(0.35, 0.60, 1.00) * trebleDust * smoothstep(0.7, 0.0, r0) * 0.4;

    // Total z extent for fog normalization.
    float zFar    = slabZFront(float(N_SLICE));
    float logSpan = log2(max(zFar / Z_NEAR, 1.0001));

    // ---- Walk slabs back-to-front, composite alpha-over ----
    for (int i = N_SLICE - 1; i >= 0; i--) {
        float ri    = float(i);
        float zF    = slabZFront(ri);
        float zB    = slabZBack(ri);
        float zMid  = 0.5 * (zF + zB);

        // World-space depth used for audio history lookup. Older = deeper.
        float depthNorm = ri / float(N_SLICE - 1);    // 0 front .. 1 back
        // Local z in slab space (for centerline lookup the camera-relative z is what we want).
        // Centerline shifts as we travel, so feed (zMid + zCam) — the world depth this slab
        // currently corresponds to. As zCam advances, slabs see different centerline values
        // so the wall appears to ripple/curve.
        float worldZ = zMid + zCam;
        vec2  ctr    = centerline(worldZ);
        // We're stepping into screen space, so the centerline shows up as a 2D
        // offset in the projected plane. Convert centerline world units into
        // screen units via 1/Z foreshortening (closer slabs = bigger offset).
        // Use a soft factor so far slabs only nudge slightly.
        float persp = 1.0 / max(zMid, 1e-3);
        // Note: centerline values are in *radii* of the tunnel, so we scale down
        // when projecting onto screen.
        vec2 screenCtr = ctr * 0.35 / max(zMid * 0.7 + 0.5, 0.5);

        // Pixel position relative to this slab's curved centerline.
        vec2 p = viewUV - screenCtr;

        // Polar within the slab.
        float r = length(p);
        if (r < 1e-4) continue;             // dead center -> nothing to draw

        // Apply radius pump (bass squeeze).
        float rEff = r / radiusPump;

        // ---- Choose angular bin ----
        // Angle in 0..TAU after spin so cube boundaries rotate.
        float a = atan(p.y, p.x) + spinAngle;
        a = mod(a, TAU);
        float angSlot = a / TAU * N_ANG;        // 0..N_ANG
        float aIdx    = floor(angSlot);
        float aFrac   = angSlot - aIdx;          // 0..1 within slot
        float angCenter = (aIdx + 0.5) / N_ANG * TAU;

        // ---- FFT-driven extrusion for THIS (angle-bin, time-slice) cube ----
        float freq01 = ringFreq(aIdx);
        float amp    = sampleFFTHistory(freq01, depthNorm);
        // Soft curve. Bass also adds an extra inward pop across all bins so the
        // whole ring contracts on a kick (your "pop outward radially" effect,
        // which inward-from-wall = inward extrusion in our convention).
        float bassPop = 0.20 * pow(u_bass, 1.4);
        float ext     = clamp(pow(amp, 1.3) + bassPop, 0.0, 1.0) * MAX_EXT;
        // Inner radial surface of this cube. Outer is the tunnel wall TUNNEL_R.
        float rInner  = TUNNEL_R - ext;

        // ---- Face tests ----
        // We're testing if (rEff, a, zFront..zBack) lies on one of the cube's
        // visible faces (INNER, AZIMUTH side, AXIAL front toward camera).
        // Cube footprint in (angle, z): [angCenter-Δa/2, +Δa/2] × [zF, zB], with
        // gaps inset on both edges so cubes read as discrete blocks.
        float dAng     = TAU / N_ANG;
        float angHalf  = 0.5 * dAng * (1.0 - CUBE_GAP);
        float zHalfPad = (zB - zF) * CUBE_GAP * 0.5;
        float zFi      = zF + zHalfPad;
        float zBi      = zB - zHalfPad;

        // Local angular offset from cube center, in radians, signed.
        float dA = a - angCenter;
        if (dA >  PI) dA -= TAU;
        if (dA < -PI) dA += TAU;

        bool inAng = abs(dA) <= angHalf;

        // INNER face: rEff is on the inner radial surface (rInner) and
        // (a, zMid) lies inside the cube footprint.
        // Since we're rendering per-pixel without true raymarching, "INNER face"
        // here means: rEff <= rInner means we've punched past the cube into the
        // tunnel hollow -> we don't draw INNER for this pixel; instead this
        // pixel sees through to closer slabs. INNER face is hit when rEff is
        // *just at* rInner (within the cube's depth slot).
        // Practical heuristic: this pixel renders the cube if rEff is in
        // [rInner, TUNNEL_R] (we're inside the cube body) AND inside the angular
        // slot. We then pick which face based on which boundary we're nearest.
        bool inRad = (rEff >= rInner) && (rEff <= TUNNEL_R);

        // Cube is "live" only if extrusion is meaningful — silent bins skip
        // entirely so the tunnel has structural gaps you fly through.
        // (Avoid reserved word `active`.)
        bool live = ext > 0.02 && inAng && inRad;
        if (!live) continue;

        // ---- Face-local UVs for wireframe edges ----
        // u along azimuth (-1..1 across the angular slot), v along depth (0..1
        // across the slab), w along radius (0 at INNER, 1 at TUNNEL_R wall).
        float fu = dA / angHalf;                                  // -1..1
        float fv = clamp((zMid - zFi) / max(zBi - zFi, 1e-4), 0.0, 1.0); // depth doesn't actually
        // vary across the pixel within a slab, so fv is essentially constant — we'll detect
        // axial-face edges using radial+azimuthal alone.
        float fw = clamp((rEff - rInner) / max(TUNNEL_R - rInner, 1e-4), 0.0, 1.0);

        // Convert fu (-1..1) into 0..1 for symmetric edge math.
        float fu01 = fu * 0.5 + 0.5;

        // Pixel-stable edge widths.
        float wU = fwidth(fu01) * 1.6;
        float wW = fwidth(fw)   * 1.6;

        // Edge masks: u edges = azimuth boundaries (between adjacent ring cubes),
        // w edges = inner-face / outer-wall transition (we mostly only see the inner edge).
        float eU = 1.0 - smoothstep(0.0, wU, min(fu01, 1.0 - fu01));
        // Inner-edge: fw close to 0 (we're at the inner face boundary).
        float eInner = 1.0 - smoothstep(0.0, wW, fw);
        // Outer-edge (close to wall) — rarely visible because outer is occluded
        // by the next slab's cube; keep dim.
        float eOuter = (1.0 - smoothstep(0.0, wW, 1.0 - fw)) * 0.35;

        float edgeMask = clamp(max(max(eU, eInner), eOuter), 0.0, 1.0);

        // ---- Color ----
        float heightT = ext / MAX_EXT;
        vec3 baseCol  = cubeColor(freq01, heightT);

        // Translucent fill — varies with radius so cube has fake AO from inner face out.
        // Inner is brightest (closest, hit by core glow), outer dimmer.
        float aoR = mix(0.95, 0.45, fw);
        vec3 fillCol = baseCol * aoR * (0.55 + 0.30 * heightT);

        // Wireframe edges glow brighter and hotter.
        vec3 edgeCol = cubeColor(freq01, min(heightT + 0.35, 1.0)) * 1.85;
        edgeCol *= 0.55 + 0.85 * heightT;

        // Depth fog — log-Z so geometric slab spacing fades evenly.
        float fog = clamp(log2(max(zMid / Z_NEAR, 1.0)) / logSpan, 0.0, 1.0);
        fog = pow(fog, 0.75);

        vec3 hazeCol = vec3(0.08, 0.06, 0.18);
        fillCol *= mix(1.0, 0.20, fog);
        fillCol  = mix(fillCol, hazeCol, fog * 0.92);
        edgeCol *= mix(1.0, 0.32, fog);
        edgeCol  = mix(edgeCol, hazeCol, fog * 0.85);

        // Bass tint: cubes shift cooler on hard hits for a strobe feel.
        float bassFlash = smoothstep(0.78, 0.95, u_bass);
        fillCol = mix(fillCol, fillCol * vec3(0.55, 0.85, 1.55), bassFlash * 0.30);

        // Composite face onto accumulator.
        float fillAlpha = 0.55;
        vec3  faceCol   = mix(fillCol, edgeCol, edgeMask);
        float faceAlpha = mix(fillAlpha, 1.0, edgeMask);
        // Distant slabs dissolve fully so back of tunnel has no hard cutoff.
        faceAlpha *= 1.0 - smoothstep(0.70, 1.0, fog);

        col = mix(col, faceCol, faceAlpha);
    }

    // ---- Treble FFT rim ribs at slab boundaries (a la tunnel.frag ribs) ----
    // Subtle, layered on top — gives an extra "ring marching toward you" cue.
    float zSaw   = u_time * (1.6 + 0.7 * u_volume) * 0.5;
    float ribPos = fract(zSaw + 0.4 * (1.0 - r0));
    float rib    = smoothstep(0.46, 0.50, ribPos) - smoothstep(0.50, 0.54, ribPos);
    float ribFFT = sampleFFT(0.40 + 0.50 * fract(zSaw + 0.13));
    col += vec3(0.35, 0.50, 0.95) * rib * (0.10 + 1.6 * ribFFT * u_treble) * smoothstep(0.0, 0.7, r0);

    // ---- Vignette + tonemap ----
    float vig = smoothstep(1.3, 0.25, length(uv));
    col *= mix(0.65, 1.0, vig);
    col = col / (1.0 + col);

    outColor = vec4(col, 1.0);
}
