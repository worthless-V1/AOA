const PER_PAGE = 6;
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const MIME = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
const mime = n => MIME[n.split('.').pop().toLowerCase()] || 'image/jpeg';
const isPage = n => /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(n) && !/__MACOSX|(^|[\\/])\./.test(n);
const enc = f => f.split('/').map(encodeURIComponent).join('/');

/* ---------- saved covers (IndexedDB) and reading progress (localStorage) ---------- */
const db = new Promise(res => {
  try {
    const r = indexedDB.open('bullseye', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('covers');
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  } catch { res(null); }
});
const idb = async (mode, fn) => {
  const d = await db; if (!d) return;
  return new Promise(res => { try { const q = fn(d.transaction('covers', mode).objectStore('covers')); q.onsuccess = () => res(q.result); q.onerror = () => res(); } catch { res(); } });
};
const getCover = k => idb('readonly', s => s.get(k));
const putCover = (k, b) => idb('readwrite', s => s.put(b, k));
const progress = () => { try { return JSON.parse(localStorage.getItem('bullseye-progress')) || {}; } catch { return {}; } };
const saveProgress = (file, page, total) => { try { const p = progress(); p[file] = { page, total }; localStorage.setItem('bullseye-progress', JSON.stringify(p)); } catch {} };

/* ---------- reading CBR (RAR) and CBZ (ZIP) in the browser ---------- */
let rarP;
const loadRar = () => rarP ||= (async () => {
  let api;
  for (const u of ['https://esm.sh/node-unrar-js@2', 'https://cdn.jsdelivr.net/npm/node-unrar-js@2/+esm']) {
    try { const m = await import(u); api = m.createExtractorFromData ? m : m.default; if (api?.createExtractorFromData) break; } catch {}
  }
  if (!api?.createExtractorFromData) throw new Error('Could not load the RAR engine. Check your connection.');
  let wasm;
  for (const p of ['esm/js/unrar.wasm', 'dist/js/unrar.wasm']) {
    try { const r = await fetch('https://cdn.jsdelivr.net/npm/node-unrar-js@2/' + p); if (r.ok) { wasm = await r.arrayBuffer(); break; } } catch {}
  }
  if (!wasm) throw new Error('Could not load the RAR engine (wasm). Check your connection.');
  return data => api.createExtractorFromData({ wasmBinary: wasm, data });
})().catch(e => { rarP = null; throw e; });

async function readArchive(file, { firstOnly = false, onProgress, onStatus } = {}) {
  const res = await fetch(enc(file));
  if (!res.ok) throw new Error(`Could not load ${file} (${res.status}). Check the path in comics.json.`);
  const total = +res.headers.get('content-length') || 0, mb = n => Math.round(n / 1048576);
  const tick = () => new Promise(r => setTimeout(r, 30));
  let buf;
  if (res.body && onStatus) {                                 // download with visible progress
    const rd = res.body.getReader(), parts = []; let got = 0, last = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      parts.push(value); got += value.length;
      const t = total ? `Downloading ${mb(got)} of ${mb(total)} MB` : `Downloading ${mb(got)} MB`;
      if (t !== last) onStatus(last = t);
    }
    buf = await new Blob(parts).arrayBuffer();
  } else buf = await res.arrayBuffer();
  const h = new Uint8Array(buf, 0, 4), pages = [];
  if (h[0] === 0x50 && h[1] === 0x4b) {                       // ZIP (.cbz, or a .cbr that is really a zip)
    if (typeof JSZip === 'undefined') throw new Error('Could not load the ZIP engine. Check your connection.');
    onStatus?.('Unpacking…'); await tick();
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir && isPage(n)).sort(nat);
    const want = firstOnly ? names.slice(0, 1) : names;
    for (const n of want) {
      pages.push({ name: n, blob: new Blob([await zip.files[n].async('uint8array')], { type: mime(n) }) });
      onProgress?.(pages.length, want.length);
    }
  } else if (h[0] === 0x52 && h[1] === 0x61) {               // RAR (.cbr)
    onStatus?.('Loading RAR engine…'); await tick();
    const rar = await (await loadRar())(buf);
    onStatus?.('Unpacking…'); await tick();
    const names = [...rar.getFileList().fileHeaders].filter(f => !f.flags.directory && isPage(f.name)).map(f => f.name).sort(nat);
    const want = firstOnly ? names.slice(0, 1) : names;
    if (want.length) for (const f of rar.extract({ files: want }).files) {
      pages.push({ name: f.fileHeader.name, blob: new Blob([f.extraction.data], { type: mime(f.fileHeader.name) }) });
      onProgress?.(pages.length, want.length);
      await new Promise(r => setTimeout(r));                  // keep the page responsive
    }
    pages.sort((a, b) => nat(a.name, b.name));
  } else throw new Error('Unsupported archive. Use a real .cbr (RAR) or .cbz (ZIP).');
  if (!pages.length) throw new Error('No images found inside this comic.');
  return pages;
}

/* ---------- library grid: 6 comics per page ---------- */
let comics = [], gen = 0, queue = Promise.resolve();

async function makeThumb(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const w = Math.min(320, bmp.width), h = Math.round(bmp.height * w / bmp.width);
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return await new Promise(r => c.toBlob(b => r(b || blob), 'image/jpeg', .8));
  } catch { return blob; }
}

function loadCover(c, img, ph) {                               // first page of the CBR = thumbnail
  const my = gen;
  img.onload = () => ph.remove();
  const fail = e => { ph.textContent = e?.message || 'Cover unavailable'; ph.classList.add('err'); };
  img.onerror = () => fail();
  queue = queue.then(async () => {
    if (my !== gen) return;                                    // user already changed page
    try {
      if (c.cover) return void (img.src = enc(c.cover));       // optional pre-made cover
      let blob = await getCover(c.file);
      if (!blob) {
        const [first] = await readArchive(c.file, { firstOnly: true, onStatus: t => ph.textContent = t });
        blob = await makeThumb(first.blob);
        putCover(c.file, blob);
      }
      img.src = URL.createObjectURL(blob);
    } catch (e) { fail(e); }
  });
}

function card(c) {
  const a = el('article', 'card'), cover = el('div', 'cover'), img = el('img'), ph = el('div', 'ph', 'Reading cover…'), bar = el('i');
  a.tabIndex = 0; img.alt = c.title; c._bar = bar;
  const s = progress()[c.file]; if (s) bar.style.width = s.page / s.total * 100 + '%';
  const prog = el('div', 'prog'); prog.append(bar);
  cover.append(img, ph, el('span', 'badge', (c.file.split('.').pop() || 'cbr').toUpperCase()), prog);
  a.append(cover, el('h2', 'title', c.title));
  const meta = [c.author, c.year].filter(Boolean).join(', ');
  if (meta) a.append(el('p', 'meta', meta));
  a.onclick = () => openReader(c);
  a.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReader(c); } };
  loadCover(c, img, ph);
  return a;
}

function pager(p, n) {
  const nav = $('#pager'); nav.replaceChildren();
  if (n < 2) return;
  const add = (label, to, cls) => { const a = el('a', cls, label); if (to) a.href = '#' + to; else a.className = 'off'; nav.append(a); };
  add('Prev', p > 1 && p - 1);
  let last = 0;
  for (let i = 1; i <= n; i++) if (i === 1 || i === n || Math.abs(i - p) <= 1) {
    if (i - last > 1) nav.append(el('span', 'gap', '…'));
    add(i, i, i === p ? 'on' : ''); last = i;
  }
  add('Next', p < n && p + 1);
}

function render() {
  const n = Math.max(1, Math.ceil(comics.length / PER_PAGE));
  const p = Math.min(n, Math.max(1, parseInt(location.hash.slice(1)) || 1));
  const grid = $('#grid'); grid.replaceChildren(); gen++;
  if (!comics.length) grid.append(el('p', 'empty', 'No comics yet. Put .cbr files in data/cbr/ and list them in data/comics.json.'));
  comics.slice((p - 1) * PER_PAGE, p * PER_PAGE).forEach(c => grid.append(card(c)));
  pager(p, n);
  scrollTo(0, 0);
}

/* ---------- reader ---------- */
const R = { pages: [], i: 0, comic: null, fit: 'height', token: 0 };
const msg = t => $('#rmsg').textContent = t;

async function openReader(c) {
  const t = ++R.token;
  Object.assign(R, { comic: c, pages: [], i: 0 });
  $('#reader').hidden = false; document.body.classList.add('lock');
  $('#rtitle').textContent = c.title; $('#rcount').textContent = '';
  $('#page').removeAttribute('src');
  msg('Downloading…');
  try {
    const pages = await readArchive(c.file, { onStatus: s => t === R.token && msg(s), onProgress: (n, total) => t === R.token && msg(`Extracting page ${n} of ${total}`) });
    if (t !== R.token) return;
    R.pages = pages; msg('');
    show((progress()[c.file]?.page || 1) - 1);
  } catch (e) { if (t === R.token) msg(e.message); }
}

function show(i) {
  if (!R.pages.length) return;
  R.i = Math.max(0, Math.min(R.pages.length - 1, i));
  const p = R.pages[R.i], nx = R.pages[R.i + 1];
  p.url ||= URL.createObjectURL(p.blob);
  $('#page').src = p.url;
  if (nx) { nx.url ||= URL.createObjectURL(nx.blob); new Image().src = nx.url; }
  $('#rcount').textContent = `${R.i + 1} / ${R.pages.length}`;
  $('#stage').scrollTop = 0;
  saveProgress(R.comic.file, R.i + 1, R.pages.length);
}

function closeReader() {
  R.token++;
  R.pages.forEach(p => p.url && URL.revokeObjectURL(p.url));
  R.pages = [];
  $('#page').removeAttribute('src');
  $('#reader').hidden = true; document.body.classList.remove('lock');
  const s = R.comic && progress()[R.comic.file];
  if (s && R.comic._bar) R.comic._bar.style.width = s.page / s.total * 100 + '%';
}

$('#close').onclick = closeReader;
$('#prev').onclick = () => show(R.i - 1);
$('#next').onclick = () => show(R.i + 1);
$('#page').onclick = e => show(R.i + (e.offsetX < e.target.clientWidth / 2 ? -1 : 1));
$('#fit').onclick = e => {
  R.fit = R.fit === 'height' ? 'width' : 'height';
  $('#reader').dataset.fit = R.fit;
  e.target.textContent = R.fit === 'height' ? 'Fit width' : 'Fit screen';
};
addEventListener('keydown', e => {
  if ($('#reader').hidden) return;
  const k = e.key;
  if (k === 'Escape') closeReader();
  else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { e.preventDefault(); show(R.i + 1); }
  else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); show(R.i - 1); }
  else if (k === 'Home') show(0);
  else if (k === 'End') show(R.pages.length - 1);
});
let sx = null;
$('#stage').addEventListener('touchstart', e => sx = e.touches[0].clientX, { passive: true });
$('#stage').addEventListener('touchend', e => {
  if (sx == null) return;
  const dx = e.changedTouches[0].clientX - sx; sx = null;
  if (Math.abs(dx) > 60) show(R.i + (dx < 0 ? 1 : -1));
});

/* ---------- start ---------- */
addEventListener('hashchange', render);
(async () => {
  try {
    const j = await (await fetch('data/comics.json', { cache: 'no-cache' })).json();
    comics = (j.comics || []).map(c => typeof c === 'string' ? { file: c } : c).filter(c => c && c.file)
      .map(c => ({ ...c, title: c.title || c.file.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') }));
  } catch { $('#grid').append(el('p', 'empty', 'Could not read data/comics.json. If testing locally, serve the folder (python3 -m http.server) instead of opening the file.')); return; }
  render();
})();
                                             
