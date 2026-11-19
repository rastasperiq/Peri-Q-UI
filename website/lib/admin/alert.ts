"use client";
// New-order alert: a short generated tone (no audio files), remembered per device.

const SOUND_KEY = "periq_admin_sound_v1";

export function readSoundPreference(): boolean {
  try { return localStorage.getItem(SOUND_KEY) === "on"; } catch { return false; }
}

export function writeSoundPreference(on: boolean) {
  try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch { /* private mode: not remembered */ }
}

type AudioCtor = typeof AudioContext;
let context: AudioContext | null = null;

/** Must be called from a click first: browsers only allow sound after a user gesture. */
export async function unlockSound(): Promise<boolean> {
  const Ctor = (globalThis as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }).AudioContext
    ?? (globalThis as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return false;
  try {
    context ??= new Ctor();
    if (context.state === "suspended") await context.resume();
    return context.state === "running";
  } catch {
    return false;
  }
}

/** Three rising beeps, about one second. */
export function playOrderTone(): boolean {
  if (!context || context.state !== "running") return false;
  const start = context.currentTime;
  [660, 880, 1100].forEach((frequency, index) => {
    const osc = context!.createOscillator();
    const gain = context!.createGain();
    const at = start + index * 0.3;
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.4, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
    osc.connect(gain).connect(context!.destination);
    osc.start(at);
    osc.stop(at + 0.26);
  });
  return true;
}

type WakeLockLike = { release: () => Promise<void> };

/** Keeps the screen on while the orders page is open, where supported. */
export async function keepScreenAwake(): Promise<WakeLockLike | null> {
  const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockLike> } }).wakeLock;
  if (!wakeLock) return null;
  try { return await wakeLock.request("screen"); } catch { return null; }
}
