import { getCaptureArgs, resolveDeviceId } from "./platform";

type Subscriber = (chunk: Uint8Array) => void;

const subscribers = new Set<Subscriber>();
let proc: ReturnType<typeof Bun.spawn> | null = null;
let currentDeviceId: string | null = null;

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getCurrentDeviceId(): string | null {
  return currentDeviceId;
}

export async function start(deviceId?: string | null): Promise<void> {
  if (proc) return;

  currentDeviceId = await resolveDeviceId(deviceId);
  const args = await getCaptureArgs(currentDeviceId);
  console.log(`[audio] ffmpeg ${args.join(" ")}`);

  proc = Bun.spawn(["ffmpeg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const launched = proc;

  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of launched.stderr as ReadableStream<Uint8Array>) {
      const msg = decoder.decode(chunk).trim();
      if (msg) console.error(`[ffmpeg] ${msg}`);
    }
  })();

  (async () => {
    for await (const chunk of launched.stdout as ReadableStream<Uint8Array>) {
      for (const fn of subscribers) {
        try {
          fn(chunk);
        } catch (err) {
          console.error("[audio] subscriber error:", err);
        }
      }
    }
  })();

  launched.exited.then((code) => {
    console.log(`[audio] ffmpeg exited with code ${code}`);
    if (proc === launched) proc = null;
  });
}

export async function stop(): Promise<void> {
  if (!proc) return;
  const old = proc;
  proc = null;
  old.kill();
  await old.exited;
}

export async function restart(deviceId: string | null): Promise<void> {
  await stop();
  await start(deviceId);
}
