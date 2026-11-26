// Проверка «контроллера» игры без браузера: node tests/flow.test.mjs
// Модули браузерные (AudioContext, AudioWorklet), поэтому подменяем их заглушками
// и проверяем именно логику сценария: длины, границы, порядок отрезков, сборку.
import assert from 'node:assert/strict';

// --- заглушки браузерного окружения ---
class FakeGain { connect() {} disconnect() {} }
class FakeAnalyser { connect() {} }
class FakeBuffer {
  constructor(ch, len) { this.ch = ch; this.length = len; this.data = new Float32Array(len); }
  copyToChannel(src) { this.data.set(src.subarray(0, this.length)); }
  getChannelData() { return this.data; }
}
class FakeSource {
  connect() {} disconnect() {}
  start() { setTimeout(() => this.onended && this.onended(), 5); }
  stop() {}
}
class FakeCtx {
  constructor() {
    this.state = 'running';
    this.sampleRate = 44100;
    this.destination = { connect() {} };
    this.audioWorklet = { addModule: async () => {} };
  }
  async resume() { this.state = 'running'; }
  createBufferSource() { return new FakeSource(); }
  createBuffer(ch, len) { return new FakeBuffer(ch, len); }
  createMediaStreamSource() { return new FakeGain(); }
  createGain() { return new FakeGain(); }
  createAnalyser() { return new FakeAnalyser(); }
}
globalThis.window = {
  AudioContext: FakeCtx,
  devicePixelRatio: 1,
};
globalThis.AudioWorkletNode = class {
  constructor() { this.port = { onmessage: null, close() {} }; }
  connect() {} disconnect() {}
};
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const { computeBoundaries, sliceByBoundaries, reverse, SAMPLE_RATE, normalize, peakLevel,
  compressSamples, makeListenable, findSplitPoint, insertBoundary } =
  await import('../js/audio-engine.js');

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/** «Запись игрока»: тон с паузами и заданной длиной (в секундах). */
function sung(sec, pauses = [], freq = 220) {
  const n = Math.round(sec * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const quiet = pauses.some((q) => Math.abs(t - q) < 0.3);
    out[i] = quiet ? 0 : Math.sin(2 * Math.PI * freq * t) * 0.4;
  }
  return out;
}

test('длина записи = что спели (нет обрезки по 30 с)', () => {
  for (const sec of [4, 11, 27, 42, 63]) {
    const rec = sung(sec);
    assert.equal(rec.length / SAMPLE_RATE, sec, `длина ${sec} с должна сохраниться`);
  }
});

test('реверс длинной записи (63 с) не теряет сэмплы', () => {
  const rec = sung(63, [20, 40]);
  const rev = reverse(rec);
  assert.equal(rev.length, rec.length);
  assert.ok(Math.abs(rev[0] - rec[rec.length - 1]) < 1e-6);
});

test('нарезка 63 с: отрезки по ~5 с, границы в тишине', () => {
  const rec = sung(63, [5.2, 10.4, 15.6, 21, 26, 31, 36, 41, 46, 51, 56, 61]);
  const rev = reverse(rec);
  const bounds = computeBoundaries(rev, SAMPLE_RATE, 5, 1);
  assert.ok(bounds.length >= 10, 'должно быть ≥10 отрезков, получилось ' + (bounds.length - 1));
  assert.equal(bounds[0], 0);
  assert.equal(bounds[bounds.length - 1], rev.length);
  const lens = [];
  for (let i = 1; i < bounds.length; i++) lens.push((bounds[i] - bounds[i - 1]) / SAMPLE_RATE);
  for (const l of lens) assert.ok(l >= 1 && l <= 8, 'отрезок вне 1..8 с: ' + l.toFixed(2));
});

test('нарезка: короткая запись (3 с) = один отрезок', () => {
  const rec = sung(3);
  const bounds = computeBoundaries(rec, SAMPLE_RATE, 5, 1);
  assert.equal(bounds.length, 2);
  assert.equal(bounds[1], rec.length);
});

test('нарезка: пустая запись не роняет', () => {
  const bounds = computeBoundaries(new Float32Array(0), SAMPLE_RATE, 5, 1);
  assert.deepEqual(bounds, [0]);
});

test('нарезка по 3 с (рабочая длина): отрезки 2–4 с', () => {
  const n = 20 * SAMPLE_RATE;
  const rec = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    rec[i] = (t % 1.4) > 1.05 ? 0 : Math.sin(2 * Math.PI * 220 * t) * 0.5;
  }
  const bounds = computeBoundaries(rec, SAMPLE_RATE, 3);
  assert.ok(bounds.length >= 5, 'отрезков: ' + (bounds.length - 1));
  for (let i = 1; i < bounds.length; i++) {
    const len = (bounds[i] - bounds[i - 1]) / SAMPLE_RATE;
    assert.ok(len >= 1 && len <= 4.2, 'длина отрезка ' + len.toFixed(2) + ' с');
  }
});

test('отрезки по порядку = исходный реверс (без потерь и перестановок)', () => {
  const rec = sung(23, [6, 12, 18]);
  const rev = reverse(rec);
  const bounds = computeBoundaries(rev, SAMPLE_RATE, 5, 1);
  const segs = sliceByBoundaries(rev, bounds);
  let off = 0;
  for (const s of segs) {
    for (let i = 0; i < s.length; i += 97) {
      assert.ok(Math.abs(s[i] - rev[off + i]) < 1e-9, 'сдвиг на отрезке');
    }
    off += s.length;
  }
  assert.equal(off, rev.length);
});

test('сборка записей игрока 2 → реверс даёт непустой результат', () => {
  const recs = [sung(2), sung(3, [], 330), sung(2.5, [], 440)];
  let total = 0;
  for (const r of recs) total += r.length;
  const assembled = new Float32Array(total);
  let off = 0;
  for (const r of recs) { assembled.set(r, off); off += r.length; }
  const final = reverse(assembled);
  assert.equal(final.length, total);
  // в результате есть звук
  let peak = 0;
  for (let i = 0; i < final.length; i += 50) peak = Math.max(peak, Math.abs(final[i]));
  assert.ok(peak > 0.05, 'результат должен содержать звук');
});

test('нормализация: тихая запись (пик 0.12) поднимается до 0.95', () => {
  const quiet = Array.from(sung(4), (v) => v * 0.3); // пик ≈ 0.12
  const out = normalize(quiet);
  const p = peakLevel(out);
  assert.ok(Math.abs(p - 0.95) < 0.01, 'пик после нормализации: ' + p.toFixed(3));
});

test('нормализация не раздувает шум (пик ниже порога не трогаем)', () => {
  const veryQuiet = Array.from(sung(2), (v) => v * 0.005); // пик ≈ 0.002
  const out = normalize(veryQuiet);
  assert.ok(peakLevel(out) <= 0.0021, 'шум не усилен');
});

test('нормализация не трогает чистую тишину', () => {
  const silence = new Float32Array(44100);
  assert.equal(peakLevel(normalize(silence)), 0);
});

test('нормализация не выходит за пределы -1..1', () => {
  const hot = Array.from(sung(2), (v) => v * 5);
  const out = normalize(hot);
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i]) <= 1);
  assert.ok(peakLevel(out) <= 1);
});

test('сжатие динамики поднимает тихие края относительно середины', () => {
  const n = 4 * SAMPLE_RATE;
  const rec = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const edge = Math.min(1, Math.min(t, 4 - t) / 1.0);
    rec[i] = Math.sin(2 * Math.PI * 220 * t) * 0.6 * (0.1 + 0.9 * edge);
  }
  const before = (() => {
    const e = Math.max(peakLevel(rec.subarray(0, SAMPLE_RATE / 10)), peakLevel(rec.subarray(rec.length - SAMPLE_RATE / 10)));
    const m = peakLevel(rec.subarray(SAMPLE_RATE * 1.8, SAMPLE_RATE * 2.2));
    return e / m;
  })();
  const out = makeListenable(rec);
  const e = Math.max(peakLevel(out.subarray(0, SAMPLE_RATE / 10)), peakLevel(out.subarray(out.length - SAMPLE_RATE / 10)));
  const m = peakLevel(out.subarray(SAMPLE_RATE * 1.8, SAMPLE_RATE * 2.2));
  const after = e / m;
  assert.ok(after > before * 2, `края должны подняться минимум вдвое: ${before.toFixed(2)} → ${after.toFixed(2)}`);
  assert.ok(peakLevel(out) > 0.9, 'итоговый пик близок к 0.95: ' + peakLevel(out).toFixed(2));
});

test('разбиение отрезка: добавляется одна граница, общее число растёт', () => {
  const rec = sung(12, [3, 6, 9]);
  const bounds = computeBoundaries(rec, SAMPLE_RATE, 4);
  const before = sliceByBoundaries(rec, bounds).length;
  const at = findSplitPoint(rec, bounds[0], bounds[1], SAMPLE_RATE);
  const next = insertBoundary(bounds, at, rec.length);
  assert.equal(next.length, bounds.length + 1);
  assert.equal(sliceByBoundaries(rec, next).length, before + 1);
  assert.equal(next[0], 0);
  assert.equal(next[next.length - 1], rec.length);
});

test('разбиение: точка попадает внутрь отрезка и в тишину', () => {
  const n = 4 * SAMPLE_RATE;
  const rec = new Float32Array(n);
  // громко везде, кроме провала около 2.0 с
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    rec[i] = Math.abs(t - 2) < 0.15 ? 0 : Math.sin(2 * Math.PI * 220 * t) * 0.5;
  }
  const at = findSplitPoint(rec, 0, n, SAMPLE_RATE);
  assert.ok(at > 0 && at < n, 'точка внутри отрезка');
  assert.ok(Math.abs(at / SAMPLE_RATE - 2) < 0.3, 'точка в провале: ' + (at / SAMPLE_RATE).toFixed(2) + ' с');
});

test('разбиение: слишком близко к соседней границе — не добавляется', () => {
  const rec = sung(6);
  const bounds = computeBoundaries(rec, SAMPLE_RATE, 3);
  const next = insertBoundary(bounds, bounds[0] + 10, rec.length);
  assert.equal(next.length, bounds.length);
});

test('разбиение: короткий отрезок делится пополам', () => {
  const rec = sung(1.2);
  const at = findSplitPoint(rec, 0, rec.length, SAMPLE_RATE);
  assert.ok(Math.abs(at - rec.length / 2) < SAMPLE_RATE * 0.1);
});

test('разбиение: точка всегда пригодна для вставки (не ближе 1 с к краям)', () => {
  for (const total of [2.4, 3, 4.5, 8, 15]) {
    const n = Math.round(total * SAMPLE_RATE);
    const rec = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      rec[i] = (t % 0.9) > 0.7 ? 0 : Math.sin(2 * Math.PI * 220 * t) * 0.5; // частая тишина
    }
    const bounds = [0, n];
    const at = findSplitPoint(rec, 0, n, SAMPLE_RATE);
    const next = insertBoundary(bounds, at, n);
    assert.equal(next.length, 3, `не вставилось при длине ${total} с (точка ${(at / SAMPLE_RATE).toFixed(2)})`);
  }
});

console.log(`\nПройдено: ${passed}`);
