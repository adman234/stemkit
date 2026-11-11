import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StemEngine } from '../src/renderer/src/lib/engine.ts'

class Param {
  value = 0
  setTargetAtTime(value) { this.value = value }
}
class AudioNode {
  outputs = []
  connect(node) { this.outputs.push(node) }
  disconnect() { this.outputs = [] }
}
class Context {
  static last
  currentTime = 1
  destination = new AudioNode()
  sources = []
  constructor() { Context.last = this }
  createGain() { return Object.assign(new AudioNode(), { gain: new Param() }) }
  createStereoPanner() { return Object.assign(new AudioNode(), { pan: new Param() }) }
  createBufferSource() {
    const node = Object.assign(new AudioNode(), { playbackRate: new Param(), start() {}, stop() {} })
    this.sources.push(node)
    return node
  }
  async resume() {}
}
globalThis.AudioContext = Context
const buffers = { vocals: { duration: 10 }, drums: { duration: 10 } }
const nodes = (source) => {
  const gain = source.outputs[0]
  const pan = gain.outputs[0]
  return { gain, pan, master: pan.outputs[0] }
}

test('saved mix applies on first playback and pan stays independent of mute/solo', () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.applyMix({ vocals: 0.4, drums: 0.8 }, new Set(), new Set(['vocals']), 0.6, { vocals: -1, drums: 1 })
  engine.setPlaying(true, 0)
  const [voice, drums] = Context.last.sources.map(nodes)
  assert.equal(voice.pan.pan.value, -1)
  assert.equal(drums.pan.pan.value, 1)
  assert.equal(voice.gain.gain.value, 0.4)
  assert.equal(drums.gain.gain.value, 0)
  assert.equal(voice.master.gain.value, 0.6)
  engine.applyMix({ vocals: 0.4, drums: 0.8 }, new Set(['vocals']), new Set(), 0.6, { vocals: 0, drums: 1 })
  assert.equal(voice.pan.pan.value, 0)
  assert.equal(drums.pan.pan.value, 1)
  assert.equal(voice.gain.gain.value, 0)
  assert.equal(drums.gain.gain.value, 0.8)
})

test('seeking and resume preserve pan; switching songs disconnects and resets it', () => {
  const engine = new StemEngine()
  engine.setBuffers(buffers)
  engine.applyMix({}, new Set(), new Set(), 0.9, { vocals: 0.55 })
  engine.setPlaying(true, 0)
  const original = nodes(Context.last.sources[0])
  engine.align(4)
  assert.equal(nodes(Context.last.sources[2]).pan, original.pan)
  engine.setPlaying(false, 4)
  engine.setPlaying(true, 4)
  assert.equal(nodes(Context.last.sources[4]).pan.pan.value, 0.55)
  engine.setBuffers(buffers)
  assert.deepEqual(original.pan.outputs, [])
  engine.setPlaying(true, 0)
  assert.equal(nodes(Context.last.sources[6]).pan.pan.value, 0)
})
