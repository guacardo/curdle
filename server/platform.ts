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
    case "darwin": {
      const listing = await $`ffmpeg -hide_banner -f avfoundation -list_devices true -i ""`
        .nothrow().quiet();
      const audioSection = new TextDecoder().decode(listing.stderr)
        .split("AVFoundation audio devices:")[1] ?? "";
      const match = audioSection.match(/\[(\d+)\]\s+BlackHole/);
      if (!match) {
        throw new Error(
          "BlackHole audio device not found. Install BlackHole from " +
          "https://existential.audio/blackhole/, then in Audio MIDI Setup create " +
          "a Multi-Output Device that includes both your speakers and BlackHole, " +
          "and set it as your system output. First run will trigger a macOS " +
          "microphone-permission prompt for the terminal app — grant it."
        );
      }
      return [...base, "-f", "avfoundation", "-i", `:${match[1]}`, ...OUTPUT_ARGS];
    }
    case "win32":
      throw new Error(
        "Windows capture not yet implemented. Try: -f wasapi -i loopback (requires recent ffmpeg)."
      );
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
