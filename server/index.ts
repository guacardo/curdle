import { subscribe, start } from "./audio";
import { SAMPLE_RATE, CHANNELS } from "./platform";

const PORT = Number(process.env.PORT ?? 8788);
const ROOT = new URL("../", import.meta.url).pathname;
const CLIENT_DIR = ROOT + "client/";
const SHADERS_DIR = ROOT + "shaders/";

type WSData = { unsub?: () => void };

const server = Bun.serve<WSData, undefined>({
  port: PORT,

  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/audio") {
      const ok = srv.upgrade<WSData>(req, { data: {} });
      if (ok) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/config") {
      return Response.json({ sampleRate: SAMPLE_RATE, channels: CHANNELS });
    }

    if (url.pathname === "/shaders.json") {
      const glob = new Bun.Glob("*.frag");
      const names: string[] = [];
      for (const file of glob.scanSync({ cwd: SHADERS_DIR })) {
        names.push(file.replace(/\.frag$/, ""));
      }
      names.sort();
      return Response.json(names);
    }

    let path = url.pathname === "/" ? "/index.html" : url.pathname;

    const absPath = path.startsWith("/shaders/")
      ? SHADERS_DIR + path.slice("/shaders/".length)
      : CLIENT_DIR + path.slice(1);

    return serveStatic(absPath);
  },

  websocket: {
    open(ws) {
      ws.binaryType = "uint8array";
      ws.data.unsub = subscribe((chunk) => {
        if (ws.readyState === 1) ws.send(chunk);
      });
    },
    close(ws) {
      ws.data.unsub?.();
    },
    message() {},
  },
});

async function serveStatic(absPath: string): Promise<Response> {
  const file = Bun.file(absPath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  if (absPath.endsWith(".ts")) {
    const src = await file.text();
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
    const js = transpiler.transformSync(src);
    return new Response(js, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  if (absPath.endsWith(".glsl") || absPath.endsWith(".frag") || absPath.endsWith(".vert")) {
    return new Response(file, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return new Response(file);
}

await start();

console.log(`\n  curdle\n  → http://localhost:${PORT}\n`);
