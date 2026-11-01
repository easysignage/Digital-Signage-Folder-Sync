// The sync engine. Folder changes are batched; each batch compares the folder with what was
// uploaded, applies the differences through the API, sets the play order and publishes once.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { NotFoundError } from "@easysignage/sdk";
import { call, client, codeOf, playlistMedia } from "./easysignage.ts";
import { config, requirePlaylist } from "./config.ts";
import { hashFile, isImage, scan, type LocalFile } from "./files.ts";
import { emitState, log } from "./log.ts";
import * as manifestFile from "./manifest.ts";
import { plan, playOrder, type Manifest, type Step } from "./plan.ts";

export type FileStatus = "queued" | "uploading" | "stored" | "published" | "error";

export interface State {
  folder: string;
  playlistId: string;
  syncing: boolean;
  /** When the pending batch will sync (ms since epoch), or null when nothing is waiting. */
  pendingUntil: number | null;
  files: { name: string; size: number; status: FileStatus; mediaId?: string; error?: string }[];
  lastPublish?: { time: string; outcome: string };
}

export const state: State = {
  folder: config.watchDir,
  playlistId: config.playlistId,
  syncing: false,
  pendingUntil: null,
  files: [],
};

const status = new Map<string, { status: FileStatus; error?: string }>();
let manifest: Manifest = {};

function setStatus(name: string, s: FileStatus, error?: string) {
  status.set(name, { status: s, error });
  const file = state.files.find((f) => f.name === name);
  if (file) Object.assign(file, { status: s, error, mediaId: manifest[name]?.mediaId });
  emitState(state);
}

function refreshFiles(local: LocalFile[]) {
  state.files = local.map((f) => {
    const s = status.get(f.name) ?? { status: manifest[f.name] ? "published" : "queued" };
    return { name: f.name, size: f.size, status: s.status, error: s.error, mediaId: manifest[f.name]?.mediaId };
  });
  emitState(state);
}

// --- batching -----------------------------------------------------------------------------

let timer: NodeJS.Timeout | undefined;
let running = false;
let again = false;

/** Called for every folder event. The batch syncs once the folder has been quiet for DEBOUNCE_MS. */
export function changed(name: string, event: string): void {
  log("info", `${event}: ${name}`);
  if (event !== "removed") setStatus(name, "queued");
  clearTimeout(timer);
  state.pendingUntil = Date.now() + config.debounceMs;
  emitState(state);
  timer = setTimeout(() => void sync(), config.debounceMs);
}

/** Runs one sync now. If one is already running, another runs straight after it. */
export async function sync(opts: { publish?: boolean } = {}): Promise<void> {
  clearTimeout(timer);
  state.pendingUntil = null;
  if (running) {
    again = true;
    return;
  }
  running = true;
  state.syncing = true;
  emitState(state);
  try {
    await syncOnce(opts.publish ?? false);
  } catch (err) {
    log("error", `Sync failed: ${codeOf(err) ?? (err as Error).message}`);
  } finally {
    running = false;
    state.syncing = false;
    emitState(state);
    if (again) {
      again = false;
      await sync();
    }
  }
}

// --- one sync -----------------------------------------------------------------------------

async function syncOnce(forcePublish: boolean): Promise<void> {
  const playlistId = requirePlaylist();
  manifest = await manifestFile.load(playlistId);
  const local = await scan(config.watchDir);
  refreshFiles(local);

  const steps = plan(local, manifest, await missingMedia(playlistId));
  if (steps.length === 0) {
    log("info", "Folder and playlist already match.");
    if (forcePublish) await publish(playlistId);
    return;
  }
  log("info", `Syncing: ${describe(steps)}.`);

  let applied = 0;
  for (const step of steps) {
    try {
      await apply(step, playlistId);
      applied++;
    } catch (err) {
      const name = step.kind === "rename" ? step.to : step.name;
      const reason = codeOf(err) ?? (err as Error).message;
      setStatus(name, "error", reason);
      log("error", `${name}: ${reason}. It will be retried on the next sync.`);
    } finally {
      await manifestFile.save(playlistId, manifest);
    }
  }

  if (applied > 0 || forcePublish) {
    const order = playOrder(manifest);
    if (order.length > 0) {
      await call(`playlists.reorder("${playlistId}", ${order.length} items)`, () =>
        client.playlists.reorder(playlistId, { items: order }),
      );
    }
    await publish(playlistId);
  }
  refreshFiles(await scan(config.watchDir));
}

/** Tracked media ids that no longer exist, e.g. deleted by hand in the CMS. */
async function missingMedia(playlistId: string): Promise<Set<string>> {
  const tracked = Object.values(manifest).map((e) => e.mediaId);
  if (tracked.length === 0) return new Set();

  const inPlaylist = new Set<string>();
  for await (const item of playlistMediaIds(playlistId)) inPlaylist.add(item);

  const missing = new Set<string>();
  for (const id of tracked) {
    if (inPlaylist.has(id)) continue;
    // Not listed in the playlist: confirm it is really gone before uploading it again.
    try {
      await client.media.get(id);
    } catch (err) {
      if (err instanceof NotFoundError) missing.add(id);
      else throw err;
    }
  }
  return missing;
}

async function* playlistMediaIds(playlistId: string) {
  for await (const item of playlistMedia(playlistId)) {
    const id = item.id ?? item._id;
    if (typeof id === "string") yield id;
  }
}

async function apply(step: Step, playlistId: string): Promise<void> {
  switch (step.kind) {
    case "forget":
      log("warn", `${step.name}: its media item was removed outside the app. Uploading it again.`);
      delete manifest[step.name];
      return;

    case "rename": {
      // Same content, so keep the item and just rename it; the reorder moves it.
      manifest[step.to] = manifest[step.from];
      delete manifest[step.from];
      status.delete(step.from);
      await call(`media.update("${step.mediaId}", { name: "${step.to}" })`, () =>
        client.media.update(step.mediaId, { name: step.to }),
      ).catch(() => log("warn", `${step.to}: could not rename the media item. Its play position is still updated.`));
      setStatus(step.to, "stored");
      return;
    }

    case "upload":
    case "replace": {
      setStatus(step.name, "uploading");
      const path = join(config.watchDir, step.name);
      // Hash before uploading: if the file changes mid-upload, the next sync sees a new hash.
      const [hash, { size }] = await Promise.all([hashFile(path), stat(path)]);
      const { result } = await call(`media.uploadFile("${step.name}")`, () =>
        client.media.uploadFile(path, {
          playlist: playlistId,
          tags: [config.ownTag],
          // Images need a display time; videos play for their own length.
          ...(isImage(step.name) ? { duration: config.defaultDuration } : {}),
        }),
      );
      manifest[step.name] = { mediaId: result.id, hash, size };
      setStatus(step.name, "stored");
      if (step.kind === "replace") await removeMedia(step.oldMediaId, playlistId, `old version of ${step.name}`);
      return;
    }

    case "remove":
      await removeMedia(step.mediaId, playlistId, step.name);
      delete manifest[step.name];
      status.delete(step.name);
      return;
  }
}

async function removeMedia(mediaId: string, playlistId: string, label: string): Promise<void> {
  try {
    if (config.deleteMode === "unassign") {
      await call(`playlists.unassignMedia("${playlistId}", "${mediaId}")`, () => client.playlists.unassignMedia(playlistId, mediaId));
    } else {
      await call(`media.delete("${mediaId}")`, () => client.media.delete(mediaId));
    }
  } catch (err) {
    // Already gone is the outcome we wanted.
    if (!(err instanceof NotFoundError)) throw err;
    log("info", `${label} was already removed.`);
  }
}

/** Publishes every screen whose content source is this playlist. */
async function publish(playlistId: string): Promise<void> {
  let outcome = "published";
  try {
    const { code } = await call(`displays.publishBySource("${playlistId}")`, () => client.displays.publishBySource(playlistId));
    if (code) outcome = code;
  } catch (err) {
    const code = codeOf(err);
    if (code !== "publish_no_players" && code !== "some_players_update_error") throw err;
    outcome = code;
  }
  if (outcome === "publish_no_players") {
    log("warn", "No screens are playing this playlist, so nothing was published. Run `npm run setup` or assign the playlist to a screen directly (not through a group or channel).");
  } else if (outcome === "some_players_update_error") {
    log("warn", "Some screens could not be updated. Check that they are online.");
  }
  state.lastPublish = { time: new Date().toISOString(), outcome };
  for (const name of Object.keys(manifest)) {
    if (status.get(name)?.status !== "error") status.set(name, { status: "published" });
  }
}

function describe(steps: Step[]): string {
  const count = (k: Step["kind"]) => steps.filter((s) => s.kind === k).length;
  const parts = [
    [count("upload"), "upload"],
    [count("replace"), "replace"],
    [count("rename"), "rename"],
    [count("remove"), "remove"],
    [count("forget"), "re-upload"],
  ] as const;
  return parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`).join(", ");
}

/** Removes everything the app uploaded and publishes the emptied playlist. Local files are left alone. */
export async function reset(): Promise<void> {
  const playlistId = requirePlaylist();
  manifest = await manifestFile.load(playlistId);
  const names = Object.keys(manifest);
  log("info", `Reset: removing ${names.length} item(s) this app uploaded.`);
  for (const name of names) {
    try {
      await removeMedia(manifest[name].mediaId, playlistId, name);
      delete manifest[name];
    } catch (err) {
      log("error", `${name}: ${codeOf(err) ?? (err as Error).message}`);
    }
    await manifestFile.save(playlistId, manifest);
  }
  status.clear();
  await publish(playlistId);
  state.files = state.files.map((f) => ({ ...f, status: "queued" as const, mediaId: undefined, error: undefined }));
  emitState(state);
  log("info", "Reset done. Files still in the folder upload again on the next change or Sync now.");
}
