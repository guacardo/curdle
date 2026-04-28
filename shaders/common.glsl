// Curdle shader common header. Auto-prepended to every fragment shader.
// Already declared upstream: u_time, u_resolution, u_fft, u_bass, u_mid, u_treble, u_volume,
// v_uv (input), outColor (output).

#define PI  3.14159265359
#define TAU 6.28318530718

// Sample the FFT texture at normalized frequency t ∈ [0,1].
// 0 = lowest bin (bass), 1 = highest bin (treble).
float sampleFFT(float t) {
  return texture(u_fft, vec2(clamp(t, 0.0, 1.0), 0.5)).r;
}

// Sample the FFT *history* texture — past spectra (~64 frames, ~1 second).
//   freq:  0..1 normalized frequency (0=bass, 1=treble)
//   depth: 0..1 time-ago (0=now, 1=oldest in buffer)
// Useful for waterfall / spectrogram-style visuals or detecting changes
// (e.g. compare current u_volume to mean of sampleFFTHistory(0.5, k) over k).
float sampleFFTHistory(float freq, float depth) {
  float row = u_fftHistoryHead - depth;
  row = fract(row + 1.0);
  return texture(u_fftHistory, vec2(clamp(freq, 0.0, 1.0), row)).r;
}

// IQ-style cosine palette. https://iquilezles.org/articles/palettes/
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(TAU * (c * t + d));
}

// Cheap deterministic hash.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// 2D value noise.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i + vec2(0.0, 0.0));
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractional Brownian motion (4 octaves of value noise).
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

// 2D rotation matrix.
mat2 rot2d(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

// Smooth minimum (polynomial). Good for blending distance fields.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// ===== Shared triadic palette =====
// All shaders that opt into the triad share one rotating base hue, so the
// whole visualizer feels chromatically coherent across shader switches.
// Period is intentionally slow (~45s/revolution) — color identity should
// outlast a single song section.
#define TRIAD_PERIOD_SECONDS 45.0

// Cheap HSL→RGB. h in [0,1) (wraps), s,l in [0,1].
//   s=0 → grey, s=1 → pure hue.
//   l<0.5 darkens toward black, l>0.5 brightens toward white, l=0.5 is the
//   pure mid-luminance hue.
vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = mod(vec3(0.0, 2.0/3.0, 1.0/3.0) + h, 1.0);
  vec3 c = abs(6.0 * k - 3.0) - 1.0;
  vec3 rgb = clamp(c, 0.0, 1.0);
  vec3 grey = vec3(0.5);
  rgb = mix(grey, rgb, s);
  if (l < 0.5) rgb *= (l * 2.0);
  else         rgb = mix(rgb, vec3(1.0), (l - 0.5) * 2.0);
  return rgb;
}

// Current rotating base hue of the global triad (in [0,1)).
// `phaseOffset` lets a shader bias its triad without breaking sync — pass 0
// to land exactly on the shared phase.
float triadHue(float phaseOffset) {
  return fract(u_time * (1.0 / TRIAD_PERIOD_SECONDS) + phaseOffset);
}

// Pick one of the three triad hues by a 0..1 selector with smooth crossfades.
// selector ∈ [0,1] → blend across hues at 0°, 120°, 240° from `baseHue`.
// Returns RGB at the given saturation/lightness.
vec3 triadPick(float selector, float baseHue, float sat, float lit) {
  float s = clamp(selector, 0.0, 1.0);
  // Three smooth bumps centered at 1/6, 1/2, 5/6 with soft transitions.
  float w0 = smoothstep(0.00, 0.34, s) * (1.0 - smoothstep(0.34, 0.66, s));
  float w1 = smoothstep(0.34, 0.66, s) * (1.0 - smoothstep(0.66, 1.00, s));
  float w2 = smoothstep(0.66, 1.00, s);
  // Tail weights so the extremes keep a clean identity even past the bumps.
  w0 += 1.0 - smoothstep(0.00, 0.18, s);
  w2 += smoothstep(0.82, 1.00, s) * 0.7;
  float wSum = max(w0 + w1 + w2, 1e-4);
  w0 /= wSum; w1 /= wSum; w2 /= wSum;

  vec3 c0 = hsl2rgb(baseHue,                       sat, lit);
  vec3 c1 = hsl2rgb(fract(baseHue + 1.0 / 3.0),    sat, lit);
  vec3 c2 = hsl2rgb(fract(baseHue + 2.0 / 3.0),    sat, lit);
  return c0 * w0 + c1 * w1 + c2 * w2;
}

// Sharper triad picker for neon looks. Same selector convention as triadPick
// but transitions are *narrow seams* instead of broad crossfades — most pixels
// land squarely on ONE triad hue, so the screen reads as deliberate neon
// blocks instead of muddy RGB-interpolated midtones.
//   crossfade ∈ [0, 0.3]: width of the seam between adjacent hues.
//     0.0  → cel-shade hard edge (1px aliased boundary).
//     0.05 → thin antialiased seam (good default for smooth fields).
//     0.20 → soft but still hue-distinct.
// Implementation: pick the dominant of the 3 thirds (0..1/3, 1/3..2/3, 2/3..1),
// then mix only across the small crossfade band straddling each boundary. The
// in-between zone is at most `crossfade` wide, so muddy RGB-mixed colors are
// confined to seams instead of dominating the canvas.
vec3 triadPickHard(float selector, float baseHue, float sat, float lit, float crossfade) {
  float s = clamp(selector, 0.0, 1.0);
  float cf = clamp(crossfade, 0.0, 0.33);

  vec3 c0 = hsl2rgb(baseHue,                       sat, lit);
  vec3 c1 = hsl2rgb(fract(baseHue + 1.0 / 3.0),    sat, lit);
  vec3 c2 = hsl2rgb(fract(baseHue + 2.0 / 3.0),    sat, lit);

  // Boundaries at 1/3 and 2/3. Use a half-width seam on each side.
  float half_cf = cf * 0.5;
  // Dominant hue is c0 below 1/3, c1 between 1/3 and 2/3, c2 above 2/3.
  float t01 = smoothstep(1.0/3.0 - half_cf, 1.0/3.0 + half_cf, s);
  float t12 = smoothstep(2.0/3.0 - half_cf, 2.0/3.0 + half_cf, s);
  vec3 lo = mix(c0, c1, t01);
  return mix(lo, c2, t12);
}
