import type { Loudness } from "@soundlab/project";

export const time = (s: number) => {
  if (!Number.isFinite(s)) return "–:––";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
export const khz = (rate: number) => `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`;
export const mb = (bytes: number) => `${(bytes / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB`;
export const lufs = (l?: Loudness | null) => (l?.integratedLufs == null ? "silent" : `${l.integratedLufs.toFixed(1)} LUFS`);
export const dbtp = (l?: Loudness | null) => (l ? `${l.truePeakDbtp.toFixed(1)} dBTP` : "");
export const dbToGain = (db: number) => 10 ** (db / 20);
export const channelsName = (n: number) => (n === 1 ? "mono" : n === 2 ? "stereo" : `${n} channels`);
export function eta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}
