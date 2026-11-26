/**
 * Ядро звука: запись PCM, реверс, нарезка по тишине, склейка, экспорт WAV.
 * Всё в памяти устройства — никаких сетевых запросов с аудио.
 */

export const SAMPLE_RATE = 44100;
const FRAME_MS = 20;           // окно анализа громкости
const MIN_SEGMENT_SEC = 1;     // минимальная длина отрезка
const CROSSFADE_MS = 8;        // микрофейд на стыках склейки

/**
 * ОДИН AudioContext на всё приложение.
 * iOS/Safari «будят» контекст только жестом пользователя, поэтому создаём его
 * единожды и всегда вызываем resume() прямо из обработчика клика.
 */
let sharedCtx = null;
let workletReady = null;
let currentSource = null;
let playbackChain = [];

/**
 * Категория аудио-сессии iOS (Safari 16.4+).
 * ВАЖНО: категория фиксируется в момент создания AudioContext и на лету
 * НЕ меняется. 'playback' запрещает захват («AudioSession category is not
 * compatible with audio capture»), поэтому везде используем 'play-and-record'
 * (и микрофон, и вывод). Если контекст уже создан с другой категорией —
 * его нужно пересоздать: см. resetContext().
 */
export function setAudioSession(type) {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) {
      navigator.audioSession.type = type;
    }
  } catch {}
}

/** Закрыть и забыть текущий контекст (нужно после смены категории на iOS). */
export function resetContext() {
  if (sharedCtx) {
    try { sharedCtx.close(); } catch {}
    sharedCtx = null;
  }
  workletReady = null;
  currentSource = null;
}

export function getContext() {
  if (!sharedCtx) {
    // категорию ставим ДО создания контекста — иначе iOS её проигнорирует
    setAudioSession('play-and-record');
    const Ctor = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  }
  return sharedCtx;
}

/** Вызывать ИЗ ОБРАБОТЧИКА КЛИКА — тогда iOS разрешит звук. */
export async function unlockAudio() {
  const ctx = getContext();
  if (ctx.state !== 'running') {
    // resume() без жеста может не завершиться НИКОГДА — ждём не дольше 400 мс,
    // иначе весь сценарий молча зависает («кнопка нажимается, а ничего нет»).
    try {
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    } catch {}
  }
  if (!workletReady) {
    workletReady = ctx.audioWorklet.addModule('js/pcm-worklet.js').catch((e) => {
      workletReady = null;
      throw e;
    });
  }
  await workletReady;
  return ctx;
}

/** Запись сырого PCM с микрофона через AudioWorklet. */
export class Recorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.chunks = [];
    this.recording = false;
    this.onLevel = null;
    this._autoStop = null;
  }

  async ensureContext() {
    this.ctx = await unlockAudio();
    return this.ctx;
  }

  /** maxSeconds = 0 → пишем до «Стоп» без ограничения (длина = что спели). */
  async start({ maxSeconds = 0, onLevel = null } = {}) {
    if (this.recording) return;
    this.onLevel = onLevel;
    this.chunks = [];
    const micConstraints = {
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };

    // ПОРЯДОК ВАЖЕН: сначала микрофон, потом AudioContext.
    // iOS фиксирует категорию аудио-сессии при создании контекста; если контекст
    // уже есть, запрос микрофона падает с «AudioSession category is not
    // compatible with audio capture». Поэтому категорию ставим и контекст
    // закрываем ДО запроса микрофона.
    if (sharedCtx) resetContext();
    setAudioSession('play-and-record');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(micConstraints);
    } catch (err) {
      if (String(err && err.message).includes('AudioSession')) {
        // ещё одна попытка: контекст точно закрыт, категория выставлена
        resetContext();
        setAudioSession('play-and-record');
        this.stream = await navigator.mediaDevices.getUserMedia(micConstraints);
      } else {
        throw err;
      }
    }

    await this.ensureContext();
    // Контекст не запустился — честно говорим об этом, а не пишем тишину.
    if (this.ctx.state !== 'running') {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
      this.stream = null;
      throw new Error('звук ещё не разрешён браузером — нажмите «Записать» ещё раз');
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder');
    this.node.port.onmessage = (e) => {
      this.chunks.push(e.data.samples);
      if (this.onLevel) this.onLevel(e.data.rms);
    };
    // ВАЖНО: узел обязан быть в графе до destination, иначе браузер не вызывает
    // process() и мы получаем пустую запись. Тянем через глушитель (gain = 0),
    // чтобы не было самопрослушивания.
    // глушитель привязан к конкретному контексту — после пересоздания берём новый
    if (!this._sink || this._sinkCtx !== this.ctx) {
      this._sink = this.ctx.createGain();
      this._sink.gain.value = 0;
      this._sink.connect(this.ctx.destination);
      this._sinkCtx = this.ctx;
    }
    src.connect(this.node);
    this.node.connect(this._sink);
    this.recording = true;
    if (maxSeconds > 0) {
      this._autoStop = setTimeout(() => {
        if (this.recording) this.stop();
      }, maxSeconds * 1000);
    }
  }

  stop() {
    if (!this.recording) return null;
    this.recording = false;
    clearTimeout(this._autoStop);
    try { this.node?.port?.close?.(); } catch {}
    try { this.node?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    this.node = null;
    this.stream = null;
    if (this.onLevel) this.onLevel(0);
    return this._merge();
  }

  _merge() {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    this.chunks = [];
    return out;
  }

  get isRecording() { return this.recording; }
}

/** Разворот массива семплов. */
export function reverse(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0, j = samples.length - 1; i < samples.length; i++, j--) out[i] = samples[j];
  return out;
}

/**
 * Выравнивание громкости: поднимаем пик до target (по умолчанию 0.95).
 * Телефонный микрофон пишет тихо, а тихие места (начало/конец фразы) без
 * нормализации вообще не слышно. Тишину не трогаем (иначе шум).
 */
export function normalize(samples, target = 0.95, noiseFloor = 0.002) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  if (peak < 0.004) return samples;           // одна тишина — не усиливаем шум
  const k = Math.min(12, target / peak);       // до +21 дБ: телефонный микрофон пишет тихо
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-1, Math.min(1, samples[i] * k));
  }
  return out;
}

/**
 * Сжатие динамики: поднимает тихие места (начало и конец фразы), поджимая
 * громкие. Без этого «середина нормально, края не слышно» — типичная картина
 * пения в телефон. Порог выше шума, чтобы паузы не раздувались.
 */
export function compressSamples(samples, { threshold = 0.18, ratio = 3, attackMs = 6, releaseMs = 120 } = {}) {
  const out = new Float32Array(samples.length);
  const atk = Math.exp(-1 / Math.max(1, (SAMPLE_RATE * attackMs) / 1000));
  const rel = Math.exp(-1 / Math.max(1, (SAMPLE_RATE * releaseMs) / 1000));
  let env = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    const g = env > threshold ? Math.pow(env / threshold, 1 / ratio - 1) : 1;
    out[i] = Math.max(-1, Math.min(1, samples[i] * g));
  }
  return out;
}

/** Обработка для прослушивания: сжатие динамики → выравнивание громкости. */
export function makeListenable(samples) {
  if (!samples || !samples.length) return samples;
  return normalize(compressSamples(samples));
}

/** Пиковый уровень (для диагностики на экране). */
export function peakLevel(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Громкость по кадрам (RMS). */
export function frameLevels(samples, sampleRate = SAMPLE_RATE, frameMs = FRAME_MS) {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const levels = new Float32Array(Math.ceil(samples.length / size));
  for (let f = 0; f < levels.length; f++) {
    const start = f * size;
    const end = Math.min(start + size, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    levels[f] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return { levels, frameSize: size };
}

/**
 * Границы нарезки: целевая длина сегмента, но режем в локальном минимуме громкости.
 * Возвращает массив индексов-границ (включая 0 и конец).
 */
export function computeBoundaries(samples, sampleRate = SAMPLE_RATE, targetSec = 5, minSec = MIN_SEGMENT_SEC) {
  const { levels, frameSize } = frameLevels(samples, sampleRate);
  const total = samples.length;
  if (total === 0) return [0];

  const targetFrames = Math.max(1, Math.round((targetSec * sampleRate) / frameSize));
  const minFrames = Math.max(1, Math.round((minSec * sampleRate) / frameSize));

  const bounds = [0];
  let pos = 0;
  while (pos + targetFrames < levels.length - minFrames) {
    const lo = Math.max(pos + minFrames, pos + Math.round(targetFrames * 0.6));
    const hi = Math.min(levels.length - minFrames, pos + Math.round(targetFrames * 1.4));
    let best = Math.min(hi, Math.max(lo, pos + targetFrames));
    let bestVal = Infinity;
    for (let f = lo; f <= hi; f++) {
      if (levels[f] < bestVal) { bestVal = levels[f]; best = f; }
    }
    bounds.push(best * frameSize);
    pos = best;
  }
  bounds.push(total);
  return bounds;
}

/**
 * Точка для дополнительного разбиения отрезка: самое тихое место в средней
 * половине отрезка (25–75 %), чтобы сложный участок разделить, не разорвав слово.
 */
export function findSplitPoint(samples, from, to, sampleRate = SAMPLE_RATE, frameMs = FRAME_MS) {
  const span = to - from;
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const mid = Math.round((from + to) / 2);
  if (span < size * 6) return mid;              // слишком короткий — просто пополам
  // граница не должна вставать ближе minSec к краям отрезка, иначе её некуда вставить
  const margin = Math.max(Math.round(span * 0.2), Math.round(MIN_SEGMENT_SEC * sampleRate * 1.05));
  if (span <= margin * 2) return mid;
  const lo = from + margin;
  const hi = to - margin;
  let bestAt = mid;
  let bestEnergy = Infinity;
  let sum = 0;
  let frames = 0;
  for (let p = lo; p + size <= hi; p += size) {
    let e = 0;
    for (let i = p; i < p + size; i += 2) e += Math.abs(samples[i]);
    sum += e;
    frames++;
    if (e < bestEnergy) { bestEnergy = e; bestAt = p + (size >> 1); }
  }
  // если тихого места нет (ровный звук) — делим пополам, а не у края
  const avg = frames ? sum / frames : Infinity;
  if (!frames || bestEnergy > avg * 0.5) return mid;
  return bestAt;
}

/**
 * Вставка дополнительной границы. Возвращает НОВЫЙ массив (старый не меняем)
 * с сохранёнными краями 0 и len.
 */
export function insertBoundary(bounds, at, total, minSec = MIN_SEGMENT_SEC, sampleRate = SAMPLE_RATE) {
  const minGap = Math.round(minSec * sampleRate);
  const next = bounds.slice();
  // не даём поставить границу ближе minGap к соседней
  for (const b of bounds) {
    if (Math.abs(b - at) < minGap) return next;
  }
  if (at <= 0 || at >= total) return next;
  next.push(Math.round(at));
  next.sort((a, b) => a - b);
  return next;
}

/** Нарезка по границам. */
export function sliceByBoundaries(samples, bounds) {
  const segs = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    segs.push(samples.slice(bounds[i], bounds[i + 1]));
  }
  return segs;
}

/** Склейка с микрофейдом на стыках (без щелчков). */
export function concatWithCrossfade(segments, sampleRate = SAMPLE_RATE, crossfadeMs = CROSSFADE_MS) {
  const parts = segments.filter((s) => s && s.length);
  if (!parts.length) return new Float32Array(0);
  const fade = Math.max(2, Math.round((sampleRate * crossfadeMs) / 1000));
  let total = 0;
  for (const p of parts) total += p.length;
  total -= fade * (parts.length - 1);

  const out = new Float32Array(Math.max(0, total));
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i === 0) { out.set(p, 0); off = p.length; continue; }
    const overlap = Math.min(fade, p.length, off);
    for (let k = 0; k < overlap; k++) {
      const t = k / overlap;
      out[off - overlap + k] = out[off - overlap + k] * (1 - t) + p[k] * t;
    }
    out.set(p.subarray(overlap), off);
    off += p.length - overlap;
  }
  return out;
}

/**
 * Обрезка тишины по краям записи. Начало и конец отрезка почти всегда
 * содержат паузу: человек нажимает «Записать», потом начинает петь, а после
 * пения молчит до «Стоп». При склейке эти паузы складываются в заметные
 * провалы. Функция убирает тишину с обоих краёв, оставляя запас на затухание.
 */
export function trimSilence(samples, sampleRate = SAMPLE_RATE, opts = {}) {
  const { floor = 0.01, padMs = 40, relThreshold = 0.06 } = opts;
  if (!samples || !samples.length) return samples;

  // порог: не ниже шумового порога и не ниже доли от пика
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  if (peak < floor) return samples;             // совсем тихо — не трогаем
  const th = Math.max(floor, peak * relThreshold);

  const frame = Math.max(1, Math.round(sampleRate * 0.005)); // кадр 5 мс
  const isLoud = (from) => {
    let e = 0;
    for (let i = from; i < Math.min(from + frame, samples.length); i++) {
      const v = Math.abs(samples[i]);
      if (v > e) e = v;
    }
    return e >= th;
  };

  let start = 0;
  while (start + frame < samples.length && !isLoud(start)) start += frame;
  let end = samples.length;
  while (end - frame > 0 && !isLoud(end - frame)) end -= frame;
  if (start >= end) return samples;             // одна тишина

  const pad = Math.round((sampleRate * padMs) / 1000);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length, end + pad);
  return samples.subarray(start, end);
}

/**
 * Склейка для финальной дорожки: обрезаем тишину у каждого куска и стыкуем
 * вплотную (с коротким фейдом против щелчков). Пауз между кусками нет.
 */
export function concatClean(segments, sampleRate = SAMPLE_RATE, crossfadeMs = CROSSFADE_MS) {
  const parts = [];
  for (const s of segments) {
    if (!s || !s.length) continue;
    const t = trimSilence(s, sampleRate);
    if (t && t.length) parts.push(t);
  }
  return concatWithCrossfade(parts, sampleRate, crossfadeMs);
}

/** Кодирование в WAV (16 бит PCM) — работает везде, включая iOS. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}

/** Остановить текущее воспроизведение (звуки не должны накладываться). */
export function stopPlayback() {
  if (currentSource) {
    try { currentSource.onended = null; } catch {}
    try { currentSource.stop(); } catch {}
    try { currentSource.disconnect(); } catch {}
    currentSource = null;
  }
  for (const n of playbackChain) {
    try { n.disconnect(); } catch {}
  }
  playbackChain = [];
}

/**
 * Воспроизведение массива семплов.
 * Контекст будим ЗДЕСЬ ЖЕ — иначе на iOS звук молчит (главная причина
 * «кнопка нажимается, а звука нет»).
 */
export async function playSamples(samples, _ctx = null, { gain = 1, compress = true } = {}) {
  if (!samples || !samples.length) return;
  stopPlayback();
  const ctx = await unlockAudio();
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch {}
  }
  const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;

  // цепочка: источник → компрессор (выравнивает тихие/громкие места) → усиление → выход
  let node = src;
  if (compress && ctx.createDynamicsCompressor) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -32;   // поджимаем пики, поднимая тихое
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.20;
    node.connect(comp);
    node = comp;
  }
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0.1, Math.min(4, gain));
  node.connect(gainNode);
  gainNode.connect(ctx.destination);
  playbackChain = [src, gainNode];

  currentSource = src;
  return new Promise((resolve) => {
    src.onended = () => { if (currentSource === src) currentSource = null; resolve(); };
    src.start(0);
  });
}

/** Диагностика для экрана: состояние контекста и параметры звука. */
export function audioStatus() {
  const ctx = sharedCtx;
  return {
    context: ctx ? ctx.state : 'не создан',
    sampleRate: ctx ? ctx.sampleRate : null,
    silentSwitch: (() => {
      try {
        if (!navigator.audioSession) return 'нет API';
        return navigator.audioSession.type + (navigator.audioSession.type === 'play-and-record'
          ? ' (микрофон разрешён; тихий режим может глушить звук)' : '');
      } catch { return 'ошибка'; }
    })(),
  };
}

/** Короткий тестовый тон 440 Гц — чтобы проверить, слышен ли звук вообще. */
export async function playTestTone(ms = 700) {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // плавные края, чтобы не было щелчка
    const env = Math.min(1, Math.min(i, n - i) / (SAMPLE_RATE * 0.02));
    s[i] = Math.sin(2 * Math.PI * 440 * t) * 0.35 * env;
  }
  await playSamples(s);
}

export function seconds(samples, sampleRate = SAMPLE_RATE) {
  return samples.length / sampleRate;
}
