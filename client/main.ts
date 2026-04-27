import { loadShader, type ShaderProgram } from "./shader-loader.ts";

const FFT_SIZE = 1024;
const FFT_BINS = FFT_SIZE / 2;
const HISTORY_LEN = 64;

const SAMPLE_RATE = 48000;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const pickerEl = document.getElementById("shader-picker") as HTMLSelectElement;
const welcomeEl = document.getElementById("welcome") as HTMLDivElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;

const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false });
if (!gl) throw new Error("WebGL2 not available");

function setStatus(state: "connecting" | "connected" | "error", text: string) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl!.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener("resize", resize);
resize();

const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 3, -1, -1, 3]),
  gl.STATIC_DRAW
);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const fftTex = gl.createTexture()!;
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, fftTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FFT_BINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(FFT_BINS));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const fftHistoryTex = gl.createTexture()!;
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, fftHistoryTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FFT_BINS, HISTORY_LEN, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(FFT_BINS * HISTORY_LEN));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

let current: ShaderProgram | null = null;
const fftBins = new Uint8Array(FFT_BINS);
let analyser: AnalyserNode | null = null;
let historyHead = 0;
const start = performance.now();

function bandAverage(from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += fftBins[i];
  return sum / ((to - from) * 255);
}

function frame() {
  if (analyser) {
    analyser.getByteFrequencyData(fftBins);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, fftTex);
    gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, FFT_BINS, 1, gl!.RED, gl!.UNSIGNED_BYTE, fftBins);

    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, fftHistoryTex);
    gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, historyHead, FFT_BINS, 1, gl!.RED, gl!.UNSIGNED_BYTE, fftBins);
    historyHead = (historyHead + 1) % HISTORY_LEN;
  }

  if (current) {
    gl!.useProgram(current.program);
    const t = (performance.now() - start) / 1000;
    const u = current.uniforms;
    if (u.u_time) gl!.uniform1f(u.u_time, t);
    if (u.u_resolution) gl!.uniform2f(u.u_resolution, canvas.width, canvas.height);
    if (u.u_fft) gl!.uniform1i(u.u_fft, 0);
    if (u.u_fftHistory) gl!.uniform1i(u.u_fftHistory, 1);
    if (u.u_fftHistoryHead) gl!.uniform1f(u.u_fftHistoryHead, historyHead / HISTORY_LEN);
    if (u.u_bass)   gl!.uniform1f(u.u_bass,   bandAverage(0, 8));
    if (u.u_mid)    gl!.uniform1f(u.u_mid,    bandAverage(8, 64));
    if (u.u_treble) gl!.uniform1f(u.u_treble, bandAverage(64, FFT_BINS));
    if (u.u_volume) gl!.uniform1f(u.u_volume, bandAverage(0, FFT_BINS));
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }
  requestAnimationFrame(frame);
}

async function switchShader(name: string) {
  try {
    current = await loadShader(gl!, name);
    console.log(`[curdle] loaded shader: ${name}`);
  } catch (err) {
    console.error(err);
    setStatus("error", "shader compile error (see console)");
  }
}

async function populatePicker(): Promise<string[]> {
  const res = await fetch("/shaders.json");
  const names: string[] = await res.json();
  pickerEl.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    pickerEl.appendChild(opt);
  }
  return names;
}
pickerEl.addEventListener("change", () => switchShader(pickerEl.value));

async function boot() {
  welcomeEl.hidden = true;
  setStatus("connecting", "starting audio…");

  const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule("/audio-worklet.js");
  const workletNode = new AudioWorkletNode(audioCtx, "curdle-pcm", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.75;

  // Path 1: into analyser (terminal — not connected to destination)
  workletNode.connect(analyser);

  // Path 2: muted gain → destination, keeps the graph alive without audible output
  const muted = audioCtx.createGain();
  muted.gain.value = 0;
  workletNode.connect(muted).connect(audioCtx.destination);

  setStatus("connecting", "connecting to server…");
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/audio`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setStatus("connected", "connected");
  ws.onerror = () => setStatus("error", "websocket error");
  ws.onclose = () => setStatus("error", "disconnected");
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      workletNode.port.postMessage(e.data, [e.data]);
    }
  };

  const names = await populatePicker();
  if (names.length === 0) {
    setStatus("error", "no shaders found in /shaders/");
    return;
  }
  pickerEl.value = names[0];
  await switchShader(names[0]);
  requestAnimationFrame(frame);
}

startBtn.addEventListener("click", boot);
welcomeEl.addEventListener("click", (e) => {
  if (e.target === welcomeEl) boot();
});
welcomeEl.hidden = false;
