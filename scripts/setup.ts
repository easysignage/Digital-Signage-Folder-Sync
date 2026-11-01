// One-off account setup for the demo. Safe to run again: it reuses what already exists.
//
// 1. Uses PLAYLIST_ID, or finds/creates a playlist called "Folder sync demo" and writes its id to .env.
// 2. Assigns the playlist directly to every screen tagged SCREEN_TAG and publishes them. Assigning
//    directly (not through a group or channel) is what lets publishBySource find those screens.
import { readFile, writeFile } from "node:fs/promises";
import { call, client, codeOf } from "../src/easysignage.ts";
import { config, ENV_FILE } from "../src/config.ts";

const PLAYLIST_NAME = "Folder sync demo";

async function findPlaylist(): Promise<string | undefined> {
  for await (const p of client.playlists.iterate()) {
    if (p.name === PLAYLIST_NAME && typeof p.id === "string") return p.id;
  }
}

async function savePlaylistId(id: string): Promise<void> {
  const env = await readFile(ENV_FILE, "utf8").catch(() => "");
  const line = `PLAYLIST_ID=${id}`;
  const next = /^PLAYLIST_ID=.*$/m.test(env) ? env.replace(/^PLAYLIST_ID=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
  await writeFile(ENV_FILE, next);
  console.log(`Saved PLAYLIST_ID to ${ENV_FILE}.`);
}

let playlistId = config.playlistId || (await findPlaylist());
if (playlistId) {
  console.log(`Using playlist ${playlistId}.`);
} else {
  const { result } = await call(`playlists.create({ name: "${PLAYLIST_NAME}", type: "horizontal" })`, () =>
    // `type` is the orientation and the API requires it: "horizontal" (1920×1080) or "vertical".
    client.playlists.create({ name: PLAYLIST_NAME, type: "horizontal" }),
  );
  playlistId = result.id;
}
if (playlistId !== config.playlistId) await savePlaylistId(playlistId);

try {
  await call(`displays.pushContentByTag("${config.screenTag}")`, () =>
    client.displays.pushContentByTag(config.screenTag, { sourceID: playlistId, type: "playlist" }),
  );
  console.log(`\nPlaylist assigned to the screens tagged "${config.screenTag}".`);
} catch (err) {
  if (codeOf(err) !== "publish_no_players") throw err;
  console.log(`\nNo screens are tagged "${config.screenTag}" yet. Tag one in the CMS and run setup again.`);
}

console.log(`
Before recording, check:
  • The account is on a Premium or Enterprise plan (API keys).
  • The API key has media, playlists and displays permissions.
  • 1–2 screens (or browser players) are tagged "${config.screenTag}".
  • Start with "npm run dev", then drag files from samples/ into ${config.watchDir}.
`);
