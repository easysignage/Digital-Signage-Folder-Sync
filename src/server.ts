import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { config, requirePlaylist } from "./config.ts";
import { log, sse } from "./log.ts";
import { reset, state, sync } from "./sync.ts";
import { watch } from "./watcher.ts";

requirePlaylist();
await mkdir(config.watchDir, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
// Thumbnails for the file list.
app.use("/content", express.static(config.watchDir, { dotfiles: "ignore" }));

app.get("/api/state", (_req, res) => res.json(state));
app.get("/api/events", sse(() => state));

app.post("/api/sync", async (_req, res) => {
  await sync({ publish: true });
  res.json(state);
});

app.post("/api/reset", async (_req, res) => {
  try {
    await reset();
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Opens the watched folder in Finder / Explorer, to drag files into on camera.
app.post("/api/open-folder", (_req, res) => {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [config.watchDir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  res.json({ ok: true });
});

// Local only: the server holds the API key, so it is not exposed to the network.
app.listen(config.port, "127.0.0.1", () => {
  log("info", `Folder sync demo on http://localhost:${config.port}`);
  log("info", `Watching ${config.watchDir} → playlist ${config.playlistId}.`);
});

watch(config.watchDir);
// Catch up on anything that changed while the app was not running.
void sync();
