import { Leveler } from './dsp.js';

class LevelerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.leveler = new Leveler(sampleRate);
    this.samples = 0;
    this.port.onmessage = event => this.leveler.configure(JSON.parse(event.data));
  }

  process(inputs, outputs) {
    this.leveler.process(inputs[0], outputs[0]);
    this.samples += outputs[0][0]?.length ?? 0;
    if (this.samples >= sampleRate / 5) {
      this.port.postMessage(this.leveler.meter());
      this.samples = 0;
    }
    return true;
  }
}
registerProcessor('night-leveler', LevelerProcessor);
