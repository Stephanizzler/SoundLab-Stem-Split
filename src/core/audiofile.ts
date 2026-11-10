// Reading and writing uncompressed audio at its own sample rate and bit depth.
// WAV (PCM 8–32 bit, float 32/64, WAVE_FORMAT_EXTENSIBLE) and AIFF/AIFF-C are
// decoded here; compressed formats (FLAC, MP3, AAC, Ogg) are decoded by the
// browser, at the rate sniffRate() finds so nothing is resampled.

export type Encoding = "pcm" | "float";
export type DecodedAudio = {
  sampleRate: number;
  channels: Float32Array[];
  bitDepth: number | null; // null when the browser decoded a compressed file
  encoding: Encoding | "compressed";
  container: "wav" | "aiff" | "other";
};

const fourcc = (v: DataView, at: number) => String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

export function isWav(b: Uint8Array) {
  if (b.length < 12) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return fourcc(v, 0) === "RIFF" && fourcc(v, 8) === "WAVE";
}
export function isAiff(b: Uint8Array) {
  if (b.length < 12) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return fourcc(v, 0) === "FORM" && (fourcc(v, 8) === "AIFF" || fourcc(v, 8) === "AIFC");
}

function readSamples(v: DataView, at: number, frames: number, channels: number, bits: number, encoding: Encoding, little: boolean) {
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const bytes = bits / 8;
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < channels; c++) {
      const p = at + (f * channels + c) * bytes;
      let x: number;
      if (encoding === "float") x = bits === 32 ? v.getFloat32(p, little) : v.getFloat64(p, little);
      else if (bits === 8) x = little ? (v.getUint8(p) - 128) / 128 : v.getInt8(p) / 128; // WAV 8-bit is unsigned; AIFF is signed
      else if (bits === 16) x = v.getInt16(p, little) / 32768;
      else if (bits === 24) {
        const b0 = v.getUint8(p), b1 = v.getUint8(p + 1), b2 = v.getUint8(p + 2);
        let n = little ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        if (n & 0x800000) n -= 0x1000000;
        x = n / 8388608;
      } else x = v.getInt32(p, little) / 2147483648;
      out[c][f] = x;
    }
  return out;
}

export function decodeWav(b: Uint8Array): DecodedAudio {
  if (!isWav(b)) throw new Error("This is not a WAV file.");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let fmt: { format: number; channels: number; rate: number; bits: number; block: number } | undefined;
  let data: { at: number; size: number } | undefined;
  for (let p = 12; p + 8 <= b.length; ) {
    const id = fourcc(v, p), size = v.getUint32(p + 4, true), body = p + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("This WAV file's format chunk is damaged.");
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 40) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true), block: v.getUint16(body + 12, true) };
    } else if (id === "data") {
      data = { at: body, size: Math.min(size, b.length - body) }; // tolerate a truncated or streaming-written last chunk
    }
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("This WAV file has no audio.");
  const encoding: Encoding | undefined = fmt.format === 1 ? "pcm" : fmt.format === 3 ? "float" : undefined;
  if (!encoding) throw new Error("This WAV uses a compressed encoding. Save it as PCM or float WAV.");
  const okBits = encoding === "pcm" ? [8, 16, 24, 32] : [32, 64];
  if (!okBits.includes(fmt.bits)) throw new Error(`${fmt.bits}-bit ${encoding === "pcm" ? "PCM" : "float"} WAV is not supported.`);
  if (!(fmt.channels >= 1 && fmt.channels <= 64) || !(fmt.rate >= 8000 && fmt.rate <= 384000)) throw new Error("This WAV file's format is not valid.");
  if (fmt.block !== (fmt.bits / 8) * fmt.channels) throw new Error("This WAV file's format is not valid.");
  const frames = Math.floor(data.size / fmt.block);
  if (!frames) throw new Error("This WAV file is empty.");
  return { sampleRate: fmt.rate, channels: readSamples(v, data.at, frames, fmt.channels, fmt.bits, encoding, true), bitDepth: fmt.bits, encoding, container: "wav" };
}

// 80-bit IEEE extended, used by AIFF for the sample rate.
function extended(v: DataView, at: number) {
  const exp = v.getUint16(at) & 0x7fff, hi = v.getUint32(at + 2), lo = v.getUint32(at + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
}
export function decodeAiff(b: Uint8Array): DecodedAudio {
  if (!isAiff(b)) throw new Error("This is not an AIFF file.");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const aifc = fourcc(v, 8) === "AIFC";
  let comm: { channels: number; frames: number; bits: number; rate: number; codec: string } | undefined;
  let ssnd: { at: number; size: number } | undefined;
  for (let p = 12; p + 8 <= b.length; ) {
    const id = fourcc(v, p), size = v.getUint32(p + 4), body = p + 8;
    if (id === "COMM") comm = { channels: v.getUint16(body), frames: v.getUint32(body + 2), bits: v.getUint16(body + 6), rate: extended(v, body + 8), codec: aifc && size >= 22 ? fourcc(v, body + 18) : "NONE" };
    else if (id === "SSND") { const offset = v.getUint32(body); ssnd = { at: body + 8 + offset, size: Math.min(size - 8 - offset, b.length - body - 8 - offset) }; }
    p = body + size + (size & 1);
  }
  if (!comm || !ssnd) throw new Error("This AIFF file has no audio.");
  const codecs: Record<string, { encoding: Encoding; little: boolean; bits?: number }> = {
    NONE: { encoding: "pcm", little: false }, twos: { encoding: "pcm", little: false }, sowt: { encoding: "pcm", little: true },
    fl32: { encoding: "float", little: false, bits: 32 }, FL32: { encoding: "float", little: false, bits: 32 }, fl64: { encoding: "float", little: false, bits: 64 },
  };
  const c = codecs[comm.codec];
  if (!c) throw new Error(`AIFF-C with ${comm.codec} compression is not supported.`);
  const bits = c.bits ?? Math.ceil(comm.bits / 8) * 8;
  if (!(c.encoding === "pcm" ? [8, 16, 24, 32] : [32, 64]).includes(bits)) throw new Error(`${comm.bits}-bit AIFF is not supported.`);
  const rate = Math.round(comm.rate);
  if (!(comm.channels >= 1 && comm.channels <= 64) || !(rate >= 8000 && rate <= 384000)) throw new Error("This AIFF file's format is not valid.");
  const frames = Math.min(comm.frames, Math.floor(ssnd.size / ((bits / 8) * comm.channels)));
  if (!frames) throw new Error("This AIFF file is empty.");
  return { sampleRate: rate, channels: readSamples(v, ssnd.at, frames, comm.channels, bits, c.encoding, c.little), bitDepth: comm.bits, encoding: c.encoding, container: "aiff" };
}

export type WavFormat = { bitDepth: 16 | 24 | 32; encoding: Encoding }; // 32 with "float" = 32-bit float
export type EncodeResult = { bytes: Uint8Array; clippedSamples: number };

// Writes WAV. Integer formats clip at full scale (and say how often); 16-bit
// gets TPDF dither. A seed makes the dither, and so the file, repeatable.
export function encodeWav(channels: Float32Array[], sampleRate: number, f: WavFormat, seed = 1): EncodeResult {
  const n = channels[0]?.length ?? 0, ch = channels.length;
  if (!ch || ch > 64) throw new Error("Audio needs 1 to 64 channels.");
  if (f.encoding === "float" && f.bitDepth !== 32) throw new Error("Float WAV is written as 32-bit.");
  const bytes = f.bitDepth / 8, block = bytes * ch, dataSize = n * block;
  if (44 + dataSize > 0xffffffff) throw new Error("This file is too long for WAV (over 4 GB).");
  const out = new Uint8Array(44 + dataSize), v = new DataView(out.buffer);
  const w = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, f.encoding === "float" ? 3 : 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * block, true); v.setUint16(32, block, true); v.setUint16(34, f.bitDepth, true);
  w(36, "data"); v.setUint32(40, dataSize, true);
  let clipped = 0, state = seed >>> 0 || 1;
  const rand = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const full = 2 ** (f.bitDepth - 1), dither = f.encoding === "pcm" && f.bitDepth === 16;
  for (let i = 0, p = 44; i < n; i++)
    for (let c = 0; c < ch; c++, p += bytes) {
      const x = channels[c][i];
      if (f.encoding === "float") { v.setFloat32(p, x, true); continue; }
      let q = Math.round(x * full + (dither ? rand() - rand() : 0));
      if (q > full - 1) { q = full - 1; clipped++; } else if (q < -full) { q = -full; clipped++; }
      if (f.bitDepth === 16) v.setInt16(p, q, true);
      else if (f.bitDepth === 24) { v.setUint8(p, q & 255); v.setUint8(p + 1, (q >> 8) & 255); v.setUint8(p + 2, (q >> 16) & 255); }
      else v.setInt32(p, q, true);
    }
  return { bytes: out, clippedSamples: clipped };
}

// The sample rate of a compressed file, read from its header, so the browser can
// decode it at that rate instead of resampling. null when it cannot tell.
export function sniffRate(b: Uint8Array): number | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 26 && fourcc(v, 0) === "fLaC") {
    const at = 8 + 10; // STREAMINFO body: 20-bit sample rate after min/max block and frame sizes
    return (v.getUint8(at) << 12) | (v.getUint8(at + 1) << 4) | (v.getUint8(at + 2) >> 4) || null;
  }
  if (b.length >= 64 && fourcc(v, 0) === "OggS") {
    const head = new TextDecoder("latin1").decode(b.subarray(28, 64));
    if (head.startsWith("OpusHead")) return 48000; // Opus always decodes at 48 kHz
    if (head.startsWith("\x01vorbis")) return v.getUint32(28 + 12, true) || null;
    if (head.startsWith("\x7fFLAC")) return sniffRate(b.subarray(28 + 9));
    return null;
  }
  // MP3: skip an ID3v2 tag, then read the first frame header.
  let p = 0;
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) p = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]);
  for (const end = Math.min(b.length - 4, p + 65536); p < end; p++) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, index = (b[p + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || index === 3) continue;
    if (layer !== 1) return null; // ADTS AAC or MP1/MP2; let the browser decide
    return [44100, 48000, 32000][index] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  }
  return null;
}
