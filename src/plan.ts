// Works out what to change in the playlist so it matches the folder. No API calls here, so the
// rules can be tested on their own (see test/plan.test.ts).
import { byName, type LocalFile } from "./files.ts";

export interface Entry {
  mediaId: string;
  hash: string;
  size: number;
}

/** What this app has uploaded: file name → media item. Saved in .sync-state.json. */
export type Manifest = Record<string, Entry>;

export type Step =
  /** The media item was removed outside the app (e.g. in the CMS): stop tracking it. */
  | { kind: "forget"; name: string; mediaId: string }
  /** Same content under a new name: keep the media item, no upload. */
  | { kind: "rename"; from: string; to: string; mediaId: string }
  | { kind: "upload"; name: string }
  /** The file's content changed: upload the new version, then remove the old item. */
  | { kind: "replace"; name: string; oldMediaId: string }
  | { kind: "remove"; name: string; mediaId: string };

/**
 * @param local   the files in the folder now
 * @param manifest what the app uploaded last time
 * @param missing media ids from the manifest that no longer exist on the account
 */
export function plan(local: LocalFile[], manifest: Manifest, missing: Set<string> = new Set()): Step[] {
  const steps: Step[] = [];
  const tracked = new Map<string, Entry>();
  for (const [name, entry] of Object.entries(manifest)) {
    if (missing.has(entry.mediaId)) steps.push({ kind: "forget", name, mediaId: entry.mediaId });
    else tracked.set(name, entry);
  }

  const localNames = new Set(local.map((f) => f.name));
  const gone = [...tracked.keys()].filter((name) => !localNames.has(name));

  const changes: Step[] = [];
  for (const file of local) {
    const entry = tracked.get(file.name);
    if (entry) {
      if (entry.hash !== file.hash) changes.push({ kind: "replace", name: file.name, oldMediaId: entry.mediaId });
      continue;
    }
    // A new name whose content matches a file that just disappeared is a rename.
    const renamedFrom = gone.find((name) => tracked.get(name)!.hash === file.hash);
    if (renamedFrom) {
      gone.splice(gone.indexOf(renamedFrom), 1);
      steps.push({ kind: "rename", from: renamedFrom, to: file.name, mediaId: tracked.get(renamedFrom)!.mediaId });
    } else {
      changes.push({ kind: "upload", name: file.name });
    }
  }

  // New content goes up before old content comes down, so the screen is never left empty.
  steps.push(...changes);
  for (const name of gone.sort(byName)) steps.push({ kind: "remove", name, mediaId: tracked.get(name)!.mediaId });
  return steps;
}

/** Sort positions for the tracked items, in filename order. */
export function playOrder(manifest: Manifest): { id: string; sort: number }[] {
  return Object.keys(manifest)
    .sort(byName)
    .map((name, i) => ({ id: manifest[name].mediaId, sort: i + 1 }));
}
