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

1. Drop `your-shader.frag` into `shaders/`. Define `void main()` and write
   to `outColor`. Don't redeclare `#version`, `precision`, or any uniforms —
   they're prepended automatically.
2. Refresh the browser. Shaders are auto-discovered from disk; the picker
   updates on reload.

The full contract — available uniforms, helpers, constraints, reserved-word
gotchas — lives in [`shaders/common.glsl`](shaders/common.glsl) and
[`.claude/agents/shader-builder.md`](.claude/agents/shader-builder.md).

The latter doubles as a Claude Code subagent definition: running Claude
Code from this directory lets you say "build me a shader that does X" and
it spawns a `shader-builder` agent that knows the contract. Multiple agents
can run in parallel since shaders are auto-discovered.

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
    └── *.frag              Individual shaders (auto-discovered at runtime)
```
