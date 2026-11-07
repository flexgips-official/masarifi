// مصاريفي – main application (Arabic, RTL, installable web app)
import { SUPABASE_URL, SUPABASE_KEY, APP_VERSION, AI_MONTHLY_LIMIT, MAX_RECORDING_SECONDS, MAX_IMAGES } from './config.js';
import * as L from './lib.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = L.esc;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'masarifi-auth' },
});

class AppError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
const isNetErr = (e) => /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(String(e?.message || e || ''));

// ─────────────────────────── state & settings ───────────────────────────
const state = {
  user: null,
  vocab: { categories: [], items: [] },
  draftImages: [],
  pendingLoc: null,
  view: 'add',
  history: { month: L.startOfMonth(new Date()), rows: [] },
  report: { key: 'month', from: null, to: null, data: null, openCat: null },
  recent: [],
};

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
const settings = {
  get autoSave() { return lsGet('masarifi.autoSave', '0') === '1'; },
  set autoSave(v) { lsSet('masarifi.autoSave', v ? '1' : '0'); },
  get useLocation() { return lsGet('masarifi.useLocation', '1') === '1'; },
  set useLocation(v) { lsSet('masarifi.useLocation', v ? '1' : '0'); },
};

// ─────────────────────────── toast ───────────────────────────
let toastTimer;
function toast(msg, type = 'info', ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
}

// ─────────────────────────── sheet (modal) ───────────────────────────
let sheetOpen = false;
function openSheet(html) {
  const s = $('#sheet');
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add('open'));
  if (!sheetOpen) {
    history.pushState({ sheet: 1 }, '');
    sheetOpen = true;
  }
}
function closeSheet(fromPop = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  const s = $('#sheet');
  s.classList.remove('open');
  setTimeout(() => {
    if (!sheetOpen) { s.hidden = true; $('#sheet-body').innerHTML = ''; }
  }, 220);
  if (!fromPop && history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => { if (sheetOpen) closeSheet(true); });
$('#sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet' || e.target.closest('[data-close]')) closeSheet();
});

// ─────────────────────────── outbox (IndexedDB) ───────────────────────────
let dbPromise;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('masarifi', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
async function obTx(mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const t = d.transaction('outbox', mode);
    const req = fn(t.objectStore('outbox'));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const ob = {
  put: (item) => obTx('readwrite', (s) => s.put(item)),
  del: (id) => obTx('readwrite', (s) => s.delete(id)),
  get: (id) => obTx('readonly', (s) => s.get(id)),
  all: () => obTx('readonly', (s) => s.getAll()),
};

// ─────────────────────────── location ───────────────────────────
function getPosition() {
  if (!settings.useLocation || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&zoom=18&addressdetails=1&accept-language=de`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    const a = j.address || {};
    const city = a.city || a.town || a.village || a.suburb || a.municipality || '';
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const name = j.name || a.shop || a.amenity || a.fuel || '';
    const main = name || street;
    const out = [main, city].filter(Boolean).join(', ');
    return out || j.display_name || null;
  } catch {
    return null;
  }
}

function startLocation() {
  if (state.pendingLoc || !settings.useLocation) return;
  state.pendingLoc = getPosition().then(async (loc) => {
    if (loc) loc.place = await reverseGeocode(loc.lat, loc.lng);
    return loc;
  });
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

// ─────────────────────────── audio recording ───────────────────────────
const rec = { active: false, mr: null, stream: null, chunks: [], t0: 0, timer: null, ctx: null, raf: 0 };

async function toggleMic() {
  if (rec.active) return finishRecording();
  return startRecording();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('هذا المتصفح لا يدعم التسجيل الصوتي', 'error');
    return;
  }
  startLocation();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (e) {
    toast(e && e.name === 'NotAllowedError'
      ? 'اسمح للتطبيق باستخدام الميكروفون (إعدادات المتصفح ← الأذونات)'
      : 'تعذر تشغيل الميكروفون', 'error', 6000);
    return;
  }
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const mime = types.find((t) => (MediaRecorder.isTypeSupported ? MediaRecorder.isTypeSupported(t) : false)) || '';
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  } catch {
    mr = new MediaRecorder(stream);
  }
  rec.chunks = [];
  rec.stream = stream;
  rec.mr = mr;
  rec.active = true;
  rec.t0 = Date.now();
  mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  mr.start(1000);
  document.body.classList.add('recording');
  $('#rec-status').textContent = 'جارٍ التسجيل… اضغط للإيقاف';
  $('#rec-time').textContent = '00:00';
  rec.timer = setInterval(() => {
    const s = (Date.now() - rec.t0) / 1000;
    $('#rec-time').textContent = L.fmtDuration(s);
    if (s >= MAX_RECORDING_SECONDS) finishRecording();
  }, 250);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    rec.ctx = new AC();
    const src = rec.ctx.createMediaStreamSource(stream);
    const an = rec.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const btn = $('#btn-mic');
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x; }
      btn.style.setProperty('--lvl', Math.min(1, Math.sqrt(sum / buf.length) * 5).toFixed(3));
      rec.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* level meter is optional */ }
}

async function finishRecording() {
  if (!rec.active) return;
  rec.active = false;
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  if (rec.ctx) rec.ctx.close().catch(() => {});
  const mr = rec.mr;
  const duration = (Date.now() - rec.t0) / 1000;
  const blob = await new Promise((resolve) => {
    const type = (mr.mimeType || 'audio/webm').split(';')[0];
    mr.onstop = () => resolve(new Blob(rec.chunks, { type }));
    try { mr.stop(); } catch { resolve(new Blob(rec.chunks, { type })); }
  });
  rec.stream.getTracks().forEach((t) => t.stop());
  document.body.classList.remove('recording');
  $('#btn-mic').style.removeProperty('--lvl');
  $('#rec-status').textContent = 'اضغط وتكلّم';
  $('#rec-time').textContent = '';
  if (duration < 0.8 || blob.size < 800) {
    toast('التسجيل قصير جداً – اضغط وتكلّم ثم اضغط مرة ثانية للإيقاف', 'warn', 4500);
    return;
  }
  await createEntry({ audio: blob, audioType: blob.type || 'audio/webm', audioSec: duration });
}

/** fallback: convert any recorded audio to 16 kHz mono WAV */
async function blobToWav(blob) {
  const SR = 16000;
  const ab = await blob.arrayBuffer();
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, SR, SR);
  const audio = await ctx.decodeAudioData(ab);
  const len = audio.length;
  const mono = new Float32Array(len);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const d = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / audio.numberOfChannels;
  }
  return new Blob([L.encodeWav(mono, audio.sampleRate)], { type: 'audio/wav' });
}

// ─────────────────────────── photos ───────────────────────────
async function compressImage(file) {
  const MAX = 2048;
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('img'));
      img.src = URL.createObjectURL(file);
    }).catch(() => null);
  }
  if (!source) {
    if (/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    throw new AppError('image', 'صيغة الصورة غير مدعومة – استخدم JPG أو PNG');
  }
  const w0 = source.width, h0 = source.height;
  const scale = Math.min(1, MAX / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  if (source.close) source.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new AppError('image', 'تعذر تجهيز الصورة');
  return blob;
}

async function addPhotos(files) {
  const list = [...files].slice(0, Math.max(0, MAX_IMAGES - state.draftImages.length));
  if (!list.length) {
    toast(`الحد الأقصى ${MAX_IMAGES} صور لكل إدخال`, 'warn');
    return;
  }
  for (const f of list) {
    try {
      const blob = await compressImage(f);
      state.draftImages.push({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      toast(e.message || 'تعذر قراءة الصورة', 'error');
    }
  }
  renderDraft();
}

function renderDraft() {
  const has = state.draftImages.length > 0;
  $('#draft').hidden = !has;
  $('#draft-thumbs').innerHTML = state.draftImages
    .map((d, i) => `<div class="thumb"><img src="${d.url}" alt=""><button type="button" data-rm="${i}" aria-label="حذف">✕</button></div>`)
    .join('');
  $('#rec-status').textContent = rec.active ? 'جارٍ التسجيل… اضغط للإيقاف' : has ? 'اضغط لإضافة تعليق صوتي للفاتورة' : 'اضغط وتكلّم';
}

function clearDraft() {
  state.draftImages.forEach((d) => URL.revokeObjectURL(d.url));
  state.draftImages = [];
  renderDraft();
}

// ─────────────────────────── entries & processing ───────────────────────────
async function createEntry({ audio = null, audioType = null, audioSec = 0, text = null }) {
  const images = state.draftImages.map((d) => d.blob);
  clearDraft();
  const locPromise = state.pendingLoc || Promise.resolve(null);
  state.pendingLoc = null;
  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'locating',
    audio, audioType, audioSec, text,
    images,
    loc: null,
    result: null,
    exps: [],
    error: null,
  };
  try {
    await ob.put(item);
  } catch (e) {
    toast('تعذر حفظ الإدخال على الجهاز: ' + (e?.message || e), 'error', 6000);
    return;
  }
  await renderQueue();
  const loc = await withTimeout(locPromise, 6000, null);
  const fresh = await ob.get(item.id);
  if (fresh) {
    if (loc && !fresh.loc) fresh.loc = { lat: loc.lat, lng: loc.lng, acc: loc.acc, place: loc.place || null };
    if (fresh.status === 'locating') fresh.status = 'pending';
    await ob.put(fresh);
  }
  processItem(item.id);
}

const busy = new Set();

async function processAll() {
  if (!state.user) return;
  let items = [];
  try { items = await ob.all(); } catch { return; }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const now = Date.now();
  for (const it of items) {
    const stuckLocating = it.status === 'locating' && now - new Date(it.createdAt).getTime() > 20000;
    if ((['pending', 'waiting', 'processing'].includes(it.status) || stuckLocating) && !busy.has(it.id)) {
      await processItem(it.id, { auto: true });
    }
  }
  renderQueue();
}

function sourceOf(it) {
  if (it.audio && it.images.length) return 'photo_voice';
  if (it.images.length) return 'photo';
  if (it.audio) return 'voice';
  return 'text';
}

function buildExpense(it, e, transcript) {
  const useLoc = e.at_current_location !== false && it.loc;
  return {
    spent_at: e.spent_at,
    merchant: e.merchant,
    merchant_address: e.merchant_address,
    purpose: e.purpose,
    note: e.note,
    payment_method: e.payment_method,
    currency: e.currency,
    items: e.items,
    total: e.total,
    ai_total: e.ai_total,
    mismatch: e.mismatch,
    image_indexes: e.image_indexes,
    lat: useLoc ? it.loc.lat : null,
    lng: useLoc ? it.loc.lng : null,
    place_name: useLoc ? it.loc.place || null : null,
    source: sourceOf(it),
    transcript: it.text ? it.text : transcript,
    receipt_paths: [],
    ai_model: it.model || null,
  };
}

async function processItem(id, { auto = false } = {}) {
  if (busy.has(id)) return;
  busy.add(id);
  let it;
  try {
    it = await ob.get(id);
    if (!it) return;
    if (!it.result) {
      it.status = 'processing';
      it.error = null;
      await ob.put(it);
      renderQueue();
      if (!navigator.onLine) throw new AppError('network', 'لا يوجد اتصال بالإنترنت – سيتم التحليل تلقائياً عند عودة الاتصال');
      if (it.loc && !it.loc.place) {
        const p = await reverseGeocode(it.loc.lat, it.loc.lng);
        if (p) { it.loc.place = p; await ob.put(it); }
      }
      let resp;
      try {
        resp = await callAnalyze(it, !!it.useWav);
      } catch (e) {
        if (e.code === 'audio_format' && it.audio && !it.useWav) {
          it.useWav = true;
          await ob.put(it);
          resp = await callAnalyze(it, true);
        } else {
          throw e;
        }
      }
      it.model = resp.model;
      it.usage = resp.usage;
      const norm = L.normalizeAnalysis(resp.result, { createdAt: new Date(it.createdAt), imageCount: it.images.length });
      it.result = { transcript: norm.transcript, needs_review: norm.needs_review, question: norm.question };
      it.exps = norm.expenses.map((e) => ({ id: crypto.randomUUID(), state: 'new', data: buildExpense(it, e, norm.transcript) }));
      it.status = it.exps.length ? 'review' : 'empty';
      await ob.put(it);
    }
    if (it.status === 'review' && settings.autoSave && !it.result.needs_review) {
      for (const x of it.exps) {
        if (x.state === 'new' && !x.data.mismatch) await saveQueued(it, x, { silent: true });
      }
      if (it.exps.every((x) => x.state !== 'new')) toast('تم التحليل والحفظ تلقائياً ✓', 'ok');
    }
    await finalizeIfDone(it);
  } catch (e) {
    if (!it) return;
    const fresh = (await ob.get(id).catch(() => null)) || it;
    const retryable = ['network', 'server'].includes(e.code) || isNetErr(e);
    if (fresh.status === 'processing' || !fresh.result) fresh.status = retryable ? 'waiting' : 'error';
    fresh.error = e.message || String(e);
    fresh.errorCode = e.code || 'unknown';
    fresh.errorDetail = e.detail || null;
    await ob.put(fresh).catch(() => {});
    if (!auto || !retryable) toast(fresh.error, retryable ? 'warn' : 'error', 6000);
  } finally {
    busy.delete(id);
    renderQueue();
  }
}

async function callAnalyze(it, useWav) {
  const { data, error: sessErr } = await sb.auth.getSession();
  const session = data && data.session;
  if (!session) {
    if (sessErr && isNetErr(sessErr)) throw new AppError('network', 'لا يوجد اتصال بالخادم – سيتم التحليل تلقائياً عند عودة الاتصال');
    throw new AppError('auth', 'انتهت الجلسة – سجّل الدخول من جديد');
  }
  let audioBlob = it.audio;
  let audioType = it.audioType || 'audio/webm';
  if (it.audio && useWav) {
    try { audioBlob = await blobToWav(it.audio); audioType = 'audio/wav'; } catch { /* send original */ }
  }
  const created = new Date(it.createdAt);
  const meta = {
    now_local: L.localStamp(created),
    weekday: L.weekdayAr(created),
    device_place: it.loc ? it.loc.place : null,
    text: it.text || null,
    audio_seconds: it.audioSec || 0,
    categories: state.vocab.categories.map((c) => c.name),
    items: state.vocab.items.slice(0, 300).map((i) => ({ name: i.name, category: i.category, unit: i.unit })),
  };
  const fd = new FormData();
  fd.append('meta', JSON.stringify(meta));
  if (audioBlob) fd.append('audio', new File([audioBlob], audioType === 'audio/wav' ? 'voice.wav' : 'voice.webm', { type: audioType }));
  it.images.forEach((b, i) => fd.append('images', new File([b], `receipt-${i}.jpg`, { type: b.type || 'image/jpeg' })));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_KEY },
      body: fd,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new AppError('network', e && e.name === 'AbortError'
      ? 'انتهت مهلة التحليل – ستتم إعادة المحاولة'
      : 'لا يوجد اتصال بالخادم – سيتم التحليل تلقائياً عند عودة الاتصال');
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  if (res.ok && body && body.ok) return body;
  const code = (body && body.code) || 'server';
  if (res.status === 540) throw new AppError('server', 'قاعدة البيانات متوقفة مؤقتاً (Supabase يوقف المشاريع المجانية بعد 7 أيام بدون استخدام) – افتح لوحة Supabase واضغط Restore');
  const msg = (body && body.error) || `خطأ من الخادم (${res.status})`;
  const permanent = ['no_key', 'gemini_billing', 'gemini_credits', 'gemini_key', 'limit', 'auth', 'bad_request', 'too_large', 'audio_format', 'gemini_model'];
  throw new AppError(permanent.includes(code) ? code : 'server', msg, body && body.detail);
}

async function uploadReceipts(it, x) {
  const d = x.data;
  if (!it.images.length || !d.image_indexes || !d.image_indexes.length || (d.receipt_paths && d.receipt_paths.length)) return;
  const paths = [];
  for (let k = 0; k < d.image_indexes.length; k++) {
    const blob = it.images[d.image_indexes[k]];
    if (!blob) continue;
    const path = `${state.user.id}/${x.id}/${k + 1}.jpg`;
    const { error } = await sb.storage.from('receipts').upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
    if (error) throw new AppError(isNetErr(error) ? 'network' : 'storage', 'تعذر رفع صورة الفاتورة: ' + error.message);
    paths.push(path);
  }
  d.receipt_paths = paths;
  await ob.put(it);
}

async function saveQueued(it, x, { silent = false } = {}) {
  await uploadReceipts(it, x);
  const { error } = await sb.rpc('save_expense', { p: L.toPayload({ ...x.data, id: x.id }) });
  if (error) throw new AppError(isNetErr(error) ? 'network' : 'db', 'تعذر الحفظ: ' + error.message);
  x.state = 'saved';
  await ob.put(it);
  if (!silent) toast('تم الحفظ ✓', 'ok');
}

async function finalizeIfDone(it) {
  if (it.status !== 'review') return;
  if (it.exps.length && it.exps.every((x) => x.state === 'saved' || x.state === 'dismissed')) {
    await ob.del(it.id);
    if (it.exps.some((x) => x.state === 'saved')) refreshAfterChange();
  }
}

// ─────────────────────────── queue UI ───────────────────────────
function entryIcon(it) {
  const parts = [];
  if (it.audio) parts.push(`🎤 ${L.fmtDuration(it.audioSec || 0)}`);
  if (it.images && it.images.length) parts.push(`📷 ${it.images.length}`);
  if (it.text) parts.push('✍️');
  return parts.join(' · ');
}

async function renderQueue() {
  let items = [];
  try { items = await ob.all(); } catch { /* ignore */ }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#queue').innerHTML = items.map(queueItemHtml).join('');
}

function queueItemHtml(it) {
  const when = L.fmtTime(new Date(it.createdAt));
  const head = `<div class="q-head"><span>${entryIcon(it)}</span><span class="num">${when}</span></div>`;
  const del = `<button class="btn small ghost" data-act="del" data-id="${it.id}" type="button">🗑️ حذف</button>`;
  if (it.status === 'pending' || it.status === 'processing' || it.status === 'locating') {
    return `<div class="q-item">${head}<div class="q-status"><span class="spinner sm"></span> ${it.status === 'processing' ? 'جارٍ التحليل…' : 'بالانتظار…'}</div></div>`;
  }
  if (it.status === 'waiting') {
    return `<div class="q-item waiting">${head}<div class="q-wait">⏳ ${esc(it.error || 'بانتظار الاتصال')}</div>
      <div class="q-actions"><button class="btn small primary" data-act="retry" data-id="${it.id}" type="button">🔄 إعادة المحاولة</button>${del}</div></div>`;
  }
  if (it.status === 'error') {
    const extra = it.errorCode === 'auth' ? `<button class="btn small" data-act="relogin" type="button">تسجيل الدخول</button>` : '';
    return `<div class="q-item error">${head}<div class="q-err">⚠️ ${esc(it.error || 'خطأ')}</div>
      ${it.errorDetail ? `<details class="small muted"><summary>تفاصيل تقنية</summary><div class="num" style="white-space:pre-wrap">${esc(it.errorDetail)}</div></details>` : ''}
      <div class="q-actions"><button class="btn small primary" data-act="retry" data-id="${it.id}" type="button">🔄 إعادة المحاولة</button>
      <button class="btn small" data-act="manual" data-id="${it.id}" type="button">✍️ إدخال يدوي</button>${extra}${del}</div></div>`;
  }
  if (it.status === 'empty') {
    return `<div class="q-item error">${head}
      ${it.result && it.result.transcript ? `<div class="q-transcript">🎤 «${esc(it.result.transcript)}»</div>` : ''}
      <div class="q-question">${esc((it.result && it.result.question) || 'لم أجد مصروفاً في هذا الإدخال.')}</div>
      <div class="q-actions"><button class="btn small" data-act="manual" data-id="${it.id}" type="button">✍️ إدخال يدوي</button>${del}</div></div>`;
  }
  // review
  const r = it.result || {};
  const open = it.exps.filter((x) => x.state === 'new');
  const body = it.exps.map((x) => {
    if (x.state === 'saved') return `<div class="q-exp"><span class="saved-tag">✓ محفوظ: ${esc(x.data.merchant || x.data.purpose || x.data.items[0]?.name || '')} – <span class="num">${L.fmtMoney(x.data.total, x.data.currency)}</span></span></div>`;
    if (x.state === 'dismissed') return '';
    const warn = x.data.mismatch
      ? `<div class="warnline">⚠️ مجموع الأصناف (<span class="num">${L.fmtMoney(x.data.total)}</span>) لا يساوي المبلغ المذكور (<span class="num">${L.fmtMoney(x.data.ai_total)}</span>) – راجع قبل الحفظ</div>`
      : '';
    return `<div class="q-exp">${expenseCard(x.data)}${warn}
      <div class="q-actions">
        <button class="btn small primary" data-act="save" data-id="${it.id}" data-x="${x.id}" type="button">✓ حفظ</button>
        <button class="btn small" data-act="edit" data-id="${it.id}" data-x="${x.id}" type="button">✏️ تعديل</button>
        <button class="btn small ghost" data-act="dismiss" data-id="${it.id}" data-x="${x.id}" type="button">✕ تجاهل</button>
      </div></div>`;
  }).join('');
  return `<div class="q-item review">${head}
    ${r.transcript ? `<div class="q-transcript">${it.audio ? '🎤' : '📝'} «${esc(r.transcript)}»</div>` : ''}
    ${r.needs_review && r.question ? `<div class="q-question">❓ ${esc(r.question)}</div>` : ''}
    ${body}
    ${open.length > 1 ? `<div class="q-actions"><button class="btn small primary" data-act="saveall" data-id="${it.id}" type="button">✓ حفظ الكل (${open.length})</button></div>` : ''}
  </div>`;
}

$('#queue').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'relogin') { await sb.auth.signOut(); return; }
  const it = await ob.get(b.dataset.id);
  if (!it) { renderQueue(); return; }
  const x = it.exps ? it.exps.find((e) => e.id === b.dataset.x) : null;
  try {
    if (act === 'retry') {
      it.status = 'pending';
      it.error = null;
      if (it.errorCode === 'audio_format') it.useWav = true;
      await ob.put(it);
      processItem(it.id);
    } else if (act === 'del') {
      if (!confirm('حذف هذا الإدخال؟')) return;
      await ob.del(it.id);
    } else if (act === 'save' && x) {
      b.disabled = true;
      await saveQueued(it, x);
      await finalizeIfDone(it);
    } else if (act === 'saveall') {
      b.disabled = true;
      for (const e of it.exps) if (e.state === 'new') await saveQueued(it, e, { silent: true });
      toast('تم حفظ الكل ✓', 'ok');
      await finalizeIfDone(it);
    } else if (act === 'dismiss' && x) {
      x.state = 'dismissed';
      await ob.put(it);
      await finalizeIfDone(it);
      if (it.exps.every((e) => e.state === 'dismissed')) await ob.del(it.id);
    } else if (act === 'edit' && x) {
      openEditor(x.data, {
        title: 'مراجعة وتعديل',
        onSave: async (out) => {
          const fresh = await ob.get(it.id);
          if (!fresh) throw new AppError('gone', 'هذا الإدخال لم يعد موجوداً');
          const fx = fresh.exps.find((e) => e.id === x.id);
          fx.data = { ...fx.data, ...out };
          await saveQueued(fresh, fx);
          await finalizeIfDone(fresh);
          renderQueue();
        },
      });
    } else if (act === 'manual') {
      const blank = blankExpense({
        spent_at: it.createdAt,
        transcript: (it.result && it.result.transcript) || it.text || null,
        lat: it.loc ? it.loc.lat : null,
        lng: it.loc ? it.loc.lng : null,
        place_name: it.loc ? it.loc.place : null,
        source: sourceOf(it),
      });
      blank.image_indexes = it.images.map((_, i) => i);
      openEditor(blank, {
        title: 'إدخال يدوي',
        onSave: async (out) => {
          const fresh = await ob.get(it.id);
          if (!fresh) throw new AppError('gone', 'هذا الإدخال لم يعد موجوداً');
          const xid = crypto.randomUUID();
          const nx = { id: xid, state: 'new', data: { ...blank, ...out } };
          fresh.exps = [...(fresh.exps || []).filter((e) => e.state === 'saved'), nx];
          fresh.status = 'review';
          fresh.result = fresh.result || { transcript: blank.transcript, needs_review: false, question: null };
          await ob.put(fresh);
          await saveQueued(fresh, nx);
          await finalizeIfDone(fresh);
          renderQueue();
        },
      });
    }
  } catch (e) {
    toast(e.message || String(e), 'error', 6000);
  } finally {
    renderQueue();
  }
});

// ─────────────────────────── expense card & editor ───────────────────────────
function itemRow(i) {
  const q = Number(i.quantity) || 1;
  let qty = '';
  if (q !== 1 || i.unit) {
    qty = `<bdi>${L.fmtNum(q, 3)}${i.unit ? ' ' + esc(i.unit) : ''}</bdi>`;
    if (i.unit_price !== null && i.unit_price !== undefined && q !== 1) qty += ` × <span class="num">${L.fmtMoney(i.unit_price)}</span>`;
  }
  return `<li><span class="it-name">${esc(i.name)}${i.name_original ? ` <small><bdi>${esc(i.name_original)}</bdi></small>` : ''}</span><span class="it-qty">${qty}</span><span class="it-total num">${L.fmtMoney(i.total)}</span></li>`;
}

function expenseCard(e, { compact = false, clickable = false } = {}) {
  const items = e.items || [];
  const cats = L.uniq(items.map((i) => i.category));
  const title = e.merchant || e.purpose || (items[0] && items[0].name) || 'مصروف';
  const when = L.fmtDateTime(new Date(e.spent_at));
  const place = e.place_name || e.merchant_address || '';
  const photos = e.receipt_paths && e.receipt_paths.length ? ' · 🧾' : '';
  return `<div class="exp" ${clickable ? `data-open="${e.id}"` : ''}>
    <div class="exp-top"><div class="exp-title">${L.catEmoji(cats[0])} <bdi>${esc(title)}</bdi></div><div class="exp-total num">${L.fmtMoney(e.total, e.currency)}</div></div>
    <div class="exp-meta">${esc(when)}${place ? ` · 📍 <bdi>${esc(place)}</bdi>` : ''}${photos}</div>
    ${e.purpose && e.purpose !== title ? `<div class="exp-purpose">🎯 ${esc(e.purpose)}</div>` : ''}
    ${compact ? '' : `<ul class="exp-items">${items.map(itemRow).join('')}</ul>`}
    <div class="chips">${cats.map((c) => `<span class="chip" style="--c:${L.catColor(c)}">${esc(c)}</span>`).join('')}</div>
  </div>`;
}

function blankExpense(extra = {}) {
  return {
    spent_at: new Date().toISOString(),
    merchant: null, merchant_address: null, purpose: null, note: null, payment_method: null, currency: 'EUR',
    items: [{ name: '', name_original: null, category: '', quantity: 1, unit: null, unit_price: null, total: 0 }],
    total: 0, lat: null, lng: null, place_name: null, source: 'manual', transcript: null, receipt_paths: [], image_indexes: [],
    ...extra,
  };
}

function openEditor(exp, opts) {
  const e = JSON.parse(JSON.stringify(exp));
  if (!e.items || !e.items.length) e.items = blankExpense().items;
  const dt = new Date(e.spent_at || Date.now());
  openSheet(`
    <div class="sheet-head"><h2>${esc(opts.title || 'تعديل')}</h2><button class="icon-btn" data-close type="button" aria-label="إغلاق">✕</button></div>
    <form id="ed" class="ed" autocomplete="off" novalidate>
      <label>التاريخ والوقت<input type="datetime-local" name="spent_at" value="${L.toInputDateTime(dt)}" required></label>
      <label>المتجر / الجهة<input name="merchant" value="${esc(e.merchant || '')}" placeholder="مثلاً: Kaufland، مطعم…"></label>
      <label>المكان<input name="place_name" value="${esc(e.place_name || e.merchant_address || '')}"></label>
      <label>الغاية<input name="purpose" value="${esc(e.purpose || '')}" placeholder="مثلاً: للبيت، غداء مع زبون، للمكتب"></label>
      <label>ملاحظة<input name="note" value="${esc(e.note || '')}"></label>
      <label>طريقة الدفع<select name="payment_method">
        <option value="">—</option>
        <option value="نقداً" ${e.payment_method === 'نقداً' ? 'selected' : ''}>نقداً</option>
        <option value="بطاقة" ${e.payment_method === 'بطاقة' ? 'selected' : ''}>بطاقة</option>
      </select></label>
      <h3>الأصناف</h3>
      <div id="ed-items"></div>
      <button type="button" class="btn ghost" id="ed-add">+ إضافة صنف</button>
      <div class="ed-total">الإجمالي: <b class="num" id="ed-sum"></b></div>
      <div class="ed-actions">
        <button class="btn primary" type="submit">💾 حفظ</button>
        ${opts.onDelete ? '<button class="btn danger" type="button" id="ed-del">🗑️ حذف</button>' : ''}
        <button class="btn ghost" type="button" data-close>إلغاء</button>
      </div>
    </form>`);

  const host = $('#ed-items');
  const rowHtml = (it, idx) => `<div class="ed-item" data-i="${idx}">
      <button type="button" class="icon-btn f-del" aria-label="حذف الصنف">🗑️</button>
      <input class="f-name" list="dl-items" placeholder="الصنف (مثلاً: دخان، خبز…)" value="${esc(it.name || '')}">
      <input class="f-cat" list="dl-cats" placeholder="الفئة" value="${esc(it.category || '')}">
      <div class="ed-nums">
        <label>الكمية<input class="f-qty" inputmode="decimal" value="${L.numInput(it.quantity === null || it.quantity === undefined ? 1 : it.quantity)}"></label>
        <label>الوحدة<input class="f-unit" list="dl-units" value="${esc(it.unit || '')}"></label>
        <label>سعر الوحدة<input class="f-price" inputmode="decimal" value="${it.unit_price === null || it.unit_price === undefined ? '' : L.numInput(it.unit_price)}"></label>
        <label>المبلغ €<input class="f-total" inputmode="decimal" value="${L.numInput(it.total || 0)}"></label>
      </div>
    </div>`;
  const read = () => {
    $$('.ed-item', host).forEach((row) => {
      const it = e.items[+row.dataset.i];
      if (!it) return;
      it.name = $('.f-name', row).value.trim();
      it.category = $('.f-cat', row).value.trim();
      const q = L.parseNum($('.f-qty', row).value);
      it.quantity = q === null ? 1 : q;
      it.unit = $('.f-unit', row).value.trim() || null;
      it.unit_price = L.parseNum($('.f-price', row).value);
      const t = L.parseNum($('.f-total', row).value);
      it.total = t === null ? 0 : t;
    });
  };
  const sum = () => { $('#ed-sum').textContent = L.fmtMoney(L.sumItems(e.items)); };
  const draw = () => { host.innerHTML = e.items.map(rowHtml).join(''); sum(); };

  host.addEventListener('input', (ev) => {
    const row = ev.target.closest('.ed-item');
    if (!row) return;
    const q = L.parseNum($('.f-qty', row).value);
    const p = L.parseNum($('.f-price', row).value);
    if (ev.target.matches('.f-qty, .f-price') && q !== null && p !== null) $('.f-total', row).value = L.numInput(L.round2(q * p));
    if (ev.target.matches('.f-total')) {
      const t = L.parseNum(ev.target.value);
      if (t !== null && q) $('.f-price', row).value = L.numInput(L.round2(t / q));
    }
    read();
    sum();
  });
  host.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.f-del');
    if (!btn) return;
    read();
    e.items.splice(+btn.closest('.ed-item').dataset.i, 1);
    if (!e.items.length) e.items = blankExpense().items;
    draw();
  });
  $('#ed-add').addEventListener('click', () => {
    read();
    const lastCat = e.items.length ? e.items[e.items.length - 1].category : '';
    e.items.push({ name: '', name_original: null, category: lastCat || '', quantity: 1, unit: null, unit_price: null, total: 0 });
    draw();
    const rows = $$('.ed-item', host);
    rows[rows.length - 1].querySelector('.f-name').focus();
  });
  $('#ed').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    read();
    const f = ev.target;
    const items = e.items.filter((i) => i.name || (Number(i.total) || 0) !== 0);
    if (!items.length) { toast('أضف صنفاً واحداً على الأقل مع المبلغ', 'warn'); return; }
    for (const i of items) {
      if (!i.name) i.name = 'غير محدد';
      if (!i.category) i.category = 'أخرى';
      i.total = L.round2(Number(i.total) || 0);
      if (i.unit_price !== null && i.unit_price !== undefined) i.unit_price = L.round2(i.unit_price);
    }
    const when = L.fromInputDateTime(f.spent_at.value) || dt;
    const out = {
      ...e,
      spent_at: when.toISOString(),
      merchant: f.merchant.value.trim() || null,
      place_name: f.place_name.value.trim() || null,
      purpose: f.purpose.value.trim() || null,
      note: f.note.value.trim() || null,
      payment_method: f.payment_method.value || null,
      items,
      total: L.sumItems(items),
      mismatch: false,
    };
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    btn.textContent = 'جارٍ الحفظ…';
    try {
      await opts.onSave(out);
      closeSheet();
    } catch (err) {
      toast(err.message || 'تعذر الحفظ', 'error', 6000);
      btn.disabled = false;
      btn.textContent = '💾 حفظ';
    }
  });
  if (opts.onDelete) {
    $('#ed-del').addEventListener('click', async () => {
      if (!confirm('حذف هذا المصروف نهائياً؟')) return;
      try { await opts.onDelete(); closeSheet(); } catch (err) { toast(err.message || 'تعذر الحذف', 'error'); }
    });
  }
  draw();
}

// ─────────────────────────── data access ───────────────────────────
function rowToExpense(r) {
  const items = (r.expense_items || []).slice().sort((a, b) => a.position - b.position);
  return { ...r, total: Number(r.total) || 0, items };
}

async function fetchAll(build) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

async function saveExisting(id, out) {
  const { error } = await sb.rpc('save_expense', { p: L.toPayload({ ...out, id }) });
  if (error) throw new AppError('db', 'تعذر الحفظ: ' + error.message);
  toast('تم الحفظ ✓', 'ok');
  refreshAfterChange();
}

async function deleteExpense(e) {
  if (e.receipt_paths && e.receipt_paths.length) {
    await sb.storage.from('receipts').remove(e.receipt_paths);
  }
  const { error } = await sb.from('expenses').delete().eq('id', e.id);
  if (error) throw new AppError('db', 'تعذر الحذف: ' + error.message);
  toast('تم الحذف', 'ok');
  refreshAfterChange();
}

async function loadVocab() {
  const { data, error } = await sb.rpc('my_vocab');
  if (error || !data) return;
  state.vocab = { categories: data.categories || [], items: data.items || [] };
  const opt = (v) => `<option value="${esc(v)}"></option>`;
  $('#dl-cats').innerHTML = L.uniq([...state.vocab.categories.map((c) => c.name), ...L.DEFAULT_CATEGORIES]).map(opt).join('');
  $('#dl-items').innerHTML = state.vocab.items.map((i) => opt(i.name)).join('');
  $('#dl-units').innerHTML = L.uniq([...L.DEFAULT_UNITS, ...state.vocab.items.map((i) => i.unit)]).map(opt).join('');
  const sel = $('#h-cat');
  const cur = sel.value;
  sel.innerHTML = '<option value="">كل الفئات</option>' + state.vocab.categories.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  sel.value = cur;
}

async function loadSummary() {
  const now = new Date();
  const ws = L.startOfWeek(now);
  const ms = L.startOfMonth(now);
  const from = ws < ms ? ws : ms;
  const { data, error } = await sb.from('expenses').select('spent_at,total').gte('spent_at', from.toISOString());
  if (error || !data) return;
  const today = L.startOfDay(now);
  let t = 0, w = 0, m = 0;
  for (const r of data) {
    const d = new Date(r.spent_at);
    const v = Number(r.total) || 0;
    if (d >= today) t += v;
    if (d >= ws) w += v;
    if (d >= ms) m += v;
  }
  $('#sum-today').textContent = L.fmtMoney(t);
  $('#sum-week').textContent = L.fmtMoney(w);
  $('#sum-month').textContent = L.fmtMoney(m);
}

async function loadRecent() {
  const { data, error } = await sb.from('expenses').select('*, expense_items(*)').order('spent_at', { ascending: false }).limit(8);
  if (error) {
    $('#recent').innerHTML = `<div class="empty">تعذر التحميل: ${esc(error.message)}</div>`;
    return;
  }
  state.recent = (data || []).map(rowToExpense);
  $('#recent').innerHTML = state.recent.length
    ? state.recent.map((e) => expenseCard(e, { compact: true, clickable: true })).join('')
    : '<div class="empty">لا توجد مصاريف بعد – اضغط على الميكروفون وابدأ 🎤</div>';
}

function renderBanners() {
  const now = new Date();
  const out = [];
  if (now.getDay() === 1) out.push(`<div class="banner" data-report="lastweek"><span>📊 تقرير الأسبوع الماضي جاهز</span><span>←</span></div>`);
  if (now.getDate() <= 3) out.push(`<div class="banner" data-report="lastmonth"><span>📊 تقرير شهر ${esc(L.fmtMonth(L.addMonths(now, -1)))} جاهز</span><span>←</span></div>`);
  $('#banners').innerHTML = out.join('');
}

let refreshTimer;
function refreshAfterChange() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    loadVocab();
    loadSummary();
    loadRecent();
    if (state.view === 'history') loadHistory();
    if (state.view === 'reports') loadReport();
    if (state.view === 'settings') loadSettings();
  }, 150);
}

// ─────────────────────────── detail view ───────────────────────────
async function openDetail(id) {
  let e = state.history.rows.find((r) => r.id === id) || state.recent.find((r) => r.id === id);
  if (!e) {
    const { data, error } = await sb.from('expenses').select('*, expense_items(*)').eq('id', id).maybeSingle();
    if (error || !data) { toast('تعذر فتح المصروف', 'error'); return; }
    e = rowToExpense(data);
  }
  const map = e.lat !== null && e.lat !== undefined && e.lng !== null && e.lng !== undefined
    ? `<a href="https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}" target="_blank" rel="noopener">🗺️ فتح الموقع على الخريطة</a>`
    : '';
  const kv = [
    e.merchant_address ? ['عنوان المتجر', `<bdi>${esc(e.merchant_address)}</bdi>`] : null,
    e.note ? ['ملاحظة', esc(e.note)] : null,
    e.payment_method ? ['الدفع', esc(e.payment_method)] : null,
    e.transcript ? ['ما قلته', `«${esc(e.transcript)}»`] : null,
    ['المصدر', { voice: '🎤 صوت', photo: '📷 صورة', photo_voice: '📷🎤 صورة وصوت', text: '✍️ نص', manual: '✍️ يدوي' }[e.source] || esc(e.source)],
  ].filter(Boolean);
  openSheet(`
    <div class="sheet-head"><h2>تفاصيل المصروف</h2><button class="icon-btn" data-close type="button" aria-label="إغلاق">✕</button></div>
    ${expenseCard(e)}
    <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${map ? `<p>${map}</p>` : ''}
    <div class="detail-photos" id="d-photos">${(e.receipt_paths || []).map(() => '<a><span class="spinner sm"></span></a>').join('')}</div>
    <div class="ed-actions">
      <button class="btn primary" id="d-edit" type="button">✏️ تعديل</button>
      <button class="btn danger" id="d-del" type="button">🗑️ حذف</button>
      <button class="btn ghost" data-close type="button">إغلاق</button>
    </div>`);
  $('#d-edit').addEventListener('click', () => openEditor(e, {
    title: 'تعديل المصروف',
    onSave: (out) => saveExisting(e.id, out),
    onDelete: () => deleteExpense(e),
  }));
  $('#d-del').addEventListener('click', async () => {
    if (!confirm('حذف هذا المصروف نهائياً؟')) return;
    try { await deleteExpense(e); closeSheet(); } catch (err) { toast(err.message, 'error'); }
  });
  if (e.receipt_paths && e.receipt_paths.length) {
    const { data, error } = await sb.storage.from('receipts').createSignedUrls(e.receipt_paths, 3600);
    const host = $('#d-photos');
    if (host) {
      host.innerHTML = error || !data
        ? '<span class="muted small">تعذر تحميل الصور</span>'
        : data.filter((d) => d.signedUrl).map((d) => `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(d.signedUrl)}" alt="فاتورة" loading="lazy"></a>`).join('');
    }
  }
}

document.addEventListener('click', (ev) => {
  const open = ev.target.closest('[data-open]');
  if (open) { openDetail(open.dataset.open); return; }
  const goto = ev.target.closest('[data-goto]');
  if (goto) { showView(goto.dataset.goto); return; }
  const rep = ev.target.closest('[data-report]');
  if (rep) { state.report.key = rep.dataset.report; showView('reports'); }
});

// ─────────────────────────── history ───────────────────────────
async function loadHistory() {
  const m = state.history.month;
  const from = L.startOfMonth(m);
  const to = L.addMonths(m, 1);
  $('#h-month').textContent = L.fmtMonth(from);
  $('#h-next').disabled = to > new Date();
  $('#h-list').innerHTML = '<div class="empty"><span class="spinner sm"></span></div>';
  try {
    const rows = await fetchAll(() => sb.from('expenses').select('*, expense_items(*)')
      .gte('spent_at', from.toISOString()).lt('spent_at', to.toISOString()).order('spent_at', { ascending: false }));
    state.history.rows = rows.map(rowToExpense);
    renderHistory();
  } catch (e) {
    $('#h-list').innerHTML = `<div class="empty">تعذر التحميل: ${esc(e.message || e)}</div>`;
  }
}

function renderHistory() {
  const q = $('#h-search').value.trim().toLowerCase();
  const cat = $('#h-cat').value;
  const rows = state.history.rows.filter((e) => {
    if (cat && !e.items.some((i) => i.category === cat)) return false;
    if (!q) return true;
    const hay = [e.merchant, e.purpose, e.note, e.place_name, e.merchant_address, e.transcript, ...e.items.map((i) => `${i.name} ${i.name_original || ''} ${i.category}`)]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  const total = rows.reduce((a, e) => a + (cat ? L.sumItems(e.items.filter((i) => i.category === cat)) : e.total), 0);
  $('#h-total').innerHTML = rows.length ? `${rows.length} مصروف · المجموع: <span class="num">${L.fmtMoney(total)}</span>` : '';
  if (!rows.length) {
    $('#h-list').innerHTML = '<div class="empty">لا توجد مصاريف في هذه الفترة</div>';
    return;
  }
  const groups = new Map();
  for (const e of rows) {
    const k = L.dateKey(new Date(e.spent_at));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let html = '';
  for (const [k, list] of groups) {
    const d = L.parseLocalStamp(k);
    const dayTotal = list.reduce((a, e) => a + e.total, 0);
    html += `<div class="day-head"><span>${esc(L.fmtDay(d))}</span><span class="num">${L.fmtMoney(dayTotal)}</span></div>`;
    html += list.map((e) => expenseCard(e, { compact: false, clickable: true })).join('');
  }
  $('#h-list').innerHTML = html;
}

$('#h-prev').addEventListener('click', () => { state.history.month = L.addMonths(state.history.month, -1); loadHistory(); });
$('#h-next').addEventListener('click', () => { state.history.month = L.addMonths(state.history.month, 1); loadHistory(); });
$('#h-search').addEventListener('input', () => renderHistory());
$('#h-cat').addEventListener('change', () => renderHistory());

// ─────────────────────────── reports ───────────────────────────
async function loadReport() {
  const k = state.report.key;
  $$('#r-periods button').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
  $('#r-custom').hidden = k !== 'custom';
  if (k === 'custom' && (!state.report.from || !state.report.to)) {
    const now = new Date();
    $('#r-from').value = L.dateKey(L.startOfMonth(now));
    $('#r-to').value = L.dateKey(now);
    $('#r-body').innerHTML = '<div class="empty">اختر الفترة ثم اضغط «عرض»</div>';
    return;
  }
  const range = L.periodRange(k, new Date(), { from: state.report.from, to: state.report.to });
  $('#r-body').innerHTML = '<div class="empty"><span class="spinner sm"></span></div>';
  try {
    const [rows, prev] = await Promise.all([
      fetchAll(() => sb.from('v_items').select('*').gte('spent_at', range.from.toISOString()).lt('spent_at', range.to.toISOString()).order('spent_at')),
      fetchAll(() => sb.from('expenses').select('total').gte('spent_at', range.prevFrom.toISOString()).lt('spent_at', range.prevTo.toISOString())),
    ]);
    const agg = L.aggregate(rows, range);
    const prevTotal = L.round2(prev.reduce((a, r) => a + (Number(r.total) || 0), 0));
    state.report.data = { range, agg, prevTotal, rows };
    renderReport();
  } catch (e) {
    $('#r-body').innerHTML = `<div class="empty">تعذر التحميل: ${esc(e.message || e)}</div>`;
  }
}

function renderReport() {
  const { range, agg, prevTotal } = state.report.data;
  if (!agg.total && !agg.purchases) {
    $('#r-body').innerHTML = `<div class="card"><h2>${esc(range.label)}</h2><div class="empty">لا توجد مصاريف في هذه الفترة</div></div>`;
    return;
  }
  const diff = prevTotal > 0 ? ((agg.total - prevTotal) / prevTotal) * 100 : null;
  const cmpLabel = range.running ? 'مقارنة بنفس الفترة السابقة' : 'مقارنة بالفترة السابقة';
  const cmp = diff === null
    ? '<b>—</b>'
    : `<b class="${diff > 0 ? 'up' : 'down'} num">${diff > 0 ? '▲' : '▼'} ${L.fmtNum(Math.abs(diff), 0)}%</b>`;
  const avg = agg.total / range.days;
  const openCat = state.report.openCat;
  const cats = agg.categories.map((c) => `
    <div class="cat-row" data-cat="${esc(c.name)}">
      <div class="cat-line"><span>${L.catEmoji(c.name)} ${esc(c.name)}</span><span class="num">${L.fmtMoney(c.total)}</span></div>
      <div class="cat-sub">${L.fmtNum(c.pct, 1)}% · ${L.timesAr(c.count)}</div>
      <div class="bar" style="--c:${L.catColor(c.name)}"><i style="width:${Math.max(1, c.pct).toFixed(1)}%"></i></div>
      ${openCat === c.name ? `<div class="cat-items">${c.items.map((i) => `<div><span>${esc(i.name)}</span><span class="q"><bdi>${esc(i.qty)}</bdi></span><span class="num">${L.fmtMoney(i.total)}</span></div>`).join('')}</div>` : ''}
    </div>`).join('');
  const topItems = agg.items.slice(0, 15).map((i) => `<div><span>${L.catEmoji(i.category)} ${esc(i.name)}</span><span class="q"><bdi>${esc(i.qty)}</bdi></span><span class="num">${L.fmtMoney(i.total)}</span></div>`).join('');
  const places = agg.places.slice(0, 10).map((p) => `<div><span>📍 <bdi>${esc(p.name)}</bdi></span><span class="q">${L.timesAr(p.count)}</span><span class="num">${L.fmtMoney(p.total)}</span></div>`).join('');
  $('#r-body').innerHTML = `
    <div class="kpis">
      <div class="kpi main"><span>${esc(range.label)} – الإجمالي</span><b class="num">${L.fmtMoney(agg.total)}</b></div>
      <div class="kpi"><span>عدد المشتريات</span><b class="num">${agg.purchases}</b></div>
      <div class="kpi"><span>المعدل اليومي</span><b class="num">${L.fmtMoney(avg)}</b></div>
      <div class="kpi"><span>${cmpLabel}</span>${cmp}<div class="small muted num">${L.fmtMoney(prevTotal)}</div></div>
    </div>
    <div class="card"><h2>حسب الفئة</h2><p class="muted small">اضغط على فئة لرؤية الأصناف والكميات.</p>${cats}</div>
    <div class="card"><h2>على مدار الفترة</h2><div class="chart">${chartSvg(agg.series, range.bucket)}</div><div class="chart-cap" id="chart-cap">اضغط على عمود لرؤية المبلغ</div></div>
    <div class="card"><h2>أكثر الأصناف</h2><div class="top-list">${topItems}</div></div>
    <div class="card"><h2>حسب المكان</h2><div class="top-list">${places}</div></div>
    <button class="btn block" id="r-export" type="button">⬇️ تصدير إلى Excel (CSV)</button>`;
}

function chartSvg(series, bucket) {
  if (!series.length) return '';
  const W = 600, H = 190, padB = 22, padT = 10;
  const max = Math.max(...series.map((b) => b.total), 1);
  const bw = W / series.length;
  const every = Math.ceil(series.length / 12);
  let out = '';
  series.forEach((b, i) => {
    const h = Math.round(((H - padB - padT) * b.total) / max);
    const vis = b.total > 0 ? Math.max(h, 2) : 0;
    const cap = `${bucket === 'month' ? L.fmtMonth(b.date) : L.fmtDay(b.date)}: ${L.fmtMoney(b.total)}`;
    out += `<rect class="b" data-i="${i}" x="${(i * bw + bw * 0.15).toFixed(1)}" y="${H - padB - vis}" width="${(bw * 0.7).toFixed(1)}" height="${vis}" rx="3"></rect>`;
    out += `<rect class="hit" data-i="${i}" data-cap="${esc(cap)}" x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}" fill="transparent"></rect>`;
    if (i % every === 0) out += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="رسم بياني للمصاريف">${out}</svg>`;
}

$('#r-body').addEventListener('click', (ev) => {
  const row = ev.target.closest('.cat-row');
  if (row) {
    state.report.openCat = state.report.openCat === row.dataset.cat ? null : row.dataset.cat;
    renderReport();
    return;
  }
  const bar = ev.target.closest('rect[data-cap]');
  if (bar) {
    $$('#r-body rect.b').forEach((r) => r.classList.toggle('sel', r.dataset.i === bar.dataset.i));
    $('#chart-cap').textContent = bar.dataset.cap;
    return;
  }
  if (ev.target.closest('#r-export')) exportCsv();
});

function exportCsv() {
  const d = state.report.data;
  if (!d) return;
  const csv = L.toCSV(d.rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `masarifi_${L.dateKey(d.range.from)}_${L.dateKey(L.addDays(d.range.to, -1))}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$('#r-periods').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-k]');
  if (!b) return;
  state.report.key = b.dataset.k;
  state.report.openCat = null;
  if (b.dataset.k !== 'custom') { state.report.from = null; state.report.to = null; }
  loadReport();
});
$('#r-custom').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const from = L.parseLocalStamp($('#r-from').value);
  const to = L.parseLocalStamp($('#r-to').value);
  if (!from || !to) { toast('اختر التاريخين', 'warn'); return; }
  state.report.from = from;
  state.report.to = to;
  loadReport();
});

// ─────────────────────────── settings ───────────────────────────
async function loadSettings() {
  $('#s-email').textContent = state.user ? state.user.email : '';
  $('#s-autosave').checked = settings.autoSave;
  $('#s-location').checked = settings.useLocation;
  $('#s-version').textContent = APP_VERSION;
  $('#s-limit').textContent = String(AI_MONTHLY_LIMIT);
  const { data } = await sb.from('ai_usage').select('calls').eq('month', L.monthKey(new Date())).maybeSingle();
  $('#s-usage').textContent = String((data && data.calls) || 0);
  await loadVocab();
  $('#s-cats').innerHTML = state.vocab.categories.length
    ? state.vocab.categories.map((c) => `<div class="lc-row" data-rename-cat="${esc(c.name)}"><span>${L.catEmoji(c.name)} ${esc(c.name)}</span><span class="muted num">${L.fmtMoney(c.sum)}</span></div>`).join('')
    : '<div class="muted small">ستظهر الفئات هنا بعد أول مصروف.</div>';
  $('#s-items').innerHTML = state.vocab.items.length
    ? state.vocab.items.slice(0, 80).map((i) => `<div class="lc-row" data-rename-item="${esc(i.name)}"><span>${esc(i.name)} <small class="muted">${esc(i.category || '')}</small></span><span class="muted">${L.timesAr(i.n)}</span></div>`).join('')
    : '<div class="muted small">ستظهر الأصناف هنا بعد أول مصروف.</div>';
}

$('#view-settings').addEventListener('click', async (ev) => {
  const c = ev.target.closest('[data-rename-cat]');
  const i = ev.target.closest('[data-rename-item]');
  if (!c && !i) return;
  const isCat = !!c;
  const old = isCat ? c.dataset.renameCat : i.dataset.renameItem;
  const nn = prompt(isCat
    ? `اسم جديد للفئة «${old}»\n(اكتب اسم فئة موجودة لدمجهما)`
    : `اسم جديد للصنف «${old}»\n(اكتب اسم صنف موجود لدمجهما)`, old);
  if (nn === null) return;
  const name = nn.trim();
  if (!name || name === old) return;
  const { error } = await sb.from('expense_items').update(isCat ? { category: name } : { name }).eq(isCat ? 'category' : 'name', old);
  if (error) { toast('تعذر التغيير: ' + error.message, 'error'); return; }
  toast('تم التغيير ✓', 'ok');
  refreshAfterChange();
  loadSettings();
});
$('#s-autosave').addEventListener('change', (e) => { settings.autoSave = e.target.checked; });
$('#s-location').addEventListener('change', (e) => {
  settings.useLocation = e.target.checked;
  if (e.target.checked) startLocation();
});
$('#s-logout').addEventListener('click', async () => {
  if (!confirm('تسجيل الخروج من هذا الجهاز؟')) return;
  await sb.auth.signOut();
});
$('#s-reload').addEventListener('click', async () => {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    if (regs) await Promise.all(regs.map((r) => r.update()));
  } catch { /* ignore */ }
  location.reload();
});

// ─────────────────────────── navigation ───────────────────────────
function showView(v) {
  state.view = v;
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  window.scrollTo({ top: 0 });
  if (v === 'history') loadHistory();
  if (v === 'reports') loadReport();
  if (v === 'settings') loadSettings();
  if (v === 'add') { loadSummary(); loadRecent(); renderBanners(); }
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ─────────────────────────── add-view wiring ───────────────────────────
$('#btn-mic').addEventListener('click', () => toggleMic());
$('#btn-camera').addEventListener('click', () => { startLocation(); $('#file-camera').click(); });
$('#btn-gallery').addEventListener('click', () => $('#file-gallery').click());
$('#draft-more').addEventListener('click', () => $('#file-camera').click());
$('#file-camera').addEventListener('change', async (e) => { await addPhotos(e.target.files); e.target.value = ''; });
$('#file-gallery').addEventListener('change', async (e) => { await addPhotos(e.target.files); e.target.value = ''; });
$('#draft-thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  const [d] = state.draftImages.splice(+b.dataset.rm, 1);
  if (d) URL.revokeObjectURL(d.url);
  renderDraft();
});
$('#draft-cancel').addEventListener('click', () => { clearDraft(); state.pendingLoc = null; });
$('#draft-go').addEventListener('click', () => {
  if (rec.active) { finishRecording(); return; }
  const text = $('#text-input').value.trim();
  $('#text-input').value = '';
  createEntry({ text: text || null });
});
$('#text-input').addEventListener('focus', () => startLocation());
$('#text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#text-input').value.trim();
  if (!text && !state.draftImages.length) { toast('اكتب المصروف أولاً، مثلاً: خبز 2,50', 'warn'); return; }
  $('#text-input').value = '';
  $('#text-input').blur();
  createEntry({ text: text || null });
});
$('#btn-manual').addEventListener('click', async () => {
  startLocation();
  const images = state.draftImages.map((d) => d.blob);
  const loc = await withTimeout(state.pendingLoc || Promise.resolve(null), 1500, null);
  const blank = blankExpense({
    lat: loc ? loc.lat : null, lng: loc ? loc.lng : null, place_name: loc ? loc.place || null : null,
    source: images.length ? 'photo' : 'manual',
  });
  openEditor(blank, {
    title: 'إدخال يدوي',
    onSave: async (out) => {
      const id = crypto.randomUUID();
      const paths = [];
      for (let k = 0; k < images.length; k++) {
        const path = `${state.user.id}/${id}/${k + 1}.jpg`;
        const { error } = await sb.storage.from('receipts').upload(path, images[k], { contentType: 'image/jpeg', upsert: true });
        if (error) throw new AppError('storage', 'تعذر رفع الصورة: ' + error.message);
        paths.push(path);
      }
      const { error } = await sb.rpc('save_expense', { p: L.toPayload({ ...out, id, receipt_paths: paths }) });
      if (error) throw new AppError('db', 'تعذر الحفظ: ' + error.message);
      if (images.length) clearDraft();
      state.pendingLoc = null;
      toast('تم الحفظ ✓', 'ok');
      refreshAfterChange();
    },
  });
});

// ─────────────────────────── auth ───────────────────────────
function authMsg(text, ok = false) {
  const m = $('#auth-msg');
  m.hidden = !text;
  m.textContent = text || '';
  m.classList.toggle('ok', ok);
}

function mapAuthError(error) {
  const m = String(error?.message || error || '');
  if (/invalid login credentials/i.test(m)) return 'البريد أو كلمة المرور غير صحيحة';
  if (/email not confirmed/i.test(m)) return 'لم يتم تأكيد البريد بعد – افتح رسالة التأكيد في بريدك واضغط الرابط';
  if (/database error saving new user|registration closed/i.test(m)) return 'التسجيل مغلق – الحساب موجود مسبقاً. استخدم «دخول».';
  if (/already registered|already been registered/i.test(m)) return 'هذا البريد مسجل مسبقاً – استخدم «دخول»';
  if (/rate limit|too many|security purposes/i.test(m)) return 'محاولات كثيرة – انتظر قليلاً ثم حاول مجدداً';
  if (/password/i.test(m) && /(weak|short|least|characters)/i.test(m)) return 'كلمة المرور ضعيفة – استخدم 8 أحرف على الأقل مع أرقام';
  if (isNetErr(error)) return 'لا يوجد اتصال بالإنترنت';
  return m || 'حدث خطأ';
}

$('#auth-toggle').addEventListener('click', () => {
  const f = $('#auth-form');
  const signup = f.dataset.mode !== 'signup';
  f.dataset.mode = signup ? 'signup' : 'login';
  $('#auth-submit').textContent = signup ? 'إنشاء الحساب' : 'دخول';
  $('#auth-toggle').textContent = signup ? 'لدي حساب – دخول' : 'أول مرة؟ إنشاء الحساب';
  f.password.autocomplete = signup ? 'new-password' : 'current-password';
  authMsg('');
});

$('#auth-forgot').addEventListener('click', async () => {
  const email = $('#auth-form').email.value.trim();
  if (!email) { authMsg('اكتب بريدك الإلكتروني أولاً ثم اضغط «نسيت كلمة المرور؟»'); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  authMsg(error ? mapAuthError(error) : '✅ أرسلنا لك رابطاً لتعيين كلمة مرور جديدة – افتح بريدك.', !error);
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim();
  const password = f.password.value;
  if (!email || !password) { authMsg('اكتب البريد وكلمة المرور'); return; }
  const btn = $('#auth-submit');
  btn.disabled = true;
  authMsg('');
  try {
    if (f.dataset.mode === 'signup') {
      if (password.length < 8) { authMsg('كلمة المرور يجب أن تكون 8 أحرف على الأقل'); return; }
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) authMsg(mapAuthError(error));
      else if (!data.session) authMsg('✅ تم إنشاء الحساب. افتح بريدك واضغط رابط التأكيد، ثم ارجع هنا واضغط «دخول».', true);
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) authMsg(mapAuthError(error));
    }
  } catch (err) {
    authMsg(mapAuthError(err));
  } finally {
    btn.disabled = false;
  }
});

function showRecovery() {
  openSheet(`
    <div class="sheet-head"><h2>كلمة مرور جديدة</h2><button class="icon-btn" data-close type="button">✕</button></div>
    <form id="rec-form" class="ed">
      <label>كلمة المرور الجديدة<input type="password" name="pw" autocomplete="new-password" minlength="8" required></label>
      <div class="ed-actions"><button class="btn primary" type="submit">حفظ</button></div>
    </form>`);
  $('#rec-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = ev.target.pw.value;
    if (pw.length < 8) { toast('8 أحرف على الأقل', 'warn'); return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { toast(mapAuthError(error), 'error'); return; }
    toast('تم تغيير كلمة المرور ✓', 'ok');
    closeSheet();
  });
}

let authReady = false;
async function handleSession(session) {
  const u = session ? session.user : null;
  const same = authReady && ((u && u.id) || null) === ((state.user && state.user.id) || null);
  authReady = true;
  $('#boot').hidden = true;
  if (same) { if (u) state.user = u; return; }
  state.user = u;
  if (u) {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    if (location.hash.includes('access_token') || location.hash.includes('type=')) history.replaceState(null, '', location.pathname);
    await loadVocab();
    showView('add');
    renderQueue();
    processAll();
  } else {
    $('#app').hidden = true;
    $('#auth').hidden = false;
  }
}

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') setTimeout(showRecovery, 300);
  setTimeout(() => handleSession(session), 0);
});

// error coming back from an e-mail link (e.g. expired confirmation link)
(() => {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const err = h.get('error_description') || new URLSearchParams(location.search).get('error_description');
  if (err) {
    authMsg(/expired|invalid/i.test(err)
      ? 'رابط البريد منتهي الصلاحية أو غير صالح – سجّل الدخول، أو اطلب رابطاً جديداً'
      : decodeURIComponent(err.replace(/\+/g, ' ')));
    history.replaceState(null, '', location.pathname);
  }
})();

// safety net: never stay on the loading screen
setTimeout(async () => {
  if (authReady) return;
  try {
    const { data } = await sb.auth.getSession();
    handleSession(data ? data.session : null);
  } catch {
    handleSession(null);
  }
}, 5000);

// ─────────────────────────── connectivity & install ───────────────────────────
function updateOnline() { $('#offline').hidden = navigator.onLine; }
window.addEventListener('online', () => { updateOnline(); processAll(); });
window.addEventListener('offline', updateOnline);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) {
    processAll();
    if (state.view === 'add') { loadSummary(); renderBanners(); }
  }
});
updateOnline();

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch { /* ignore */ }
  installEvent = null;
  $('#btn-install').hidden = true;
});
window.addEventListener('appinstalled', () => { $('#btn-install').hidden = true; toast('تم تثبيت التطبيق ✓', 'ok'); });

if ('serviceWorker' in navigator) {
  const registerSW = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (document.readyState === 'complete') registerSW();
  else window.addEventListener('load', registerSW);
}

// expose for debugging in the console
window.masarifi = { sb, state, ob, processAll, version: APP_VERSION };
