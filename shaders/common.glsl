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
