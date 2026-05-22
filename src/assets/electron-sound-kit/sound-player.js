// Minimal renderer-side helper for the reusable Electron sound kit.
// Copy this folder into your app (for example: src/assets/electron-sound-kit)
// and create one player per renderer process.

export async function createSoundPlayer(options = {}) {
  const {
    manifestUrl = new URL('./manifest.json', import.meta.url),
    baseUrl = manifestUrl,
    enabled = true,
    volume = 1,
  } = options;

  const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextImpl();
  const manifest = await fetch(manifestUrl).then((response) => response.json());
  const buffers = new Map();
  let isEnabled = enabled;
  let masterVolume = volume;

  function resolveAssetUrl(file) {
    return new URL(file, baseUrl).toString();
  }

  async function load(id) {
    if (buffers.has(id)) return buffers.get(id);
    const entry = manifest.sounds.find((sound) => sound.id === id);
    if (!entry) throw new Error(`Unknown sound: ${id}`);
    const arrayBuffer = await fetch(resolveAssetUrl(entry.file)).then((response) => response.arrayBuffer());
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    buffers.set(id, audioBuffer);
    return audioBuffer;
  }

  async function preload(ids = manifest.sounds.map((sound) => sound.id)) {
    await Promise.all(ids.map((id) => load(id)));
  }

  async function play(id, options = {}) {
    if (!isEnabled) return null;
    if (context.state === 'suspended') await context.resume();
    const entry = manifest.sounds.find((sound) => sound.id === id);
    const audioBuffer = await load(id);
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = audioBuffer;
    source.loop = Boolean(options.loop ?? entry?.loop);
    gain.gain.value = (options.volume ?? entry?.recommendedVolume ?? 0.65) * masterVolume;
    source.connect(gain).connect(context.destination);
    source.start();
    return source;
  }

  return {
    manifest,
    preload,
    play,
    setEnabled(value) { isEnabled = Boolean(value); },
    setVolume(value) { masterVolume = Math.max(0, Math.min(1, Number(value))); },
    get enabled() { return isEnabled; },
    get volume() { return masterVolume; },
  };
}
