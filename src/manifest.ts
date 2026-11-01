// .sync-state.json: which media item each file became. Written after every step, so a crash or
// restart never forgets an upload that already happened.
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Manifest } from "./plan.ts";

const FILE = resolve(".sync-state.json");

interface Saved {
  playlistId: string;
  files: Manifest;
}

/** The manifest for this playlist. A manifest written for a different playlist is ignored. */
export async function load(playlistId: string): Promise<Manifest> {
  try {
    const saved = JSON.parse(await readFile(FILE, "utf8")) as Saved;
    return saved.playlistId === playlistId ? saved.files ?? {} : {};
  } catch {
    return {};
  }
}

export async function save(playlistId: string, files: Manifest): Promise<void> {
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ playlistId, files } satisfies Saved, null, 2));
  await rename(tmp, FILE);
}
