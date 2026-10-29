/* Shared by the viewer (index.html) and the car manager (manage-local.html; manage.html on the public site).

   Built-in cars come from cars/index.js. Uploaded cars are view-only spins made in the browser from a video
   (no dots or animations). Where they are kept depends on config.js:
   - window.SHOWROOM_API set (the public site): in the shared online store (deploy/worker), so every visitor
     sees them. Anyone can add a car; removing an upload or hiding / restoring a built-in car needs the
     password, which the store checks.
   - not set: in this browser's own storage (IndexedDB) on this computer only. Removing an uploaded car
     deletes it; removing a built-in car only hides it in this browser (restorable). */
window.Garage = (() => {
  const VIEWS = 180;          // views taken from an uploaded video (one per 2 degrees for a full turn)
  const MAX_W = 1280;         // larger videos are scaled down to this width
  const API = (window.SHOWROOM_API || '').replace(/\/$/, '');

  // ---------- video -> spin (in the browser) ----------
  const once = (el, ev) => new Promise((res, rej) => {
    el.addEventListener(ev, res, { once: true });
    el.addEventListener('error', () => rej(new Error('This video format can\'t be read by the browser.')), { once: true });
  });
  const toBlob = (canvas, q) => new Promise(r => canvas.toBlob(r, 'image/jpeg', q));

  /** One full turn from a video file as JPEG views. budget: keep all views together under this many bytes
      (quality is lowered as needed). onProgress(text, share 0..1). */
  async function readSpin(file, onProgress, budget = Infinity, share = 0.95) {
    onProgress('Reading video…', 0);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = URL.createObjectURL(file);
    await once(video, 'loadedmetadata');
    const dur = video.duration;
    if (!isFinite(dur) || dur <= 0) throw new Error('Could not read the video length.');
    const scale = Math.min(1, MAX_W / video.videoWidth);
    const W = Math.round(video.videoWidth * scale), H = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    // tiny copy of each view to spot pauses (views identical to the previous one are skipped)
    const tiny = document.createElement('canvas'); tiny.width = 64; tiny.height = 48;
    const tctx = tiny.getContext('2d', { willReadFrequently: true });
    let last = null, q = 0.9, bytes = 0;
    const blobs = [];
    for (let i = 0; i < VIEWS; i++) {
      video.currentTime = Math.min(dur - 0.001, (i + 0.5) * dur / VIEWS);
      await once(video, 'seeked');
      onProgress(`Preparing the spin… ${Math.round((i + 1) / VIEWS * 100)}%`, (i + 1) / VIEWS * share);
      tctx.drawImage(video, 0, 0, 64, 48);
      const px = tctx.getImageData(0, 0, 64, 48).data;
      if (last) {
        let d = 0;
        for (let k = 0; k < px.length; k += 4) d += Math.abs(px[k] - last[k]) + Math.abs(px[k + 1] - last[k + 1]);
        if (d / (px.length / 2) < 0.8) continue;
      }
      last = px;
      ctx.drawImage(video, 0, 0, W, H);
      const b = await toBlob(canvas, q);
      blobs.push(b); bytes += b.size;
      // on course to go over the budget? lower the quality of the views still to come
      if (bytes / (i + 1) * VIEWS > budget * 0.92 && q > 0.55) q = Math.max(0.55, q - 0.05);
    }
    URL.revokeObjectURL(video.src);
    if (blobs.length < 8) throw new Error('The video barely moves - it needs to show the car turning.');
    if (bytes > budget) throw new Error('This video makes too large a spin - try a shorter or smaller video.');
    const th = document.createElement('canvas'); th.width = 240; th.height = Math.round(240 * H / W);
    th.getContext('2d').drawImage(await createImageBitmap(blobs[Math.round(blobs.length / 8)]), 0, 0, th.width, th.height);
    return { blobs, W, H, bytes, thumb: await toBlob(th, 0.85) };
  }

  const builtIns = hid => (window.CARS || []).map(c => ({
    ...c, kind: 'builtin', hidden: hid.includes(c.id),
    thumbUrl: c.thumb ? `cars/${c.id}/${c.thumb}${c.v ? '?v=' + c.v : ''}` : null
  }));
  const newId = () => 'up-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ======================= shared online store (public site) =======================
  function shared() {
    const BUDGET = 22 * 1024 * 1024;               // the store takes up to 24 MB per car
    const call = async (path, opts = {}) => {
      const r = await fetch(API + path, opts);
      if (!r.ok) {
        let msg = `Request failed (${r.status})`;
        try { msg = (await r.json()).error || msg; } catch (e) { /* not json */ }
        const err = new Error(msg.charAt(0).toUpperCase() + msg.slice(1)); err.status = r.status;
        throw err;
      }
      return r;
    };
    let lastHidden = [];
    let online = true;

    async function list() {
      let data = { uploads: [], hidden: [] };
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
        data = await (await call('/cars', { signal: ctl.signal, cache: 'no-store' })).json();
        clearTimeout(t); online = true;
      } catch (e) { online = false; }           // store unreachable: show the built-in cars anyway
      lastHidden = data.hidden || [];
      const ups = (data.uploads || []).map(c => ({
        ...c, kind: 'upload', hidden: false, subtitle: 'Uploaded · view only', thumbUrl: `${API}/cars/${c.id}/thumb`
      }));
      return [...builtIns(lastHidden), ...ups];
    }

    async function frameUrls(car, onProgress = () => {}) {
      const meta = await (await call(`/cars/${car.id}/meta`)).json();
      const r = await call(`/cars/${car.id}/frames`);
      // read with progress: a spin is several MB
      const total = meta.offsets[meta.frames], reader = r.body.getReader(), buf = new Uint8Array(total);
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.set(value, got); got += value.length;
        onProgress(got / total);
      }
      return Array.from({ length: meta.frames }, (_, i) =>
        URL.createObjectURL(new Blob([buf.subarray(meta.offsets[i], meta.offsets[i + 1])], { type: 'image/jpeg' })));
    }

    // PUT with upload progress (fetch can't report it)
    const put = (path, body, onUp) => new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('PUT', API + path);
      x.upload.onprogress = e => e.lengthComputable && onUp(e.loaded / e.total);
      x.onload = () => {
        if (x.status < 300) return res();
        let msg = `Upload failed (${x.status})`;
        try { msg = JSON.parse(x.responseText).error || msg; } catch (e) { /* not json */ }
        rej(new Error(msg.charAt(0).toUpperCase() + msg.slice(1)));
      };
      x.onerror = () => rej(new Error('Upload failed - check the internet connection.'));
      x.send(body);
    });

    async function addVideo(file, name, onProgress = () => {}) {
      const spin = await readSpin(file, onProgress, BUDGET, 0.6);
      const id = newId();
      const offsets = [0];
      for (const b of spin.blobs) offsets.push(offsets[offsets.length - 1] + b.size);
      const mbs = (spin.bytes / 1048576).toFixed(1);
      await put(`/cars/${id}/thumb`, spin.thumb, () => {});
      await put(`/cars/${id}/frames`, new Blob(spin.blobs, { type: 'application/octet-stream' }),
        s => onProgress(`Uploading… ${Math.round(s * 100)}% of ${mbs} MB`, 0.6 + s * 0.38));
      onProgress('Saving…', 0.99);
      const meta = await (await call('/cars', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: (name || file.name.replace(/\.[^.]+$/, '')).slice(0, 60),
                               frames: spin.blobs.length, size: [spin.W, spin.H], offsets })
      })).json();
      onProgress('Saved', 1);
      return meta;
    }

    const withPw = pw => ({ 'Content-Type': 'application/json', 'X-Password': pw || '' });
    async function checkPassword(pw) {
      try { await call('/check', { method: 'POST', headers: withPw(pw) }); return true; }
      catch (e) { if (e.status === 401) return false; throw e; }
    }
    async function remove(car, pw) {
      if (car.kind === 'upload') await call(`/cars/${car.id}`, { method: 'DELETE', headers: withPw(pw) });
      else await call('/hidden', { method: 'POST', headers: withPw(pw), body: JSON.stringify({ id: car.id, hide: true }) });
    }
    const restore = (id, pw) => call('/hidden', { method: 'POST', headers: withPw(pw),
      body: JSON.stringify(id ? { id, hide: false } : { all: true }) });

    return {
      shared: true, needsPassword: true, list, frameUrls, addVideo, remove, restore, checkPassword,
      rename: null, storageUse: async () => null, hidden: () => lastHidden, online: () => online
    };
  }

  // ======================= this browser only (offline / local copy) =======================
  function local() {
    const HIDDEN_KEY = 'showroom360.hidden';
    const db = new Promise((res, rej) => {
      const r = indexedDB.open('showroom360', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('cars', { keyPath: 'id' });       // name, size, thumb, frame count
        r.result.createObjectStore('frames');                         // key `${id}/${i}` -> JPEG blob
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = async (stores, mode, fn) => {
      const d = await db;
      return new Promise((res, rej) => {
        const t = d.transaction(stores, mode);
        const out = fn(t);
        t.oncomplete = () => res(out && 'result' in out ? out.result : out);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error || new Error('Storage is full or not available.'));
      });
    };
    const hidden = () => { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []; } catch (e) { return []; } };
    const setHidden = ids => { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(ids)); } catch (e) { /* private mode */ } };

    async function list() {
      let ups = [];
      try { ups = await tx(['cars'], 'readonly', t => t.objectStore('cars').getAll()); } catch (e) { /* no storage */ }
      const uploads = ups.sort((a, b) => a.added - b.added).map(c => ({
        ...c, kind: 'upload', hidden: false, subtitle: 'Your upload', thumbUrl: URL.createObjectURL(c.thumb)
      }));
      return [...builtIns(hidden()), ...uploads];
    }

    async function frameUrls(car) {
      const d = await db;
      const blobs = await Promise.all(Array.from({ length: car.frames }, (_, i) => new Promise((res, rej) => {
        const r = d.transaction('frames').objectStore('frames').get(`${car.id}/${i}`);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      })));
      return blobs.map(b => URL.createObjectURL(b));
    }

    async function remove(car) {
      if (car.kind === 'upload') {
        await tx(['cars', 'frames'], 'readwrite', t => {
          t.objectStore('cars').delete(car.id);
          t.objectStore('frames').delete(IDBKeyRange.bound(`${car.id}/`, `${car.id}/￿`));
        });
      } else {
        setHidden([...new Set([...hidden(), car.id])]);
      }
    }
    const restore = async id => setHidden(id ? hidden().filter(x => x !== id) : []);

    async function rename(car, name) {
      if (car.kind !== 'upload') return;
      await tx(['cars'], 'readwrite', t => {
        const s = t.objectStore('cars');
        const r = s.get(car.id);
        r.onsuccess = () => { if (r.result) s.put({ ...r.result, name }); };
      });
    }

    async function storageUse() {
      try { const e = await navigator.storage.estimate(); return e.usage || 0; } catch (e) { return null; }
    }

    async function addVideo(file, name, onProgress = () => {}) {
      const spin = await readSpin(file, onProgress);
      const car = {
        id: newId(), name: (name || file.name.replace(/\.[^.]+$/, '')).slice(0, 60),
        frames: spin.blobs.length, size: [spin.W, spin.H], added: Date.now(), source: file.name,
        bytes: spin.bytes, thumb: spin.thumb
      };
      onProgress('Saving…', 0.97);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      await tx(['cars', 'frames'], 'readwrite', t => {
        t.objectStore('cars').put(car);
        spin.blobs.forEach((b, i) => t.objectStore('frames').put(b, `${car.id}/${i}`));
      });
      onProgress('Saved', 1);
      return car;
    }

    return {
      shared: false, needsPassword: false, list, frameUrls, addVideo, remove, restore, rename, storageUse, hidden,
      checkPassword: async () => true, online: () => true
    };
  }

  return API ? shared() : local();
})();
