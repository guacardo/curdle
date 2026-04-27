import { $ } from "bun";

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;

const OUTPUT_ARGS = [
  "-f", "s16le",
  "-acodec", "pcm_s16le",
  "-ac", String(CHANNELS),
  "-ar", String(SAMPLE_RATE),
  "pipe:1",
];

export async function getCaptureArgs(): Promise<string[]> {
  const base = ["-hide_banner", "-loglevel", "error"];

  switch (process.platform) {
    case "linux": {
      const sink = (await $`pactl get-default-sink`.text()).trim();
      if (!sink) {
        throw new Error(
          "Could not detect default audio sink via pactl. Is PipeWire/PulseAudio running?"
        );
      }
      return [...base, "-f", "pulse", "-i", `${sink}.monitor`, ...OUTPUT_ARGS];
    }
    case "darwin":
      throw new Error(
        "macOS capture not yet implemented. Install BlackHole (https://existential.audio/blackhole/), " +
        "route system audio to it, then add an avfoundation case here."
      );
    case "win32":
      throw new Error(
        "Windows capture not yet implemented. Try: -f wasapi -i loopback (requires recent ffmpeg)."
      );
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
