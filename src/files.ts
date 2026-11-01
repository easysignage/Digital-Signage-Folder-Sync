// Reading the watched folder: which files count, their play order, and a content hash for each.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const VIDEO = new Set(["mp4", "mov", "webm", "m4v"]);

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

export const isImage = (name: string) => IMAGE.has(ext(name));
export const isVideo = (name: string) => VIDEO.has(ext(name));

/**
 * Files the sync picks up: images and videos the API accepts. Hidden files, Office lock files and
 * half-finished downloads are skipped. SVG is left out because the API refuses it.
 */
export function isSupported(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$")) return false;
  return isImage(name) || isVideo(name);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural filename order: `2-x` before `10-x`, so `01-`, `02-`… prefixes set the play order. */
export const byName = (a: string, b: string) => collator.compare(a, b);

export interface LocalFile {
  name: string;
  hash: string;
  size: number;
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** The supported files at the top level of `dir`, in play order. */
export async function scan(dir: string): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isSupported(entry.name)) continue;
    const path = join(dir, entry.name);
    try {
      const { size } = await stat(path);
      files.push({ name: entry.name, size, hash: await hashFile(path) });
    } catch {
      // Removed or locked while scanning: the watcher will report it again.
    }
  }
  return files.sort((a, b) => byName(a.name, b.name));
}
