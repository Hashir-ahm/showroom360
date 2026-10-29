/* 360 vehicle viewer with hotspots, rotate-to-part + zoom, door/tailgate opening and interior photos.
   Everything car-specific comes from cars/<id>/car.js (window.CAR_DATA), written by pipeline/ingest.py:
   frame count + size, hotspot paths in frame pixels, focus angles, door outlines, photos and part text. */
(() => {
  const CAR = window.CAR_DATA;
  const BASE = `cars/${CAR.id}/`;
  const N = CAR.frames, W = CAR.size[0], H = CAR.size[1];
  const PATTERN = CAR.frame_pattern || 'frames/{i:03d}.jpg';
  // the car's version (see pipeline/ingest.py): changes when the car is updated, so browsers don't show old copies
  const VQ = window.CAR_VERSION ? '?v=' + window.CAR_VERSION : '';
  const FRAME_SRC = CAR.frame_urls ? i => CAR.frame_urls[i]          // a video read in the browser (upload)
                                    : i => BASE + PATTERN.replace('{i:03d}', String(i).padStart(3, '0')) + VQ;
  // each start of the viewer gets a number; a viewer replaced by a newer one (e.g. after an upload) goes quiet
  const GEN = window.__viewerGen = (window.__viewerGen || 0) + 1;
  const alive = () => GEN === window.__viewerGen;
  const SPEED = 67 / N;    // timings were tuned on a 67-frame spin; keep the same turning speed for any N
  const MAX_KEY_GAP = 6 / SPEED;   // keyframes further apart than this (same angle for any N) mean "hidden"
  const FADE = 1.6 / SPEED;        // frames over which a dot fades in/out at the ends of its path
  // Dense spins (>= 1 view per 3°) show exactly one photo at a time: sharp, no ghosting. Sparse spins
  // cross-fade neighbouring photos so the turn doesn't look jumpy.
  const BLEND = N < 120;

  const ICONS = {
    light: '<path d="M4 9h5M4 12h5M4 15h5"/><path d="M12 6c5 0 8 2.7 8 6s-3 6-8 6z"/>',
    grille: '<rect x="3" y="7" width="18" height="10" rx="3"/><path d="M7 10v4M10 10v4M14 10v4M17 10v4"/>',
    mirror: '<path d="M5 8c0-2 2-3 5-3h6c2 0 3 1 3 3v4c0 2-1 3-3 3h-6c-3 0-5-1-5-3z"/><path d="M8 15l-2 4"/>',
    door: '<path d="M5 20V9l5-5h9v16z"/><path d="M5 11h14M14 14h2"/>',
    wheel: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M12 3.5V9M12 15v5.5M3.5 12H9M15 12h5.5"/>',
    tail: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M4 10h16"/>',
    gate: '<path d="M3 8h18v9H3z"/><path d="M9 12h6M3 8l2-3h14l2 3"/>',
    scratch: '<path d="M4 18L18 4M8 20L20 8M3 13L13 3"/>',
    dent: '<path d="M3 8h18M3 16h18"/><path d="M7 8c1 4 3 6 5 6s4-2 5-6"/>',
    engine: '<path d="M5 10h3l2-2h5l2 2h2v6h-2l-2 2h-6l-2-2H5z"/><path d="M3 11v4M21 11v4M10 8V6h4v2"/>'
  };

  // group = what a bottom-bar button represents; each hotspot belongs to one group.
  const GROUPS = CAR.groups;
  /* spot.keys: { frame: [x, y] } — frames may exceed N-1 to express wrap-around (N == 0).
     spot.focus: frame to rotate to + zoom level.
     spot.door: outline polygon at the focus frame, hinge side and (optionally) the photo revealed behind it. */
  const SPOTS = CAR.spots;

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const canvas = $('frame'), ctx = canvas.getContext('2d');
  const stage = $('stage'), wrap = stage.parentElement, viewer = $('viewer');
  const hsLayer = $('hotspots'), doorLayer = $('doorLayer');
  const info = $('info'), cabin = $('cabin'), cabinPhoto = $('cabinPhoto');

  const frames = new Array(N);
  const photos = {};
  let cur = CAR.start || 0;               // current (float) frame
  let drawnAt = -1;          // float frame last drawn
  let auto = true, dotsOn = true;
  let focused = null;        // spot currently zoomed into
  let busy = false;
  let rotAnim = null;
  let zoomState = { tx: 0, ty: 0, z: 1 };
  let stageW = 0, stageH = 0;

  const mod = (a, n) => ((a % n) + n) % n;
  // partial spins (a video that doesn't come all the way round) stop at their ends instead of wrapping
  const LOOP = CAR.loop !== false;
  const clampF = f => LOOP ? mod(f, N) : Math.min(N - 1, Math.max(0, f));
  let pingDir = 1;             // auto-rotate direction on a partial spin (bounces at the ends)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pct = (v, total) => (v / total) * 100;
  const smooth = t => t * t * (3 - 2 * t);

  // ---------- loading ----------
  function loadImg(src) {
    return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }
  /* Coarse-to-fine loading: every 8th view first (the spin is usable straight away), then every 4th, 2nd
     and the rest. Each image is decoded before it's used, so drawing it never stalls a frame. */
  function load() {
    const order = [], seen = new Set();
    for (const stride of [8, 4, 2, 1]) for (let i = 0; i < N; i += stride) if (!seen.has(i)) { seen.add(i); order.push(i); }
    const first = Math.ceil(N / 8);
    let done = 0, next = 0, readyFired = false, resolveReady;
    const ready = new Promise(r => { resolveReady = r; });
    const fetchOne = () => {
      if (next >= order.length) return;
      const i = order[next++];
      const img = new Image();
      img.decoding = 'async';
      img.src = FRAME_SRC(i);
      img.decode().catch(() => null).then(() => {
        if (img.naturalWidth) frames[i] = img;
        done++;
        if (!readyFired) $('loadBar').style.width = Math.min(100, done / first * 100) + '%';
        if (!readyFired && done >= first) { readyFired = true; resolveReady(); }
        if (readyFired && done < N) $('status').textContent = `Loading detail… ${Math.round(done / N * 100)}%`;
        if (done === N) {
          $('status').textContent = SPOTS.length ? 'Press a part or drag to rotate.' : '';
          draw(true);
          preloadAnims();                              // opening clips next, so they're ready before a click
        }
        if (frames[i] && mod(i - Math.round(cur), N) === 0) draw(true);
        fetchOne();
      });
    };
    for (let k = 0; k < 8; k++) fetchOne();
    for (const s of SPOTS) if (s.door && s.door.photo) loadImg(BASE + s.door.photo + VQ).then(img => { if (img) photos[s.id] = img; });
    return ready;
  }

  // nearest frame that has loaded (while loading, the spin uses the coarse set)
  function loadedNear(i) {
    for (let d = 0; d < N; d++) {
      if (frames[mod(i + d, N)]) return mod(i + d, N);
      if (frames[mod(i - d, N)]) return mod(i - d, N);
    }
    return -1;
  }

  // ---------- angle strip: 8 views around the car, click to spin there ----------
  const ANGLES = 8, angleBtns = [];
  let activeAngle = -1;
  function buildAngles() {
    const box = $('angles');
    if (!box) return;
    for (let k = 0; k < ANGLES; k++) {
      const f = LOOP ? Math.round(k * N / ANGLES) % N : Math.round(k * (N - 1) / (ANGLES - 1));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'angle';
      b.setAttribute('aria-label', `View ${Math.round(k * 360 / ANGLES)}°`);
      b.innerHTML = `<img alt="" loading="lazy" src="${FRAME_SRC(f)}">`;
      b.addEventListener('click', async () => {
        if (busy) return;
        if (focused) await unfocus();
        setAuto(false); vel = 0; autoSpeed = 0;
        $('dragHint').classList.add('gone');
        rotateTo(f);
      });
      box.appendChild(b);
      angleBtns.push(b);
    }
  }
  function markAngle(f) {
    if (!angleBtns.length) return;
    const k = LOOP ? Math.round(mod(f, N) / (N / ANGLES)) % ANGLES : Math.round(f / (N - 1) * (ANGLES - 1));
    if (k === activeAngle) return;
    if (activeAngle >= 0) angleBtns[activeAngle].classList.remove('active');
    angleBtns[k].classList.add('active');
    activeAngle = k;
  }

  // ---------- drawing ----------
  let shownFrame = -1;
  let animOn = false;          // an opening animation owns the canvas
  function draw(force) {
    if (animOn) return;
    // auto-spin turns ~27 views/s while the screen refreshes 60+ times/s: showing whole views only would hold
    // each one for an uneven 2 or 3 refreshes (judder). While it spins on its own, blend neighbouring views.
    if (!BLEND && !dragging && !focused && Math.abs(autoSpeed) > 1e-4) {
      const i0 = mod(Math.floor(cur), N), i1 = mod(i0 + 1, N), a = cur - Math.floor(cur);
      if (frames[i0] && frames[i1]) {
        ctx.globalAlpha = 1;
        ctx.drawImage(frames[i0], 0, 0, W, H);
        if (a > 0.02) { ctx.globalAlpha = a; ctx.drawImage(frames[i1], 0, 0, W, H); ctx.globalAlpha = 1; }
        shownFrame = -1;                   // the next whole-view draw repaints
        placeHotspots(cur);
        markAngle(i0);
        return;
      }
    }
    if (!BLEND) {
      const i = loadedNear(Math.round(cur));
      if (i < 0 || (!force && i === shownFrame)) return;
      shownFrame = i;
      ctx.drawImage(frames[i], 0, 0, W, H);
      placeHotspots(i);                    // dots for exactly the photo on screen
      markAngle(i);
      return;
    }
    if (!force && Math.abs(cur - drawnAt) < 0.004) return;
    drawnAt = cur;
    const i0 = Math.floor(cur) % N, i1 = (i0 + 1) % N, a = cur - Math.floor(cur);
    ctx.globalAlpha = 1;
    ctx.drawImage(frames[i0], 0, 0, W, H);
    if (a > 0.02) { ctx.globalAlpha = a; ctx.drawImage(frames[i1], 0, 0, W, H); ctx.globalAlpha = 1; }
    placeHotspots(cur);
  }
  const nearestFrame = () => BLEND ? mod(Math.round(cur), N) : shownFrame;

  // ---------- hotspot paths: cubic Hermite spline through keyframes ----------
  function buildPaths() {
    for (const s of SPOTS) {
      const ks = Object.keys(s.keys || {}).map(Number).sort((a, b) => a - b);
      if (!ks.length) { s.runs = []; continue; }          // a part with a button but no dot
      // split into runs of keys that are close enough to be continuous
      const runs = [[ks[0]]];
      for (let i = 1; i < ks.length; i++) {
        if (ks[i] - ks[i - 1] <= MAX_KEY_GAP) runs[runs.length - 1].push(ks[i]); else runs.push([ks[i]]);
      }
      s.runs = runs.map(r => {
        const P = r.map(k => s.keys[k]);
        const M = r.map((k, i) => {        // tangent in px per frame
          const a = Math.max(0, i - 1), b = Math.min(r.length - 1, i + 1);
          if (a === b) return [0, 0];
          return [(P[b][0] - P[a][0]) / (r[b] - r[a]), (P[b][1] - P[a][1]) / (r[b] - r[a])];
        });
        return { k: r, P, M };
      });
    }
  }

  function evalRun(run, f) {
    const { k, P, M } = run, last = k.length - 1;
    if (f <= k[0]) return [P[0][0] + M[0][0] * (f - k[0]), P[0][1] + M[0][1] * (f - k[0])];
    if (f >= k[last]) return [P[last][0] + M[last][0] * (f - k[last]), P[last][1] + M[last][1] * (f - k[last])];
    let i = 0; while (f > k[i + 1]) i++;
    const h = k[i + 1] - k[i], t = (f - k[i]) / h, t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    return [0, 1].map(d => h00 * P[i][d] + h10 * h * M[i][d] + h01 * P[i + 1][d] + h11 * h * M[i + 1][d]);
  }

  // position + visibility (0..1) of a spot at float frame f
  function spotPos(spot, f) {
    let best = null;
    for (const run of spot.runs) {
      const a = run.k[0], b = run.k[run.k.length - 1];
      for (const ff of [mod(f, N), mod(f, N) + N, mod(f, N) - N]) {
        if (ff < a - FADE || ff > b + FADE) continue;
        const outside = Math.max(a - ff, ff - b, 0);
        const vis = 1 - smooth(Math.min(1, outside / FADE));
        if (!best || vis > best.vis) best = { p: evalRun(run, ff), vis };
      }
    }
    return best;
  }

  const spotEls = {};
  function buildHotspots() {
    for (const s of SPOTS) {
      const b = document.createElement('button');
      b.className = 'hs' + (s.damage ? ' damage' + (s.kind === 'dent' ? ' dent' : '') : ''); b.type = 'button';
      b.setAttribute('aria-label', s.label);
      b.innerHTML = `<span class="dot"></span><span class="tip">${s.label}</span>`;
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('click', () => focusSpot(s));
      hsLayer.appendChild(b);
      spotEls[s.id] = b;
    }
  }

  function placeHotspots(f) {
    for (const s of SPOTS) {
      const el = spotEls[s.id], r = spotPos(s, f);
      const vis = r ? r.vis : 0;
      if (r) el.style.transform = `translate3d(${(r.p[0] / W * stageW).toFixed(1)}px, ${(r.p[1] / H * stageH).toFixed(1)}px, 0)`;
      el.style.setProperty('--vis', vis.toFixed(3));
      el.classList.toggle('off', vis < 0.35);
    }
  }

  function measure() { stageW = wrap.clientWidth; stageH = wrap.clientHeight; placeHotspots(BLEND ? cur : Math.max(0, shownFrame)); }

  // ---------- rotation ----------
  function rotateTo(target) {
    if (rotAnim) cancelAnimationFrame(rotAnim);
    const start = cur;
    let d = LOOP ? mod(target - start, N) : clampF(target) - start;
    if (LOOP && d > N / 2) d -= N;
    const dur = Math.min(1600, Math.max(300, Math.abs(d) * 38 * SPEED));
    const t0 = performance.now();
    return new Promise(res => {
      const step = now => {
        const t = Math.min(1, (now - t0) / dur);
        const e = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
        cur = clampF(start + d * e);
        draw();
        if (t < 1) rotAnim = requestAnimationFrame(step);
        else { cur = clampF(Math.round(LOOP ? target : clampF(target))); draw(true); rotAnim = null; res(); }
      };
      rotAnim = requestAnimationFrame(step);
    });
  }

  // auto-rotate + inertia loop
  let vel = 0, lastT = performance.now(), autoSpeed = 0;
  function tick(now) {
    const dt = Math.min(50, now - lastT); lastT = now;
    if (!dragging && !focused && !busy && !rotAnim) {
      // ease auto-rotate speed in/out instead of starting/stopping abruptly
      if (!LOOP && auto && (cur >= N - 1.01 && pingDir > 0 || cur <= 0.01 && pingDir < 0)) { pingDir = -pingDir; autoSpeed = 0; }
      autoSpeed += ((auto ? pingDir * 0.005 / SPEED : 0) - autoSpeed) * Math.min(1, dt / 400);
      if (Math.abs(vel) > .0005) vel *= Math.pow(.93, dt / 16); else vel = 0;
      const step = (vel + autoSpeed) * dt;
      if (Math.abs(step) > 1e-5) { cur = clampF(cur + step); draw(); }
    }
    if (alive()) requestAnimationFrame(tick);
  }

  // ---------- drag ----------
  let dragging = false, lastX = 0, lastMoveT = 0;
  wrap.addEventListener('pointerdown', e => {
    if (focused || busy) return;
    dragging = true; lastX = e.clientX; lastMoveT = performance.now(); vel = 0; autoSpeed = 0;
    setAuto(false); $('dragHint').classList.add('gone');
    wrap.classList.add('dragging'); wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', e => {
    if (!dragging) return;
    const now = performance.now();
    const dx = e.clientX - lastX; lastX = e.clientX;
    const df = dx / wrap.clientWidth * N * 0.9; // ~1 full turn per width
    cur = clampF(cur + df);
    const v = df / Math.max(8, now - lastMoveT);
    vel = vel * 0.6 + v * 0.4;                  // smoothed release velocity
    lastMoveT = now;
    draw();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false; wrap.classList.remove('dragging');
    if (performance.now() - lastMoveT > 80) vel = 0; // held still before release
    vel = Math.max(-0.06 / SPEED, Math.min(0.06 / SPEED, vel));
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  // ---------- zoom ----------
  function zoomTo(p, z, maxMag = 1.7) {
    // never magnify the photo more than ~1.7x its real pixels: beyond that it only gets blurrier
    // (damage dots allow a closer look: seeing the scratch matters more than perfect sharpness)
    z = Math.min(z, Math.max(1.4, maxMag * W / Math.max(1, stageW)));
    const px = pct(p[0], W), py = pct(p[1], H);
    const tx = Math.min(0, Math.max(100 * (1 - z), 50 - z * px));
    const ty = Math.min(0, Math.max(100 * (1 - z), 50 - z * py));
    zoomState = { tx, ty, z };
    stage.style.transform = `translate(${tx}%, ${ty}%) scale(${z})`;
  }
  function zoomOut() { zoomState = { tx: 0, ty: 0, z: 1 }; stage.style.transform = ''; }
  // frame coords -> px inside the viewer, under the current zoom
  const toScreen = ([x, y]) => [(zoomState.tx / 100 + zoomState.z * x / W) * stageW, (zoomState.ty / 100 + zoomState.z * y / H) * stageH];

  // ---------- door / tailgate ----------
  const polyCss = poly => `polygon(${poly.map(([x, y]) => `${pct(x, W).toFixed(2)}% ${pct(y, H).toFixed(2)}%`).join(',')})`;
  const bbox = poly => {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };

  function drawOpening(c, spot) {
    const g = c.getContext('2d'), b = bbox(spot.door.poly), w = b.x1 - b.x0, h = b.y1 - b.y0;
    g.fillStyle = '#0c0d10'; g.fillRect(b.x0, b.y0, w, h);
    const img = photos[spot.id];
    if (img) {
      const s = Math.max(w / img.width, h / img.height);
      g.drawImage(img, b.x0 + (w - img.width * s) / 2, b.y0 + (h - img.height * s) / 2, img.width * s, img.height * s);
    }
    // inner shadow so the opening reads as depth
    const sh = g.createLinearGradient(b.x0, 0, b.x1, 0);
    sh.addColorStop(0, 'rgba(0,0,0,.45)'); sh.addColorStop(.18, 'rgba(0,0,0,0)'); sh.addColorStop(.82, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.45)');
    g.fillStyle = sh; g.fillRect(b.x0, b.y0, w, h);
  }

  async function openDoor(spot) {
    const { poly, hinge } = spot.door, b = bbox(poly);
    const clip = polyCss(poly);
    const ox = hinge === 'left' ? b.x0 : hinge === 'right' ? b.x1 : (b.x0 + b.x1) / 2;
    const oy = hinge === 'bottom' ? b.y1 : (b.y0 + b.y1) / 2;

    const opening = document.createElement('canvas');
    opening.width = W; opening.height = H; opening.className = 'door-interior';
    opening.style.clipPath = clip;
    drawOpening(opening, spot);

    const panel = document.createElement('canvas');
    panel.width = W; panel.height = H; panel.className = 'door-panel';
    panel.getContext('2d').drawImage(frames[nearestFrame()], 0, 0, W, H);
    panel.style.clipPath = clip;
    panel.style.transformOrigin = `${pct(ox, W)}% ${pct(oy, H)}%`;

    doorLayer.style.perspectiveOrigin = `${pct(ox, W)}% ${pct(oy, H)}%`;
    doorLayer.replaceChildren(opening, panel);
    await sleep(30);
    opening.classList.add('on');
    panel.classList.add('open');
    // panel swings outward toward the viewer around its hinge
    panel.style.transform = hinge === 'bottom' ? 'rotateX(-78deg)' : `rotateY(${hinge === 'left' ? -64 : 64}deg)`;
    await sleep(1100);
  }

  async function closeDoor() {
    const panel = doorLayer.querySelector('.door-panel');
    if (!panel) return;
    panel.style.transform = 'none';
    panel.classList.remove('open');
    await sleep(1150);
    doorLayer.replaceChildren();
  }

  // ---------- interior photo: grows out of the door opening ----------
  let cabinFrom = null;
  async function showCabin(spot) {
    const img = photos[spot.id];
    if (!img) return;
    cabinPhoto.src = img.src;
    // target box: right of the info card on wide screens, above it on narrow ones
    const wide = stageW > 700;
    const area = wide ? { x: 360, y: 20, w: stageW - 380, h: stageH - 80 } : { x: 10, y: 10, w: stageW - 20, h: stageH * 0.58 };
    const s = Math.min(area.w / img.width, area.h / img.height, 2.4);
    const fw = img.width * s, fh = img.height * s;
    const fx = area.x + (area.w - fw) / 2, fy = area.y + (area.h - fh) / 2;
    Object.assign(cabinPhoto.style, { left: fx + 'px', top: fy + 'px', width: fw + 'px', height: fh + 'px' });

    // start: centred on the door opening, sized to it
    const b = bbox(spot.door.poly);
    const [ax, ay] = toScreen([b.x0, b.y0]), [bx, by] = toScreen([b.x1, b.y1]);
    const k = Math.min((bx - ax) / fw, (by - ay) / fh);
    cabinFrom = `translate(${(ax + bx) / 2 - (fx + fw / 2)}px, ${(ay + by) / 2 - (fy + fh / 2)}px) scale(${k})`;

    cabin.classList.remove('shown');
    cabinPhoto.style.transition = 'none';
    cabinPhoto.style.transform = cabinFrom;
    cabinPhoto.style.opacity = '0';
    cabin.hidden = false;
    void cabinPhoto.offsetWidth;
    cabinPhoto.style.transition = '';
    cabin.classList.add('shown');
    cabinPhoto.style.transform = 'none';
    cabinPhoto.style.opacity = '1';
    await sleep(750);
  }

  async function hideCabin() {
    if (cabin.hidden) return;
    cabin.classList.remove('shown');
    cabinPhoto.style.transform = cabinFrom || 'scale(.6)';
    cabinPhoto.style.opacity = '0';
    await sleep(600);
    cabin.hidden = true;
  }

  // ---------- focus flow ----------
  // ---------- opening animations (e.g. a filmed tailgate opening, aligned to the spin by add_anim.py) ----------
  const anims = {};
  function loadAnim(spot) {
    if (!spot.anim || anims[spot.id]) return anims[spot.id];
    const n = spot.anim.frames;
    anims[spot.id] = Promise.all(Array.from({ length: n }, (_, k) => {
      const img = new Image();
      img.src = BASE + spot.anim.pattern.replace('{i:03d}', String(k).padStart(3, '0')) + VQ;
      return img.decode().then(() => img, () => null);
    }));
    return anims[spot.id];
  }
  /* Video version (anim.video, made by pipeline/anim_video.py): the same two-speed timing baked into a short
     open.mp4 and close.mp4. A video streams and is decoded by the graphics hardware, so it starts quickly and
     plays without stutter; the opening clips are fetched in the background once the spin has loaded. */
  const vids = {};
  function animVideo(spot, which) {
    const key = spot.id + ':' + which;
    if (vids[key]) return vids[key];
    const v = document.createElement('video');
    v.className = 'anim-video';
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.src = BASE + spot.anim.video[which] + VQ;
    stage.insertBefore(v, canvas.nextSibling);
    const ready = new Promise(res => {
      if (v.readyState >= 4) return res(v);
      v.addEventListener('canplaythrough', () => res(v), { once: true });
      v.addEventListener('error', () => res(null), { once: true });
    });
    v.load();
    return (vids[key] = { v, ready });
  }
  function prepAnim(spot, both) {
    if (!spot.anim) return;
    if (!spot.anim.video) return loadAnim(spot);
    animVideo(spot, 'open');
    if (both) animVideo(spot, 'close');
  }
  const seekStart = v => v.currentTime < 0.01 ? Promise.resolve()
    : new Promise(res => { v.addEventListener('seeked', res, { once: true }); v.currentTime = 0; });
  async function playVideo(spot, forward) {
    const { v, ready } = animVideo(spot, forward ? 'open' : 'close');
    if (forward) animVideo(spot, 'close');                    // fetch the closing clip while this one plays
    const ok = await Promise.race([ready, sleep(6000).then(() => v.readyState >= 2 ? v : null)]);
    if (!ok) return false;
    await seekStart(v);
    const other = vids[spot.id + ':' + (forward ? 'close' : 'open')];
    v.style.zIndex = 2;
    if (other) other.v.style.zIndex = 1;
    // opening: fade in over the spin view; closing: starts on top of the open clip (same picture)
    v.style.opacity = forward ? '0' : '1';
    try { await v.play(); } catch (e) { v.style.opacity = '0'; return false; }
    await new Promise(res => {
      const step = () => {
        const d = v.duration || 1, t = v.currentTime;
        if (other && t > 0) { other.v.style.opacity = '0'; other.v.pause(); }
        // short cross-fade with the spin view at the closed end hides any small mismatch
        v.style.opacity = String(Math.min(1, (forward ? t : d - t) / (0.12 * d)));
        if (v.ended || t >= d - 0.005) { v.style.opacity = forward ? '1' : '0'; res(); }
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return true;
  }
  async function runAnim(spot, forward) {
    if (spot.anim.video && await playVideo(spot, forward)) return;
    for (const k of ['open', 'close']) { const e = vids[spot.id + ':' + k]; if (e) e.v.style.opacity = '0'; }
    await playAnim(spot, forward);                           // image frames (older cars / video failed)
  }
  function preloadAnims() {
    for (const s of SPOTS) if (s.anim && s.anim.video) prepAnim(s);
  }

  /* Two-speed playback: the camera move-in before the door/trunk starts to open (anim.open = where that is,
     0..1) plays quickly; the opening itself plays slowly and settles gently at the end. Closing reverses it. */
  const OPEN_MS = 2600, CLOSE_MS = 2000;
  async function playAnim(spot, forward) {
    const imgs = (await loadAnim(spot)).filter(Boolean);
    if (!imgs.length) return;
    const split = spot.anim.open || 0;                       // share of the clip before the opening starts
    const fast = split > 0.02 ? 500 + 700 * split : 0;       // ms for the move-in
    const slow = forward ? OPEN_MS : CLOSE_MS;               // ms for the opening / closing
    const total = fast + slow;
    const clamp = t => Math.min(1, Math.max(0, t));           // float rounding can step just past 0..1
    const easeIn = t => clamp(t) ** 2;                         // move-in: smooth start, full speed into the opening
    const easeOut = t => 1 - Math.pow(1 - clamp(t), 2.2);     // opening: keeps moving, slows to rest at the end
    const easeInOut = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // forward: time -> position in the clip (0 = closed, 1 = fully open)
    const pos = ms => ms < fast ? split * easeIn(ms / fast) : split + (1 - split) * easeOut((ms - fast) / slow);
    // backward: close slowly (gentle start and end), then pull back out quickly
    const posBack = ms => ms < slow ? 1 - (1 - split) * easeInOut(ms / slow) : split * (1 - easeOut((ms - slow) / Math.max(1, fast)));
    const t0 = performance.now();
    await new Promise(res => {
      const step = now => {
        const ms = Math.min(total, now - t0), t = ms / total;
        const p = forward ? pos(ms) : posBack(ms);
        const k = Math.round(clamp(p) * (imgs.length - 1));
        // short cross-fade with the spin view at the closed end hides any small mismatch
        const a = Math.min(1, (forward ? t : 1 - t) / 0.12);
        if (a < 1 && frames[shownFrame]) { ctx.globalAlpha = 1; drawSpinView(spot.anim.view); ctx.globalAlpha = a; }
        ctx.drawImage(imgs[k], 0, 0, W, H);
        ctx.globalAlpha = 1;
        if (ms < total) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }

  // zoomed window {x, y, z} in frame pixels: CSS zoom of the stage, or the same crop drawn into the canvas
  const viewTransform = v => `translate(${-v.z * v.x / W * 100}%, ${-v.z * v.y / H * 100}%) scale(${v.z})`;
  function zoomToView(v) {
    zoomState = { tx: -v.z * v.x / W * 100, ty: -v.z * v.y / H * 100, z: v.z };
    stage.style.transform = viewTransform(v);
  }
  function setStageInstant(t) {
    stage.style.transition = 'none';
    stage.style.transform = t;
    void stage.offsetWidth;
    stage.style.transition = '';
    if (!t) zoomState = { tx: 0, ty: 0, z: 1 };
  }
  function drawSpinView(v) {
    const img = frames[shownFrame];
    if (!img) return;
    if (v && v.z > 1) ctx.drawImage(img, v.x, v.y, W / v.z, H / v.z, 0, 0, W, H);
    else ctx.drawImage(img, 0, 0, W, H);
  }

  async function focusSpot(spot) {
    if (busy) return;
    busy = true;
    setAuto(false); vel = 0;
    $('dragHint').classList.add('gone');
    setActive(spot.group);
    hideInfo();
    hsLayer.classList.add('hidden');

    if (focused) { await closeFocused(); }
    focused = spot;
    if (spot.anim) prepAnim(spot, true);              // start fetching the clip while the car turns

    await rotateTo(spot.focus.f);                     // 1. spin to the side the part is on
    if (spot.anim) {                                  // filmed opening
      const v = spot.anim.view;
      if (v && v.z > 1) {                             // zoom into the part first (same window the clip was fitted to)
        zoomToView(v);
        await sleep(950);
      }
      animOn = true;
      drawSpinView(v);                                // canvas takes over the zoom: same picture, now full resolution
      setStageInstant('');
      await runAnim(spot, true);
      showInfo(spot);
      busy = false;
      return;
    }
    const r = spotPos(spot, spot.focus.f);
    zoomTo(r ? r.p : [W / 2, H / 2], spot.focus.z, spot.damage ? 2.6 : 1.7);   // 2. zoom into it
    await sleep(950);
    if (spot.door && photos[spot.id]) {               // 3. open it and show what's inside (needs a photo)
      await openDoor(spot);
      await showCabin(spot);
    }
    showInfo(spot);
    busy = false;
  }

  async function closeFocused() {
    if (focused && focused.anim) {                    // play the opening backwards, back to the spin view
      await runAnim(focused, false);
      const v = focused.anim.view;
      animOn = false;
      if (v && v.z > 1) {                             // hand back to the zoomed spin view, then zoom out smoothly
        setStageInstant(viewTransform(v));
        draw(true);
        await sleep(30);
        zoomOut();
        await sleep(900);
      } else draw(true);
      return;
    }
    await hideCabin();
    await closeDoor();
    zoomOut();
    await sleep(900);
  }

  async function unfocus() {
    if (!focused || busy) return;
    busy = true;
    hideInfo();
    await closeFocused();
    focused = null;
    setActive(null);
    if (dotsOn) hsLayer.classList.remove('hidden');
    busy = false;
  }

  function showInfo(spot) {
    const g = GROUPS[spot.group];
    $('infoGroup').textContent = spot.damage ? g.title : spot.label;     // "Scratch" / "Dent"
    $('infoTitle').textContent = spot.damage ? spot.label : g.title;
    $('infoText').textContent = spot.damage && spot.note ? spot.note : g.text;
    $('infoSpecs').innerHTML = g.specs.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('');
    // photos linked to this part, or to the same part on the other side (e.g. front door left / right)
    const groupOf = id => (SPOTS.find(x => x.id === id) || {}).group;
    const mine = PHOTOS.filter(p => p.part && (p.part === spot.id || groupOf(p.part) === spot.group));
    $('infoPhotos').replaceChildren(...mine.map(p => photoButton(p, mine)));
    info.classList.add('show');
  }

  // ---------- photos (added on the Manage page): strip under the viewer + per-part photos in the info card ----------
  const PHOTOS = (CAR.photos || []).map(p => ({ ...p, url: BASE + p.file + VQ }));
  function photoButton(p, set) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = p.caption || 'Open photo';
    b.innerHTML = `<img alt="" loading="lazy" src="${p.url}">`;
    b.addEventListener('click', () => lightbox(set, set.indexOf(p)));
    return b;
  }
  function lightbox(set, i) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<figure><img alt=""><figcaption></figcaption></figure>` +
      (set.length > 1 ? '<button class="lb-nav lb-prev" aria-label="Previous">‹</button><button class="lb-nav lb-next" aria-label="Next">›</button>' : '');
    const show = k => { i = (k + set.length) % set.length; lb.querySelector('img').src = set[i].url; lb.querySelector('figcaption').textContent = set[i].caption || ''; };
    const close = () => { lb.remove(); document.removeEventListener('keydown', key); };
    const key = e => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') show(i + 1); if (e.key === 'ArrowLeft') show(i - 1); };
    lb.addEventListener('click', e => {
      if (e.target.classList.contains('lb-prev')) show(i - 1);
      else if (e.target.classList.contains('lb-next')) show(i + 1);
      else close();
    });
    document.addEventListener('keydown', key);
    show(i);
    document.body.appendChild(lb);
  }
  function buildPhotos() {
    const loose = PHOTOS.filter(p => !p.part);
    $('photosPanel').hidden = !loose.length;
    $('photoStrip').replaceChildren(...loose.map(p => photoButton(p, loose)));
  }
  function hideInfo() { info.classList.remove('show'); }

  // ---------- part bar ----------
  const partBtns = {};
  function buildParts() {
    const nav = $('parts');
    for (const [key, g] of Object.entries(GROUPS)) {
      const b = document.createElement('button');
      b.className = 'part'; b.type = 'button';
      b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[g.icon]}</svg>${g.label}`;
      b.addEventListener('click', () => {
        // pick the variant (left/right) that is the shortest spin away
        const opts = SPOTS.filter(s => s.group === key);
        const dist = s => { const d = mod(s.focus.f - cur, N); return Math.min(d, N - d); };
        opts.sort((a, b) => dist(a) - dist(b));
        if (focused && focused.group === key && opts.length > 1) {
          // next tap = the next one in turn (other side for left/right parts; every scratch for damage)
          const order = [...opts].sort((a, b) => a.focus.f - b.focus.f || a.id.localeCompare(b.id));
          focusSpot(order[(order.indexOf(focused) + 1) % order.length]);
        } else focusSpot(opts[0]);
      });
      nav.appendChild(b);
      partBtns[key] = b;
    }
  }
  function setActive(group) {
    for (const [k, b] of Object.entries(partBtns)) b.classList.toggle('active', k === group);
  }

  // ---------- tools ----------
  function setAuto(on) {
    auto = on;
    const b = $('autoBtn');
    b.classList.toggle('on', on);
    b.querySelector('.play-label').textContent = on ? 'Pause' : 'Play 360°';
    b.setAttribute('aria-label', on ? 'Pause 360° spin' : 'Play 360° spin');
  }
  $('autoBtn').addEventListener('click', () => { if (focused) unfocus(); setAuto(!auto); });
  $('dotsBtn').addEventListener('click', () => {
    dotsOn = !dotsOn;
    $('dotsBtn').classList.toggle('on', dotsOn);
    if (!focused) hsLayer.classList.toggle('hidden', !dotsOn);
  });
  $('fsBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else viewer.requestFullscreen?.();
  });
  $('backBtn').addEventListener('click', unfocus);
  cabin.addEventListener('click', e => { if (e.target === cabin) unfocus(); });
  document.addEventListener('keydown', e => {
    if (!alive()) return;
    if (e.key === 'Escape') unfocus();
    if (!focused && !busy && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      setAuto(false); rotateTo(Math.round(cur) + (e.key === 'ArrowRight' ? 2 : -2));
    }
  });
  new ResizeObserver(() => { if (alive()) measure(); }).observe(wrap);

  // ---------- boot ----------
  buildPaths();
  buildHotspots();
  canvas.width = W; canvas.height = H;
  viewer.style.setProperty('--ar', `${W} / ${H}`);
  viewer.style.setProperty('--arn', W / H);
  $('vehicleName').textContent = CAR.name + (CAR.subtitle ? ` · ${CAR.subtitle}` : '');
  document.title = `${CAR.name} · 360 Viewer`;
  buildParts();
  buildAngles();
  buildPhotos();
  if (!SPOTS.length) {                     // viewer-only car (no part detection yet)
    $('parts').hidden = true;
    $('dotsBtn').hidden = true;
    document.querySelector('.sub').textContent = 'Drag to rotate, or jump to an angle below.';
  }
  measure();
  $('dotsBtn').classList.add('on');
  setAuto(false);                          // still until the visitor drags or presses Play
  ctx.imageSmoothingQuality = 'high';
  load().then(() => {
    $('loader').classList.add('done');
    draw(true);
    requestAnimationFrame(t => { lastT = t; tick(t); });
    // deep link for demos: index.html#part=doorFrontL
    const m = location.hash.match(/part=(\w+)/);
    const s = m && SPOTS.find(x => x.id === m[1]);
    if (s) focusSpot(s);
    else setTimeout(() => $('dragHint').classList.add('gone'), 4000);
  });

  // small hook for testing/screens: viewer360.go(12.5)
  window.viewer360 = { go(f) { setAuto(false); autoSpeed = 0; vel = 0; cur = clampF(f); draw(true); }, get frame() { return shownFrame; } };
})();
