# curdle

A music visualizer that captures your system audio natively (no virtual cable
required) and renders it through hot-swappable WebGL2 shaders in the browser.

## Why

`projectM` and the Milkdrop lineage are showing their age. `curdle` is a
modern, minimal alternative: spin up a local server, open a browser tab, watch
your music turn into shaders.

## Run

```sh
./run.sh
```

Opens `http://localhost:8788` in your browser. Click *start* (browsers require
a user gesture before audio can begin).

## Requirements

| Tool   | Why                                  | Install                                        |
| ------ | ------------------------------------ | ---------------------------------------------- |
| bun    | Server runtime                       | `curl -fsSL https://bun.sh/install \| bash`    |
| ffmpeg | Captures system audio                | `sudo pacman -S ffmpeg` (or your distro's eq.) |

## How it works

```
ffmpeg ──PCM─▶ Bun WebSocket ──PCM─▶ AudioWorklet ──▶ AnalyserNode ──FFT─▶ Shader
```

1. `server/audio.ts` spawns `ffmpeg` and pipes raw PCM (s16le, 48kHz, stereo)
   from the OS's system-audio source.
2. `server/index.ts` forwards each chunk to all WebSocket clients.
3. `client/audio-worklet.js` deinterleaves the PCM into Web Audio's float32
   sample format.
4. `AnalyserNode` runs a real FFT in native browser code; we read 512 bins
   per frame.
5. The bins are uploaded as a 1D `R8` texture and sampled by the active
   fragment shader.

## Platform support

| Platform | Status      | Notes                                              |
| -------- | ----------- | -------------------------------------------------- |
| Linux    | Working     | Captures default PipeWire/PulseAudio sink monitor. |
| macOS    | Not yet     | Will need ScreenCaptureKit (`-f sck`) or BlackHole.|
| Windows  | Not yet     | Will need WASAPI loopback.                         |

Add new platforms in `server/platform.ts`.

## Adding a shader

1. Drop `your-shader.frag` into `shaders/`.
2. Define `void main()`. The following uniforms and helpers are available
   automatically (see `shaders/common.glsl`):

   ```glsl
   uniform float u_time;        // seconds since start
   uniform vec2  u_resolution;  // canvas size in pixels
   uniform sampler2D u_fft;     // 1D R8 texture, 512 bins (0=bass, 1=treble)
   uniform float u_bass;        // 0..1 (bins 0–7,    ~0–375 Hz)
   uniform float u_mid;         // 0..1 (bins 8–63,   ~375 Hz–3 kHz)
   uniform float u_treble;      // 0..1 (bins 64–511, ~3 kHz–12 kHz)
   uniform float u_volume;      // 0..1 (mean of all bins)

   in  vec2 v_uv;       // [0,1] screen UV
   out vec4 outColor;

   float sampleFFT(float t);                    // sample texture at freq t
   vec3  palette(float t, vec3 a, vec3 b, vec3 c, vec3 d);   // IQ palette
   float fbm(vec2 p);                           // 4-octave value noise
   mat2  rot2d(float a);
   float smin(float a, float b, float k);
   ```

3. Add the shader name to the `SHADERS` array in `client/main.ts`.

## Layout

```
curdle/
├── run.sh                  Entry point
├── server/
│   ├── index.ts            Bun.serve + WebSocket + on-the-fly TS transpile
│   ├── audio.ts            ffmpeg subprocess + PCM broadcast
│   └── platform.ts         OS-specific ffmpeg capture flags
├── client/
│   ├── index.html
│   ├── styles.css
│   ├── main.ts             WebGL2 + analyser + render loop
│   ├── shader-loader.ts    Compiles fragment shaders against common.glsl
│   └── audio-worklet.js    PCM → Float32 ring buffer → Web Audio
└── shaders/
    ├── common.glsl         Shared header (uniforms, helpers)
    └── liquid-metal.frag   First shader
```
