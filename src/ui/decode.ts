// Opening audio at its own sample rate and bit depth (START_HERE rule 3).
import { decodeAiff, decodeWav, isAiff, isWav, sniffRate, type DecodedAudio } from "../core/audiofile.ts";

export type OpenedAudio = DecodedAudio & { note?: string };

export async function decodeAudio(bytes: Uint8Array): Promise<OpenedAudio> {
  if (isWav(bytes)) return decodeWav(bytes);
  if (isAiff(bytes)) return decodeAiff(bytes);
  // Compressed: the browser decodes it, at the file's own rate when the header says what that is.
  const sniffed = sniffRate(bytes);
  const rate = sniffed ?? 48000;
  const ctx = new OfflineAudioContext(1, 1, rate);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes.slice().buffer);
  } catch {
    throw new Error("This file could not be opened. Stem Split reads WAV, AIFF, FLAC, MP3, AAC/M4A and Ogg.");
  }
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
  return {
    sampleRate: rate, channels, bitDepth: null, encoding: "compressed", container: "other",
    note: sniffed ? undefined : "The file's own sample rate could not be read, so your browser converted it to 48 kHz.",
  };
}
