import test from "node:test";
import assert from "node:assert/strict";
import { decodeWav, encodeWav, decodeAiff, sniffRate } from "../src/core/audiofile.ts";
import { sine, maxDiff } from "./helpers.mjs";

test("WAV round-trips at every bit depth, keeping rate and depth", () => {
  const ch = [sine(96000, 0.1, 1000, 0.7), sine(96000, 0.1, 1500, -0.4)];
  for (const [bitDepth, encoding, tol] of [[16, "pcm", 2 / 32768], [24, "pcm", 1 / 8388608], [32, "pcm", 1e-9], [32, "float", 0]]) {
    const { bytes, clippedSamples } = encodeWav(ch, 96000, { bitDepth, encoding });
    assert.equal(clippedSamples, 0);
    const back = decodeWav(bytes);
    assert.equal(back.sampleRate, 96000); assert.equal(back.bitDepth, bitDepth); assert.equal(back.encoding, encoding);
    assert.equal(back.channels.length, 2);
    assert.ok(maxDiff(back.channels[0], ch[0]) <= tol + 1e-12, `${bitDepth} ${encoding}`);
  }
});

test("integer WAV counts clipped samples; float keeps overs", () => {
  const hot = [Float32Array.of(0.5, 1.2, -1.5, 0)];
  assert.equal(encodeWav(hot, 44100, { bitDepth: 24, encoding: "pcm" }).clippedSamples, 2);
  const f = decodeWav(encodeWav(hot, 44100, { bitDepth: 32, encoding: "float" }).bytes);
  assert.ok(Math.abs(f.channels[0][1] - 1.2) < 1e-6);
});

test("16-bit dither is repeatable with the same seed", () => {
  const ch = [sine(44100, 0.05, 440, 0.001)];
  const a = encodeWav(ch, 44100, { bitDepth: 16, encoding: "pcm" }, 7).bytes, b = encodeWav(ch, 44100, { bitDepth: 16, encoding: "pcm" }, 7).bytes;
  assert.deepEqual(a, b);
});

test("damaged or unsupported WAV files are refused with a reason", () => {
  assert.throws(() => decodeWav(new Uint8Array(4)), /not a WAV/);
  const ok = encodeWav([sine(44100, 0.01, 440)], 44100, { bitDepth: 16, encoding: "pcm" }).bytes;
  const mp3wav = ok.slice(); new DataView(mp3wav.buffer).setUint16(20, 0x55, true);
  assert.throws(() => decodeWav(mp3wav), /compressed/);
  assert.throws(() => decodeWav(ok.slice(0, 40)), /no audio/);
});

// Build a big-endian AIFF by hand.
function aiff(ch, rate, bits) {
  const frames = ch[0].length, bytes = bits / 8, data = frames * ch.length * bytes;
  const b = new Uint8Array(12 + 26 + 16 + data), v = new DataView(b.buffer);
  const w = (at, s) => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i); };
  w(0, "FORM"); v.setUint32(4, b.length - 8); w(8, "AIFF");
  w(12, "COMM"); v.setUint32(16, 18); v.setUint16(20, ch.length); v.setUint32(22, frames); v.setUint16(26, bits);
  // 80-bit extended sample rate
  const e = Math.floor(Math.log2(rate)); v.setUint16(28, 16383 + e); v.setUint32(30, (rate / 2 ** e) * 2 ** 31 >>> 0); v.setUint32(34, 0);
  w(38, "SSND"); v.setUint32(42, 8 + data); v.setUint32(46, 0); v.setUint32(50, 0);
  for (let f = 0, p = 54; f < frames; f++) for (const c of ch) { const q = Math.round(c[f] * 2 ** (bits - 1)); if (bits === 16) v.setInt16(p, q); else { v.setUint8(p, (q >> 16) & 255); v.setUint8(p + 1, (q >> 8) & 255); v.setUint8(p + 2, q & 255); } p += bytes; }
  return b;
}
test("AIFF is read at its own rate and depth", () => {
  const ch = [sine(48000, 0.02, 1000, 0.6), sine(48000, 0.02, 500, 0.3)];
  for (const bits of [16, 24]) {
    const a = decodeAiff(aiff(ch, 48000, bits));
    assert.equal(a.sampleRate, 48000); assert.equal(a.bitDepth, bits); assert.equal(a.container, "aiff");
    assert.ok(maxDiff(a.channels[1], ch[1]) < 2 / 2 ** (bits - 1));
  }
});

test("sample rates are read from compressed file headers", () => {
  const flac = new Uint8Array(42); flac.set([0x66, 0x4c, 0x61, 0x43], 0);
  // 96000 Hz as a 20-bit field starting at byte 18
  flac[18] = (96000 >> 12) & 255; flac[19] = (96000 >> 4) & 255; flac[20] = (96000 & 15) << 4;
  assert.equal(sniffRate(flac), 96000);
  const mp3 = new Uint8Array(100); mp3.set([0xff, 0xfb, 0x90 | (1 << 2), 0x00], 20); // MPEG-1 layer III, 48 kHz
  assert.equal(sniffRate(mp3), 48000);
  assert.equal(sniffRate(new Uint8Array(100)), null);
});
