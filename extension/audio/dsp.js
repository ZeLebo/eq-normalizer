import { DEFAULT_AUDIO_SETTINGS, validateAudioSettings } from './settings.js';

const dbToGain = db => 10 ** (db / 20);
const toDb = power => 10 * Math.log10(Math.max(power, 1e-12));

export class Leveler {
  constructor(sampleRate, settings = DEFAULT_AUDIO_SETTINGS) {
    this.sampleRate = sampleRate;
    this.holdRemaining = 0;
    this.silentSamples = 0;
    this.configure(settings);
    this.delay = Math.ceil(sampleRate * 0.005);
    this.rings = [];
    this.position = 0;
    this.frame = 0;
    this.energy = 0;
    this.gainDb = 0;
    this.limiterGain = 1;
    this.ceiling = dbToGain(-1);
    this.energyRate = Math.exp(-1 / (sampleRate * 0.02));
    this.floorPower = 10 ** (-55 / 10);
    this.limitRelease = Math.exp(-1 / (sampleRate * 0.06));
    this.peaks = new Float64Array(this.delay + 2);
    this.peakFrames = new Float64Array(this.delay + 2);
    this.head = 0;
    this.tail = 0;
    this.inputPower = 0;
    this.outputPower = 0;
    this.meterSamples = 0;
  }

  configure(settings) {
    validateAudioSettings(settings);
    this.ratio = 36 / settings.rangeDb;
    this.cutRate = Math.exp(-1 / (this.sampleRate * settings.attackMs / 1000));
    this.boostRate = Math.exp(-1 / (this.sampleRate * settings.releaseMs / 1000));
    this.holdSamples = Math.round(this.sampleRate * settings.holdMs / 1000);
    this.holdRemaining = Math.min(this.holdRemaining, this.holdSamples);
  }

  process(input, output) {
    const channels = input.length;
    const size = output[0]?.length ?? 0;
    for (let ch = this.rings.length; ch < channels; ch++) this.rings.push(new Float32Array(this.delay));
    const queueSize = this.peaks.length;
    for (let i = 0; i < size; i++) {
      let power = 0;
      for (let ch = 0; ch < channels; ch++) power += input[ch][i] ** 2;
      power /= Math.max(channels, 1);
      this.energy = this.energyRate * this.energy + (1 - this.energyRate) * power;
      const levelDb = toDb(this.energy);
      this.holdRemaining = Math.max(0, this.holdRemaining - 1);
      this.silentSamples = power < this.floorPower ? this.silentSamples + 1 : 0;
      // Freeze gain through a pause; the decaying RMS tail must not create a boost followed by a fast reset.
      if (this.silentSamples > 0) {
        if (this.silentSamples > this.holdSamples) this.gainDb *= this.boostRate;
      } else if (levelDb < -55) {
        this.gainDb *= this.boostRate;
      } else {
        const target = Math.max(-30, Math.min(24, -20 + (levelDb + 24) / this.ratio - levelDb));
        if (target < this.gainDb) {
          this.gainDb = this.cutRate * this.gainDb + (1 - this.cutRate) * target;
          this.holdRemaining = this.holdSamples;
        } else if (this.holdRemaining === 0) {
          this.gainDb = this.boostRate * this.gainDb + (1 - this.boostRate) * target;
        }
      }
      const gain = dbToGain(this.gainDb);
      let peak = 0;
      for (let ch = 0; ch < channels; ch++) peak = Math.max(peak, Math.abs(input[ch][i] * gain));

      while (this.head !== this.tail && this.peakFrames[this.head] < this.frame - this.delay) this.head = (this.head + 1) % queueSize;
      while (this.head !== this.tail) {
        const previous = (this.tail + queueSize - 1) % queueSize;
        if (this.peaks[previous] > peak) break;
        this.tail = previous;
      }
      this.peaks[this.tail] = peak;
      this.peakFrames[this.tail] = this.frame++;
      this.tail = (this.tail + 1) % queueSize;
      const limit = Math.min(1, this.ceiling / Math.max(this.peaks[this.head], 1e-12));
      this.limiterGain = limit < this.limiterGain ? limit : this.limitRelease * this.limiterGain + (1 - this.limitRelease) * limit;

      let outPower = 0;
      for (let ch = 0; ch < output.length; ch++) {
        const ring = this.rings[ch];
        const delayed = ring ? ring[this.position] : 0;
        if (ring) ring[this.position] = (input[ch]?.[i] ?? 0) * gain;
        const sample = Math.max(-this.ceiling, Math.min(this.ceiling, delayed * this.limiterGain));
        output[ch][i] = sample;
        outPower += sample ** 2;
      }
      this.position = (this.position + 1) % this.delay;
      this.inputPower += power;
      this.outputPower += outPower / Math.max(output.length, 1);
      this.meterSamples++;
    }
  }

  meter() {
    const result = {
      inputDb: toDb(this.inputPower / Math.max(1, this.meterSamples)),
      outputDb: toDb(this.outputPower / Math.max(1, this.meterSamples)),
      gainDb: this.gainDb + 20 * Math.log10(this.limiterGain)
    };
    this.inputPower = this.outputPower = this.meterSamples = 0;
    return result;
  }
}
