// Plays the mix, each stem and the remainder in sync, each through its own gain,
// so mute, solo, level and A/B switch instantly without re-rendering anything.
export type Track = { id: string; channels: Float32Array[]; sampleRate: number };

export class Player {
  private ctx: AudioContext | null = null;
  private tracks = new Map<string, { buffer: AudioBuffer; gain: GainNode; source?: AudioBufferSourceNode }>();
  private startedAt = 0;
  private offset = 0;
  private gains = new Map<string, number>();
  playing = false;
  duration = 0;
  onEnded?: () => void;

  private context() {
    this.ctx ??= new AudioContext({ latencyHint: "playback" });
    return this.ctx;
  }
  setTracks(list: Track[]) {
    this.stop();
    const ctx = this.context();
    for (const t of this.tracks.values()) t.gain.disconnect();
    this.tracks.clear();
    for (const t of list) {
      const buffer = ctx.createBuffer(t.channels.length, t.channels[0].length, t.sampleRate);
      t.channels.forEach((ch, c) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
      const gain = ctx.createGain();
      gain.gain.value = this.gains.get(t.id) ?? 0;
      gain.connect(ctx.destination);
      this.tracks.set(t.id, { buffer, gain });
      this.duration = Math.max(this.duration, buffer.duration);
    }
    this.offset = 0;
  }
  setGain(id: string, value: number) {
    this.gains.set(id, value);
    const t = this.tracks.get(id);
    if (t && this.ctx) t.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01); // short ramp, no clicks
  }
  get position() {
    if (!this.playing || !this.ctx) return this.offset;
    return Math.min(this.duration, this.offset + this.ctx.currentTime - this.startedAt);
  }
  async play(from = this.position) {
    const ctx = this.context();
    await ctx.resume();
    this.halt();
    this.offset = Math.max(0, Math.min(from, this.duration - 0.01));
    const when = ctx.currentTime + 0.05;
    let first = true;
    for (const t of this.tracks.values()) {
      const s = ctx.createBufferSource();
      s.buffer = t.buffer;
      s.connect(t.gain);
      s.start(when, this.offset);
      if (first) { s.onended = () => { if (this.playing && this.position >= this.duration - 0.1) { this.playing = false; this.offset = 0; this.onEnded?.(); } }; first = false; }
      t.source = s;
    }
    this.startedAt = when;
    this.playing = true;
  }
  pause() {
    this.offset = this.position;
    this.halt();
  }
  stop() {
    this.halt();
    this.offset = 0;
  }
  seek(to: number) {
    if (this.playing) void this.play(to);
    else this.offset = Math.max(0, Math.min(to, this.duration));
  }
  private halt() {
    for (const t of this.tracks.values()) {
      if (t.source) { t.source.onended = null; try { t.source.stop(); } catch { /* not started */ } t.source.disconnect(); t.source = undefined; }
    }
    this.playing = false;
  }
  close() {
    this.halt();
    void this.ctx?.close();
    this.ctx = null;
  }
}
