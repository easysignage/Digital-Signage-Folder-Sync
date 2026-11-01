// Removes everything the app uploaded from the playlist and publishes, so every take starts empty.
// Files in the folder are not touched.
import { reset } from "../src/sync.ts";

await reset();
