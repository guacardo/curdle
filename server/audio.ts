import { getCaptureArgs } from "./platform";

type Subscriber = (chunk: Uint8Array) => void;

const subscribers = new Set<Subscriber>();
let proc: ReturnType<typeof Bun.spawn> | null = null;

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export async function start(): Promise<void> {
  if (proc) return;

  const args = await getCaptureArgs();
  console.log(`[audio] ffmpeg ${args.join(" ")}`);

  proc = Bun.spawn(["ffmpeg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc!.stderr as ReadableStream<Uint8Array>) {
      const msg = decoder.decode(chunk).trim();
      if (msg) console.error(`[ffmpeg] ${msg}`);
    }
  })();

  (async () => {
    for await (const chunk of proc!.stdout as ReadableStream<Uint8Array>) {
      for (const fn of subscribers) {
        try {
          fn(chunk);
        } catch (err) {
          console.error("[audio] subscriber error:", err);
        }
      }
    }
  })();

  proc.exited.then((code) => {
    console.log(`[audio] ffmpeg exited with code ${code}`);
    proc = null;
  });
}

export function stop(): void {
  if (proc) {
    proc.kill();
    proc = null;
  }
}
