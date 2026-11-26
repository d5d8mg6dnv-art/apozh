// Проверка ядра звука без браузера: node tests/engine.test.mjs
import assert from 'node:assert/strict';
import {
  reverse, computeBoundaries, sliceByBoundaries,
  concatWithCrossfade, encodeWav, SAMPLE_RATE,
} from '../js/audio-engine.js';

const SR = SAMPLE_RATE;
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// синтетический сигнал: 10 с, тон с паузами
function makeSignal(seconds, freq = 440) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // паузы около 2.4, 5.1, 7.6 с — там должны встать границы
    const quiet = [2.4, 5.1, 7.6].some((q) => Math.abs(t - q) < 0.25);
    out[i] = quiet ? 0 : Math.sin(2 * Math.PI * freq * t) * 0.6;
  }
  return out;
}

test('reverse переворачивает массив', () => {
  const a = Float32Array.from([1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(reverse(a)), [5, 4, 3, 2, 1]);
});

test('reverse дважды = исходный сигнал', () => {
  const a = makeSignal(3);
  const b = reverse(reverse(a));
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 997) assert.ok(Math.abs(a[i] - b[i]) < 1e-6);
});

test('границы: не рвут слова (стоят в тишине)', () => {
  const sig = makeSignal(10);
  const bounds = computeBoundaries(sig, SR, 5, 1);
  assert.ok(bounds.length >= 3, 'должно быть минимум 2 отрезка');
  assert.equal(bounds[0], 0);
  assert.equal(bounds[bounds.length - 1], sig.length);
  // каждая внутренняя граница — в зоне тишины (|амплитуда| мала)
  for (let i = 1; i < bounds.length - 1; i++) {
    const idx = bounds[i];
    const amp = Math.abs(sig[Math.min(idx, sig.length - 1)]);
    assert.ok(amp < 0.05, `граница ${i} попала на громкий звук: ${amp.toFixed(3)}`);
  }
});

test('границы: отрезки примерно равной длины', () => {
  const sig = makeSignal(10);
  const bounds = computeBoundaries(sig, SR, 5, 1);
  const lens = [];
  for (let i = 0; i < bounds.length - 1; i++) lens.push((bounds[i + 1] - bounds[i]) / SR);
  for (const l of lens) assert.ok(l > 0.9 && l < 7.5, 'отрезок вне диапазона: ' + l.toFixed(2));
});

test('нарезка даёт столько отрезков, сколько интервалов', () => {
  const sig = makeSignal(10);
  const bounds = computeBoundaries(sig, SR, 5, 1);
  const segs = sliceByBoundaries(sig, bounds);
  assert.equal(segs.length, bounds.length - 1);
  const total = segs.reduce((n, s) => n + s.length, 0);
  assert.equal(total, sig.length);
});

test('склейка без потерь: суммарная длина = сумма минус фейды', () => {
  const a = new Float32Array(SR);  // 1 с
  const b = new Float32Array(SR);
  a.fill(0.5); b.fill(-0.5);
  const out = concatWithCrossfade([a, b], SR, 8);
  assert.ok(out.length < a.length + b.length, 'должен быть фейд');
  assert.ok(out.length > a.length + b.length - SR * 0.05, 'фейд слишком длинный');
});

test('склейка одного отрезка = сам отрезок по длине', () => {
  const a = new Float32Array(SR * 2);
  const out = concatWithCrossfade([a], SR, 8);
  assert.equal(out.length, a.length);
});

test('пустые отрезки не ломают склейку', () => {
  const a = new Float32Array(SR);
  const out = concatWithCrossfade([a, null, new Float32Array(0), a], SR, 8);
  assert.ok(out.length > 0);
});

test('WAV: корректный заголовок и размер', () => {
  const sig = makeSignal(1);
  const blob = encodeWav(sig, SR);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + sig.length * 2);
});

test('WAV: кодирование без клиппинга', async () => {
  const sig = new Float32Array([0, 1, -1, 0.5, -0.5]);
  const blob = encodeWav(sig, SR);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer);
  assert.equal(String.fromCharCode(...buf.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...buf.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 1, 'моно');
  assert.equal(view.getUint32(24, true), SR, 'частота');
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});

console.log(`\nПройдено: ${passed}`);
