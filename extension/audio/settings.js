export const DEFAULT_AUDIO_SETTINGS = { rangeDb: 6, attackMs: 100, holdMs: 500, releaseMs: 1500 };

export function validateAudioSettings(settings) {
  for (const [key, min, max, label] of [
    ['rangeDb', 3, 12, 'Перепад, дБ'],
    ['attackMs', 5, 2000, 'Attack, мс'],
    ['holdMs', 0, 10000, 'Hold, мс'],
    ['releaseMs', 50, 10000, 'Release, мс']
  ]) {
    if (!Number.isFinite(settings[key]) || settings[key] < min || settings[key] > max) throw new RangeError(`${label}: укажи число от ${min} до ${max}.`);
  }
}
