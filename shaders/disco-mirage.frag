// disco-mirage: a faceted disco ball at the center of a kaleidoscopic mirror
// hall, glazed with oil-slick thin-film iridescence and rippling like the
// scene is viewed through water.
//
// Layered construction:
//   1) Water-ripple domain warp on screen UVs — concentric sin waves whose
//      wavelength is set by spatial FFT energy, amplitude by u_bass.
//   2) Mirror-hall outside the ball: 8-fold kaleidoscopic fold of the warped
//      UV, projected through a long-tail beam function so light streaks shoot
//      radially outward. Treble drives streak count + sharpness.
//   3) Disco ball as a fake sphere (z = sqrt(R^2 - r^2)). The sphere surface
//      is partitioned into hexagonal-ish facets via a polar Voronoi (a stable
//      cell layout in spherical coords). Each facet has its own:
//       - sparkle phase (deterministic hash) lit by treble transients
//       - thin-film oil tint indexed by facet-normal . view + time
//   4) Bass squeezes the ball radius and pumps the mirror beams.
//
// Cool palette throughout — cyans, deep blues, magentas, electric violet.
// The IQ palette parameters are tuned to never land on warm yellows.

// ---- Cool oil-slick palette (no warm yellows) -------------------------------
// Tuned so the cosine sweep across t∈[0,1] visits:
//   t≈0.0 → deep navy / indigo
//   t≈0.25 → electric magenta
//   t≈0.5 → teal / cyan
//   t≈0.75 → violet
// (a + b*cos(2π(c*t + d)))
const vec3 PAL_A = vec3(0.42, 0.40, 0.58);
const vec3 PAL_B = vec3(0.45, 0.42, 0.52);
const vec3 PAL_C = vec3(1.00, 0.95, 1.10);
const vec3 PAL_D = vec3(0.10, 0.32, 0.62);

vec3 oilSlick(float t) {
  return palette(t, PAL_A, PAL_B, PAL_C, PAL_D);
}

// Polar-cell ID for the disco ball. Given a unit-sphere surface point n
// (n.z is "out of screen"), partition into facets by quantizing latitude
// (n.z) into rings and then the azimuth into a row-dependent slot count.
// Returns vec3(cellId.x, cellId.y, facetCenterAngularIndex) used downstream
// to drive sparkle phase + facet normal.
vec3 facetCell(vec3 n) {
  // Latitude ring: z runs from 0 (limb) to 1 (pole, facing camera).
  // Use acos so rings are equal-angle bands.
  float lat = acos(clamp(n.z, -1.0, 1.0));   // 0 at pole, PI/2 at limb
  // 7 rings from pole to limb gives a chunky, readable facet count.
  float ringF = lat / (PI * 0.5) * 7.0;
  float ring = floor(ringF);
  // Slots per ring scale with sin(lat) so cells stay roughly square.
  float slots = max(6.0, floor(6.0 + 18.0 * sin(lat)));
  float az = atan(n.y, n.x);                  // [-PI, PI]
  float slotF = (az / TAU + 0.5) * slots;
  float slot = floor(slotF);
  return vec3(ring, slot, slots);
}

// Facet center direction: snap n to the center of its cell.
vec3 facetNormal(vec3 n) {
  float lat = acos(clamp(n.z, -1.0, 1.0));
  float ringF = lat / (PI * 0.5) * 7.0;
  float ring = floor(ringF) + 0.5;
  float ringLat = ring / 7.0 * (PI * 0.5);
  float slots = max(6.0, floor(6.0 + 18.0 * sin(ringLat)));
  float az = atan(n.y, n.x);
  float slotF = (az / TAU + 0.5) * slots;
  float slot = floor(slotF) + 0.5;
  float ringAz = (slot / slots - 0.5) * TAU;
  float s = sin(ringLat), c = cos(ringLat);
  return vec3(s * cos(ringAz), s * sin(ringAz), c);
}

// Distance to nearest facet edge in sphere-surface coordinates (used for the
// inked seams between mirror tiles). Returns ~0 at edge, >0 inside.
float facetEdge(vec3 n) {
  float lat = acos(clamp(n.z, -1.0, 1.0));
  float ringF = lat / (PI * 0.5) * 7.0;
  float ringFr = abs(fract(ringF) - 0.5) * 2.0;   // 1 at edge, 0 at center
  float ringLat = (floor(ringF) + 0.5) / 7.0 * (PI * 0.5);
  float slots = max(6.0, floor(6.0 + 18.0 * sin(ringLat)));
  float az = atan(n.y, n.x);
  float slotF = (az / TAU + 0.5) * slots;
  float slotFr = abs(fract(slotF) - 0.5) * 2.0;
  // Edge-ness = max of the two; we want a small number near the seams.
  float edge = max(ringFr, slotFr);
  return edge;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  // ===== 1) Water ripple distortion ========================================
  // Distance from a point that gently wanders so the ripples don't look
  // perfectly radial-symmetric all the time.
  vec2 rippleSrc = 0.18 * vec2(sin(t * 0.27), cos(t * 0.21));
  float rd = length(uv - rippleSrc);

  // FFT-tied wavelength: low-mid bins compress the ripple stack on energy.
  float bassPump = pow(u_bass, 1.3);
  float ripWaves = 28.0 + 18.0 * sampleFFT(0.08);
  float ripple = sin(rd * ripWaves - t * 3.2) * exp(-rd * 1.4);
  ripple += 0.6 * sin(rd * (ripWaves * 1.7) - t * 5.1) * exp(-rd * 2.0);
  float ripAmp = 0.012 + 0.045 * bassPump;
  vec2 rippleDir = (rd > 1e-4) ? (uv - rippleSrc) / rd : vec2(0.0, 1.0);
  vec2 wuv = uv + rippleDir * ripple * ripAmp;

  // ===== 2) Mirror-hall (kaleidoscopic beams outside the ball) =============
  // Convert warped uv to polar; reflect azimuth into a wedge for kaleidoscope.
  float r = length(wuv);
  float ang = atan(wuv.y, wuv.x);
  // Slow rotation so the mirror hall spins like a real ball is throwing it.
  ang += t * 0.15 + 0.6 * u_mid;

  // Treble adds petals. Always at least 8 to keep "disco shards" character.
  float petals = 8.0 + floor(8.0 * smoothstep(0.0, 0.6, u_treble));
  // Fold into wedge.
  float wedge = TAU / petals;
  float a = mod(ang, wedge);
  a = abs(a - wedge * 0.5);   // mirror

  // Beam mask: a sharp angular slit modulated by treble sparkle; long radial
  // tail so it reads as a beam shooting out from the ball.
  float beamSharp = mix(8.0, 22.0, smoothstep(0.0, 0.6, u_treble));
  float beam = pow(max(0.0, 1.0 - a / (wedge * 0.5)), beamSharp);
  // Per-petal sparkle: hash by the petal index lit by current treble FFT.
  float petalIdx = floor((ang + PI) / wedge);
  float petalFreq = fract(petalIdx * 0.137) * 0.9 + 0.05;
  float petalEnergy = sampleFFT(0.4 + 0.6 * petalFreq);
  beam *= 0.4 + 1.6 * petalEnergy;

  // Radial tail: bright near the ball, fades outward; bass extends reach.
  float tail = exp(-r * (3.2 - 1.6 * bassPump));
  // A second high-freq radial striation to suggest scattered glints.
  float strobe = 0.5 + 0.5 * sin(r * 60.0 - t * 9.0 + petalIdx * 1.7);
  beam *= tail * (0.55 + 0.45 * strobe);

  // Beam color from oil-slick palette indexed by petal + time.
  float beamHue = 0.45 + 0.35 * sin(petalIdx * 0.91 + t * 0.4) + 0.15 * u_treble;
  vec3 beamCol = oilSlick(beamHue) * beam * 1.4;

  // Ambient deep-water backdrop so silence still has color.
  vec3 backdrop = mix(
    vec3(0.02, 0.03, 0.08),
    oilSlick(0.55 + 0.15 * sin(t * 0.13)) * 0.18,
    smoothstep(0.0, 1.2, r)
  );
  // Slow churning fbm tint behind the beams — keeps the field alive.
  float churn = fbm(wuv * 1.4 + vec2(t * 0.08, -t * 0.05));
  backdrop += oilSlick(0.6 + 0.2 * churn) * 0.06;

  vec3 col = backdrop + beamCol;

  // ===== 3) Disco ball (fake sphere at center) =============================
  // Bass pulses the ball outward; idle radius keeps it always visible.
  float ballR = 0.32 + 0.045 * bassPump + 0.012 * sin(t * 1.7);

  if (r < ballR) {
    // Sphere normal in screen-space: (xy/R, sqrt(1 - (r/R)^2)).
    vec2 sxy = wuv / ballR;
    float nz = sqrt(max(1.0 - dot(sxy, sxy), 0.0));
    vec3 n = vec3(sxy, nz);

    // Slowly spin the sphere by rotating the lookup normal about Y.
    float spin = t * 0.5 + 0.8 * u_volume;
    float cs = cos(spin), sn = sin(spin);
    vec3 nSpun = vec3(cs * n.x + sn * n.z, n.y, -sn * n.x + cs * n.z);

    // Snap to facet center so each tile reads as a flat mirror.
    vec3 fn = facetNormal(nSpun);
    vec3 cell = facetCell(nSpun);
    float edge = facetEdge(nSpun);

    // Per-facet hash for sparkle timing + freq assignment.
    float h = hash21(cell.xy + 17.3);
    // Facet picks a random freq bin in the upper half (sparkle = treble).
    float facetFreq = 0.35 + 0.6 * fract(h * 7.13);
    float facetAmp = sampleFFT(facetFreq);

    // Mirror reflection vector: reflect the camera ray (0,0,-1) about fn.
    // R = V - 2*dot(V,N)*N, with V = (0,0,1) (toward camera).
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 R = reflect(-V, fn);

    // Use R.xy to sample the same kaleidoscope beams the room is lit by, so
    // each facet appears to be reflecting the surrounding mirror hall.
    vec2 ruv = R.xy * 1.2;
    float rr = length(ruv);
    float rang = atan(ruv.y, ruv.x) + t * 0.15;
    float ra = mod(rang, wedge);
    ra = abs(ra - wedge * 0.5);
    float rbeam = pow(max(0.0, 1.0 - ra / (wedge * 0.5)), beamSharp);
    rbeam *= exp(-rr * 1.6);
    float rPetal = floor((rang + PI) / wedge);
    rbeam *= 0.4 + 1.6 * sampleFFT(0.4 + 0.6 * fract(rPetal * 0.137));

    // Thin-film iridescence. Approx Fresnel/path-difference proxy =
    // 1 - dot(N, V) gives angle dependence; scale it so the hue cycles
    // multiple times across the sphere.
    float ndv = clamp(dot(fn, V), 0.0, 1.0);
    float thinFilm = (1.0 - ndv) * 3.5 + 0.18 * fract(h * 13.7);
    thinFilm += 0.4 * u_treble + 0.05 * t;
    vec3 iridescent = oilSlick(thinFilm);

    // Base facet color: dark mirror tinted with iridescence.
    vec3 facetCol = mix(vec3(0.04, 0.06, 0.12), iridescent * 0.55, 0.7);

    // Reflection of the room beams contributes hard light onto the facet.
    facetCol += iridescent * rbeam * 1.2;

    // Sparkle: each facet flares when its assigned freq pops. Sharp pulse
    // shaped by hash-driven phase so adjacent facets don't all flare in sync.
    float sparkPhase = h * TAU + t * (4.0 + 6.0 * h);
    float sparkBase = 0.5 + 0.5 * sin(sparkPhase);
    float sparkle = pow(sparkBase, 8.0) * smoothstep(0.05, 0.5, facetAmp);
    // Treble globally lifts every sparkle so loud highs make the ball "burn".
    sparkle *= 0.5 + 1.8 * u_treble;
    facetCol += vec3(0.85, 0.95, 1.15) * sparkle;

    // Specular hot-spot toward the top-front of the ball (fixed light).
    vec3 lightDir = normalize(vec3(0.4, 0.6, 0.9));
    float spec = pow(max(dot(fn, lightDir), 0.0), 28.0);
    facetCol += iridescent * spec * (0.6 + 0.7 * u_mid);

    // Inked seams between facets — pull the value down at edges.
    float seam = smoothstep(0.0, 0.06, edge);   // 0 at seam, 1 inside
    facetCol *= mix(0.25, 1.0, seam);

    // Soft sphere terminator so the silhouette doesn't read as a hard disc.
    float limb = smoothstep(0.0, 0.06, 1.0 - length(sxy));
    facetCol *= mix(0.3, 1.0, limb);

    // Composite ball over the room. Edge of the ball gets a thin halo to sell
    // the "this is a glowing sphere" read.
    float ballMask = smoothstep(ballR, ballR - 0.012, r);
    col = mix(col, facetCol, ballMask);
  }

  // ===== 4) Halo around the ball (independent of inside/outside) ===========
  float haloR = ballR + 0.04;
  float halo = exp(-pow((r - haloR) * 8.0, 2.0)) * (0.18 + 0.9 * bassPump);
  col += oilSlick(0.5 + 0.2 * sin(t * 0.6) + 0.3 * u_mid) * halo;

  // Outer radial bloom that breathes with bass.
  float bloom = exp(-r * 1.1) * 0.12 * (0.4 + 1.4 * bassPump);
  col += oilSlick(0.3 + 0.1 * sin(t * 0.4)) * bloom;

  // ===== Vignette + tonemap ================================================
  float vig = smoothstep(1.35, 0.25, length(uv));
  col *= mix(0.6, 1.0, vig);

  // Reinhard tonemap so bass spikes don't clip to white.
  col = col / (1.0 + col);

  outColor = vec4(col, 1.0);
}
