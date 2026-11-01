import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupported } from "../src/files.ts";
import { plan, playOrder, type Manifest } from "../src/plan.ts";

const file = (name: string, hash = name) => ({ name, hash, size: 1 });
const entry = (mediaId: string, hash: string) => ({ mediaId, hash, size: 1 });

test("new files are uploaded", () => {
  assert.deepEqual(plan([file("a.png"), file("b.png")], {}), [
    { kind: "upload", name: "a.png" },
    { kind: "upload", name: "b.png" },
  ]);
});

test("nothing to do when folder and manifest match", () => {
  assert.deepEqual(plan([file("a.png")], { "a.png": entry("m1", "a.png") }), []);
});

test("changed content is replaced", () => {
  assert.deepEqual(plan([file("a.png", "new")], { "a.png": entry("m1", "old") }), [
    { kind: "replace", name: "a.png", oldMediaId: "m1" },
  ]);
});

test("removed files are removed after uploads", () => {
  const steps = plan([file("b.png")], { "a.png": entry("m1", "a") });
  assert.deepEqual(steps, [
    { kind: "upload", name: "b.png" },
    { kind: "remove", name: "a.png", mediaId: "m1" },
  ]);
});

test("same content under a new name is a rename, not an upload", () => {
  const steps = plan([file("00-x.png", "h")], { "03-x.png": entry("m1", "h") });
  assert.deepEqual(steps, [{ kind: "rename", from: "03-x.png", to: "00-x.png", mediaId: "m1" }]);
});

test("media deleted outside the app is forgotten and uploaded again", () => {
  const steps = plan([file("a.png", "h")], { "a.png": entry("m1", "h") }, new Set(["m1"]));
  assert.deepEqual(steps, [
    { kind: "forget", name: "a.png", mediaId: "m1" },
    { kind: "upload", name: "a.png" },
  ]);
});

test("play order follows natural filename order", () => {
  const manifest: Manifest = { "10-c.png": entry("c", ""), "2-b.png": entry("b", ""), "01-a.png": entry("a", "") };
  assert.deepEqual(playOrder(manifest), [
    { id: "a", sort: 1 },
    { id: "b", sort: 2 },
    { id: "c", sort: 3 },
  ]);
});

test("only images and videos are picked up", () => {
  for (const ok of ["a.png", "b.JPG", "c.webp", "d.mp4", "e.mov"]) assert.equal(isSupported(ok), true, ok);
  for (const no of [".DS_Store", "~$deck.pptx", "x.svg", "y.part", "z.crdownload", "notes.txt", ".hidden.png"]) {
    assert.equal(isSupported(no), false, no);
  }
});
