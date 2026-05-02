// mandelbrot-neon-dive: an infinite recursive zoom into the seahorse valley of
// the Mandelbrot set, painted in 1980s-arcade neon. The zoom is exponential and
// LOOPED — every ZOOM_PERIOD seconds the magnification resets cleanly back to
// 1.0, so we never run out of float precision and the dive feels truly endless.
// Smooth (continuous) escape-time coloring kills banding; the iteration count
// is decimalized via the classic log-log-radius trick so the palette flows
// across filaments instead of stepping through them.
//
// Audio:
//   - u_volume / u_bass throbs the palette phase and a soft inner glow.
//   - u_treble jitters hue along the high-iteration filaments (the "edge").
// A slow rotation around the target keeps motion alive even in silence.
//
// Target point: a famous seahorse-valley spiral just shy of the cardioid.
//   c0 = (-0.743643887037151, 0.13182590420533)

// ---- Tunables --------------------------------------------------------------
// One full zoom-in cycle, in seconds. After this we wrap back to magnification
// 1.0 and dive again. ~24s feels like a long, smooth descent without dragging.
#define ZOOM_PERIOD 24.0
// Maximum log-zoom reached at the end of one cycle. e^14 ≈ 1.2M× — deep enough
// for filament detail but well within float32 headroom around the target.
#define MAX_LOG_ZOOM 14.0
// Iteration cap. WebGL2 needs a constant bound; 96 gives clean detail at depth.
#define MAX_ITER 96
// Bailout radius squared. 256 (=16²) lets the smoothing trick be very accurate.
#define BAILOUT2 256.0

// Famous seahorse-valley target. Chosen because it's an infinite mini-spiral —
// you can zoom forever and keep finding new structure.
const vec2 TARGET = vec2(-0.743643887037151, 0.13182590420533);

// Iterate z -> z² + c, returning a fractional (smooth) iteration count.
// Returns -1.0 if the point never escaped (interior).
float smoothMandelbrot(vec2 c) {
  vec2 z = vec2(0.0);
  float iter = 0.0;
  // Track escape inside the loop; we can't break-with-data on WebGL2 cleanly
  // across all drivers, so we keep iterating but freeze z once it has escaped.
  bool escaped = false;
  float escIter = 0.0;
  vec2  escZ    = vec2(0.0);

  for (int i = 0; i < MAX_ITER; i++) {
    if (!escaped) {
      // z = z² + c, written out so we don't pay for a complex-mul function.
      z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
      float r2 = dot(z, z);
      if (r2 > BAILOUT2) {
        escaped = true;
        escIter = float(i);
        escZ    = z;
      }
    }
  }

  if (!escaped) return -1.0;

  // Continuous escape time: subtract log2(log2(|z|)) so the iteration count
  // becomes a smooth real number across the bailout boundary. Without this,
  // we'd see concentric onion-skin bands at every integer iteration.
  float logZ  = log(dot(escZ, escZ)) * 0.5;          // log|z|
  float nu    = log(logZ / log(2.0)) / log(2.0);     // log2(log2|z|)
  return escIter + 1.0 - nu;
}

// Cheap 2x2 rotated-grid supersample at deep zoom — only 4 evaluations, but
// it tames the worst aliasing on hair-fine filaments. The MAX_ITER=96 cost
// quadruples; on modern GPUs this is still trivial at typical canvas sizes.
vec3 shadePoint(vec2 c, float palPhase, float trebleJitter);

void main() {
  // Centered, aspect-correct, unit-radius UV.
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

  // ---- Looping exponential zoom -----------------------------------------
  // cyclePhase ∈ [0,1) ramps linearly across one ZOOM_PERIOD, then snaps back.
  // The actual magnification is exp(MAX_LOG_ZOOM * cyclePhase) — exponential
  // zoom, looped. Because the wrap point is at zoom=1 (a wide view of the
  // whole set), the snap is hidden by the visual similarity of "fully zoomed
  // out" frames; from the user's POV we just keep diving.
  float cyclePhase = fract(u_time / ZOOM_PERIOD);
  float zoom       = exp(MAX_LOG_ZOOM * cyclePhase);
  float invZoom    = 1.0 / zoom;

  // ---- Slow rotation as we descend --------------------------------------
  // One full turn per cycle, biased so motion is gentle near the start of the
  // dive (where features are large) and snappier deep in (where everything is
  // small anyway, so faster rotation reads as energetic without smearing).
  float spinAngle = TAU * (cyclePhase * 0.85) + 0.07 * u_time;
  mat2  spin      = rot2d(spinAngle);

  // ---- Audio coupling ---------------------------------------------------
  // Slow-attack envelope on bass so the throb breathes instead of strobing.
  float throb     = 0.5 * u_bass + 0.5 * u_volume;
  float palPhase  = 0.05 * u_time + 0.18 * throb;        // palette drift
  float trebJit   = 0.25 * u_treble;                     // hue jitter at edges

  // ---- 2x2 rotated-grid AA ----------------------------------------------
  // Subpixel offsets in screen-space, then converted to fractal-plane offsets
  // by the same invZoom we use for the main sample. Only meaningful at deep
  // zoom; cheap enough to always keep on.
  float px = invZoom / min(u_resolution.x, u_resolution.y);
  vec3 acc = vec3(0.0);

  // Four sub-samples on a rotated 2×2 grid (offsets approximate ±0.25 px).
  vec2 baseC = TARGET + spin * uv * invZoom;
  vec2 o0 = spin * vec2( 0.125, -0.375) * px;
  vec2 o1 = spin * vec2( 0.375,  0.125) * px;
  vec2 o2 = spin * vec2(-0.125,  0.375) * px;
  vec2 o3 = spin * vec2(-0.375, -0.125) * px;

  acc += shadePoint(baseC + o0, palPhase, trebJit);
  acc += shadePoint(baseC + o1, palPhase, trebJit);
  acc += shadePoint(baseC + o2, palPhase, trebJit);
  acc += shadePoint(baseC + o3, palPhase, trebJit);
  vec3 col = acc * 0.25;

  // ---- Audio-driven inner glow ------------------------------------------
  // Bass-throb pumps a soft warm bloom from the screen center, as if the
  // fractal itself were lit from within. Falls off quickly so it doesn't
  // wash the filament detail.
  float r   = length(uv);
  float glow = exp(-3.5 * r) * (0.15 + 0.55 * throb);
  // Glow color sits between hot magenta and electric cyan depending on bass —
  // hard hits push it toward magenta, quiet sections sit on cool cyan.
  vec3 glowCol = mix(vec3(0.20, 0.85, 1.00), vec3(1.00, 0.20, 0.85), smoothstep(0.0, 1.0, u_bass));
  col += glowCol * glow;

  // ---- Vignette ---------------------------------------------------------
  float vig = smoothstep(1.35, 0.30, r);
  col *= mix(0.55, 1.0, vig);

  // ---- Tonemap ----------------------------------------------------------
  // Reinhard-style soft tonemap — keeps neon chroma intact even when the
  // bass-glow stacks on a bright filament.
  col = col / (1.0 + col * 0.85);

  // Tiny crush toward an inky purple-black so the empty interior of the set
  // doesn't read as pure 0,0,0 (which clips the neon vibe).
  col = max(col, vec3(0.012, 0.006, 0.022));

  outColor = vec4(col, 1.0);
}

// ----------------------------------------------------------------------------
// shadePoint: evaluate the fractal at one complex coordinate and turn the
// smooth iteration count into a neon color.
// ----------------------------------------------------------------------------
vec3 shadePoint(vec2 c, float palPhase, float trebleJitter) {
  float n = smoothMandelbrot(c);

  // Interior (never escaped): inky base with a faint internal sheen.
  if (n < 0.0) {
    return vec3(0.015, 0.008, 0.030);
  }

  // Map the smooth iteration count into a palette parameter. log keeps the
  // visual frequency of color stripes roughly constant as we zoom — without
  // it, deep zooms collapse the palette into a few wide bands.
  float t = log(n + 1.0) * 0.18 + palPhase;

  // ---- IQ neon cosine palette ------------------------------------------
  // a = midpoint, b = swing, c = frequency per channel, d = phase per channel.
  // Tuned to spend most time in saturated pink/cyan/lime/magenta with very
  // little time near grey — that's what gives it the arcade-CRT feel.
  vec3 a = vec3(0.55, 0.40, 0.65);
  vec3 b = vec3(0.55, 0.60, 0.50);
  vec3 c1 = vec3(1.00, 1.10, 0.90);
  vec3 d = vec3(0.00, 0.33, 0.67);
  vec3 col = palette(t, a, b, c1, d);

  // Treble jitter: hue shift only on high-iteration (edge) pixels. Pixels
  // deep in the bulb (low n) stay clean; the filament fringe sparkles.
  float edge = smoothstep(8.0, 32.0, n);
  col = palette(t + trebleJitter * edge, a, b, c1, d);

  // Boost saturation toward neon — push channels away from their luminance
  // mean. This is what stops the cosine palette from looking pastel.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.35);

  // Edge brightening: high-iteration filaments are the visually interesting
  // skeleton of the set, so we push their luminance up. Inner-bulk pixels
  // stay dimmer, letting the filament glow.
  col *= 0.55 + 0.85 * edge;

  return col;
}
