/**
 * UI-логика игры «Апож»:
 * запись оригинала → реверс целиком → нарезка → запись отрезков → результат.
 */
import {
  Recorder, reverse, computeBoundaries, sliceByBoundaries,
  concatWithCrossfade, encodeWav, playSamples, stopPlayback, seconds, SAMPLE_RATE,
  audioStatus, playTestTone,
  makeListenable, peakLevel,
  findSplitPoint, insertBoundary,
} from './audio-engine.js';

const $ = (id) => document.getElementById(id);

const state = {
  segmentSec: 3,         // длина отрезка по умолчанию: 3 с — столько реально запомнить
  original: null,        // Float32Array — что спел игрок 1
  reversed: null,        // Float32Array — развёрнутый оригинал
  bounds: [],            // границы в семплах
  segments: [],          // отрезки реверса (Float32Array[])
  recordings: [],        // записи игрока 2 (Float32Array | null)
  current: 0,
  previewIndex: 0,
  finalSamples: null,
};

const recorder = new Recorder();
let timerId = null;
let timerStart = 0;

/* ---------- служебное ---------- */

function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(screenId).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function fmt(sec) {
  return sec.toFixed(1) + ' с';
}

/* ---------- громкость прослушивания ---------- */

const GAIN_KEY = 'apozh-gain';

function getGain() {
  const v = parseFloat(localStorage.getItem(GAIN_KEY) || '1.6');
  return Number.isFinite(v) ? Math.min(3, Math.max(1, v)) : 1.6;
}

function setGain(v) {
  localStorage.setItem(GAIN_KEY, String(v));
  for (const [inp, out] of [['opt-gain', 'gain-val'], ['opt-gain-2', 'gain-val-2'], ['opt-gain-3', 'gain-val-3']]) {
    const i = $(inp), o = $(out);
    if (i) i.value = String(v);
    if (o) o.textContent = v.toFixed(1) + '×';
  }
}

function initGainControls() {
  for (const id of ['opt-gain', 'opt-gain-2', 'opt-gain-3']) {
    const el = $(id);
    if (!el) continue;
    el.value = String(getGain());
    el.addEventListener('input', () => setGain(Number(el.value)));
  }
  setGain(getGain());
}

/** Таймер без ограничения сверху: показывает, сколько уже идёт запись. */
function startTimer(el) {
  timerStart = performance.now();
  clearInterval(timerId);
  timerId = setInterval(() => {
    const t = (performance.now() - timerStart) / 1000;
    el.textContent = fmt(t);
  }, 100);
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

function updateLevel(levelEl) {
  return (rms) => {
    // лог-шкала, чтобы тихие звуки были видны
    const pct = Math.min(100, Math.sqrt(Math.max(0, rms)) * 260);
    levelEl.style.width = `${pct}%`;
  };
}

/* ---------- экран 1: старт ---------- */

function initStart() {
  $('btn-start').addEventListener('click', () => {
    resetRound();
    show('screen-record');
  });

  // Диагностика: слышен ли звук вообще (частая причина на iPhone — тихий режим)
  $('btn-test-sound').addEventListener('click', async () => {
    try {
      await playTestTone(700);
      renderAudioStatus('тон проигран — если не слышно, включите звук/выключите тихий режим');
    } catch (e) {
      renderAudioStatus('ошибка звука: ' + (e && e.message ? e.message : e));
    }
  });
}

function renderAudioStatus(extra = '') {
  try {
    const s = audioStatus();
    $('audio-status').textContent =
      `Аудио: ${s.context} · ${s.sampleRate || '—'} Гц · режим ${s.silentSwitch}` +
      (extra ? ` · ${extra}` : '');
  } catch (e) {
    $('audio-status').textContent = 'Диагностика недоступна: ' + e.message;
  }
}

function resetRound() {
  state.original = null;
  state.reversed = null;
  state.bounds = [];
  state.segments = [];
  state.recordings = [];
  state.current = 0;
  state.previewIndex = 0;
  state.finalSamples = null;
  $('btn-rec-redo').disabled = true;
  $('btn-to-cut').disabled = true;
  $('rec-timer').textContent = '0.0 с';
  $('rec-level').style.width = '0%';
}

/* ---------- экран 2: запись оригинала ---------- */

function initRecord() {
  $('btn-rec-start').addEventListener('click', async () => {
    try {
      // Длина не ограничена: пишем до кнопки «Стоп»
      await recorder.start({
        maxSeconds: 0,
        onLevel: updateLevel($('rec-level')),
      });
      startTimer($('rec-timer'));
      $('btn-rec-start').disabled = true;
      $('btn-rec-stop').disabled = false;
      $('btn-rec-redo').disabled = true;
      $('btn-to-cut').disabled = true;
    } catch (e) {
      alert('Микрофон недоступен: ' + e.message + '\n\nПроверьте разрешение в настройках браузера.');
    }
  });

  $('btn-rec-stop').addEventListener('click', stopOriginal);
  $('btn-rec-redo').addEventListener('click', () => {
    state.original = null;
    $('btn-rec-redo').disabled = true;
    $('btn-to-cut').disabled = true;
    $('btn-rec-start').disabled = false;
    $('btn-rec-stop').disabled = true;
    $('rec-timer').textContent = '0.0 с';
  });
  $('btn-to-cut').addEventListener('click', buildCut);
}

function stopOriginal() {
  if (!recorder.isRecording) return;
  const data = recorder.stop();
  stopTimer();
  $('btn-rec-start').disabled = false;
  $('btn-rec-stop').disabled = true;
  if (!data || data.length < SAMPLE_RATE * 0.3) {
    alert('Запись слишком короткая. Попробуйте ещё раз.');
    return;
  }
  const rawPeak = peakLevel(data);
  // телефонный микрофон пишет тихо, края фразы почти не слышно —
  // сжимаем динамику и выравниваем уровень
  state.original = makeListenable(data);
  $('rec-timer').textContent = `${fmt(seconds(data))} · пик ${rawPeak.toFixed(2)} → выровнено`;
  $('btn-rec-redo').disabled = false;
  $('btn-to-cut').disabled = false;
  $('rec-level').style.width = '100%';
}

/** Воспроизведение: ядро само будит контекст (важно для iOS). */
async function play(samples) {
  try {
    await playSamples(samples, null, { gain: getGain(), compress: true });
  } catch (e) {
    alert('Не удалось включить звук: ' + (e && e.message ? e.message : e));
  }
}

/* ---------- экран 3: нарезка ---------- */

function buildCut() {
  state.reversed = reverse(state.original);
  state.bounds = computeBoundaries(state.reversed, SAMPLE_RATE, state.segmentSec);
  state.segments = sliceByBoundaries(state.reversed, state.bounds);
  state.previewIndex = 0;
  state.cutKey = null;       // нарезка новая — старые записи отрезков не годятся
  state.recordings = [];
  state.current = 0;
  renderCut();
  show('screen-cut');
}

function renderCut() {
  drawWave($('wave'), state.reversed, state.bounds);
  const box = $('cut-controls');
  box.innerHTML = '';
  const total = state.reversed.length;

  // ползунки для внутренних границ
  for (let i = 1; i < state.bounds.length - 1; i++) {
    const minMs = Math.round(((state.bounds[i - 1] + SAMPLE_RATE * 1) / SAMPLE_RATE) * 1000);
    const maxMs = Math.round(((state.bounds[i + 1] - SAMPLE_RATE * 1) / SAMPLE_RATE) * 1000);

    const wrap = document.createElement('label');
    wrap.className = 'cut-row';
    const name = document.createElement('span');
    name.textContent = `Граница ${i}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(minMs);
    input.max = String(maxMs);
    input.value = String(Math.round((state.bounds[i] / SAMPLE_RATE) * 1000));
    const val = document.createElement('output');
    val.textContent = (state.bounds[i] / SAMPLE_RATE).toFixed(1) + ' с';

    input.addEventListener('input', () => {
      const pos = Math.round((Number(input.value) / 1000) * SAMPLE_RATE);
      state.bounds[i] = Math.min(total - SAMPLE_RATE * 0.5, Math.max(SAMPLE_RATE * 0.5, pos));
      val.textContent = (state.bounds[i] / SAMPLE_RATE).toFixed(1) + ' с';
      // пересорт, чтобы границы не пересекались
      state.bounds.sort((a, b) => a - b);
      if (state.bounds[0] !== 0) state.bounds[0] = 0;
      if (state.bounds[state.bounds.length - 1] !== total) state.bounds[state.bounds.length - 1] = total;
      state.segments = sliceByBoundaries(state.reversed, state.bounds);
      state.previewIndex = Math.min(state.previewIndex, state.segments.length - 1);
      drawWave($('wave'), state.reversed, state.bounds);
      updateCutCounter();
    });

    wrap.append(name, input, val);
    box.appendChild(wrap);
  }
  updateCutCounter();
}

function updateCutCounter() {
  $('cut-counter').textContent = `Отрезок ${state.previewIndex + 1} из ${state.segments.length}`;
  const b = $('btn-split-seg');
  if (b) b.textContent = `÷ Разбить отрезок ${state.previewIndex + 1}`;
}

function initCut() {
  // Дать прослушать реверс целиком — до нарезки
  $('btn-rev-play').addEventListener('click', () => play(state.reversed));
  $('btn-rev-stop').addEventListener('click', () => stopPlayback());

  $('btn-preview-seg').addEventListener('click', () => {
    const seg = state.segments[state.previewIndex];
    if (!seg) return;
    play(seg);
  });

  $('btn-seg-prev').addEventListener('click', () => {
    state.previewIndex = (state.previewIndex - 1 + state.segments.length) % state.segments.length;
    updateCutCounter();
  });
  $('btn-seg-next').addEventListener('click', () => {
    state.previewIndex = (state.previewIndex + 1) % state.segments.length;
    updateCutCounter();
  });

  // «Разбить этот отрезок»: добавляем ещё одну границу — сложный участок делится
  $('btn-split-seg').addEventListener('click', () => {
    const i = state.previewIndex;
    const from = state.bounds[i];
    const to = state.bounds[i + 1];
    if (from === undefined || to === undefined) return;
    const at = findSplitPoint(state.reversed, from, to, SAMPLE_RATE);
    let nextBounds = insertBoundary(state.bounds, at, state.reversed.length);
    // тихое место оказалось слишком близко к краю — пробуем ровно пополам
    if (nextBounds.length === state.bounds.length) {
      nextBounds = insertBoundary(state.bounds, Math.round((from + to) / 2), state.reversed.length);
    }
    if (nextBounds.length === state.bounds.length) {
      alert('Отрезок уже слишком короткий для разбиения.');
      return;
    }
    state.bounds = nextBounds;
    state.segments = sliceByBoundaries(state.reversed, state.bounds);
    renderCut();                    // перерисовать ползунки и волну
    state.previewIndex = Math.min(i, state.segments.length - 1);
    updateCutCounter();
  });

  $('btn-to-segments').addEventListener('click', () => {
    // если нарезку поменяли — старые записи к ней уже не подходят
    const key = state.bounds.join(',');
    if (state.cutKey !== key) {
      state.recordings = new Array(state.segments.length).fill(null);
      state.current = 0;
      state.cutKey = key;
    } else if (!state.recordings || state.recordings.length !== state.segments.length) {
      state.recordings = new Array(state.segments.length).fill(null);
      state.current = 0;
    }
    renderSegments();
    show('screen-segments');
});

  $('btn-cut-back').addEventListener('click', () => show('screen-record'));
}

function drawWave(canvas, samples, bounds = []) {
  const ctx2d = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = 160;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, w, h);

  const style = getComputedStyle(document.body);
  const waveColor = style.getPropertyValue('--wave') || '#4f8cff';
  const lineColor = style.getPropertyValue('--wave-line') || '#ff6b6b';

  if (!samples || !samples.length) return;
  const step = Math.max(1, Math.floor(samples.length / w));
  ctx2d.fillStyle = waveColor;
  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    const start = x * step;
    for (let i = start; i < Math.min(start + step, samples.length); i++) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - max) * (h / 2);
    const y2 = (1 - min) * (h / 2);
    ctx2d.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  ctx2d.fillStyle = lineColor;
  for (const b of bounds) {
    const x = Math.round((b / samples.length) * w);
    ctx2d.fillRect(x, 0, 1.5, h);
  }
}

/* ---------- экран 4: запись отрезков ---------- */

function renderSegments() {
  const total = state.segments.length;
  $('seg-progress').textContent = `Отрезок ${state.current + 1} из ${total}`;
  // кнопки в согласованном состоянии: пишем — «Записать» спрятана за disabled,
  // «Стоп» доступна; не пишем — наоборот, «Готово» зависит от наличия записи
  setSegRecording(recorder.isRecording === true);
  $('seg-timer').textContent = '0.0 с';

  const list = $('seg-list');
  list.innerHTML = '';
  state.segments.forEach((_, i) => {
    const li = document.createElement('li');
    li.className = 'seg-item';
    if (i < state.current) li.classList.add('done');
    if (i === state.current) li.classList.add('active');
    li.textContent = `Отрезок ${i + 1}` + (i < state.current ? ' — готово' : i === state.current ? ' — сейчас' : '');
    list.appendChild(li);
  });
}

function initSegments() {
  $('btn-seg-back').addEventListener('click', () => {
    // вернуться к нарезке: остановить запись и прослушивание, записи сохраняем
    if (recorder.isRecording) { recorder.stop(); stopTimer(); }
    stopPlayback();
    renderCut();
    show('screen-cut');
  });
  $('btn-seg-play').addEventListener('click', () => {
    const seg = state.segments[state.current];
    if (seg) play(seg);
  });
  $('btn-seg-stop').addEventListener('click', () => stopPlayback());

  $('btn-seg-rec').addEventListener('click', async () => {
    // уже пишем — значит перезапись с нуля: текущую попытку выбрасываем
    if (recorder.isRecording) {
      recorder.stop();
      stopTimer();
    }
    try {
      stopPlayback(); // не петь под играющий отрезок
      await recorder.start({ maxSeconds: 0, onLevel: null });
      startTimer($('seg-timer'));
      setSegRecording(true);
    } catch (e) {
      alert('Микрофон недоступен: ' + e.message);
    }
  });

  // Отдельная кнопка «Остановить запись»: запись прекращается, «Готово» становится доступной
  $('btn-seg-rec-stop').addEventListener('click', () => {
    if (!recorder.isRecording) return;
    finishSegRecording();
    setSegRecording(false);
  });

  $('btn-seg-done').addEventListener('click', () => {
    // «Готово» принимает уже записанный и остановленный отрезок
    if (recorder.isRecording) {
      finishSegRecording();
      setSegRecording(false);
    }
    if (!state.recordings[state.current]) return;
    state.current++;
    if (state.current >= state.segments.length) {
      buildFinal();
      show('screen-finish');
    } else {
      setSegRecording(false);
      renderSegments();
    }
  });
}

/** Переключение кнопок на экране записи отрезка: пишем / остановлено. */
function setSegRecording(on) {
  const rec = $('btn-seg-rec');
  const stop = $('btn-seg-rec-stop');
  const done = $('btn-seg-done');
  if (rec) rec.disabled = on;
  if (stop) stop.disabled = !on;
  if (done) done.disabled = on || !state.recordings[state.current];
}

function finishSegRecording() {
  const data = recorder.stop();
  stopTimer();
  if (!data || data.length < SAMPLE_RATE * 0.2) {
    $('seg-timer').textContent = '0.0 с';
    return;
  }
  // каждую запись игрока 2 тоже обрабатываем: отрезки не должны прыгать по громкости
  state.recordings[state.current] = makeListenable(data);
  $('seg-timer').textContent = `${fmt(seconds(data))} · пик ${peakLevel(data).toFixed(2)}`;
  if (typeof setSegRecording === 'function') setSegRecording(false);
  else $('btn-seg-done').disabled = false;
}

/* ---------- экран 5: финал ---------- */

function buildFinal() {
  const order = state.recordings.map((r) => r || new Float32Array(0));
  const assembled = concatWithCrossfade(order, SAMPLE_RATE);
  // финал тоже обрабатываем — иначе кнопка «Слушать результат» тише, чем куски
  state.finalSamples = makeListenable(reverse(assembled));
  const secs = seconds(state.finalSamples);
  $('finish-note').textContent =
    `Собрано отрезков: ${state.recordings.filter(Boolean).length}. Длительность: ${secs.toFixed(1)} с.`;
}

function initFinish() {
  $('btn-final-play').addEventListener('click', () => play(state.finalSamples));

  $('btn-share').addEventListener('click', async () => {
    if (!state.finalSamples) return;
    const blob = encodeWav(state.finalSamples, SAMPLE_RATE);
    const file = new File([blob], `apozh-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.wav`,
      { type: 'audio/wav' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Апож' });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    // запасной путь — скачивание
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  $('btn-restart').addEventListener('click', () => {
    resetRound();
    show('screen-start');
  });
}

/* ---------- запуск ---------- */

initStart();
initRecord();
initCut();
initSegments();
initFinish();
initGainControls();

// Отладочный доступ из консоли телефона (не влияет на работу приложения)
window.__apozh = {
  state, buildCut, renderSegments, buildFinal, show, play, reverse, recorder,
};

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
