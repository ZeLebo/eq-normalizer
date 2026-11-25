import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Leveler } from '../extension/audio/dsp.js';
import { DEFAULT_AUDIO_SETTINGS } from '../extension/audio/settings.js';

function render(leveler, db, seconds = 2, channels = 2) {
  let energy = 0, count = 0, peak = 0;
  const amplitude = Math.SQRT2 * 10 ** (db / 20);
  for (let frame = 0; frame < leveler.sampleRate * seconds; frame += 128) {
    const input = Array.from({ length: channels }, () => Float32Array.from({ length: 128 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * (frame + i) / leveler.sampleRate)));
    const output = input.map(() => new Float32Array(128));
    leveler.process(input, output);
    for (const sample of output[0]) {
      peak = Math.max(peak, Math.abs(sample));
      if (frame > leveler.sampleRate * (seconds - 0.5)) { energy += sample ** 2; count++; }
    }
  }
  return { db: 10 * Math.log10(energy / count), peak };
}

test('36 dB between settled scenes becomes approximately 6 dB at the default setting', () => {
  const quiet = render(new Leveler(48000), -42, 12);
  const loud = render(new Leveler(48000), -6, 12);
  assert.ok(Math.abs((loud.db - quiet.db) - 6) < 0.5, JSON.stringify({ quiet, loud }));
  assert.ok(quiet.db > -26);
});

test('range control changes compression, at 44.1 and 48 kHz', () => {
  for (const rate of [44100, 48000]) {
    for (const range of [3, 12]) {
      const quiet = render(new Leveler(rate, { ...DEFAULT_AUDIO_SETTINGS, rangeDb: range }), -36, 12);
      const loud = render(new Leveler(rate, { ...DEFAULT_AUDIO_SETTINGS, rangeDb: range }), -6, 12);
      assert.ok(Math.abs(loud.db - quiet.db - 30 / (36 / range)) < 0.6);
    }
  }
});

test('silence stays silent; low room noise does not get makeup gain', () => {
  const leveler = new Leveler(48000);
  const output = [new Float32Array(128)];
  leveler.process([new Float32Array(128)], output);
  assert.ok(output[0].every(sample => sample === 0));
  const noise = render(new Leveler(48000), -70);
  assert.ok(Math.abs(noise.db + 70) < 0.1);
});

test('a short silence holds gain instead of abruptly resetting it', () => {
  for (const level of [-40, -6]) {
    const leveler = new Leveler(48000);
    render(leveler, level, 3);
    const before = leveler.gainDb;
    for (let sample = 0; sample < 48000 * 0.25; sample += 128) {
      leveler.process([new Float32Array(128)], [new Float32Array(128)]);
    }
    assert.equal(leveler.limiterGain, 1, 'reproduces without the peak limiter');
    assert.ok(Math.abs(leveler.gainDb - before) < 0.5, `gain fell from ${before} to ${leveler.gainDb}`);
  }
});

test('after hold, silence releases gain gradually without a boost spike', () => {
  const leveler = new Leveler(48000);
  render(leveler, -40, 12);
  const before = leveler.gainDb;
  render(leveler, -Infinity, 0.6);
  assert.ok(leveler.gainDb < before && leveler.gainDb > before - 2);
  const after = leveler.gainDb;
  render(leveler, -Infinity, 3);
  assert.ok(leveler.gainDb < after / 3);
});

test('attack and release settings independently slow attenuation and recovery', () => {
  const fast = new Leveler(48000, { ...DEFAULT_AUDIO_SETTINGS, attackMs: 5, holdMs: 0 });
  const slow = new Leveler(48000, { ...DEFAULT_AUDIO_SETTINGS, attackMs: 1000, holdMs: 0 });
  for (const leveler of [fast, slow]) { render(leveler, -40, 12); render(leveler, -6, 0.1); }
  assert.ok(slow.gainDb > fast.gainDb + 5);
  const quickRelease = new Leveler(48000, { ...DEFAULT_AUDIO_SETTINGS, releaseMs: 100, holdMs: 0 });
  const slowRelease = new Leveler(48000, { ...DEFAULT_AUDIO_SETTINGS, releaseMs: 3000, holdMs: 0 });
  for (const leveler of [quickRelease, slowRelease]) { render(leveler, -6, 3); render(leveler, -40, 0.5); }
  assert.ok(quickRelease.gainDb > slowRelease.gainDb + 5);
});

test('hold delays recovery after a loud scene', () => {
  const held = new Leveler(48000, { ...DEFAULT_AUDIO_SETTINGS, releaseMs: 100, holdMs: 1000 });
  const immediate = new Leveler(48000, { ...DEFAULT_AUDIO_SETTINGS, releaseMs: 100, holdMs: 0 });
  for (const leveler of [held, immediate]) { render(leveler, -6, 3); render(leveler, -40, 0.3); }
  assert.ok(immediate.gainDb > held.gainDb + 5);
});

test('live timing changes preserve current gain; invalid times are rejected', () => {
  const leveler = new Leveler(48000);
  render(leveler, -40, 2);
  const before = leveler.gainDb;
  leveler.configure({ ...DEFAULT_AUDIO_SETTINGS, attackMs: 250, holdMs: 1000, releaseMs: 3000 });
  assert.equal(leveler.gainDb, before);
  assert.throws(() => leveler.configure({ ...DEFAULT_AUDIO_SETTINGS, attackMs: 0 }), RangeError);
  assert.throws(() => leveler.configure({ ...DEFAULT_AUDIO_SETTINGS, releaseMs: NaN }), RangeError);
});

test('a sudden full-scale transient after a quiet scene stays below the -1 dBFS ceiling', () => {
  const leveler = new Leveler(48000);
  render(leveler, -42, 2);
  const input = [new Float32Array(128), new Float32Array(128)];
  input[0][0] = 1;
  input[1][0] = -1;
  let peak = 0;
  for (let i = 0; i < 10; i++) {
    const output = input.map(() => new Float32Array(128));
    leveler.process(input, output);
    for (const channel of output) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
    input.forEach(channel => channel.fill(0));
  }
  assert.ok(peak > 0.1);
  assert.ok(peak <= 10 ** (-1 / 20) + 1e-6, peak);
});

test('stereo gain stays linked and channel changes produce finite samples', () => {
  const leveler = new Leveler(48000);
  for (let block = 0; block < 10; block++) {
    const left = Float32Array.from({length: 128}, (_, i) => 0.2 * Math.sin((block * 128 + i) / 10));
    const right = Float32Array.from(left, value => -value / 2);
    const output = [new Float32Array(128), new Float32Array(128)];
    leveler.process([left, right], output);
    for (let i = 0; i < 128; i++) assert.ok(Math.abs(output[0][i] + 2 * output[1][i]) < 1e-6);
  }
  const output = [new Float32Array(128)];
  leveler.process([], output);
  assert.ok(output[0].every(Number.isFinite));
});
