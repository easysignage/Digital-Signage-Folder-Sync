// Watches the top level of the folder. `awaitWriteFinish` holds an event until the file has stopped
// growing, so a large video is not uploaded while it is still being copied in.
import { basename } from "node:path";
import chokidar from "chokidar";
import { isSupported } from "./files.ts";
import { changed } from "./sync.ts";

export function watch(dir: string) {
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true, // the startup sync covers what is already there
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    ignored: (path, stats) => Boolean(stats?.isFile()) && !isSupported(basename(path)),
  });
  watcher
    .on("add", (path) => changed(basename(path), "added"))
    .on("change", (path) => changed(basename(path), "changed"))
    .on("unlink", (path) => changed(basename(path), "removed"));
  return watcher;
}
