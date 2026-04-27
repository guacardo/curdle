// Loads and compiles fragment shaders. Each shader file defines `void main()`.
// We prepend a header (common.glsl + version + uniform declarations) at compile time.

const VERTEX_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const HEADER_PRELUDE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform float u_time;
uniform vec2  u_resolution;
uniform sampler2D u_fft;
uniform sampler2D u_fftHistory;
uniform float u_fftHistoryHead;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_volume;
`;

export type ShaderProgram = {
  name: string;
  program: WebGLProgram;
  uniforms: {
    u_time: WebGLUniformLocation | null;
    u_resolution: WebGLUniformLocation | null;
    u_fft: WebGLUniformLocation | null;
    u_fftHistory: WebGLUniformLocation | null;
    u_fftHistoryHead: WebGLUniformLocation | null;
    u_bass: WebGLUniformLocation | null;
    u_mid: WebGLUniformLocation | null;
    u_treble: WebGLUniformLocation | null;
    u_volume: WebGLUniformLocation | null;
  };
};

let commonSrc: string | null = null;

async function getCommon(): Promise<string> {
  if (commonSrc !== null) return commonSrc;
  const res = await fetch("/shaders/common.glsl");
  commonSrc = await res.text();
  return commonSrc;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "(no log)";
    gl.deleteShader(sh);
    const numbered = src.split("\n").map((l, i) => `${(i + 1).toString().padStart(3)}: ${l}`).join("\n");
    throw new Error(`Shader compile error:\n${log}\n\n${numbered}`);
  }
  return sh;
}

export async function loadShader(gl: WebGL2RenderingContext, name: string): Promise<ShaderProgram> {
  const [common, body] = await Promise.all([
    getCommon(),
    fetch(`/shaders/${name}.frag`).then((r) => {
      if (!r.ok) throw new Error(`Failed to load shader: ${name}`);
      return r.text();
    }),
  ]);

  const fragSrc = `${HEADER_PRELUDE}\n${common}\n${body}`;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);

  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "(no log)";
    throw new Error(`Program link error: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  return {
    name,
    program,
    uniforms: {
      u_time: gl.getUniformLocation(program, "u_time"),
      u_resolution: gl.getUniformLocation(program, "u_resolution"),
      u_fft: gl.getUniformLocation(program, "u_fft"),
      u_fftHistory: gl.getUniformLocation(program, "u_fftHistory"),
      u_fftHistoryHead: gl.getUniformLocation(program, "u_fftHistoryHead"),
      u_bass: gl.getUniformLocation(program, "u_bass"),
      u_mid: gl.getUniformLocation(program, "u_mid"),
      u_treble: gl.getUniformLocation(program, "u_treble"),
      u_volume: gl.getUniformLocation(program, "u_volume"),
    },
  };
}
