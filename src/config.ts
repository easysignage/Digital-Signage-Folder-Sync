// Settings come from .env (see .env.example). Missing or bad values stop the app at startup
// rather than surfacing later as confusing API errors.
import { resolve } from "node:path";

export const ENV_FILE = resolve(".env");

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // No .env file: rely on the real environment.
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive number, got "${raw}".`);
  return value;
}

const deleteMode = process.env.DELETE_MODE?.trim() || "delete";
if (deleteMode !== "delete" && deleteMode !== "unassign") {
  throw new Error(`DELETE_MODE must be "delete" or "unassign", got "${deleteMode}".`);
}

export const config = {
  apiKey: required("EASYSIGNAGE_API_KEY"),
  baseURL: process.env.EASYSIGNAGE_BASE_URL?.trim() || undefined,
  /** Empty until `npm run setup` has created the playlist. */
  playlistId: process.env.PLAYLIST_ID?.trim() ?? "",
  // Display tags are stored lower-cased by the API, so address them that way.
  screenTag: (process.env.SCREEN_TAG?.trim() || "automation").toLowerCase(),
  watchDir: resolve(process.env.WATCH_DIR?.trim() || "./content"),
  defaultDuration: number("DEFAULT_DURATION", 10),
  debounceMs: number("DEBOUNCE_MS", 3000),
  deleteMode: deleteMode as "delete" | "unassign",
  port: number("PORT", 3001),
  /** Tag put on every media item this app uploads, so it only ever touches its own items. */
  ownTag: "folder-sync",
};

export function requirePlaylist(): string {
  if (!config.playlistId) throw new Error("PLAYLIST_ID is not set. Run `npm run setup` first.");
  return config.playlistId;
}
