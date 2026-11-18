// worker_threads host for @ffmpeg/core, mirroring @ffmpeg/ffmpeg's worker protocol.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";

globalThis.self ??= globalThis; // the UMD build of the core refers to `self`
globalThis.location ??= { href: import.meta.url };
const require = createRequire(import.meta.url);
let core;

parentPort.on("message", async ({ id, type, args }) => {
  try {
    let data;
    switch (type) {
      case "load": {
        const wasmBinary = readFileSync(require.resolve("@ffmpeg/core/wasm"));
        core = await require("@ffmpeg/core")({ wasmBinary });
        core.setLogger(() => {});
        core.setProgress(({ progress }) => parentPort.postMessage({ progress }));
        break;
      }
      case "write":
        core.FS.writeFile(args.path, args.data);
        break;
      case "read":
        data = core.FS.readFile(args.path);
        break;
      case "delete":
        core.FS.unlink(args.path);
        break;
      case "exec":
        core.setTimeout(-1);
        core.exec(...args.args);
        data = core.ret;
        core.reset();
        break;
    }
    parentPort.postMessage({ id, data });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message ?? e) });
  }
});
