import test from "node:test";
import assert from "node:assert/strict";
import { arrange, checkRange, withContext, slice, place, only } from "../src/core/arrange.ts";

const f = (...v) => Float32Array.from(v);
const stems = [
  { source: "drums", channels: [f(1, 2), f(3, 4)] },
  { source: "vocals", channels: [f(10, 20), f(30, 40)] },
  { source: "bass", channels: [f(100, 200), f(300, 400)] },
];

test("vocals + instrumental: instrumental is every other stem summed", () => {
  const [v, inst] = arrange(stems, "vocals-instrumental");
  assert.equal(v.source, "vocals");
  assert.equal(inst.source, "instrumental");
  assert.deepEqual([...inst.channels[0]], [101, 202]);
  assert.deepEqual([...inst.channels[1]], [303, 404]);
  assert.equal(arrange(stems, "all"), stems);
  assert.throws(() => arrange([stems[0]], "vocals-instrumental"), /no vocal/);
});

test("a selection is split with context and put back where it was", () => {
  const length = 20, r = { start: 5, end: 10 };
  const from = withContext(r, length, 3);
  assert.deepEqual(from, { start: 2, end: 13 });
  assert.deepEqual(withContext({ start: 1, end: 19 }, length, 3), { start: 0, end: 20 }, "clamped to the song");
  const song = [Float32Array.from({ length }, (_, i) => i + 1)];
  const part = slice(song, from);
  assert.equal(part[0].length, 11);
  const back = place(part, from, r, length);
  assert.equal(back[0].length, length);
  assert.deepEqual([...back[0]].map((v, i) => (i >= 5 && i < 10 ? v === i + 1 : v === 0)), Array(length).fill(true), "same place, silence outside");
  assert.deepEqual([...only(song, r)[0]], [...back[0]]);
});

test("selections must be inside the song and at least a second long", () => {
  assert.throws(() => checkRange({ start: 0, end: 50 }, 100, 44100), /one second/);
  assert.throws(() => checkRange({ start: -1, end: 50 }, 100, 10), /outside/);
  assert.doesNotThrow(() => checkRange({ start: 0, end: 50 }, 100, 10));
});
