/* Car manager page: details of every car, upload a new one, remove / restore. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const mb = b => b ? (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB' : '—';
  const date = v => {
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v).replace(' ', 'T'));
    return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // ---------- dialog in the site's style (instead of the browser's confirm / prompt / alert) ----------
  /** ask({title, text, ok, cancel, danger, needPw, value}) -> null if cancelled, else {pw, value}.
      needPw: also asks for the admin password and checks it with the store before closing. */
  function ask({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, needPw = false, value = null }) {
    const dlg = $('askDialog'), form = $('askForm'), okBtn = $('askOk'), err = $('askError');
    $('askTitle').textContent = title;
    $('askText').textContent = text; $('askText').hidden = !text;
    $('askPwRow').hidden = !needPw; $('askPw').value = '';
    $('askValueRow').hidden = value === null; $('askValue').value = value || '';
    err.hidden = true;
    okBtn.textContent = ok; okBtn.className = 'mg-btn ' + (danger ? 'danger-solid' : 'primary'); okBtn.disabled = false;
    $('askCancel').hidden = !cancel; $('askCancel').textContent = cancel || '';
    dlg.showModal();
    (needPw ? $('askPw') : value !== null ? $('askValue') : okBtn).focus();
    return new Promise(res => {
      const done = out => { form.onsubmit = null; dlg.oncancel = null; $('askCancel').onclick = null; dlg.onclick = null; dlg.close(); res(out); };
      $('askCancel').onclick = () => done(null);
      dlg.oncancel = e => { e.preventDefault(); done(null); };                     // Esc
      dlg.onclick = e => { if (e.target === dlg) done(null); };                      // click outside the box
      form.onsubmit = async e => {
        e.preventDefault();
        const pw = $('askPw').value;
        if (needPw) {
          if (!pw) { err.textContent = 'Enter the admin password.'; err.hidden = false; return; }
          okBtn.disabled = true; okBtn.textContent = 'Checking…';
          let good = false;
          try { good = await Garage.checkPassword(pw); }
          catch (x) { err.textContent = x.message || "The shared store can't be reached."; err.hidden = false; }
          okBtn.disabled = false; okBtn.textContent = ok;
          if (!good) {
            if (err.hidden) { err.textContent = 'Wrong password - try again.'; err.hidden = false; }
            $('askPw').select();
            return;
          }
          setPw(pw);
        }
        done({ pw, value: $('askValue').value.trim() });
      };
    });
  }
  const tell = (title, text) => ask({ title, text, ok: 'OK', cancel: null });

  // ---------- admin actions (shared store: removing / restoring needs the password; the store checks it) ----------
  const PW_KEY = 'showroom360.pw';
  const getPw = () => { try { return sessionStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; } };
  const setPw = v => { try { v ? sessionStorage.setItem(PW_KEY, v) : sessionStorage.removeItem(PW_KEY); } catch (e) { /* private mode */ } };
  /** confirm in a dialog (with the password field the first time in this tab), then run fn(password) */
  async function admin(opts, fn) {
    const needPw = Garage.needsPassword && !getPw();
    const r = await ask({ ...opts, needPw });
    if (!r) return;
    try { await fn(Garage.needsPassword ? getPw() : 'local'); } catch (e) {
      if (e.status === 401) setPw('');                     // password changed meanwhile: ask again next time
      await tell("That didn't work", e.message || 'Please try again.');
    }
    render();
  }

  // details of a built-in car come from its cars/<id>/car.js (loaded one at a time; each sets window.CAR_DATA)
  const details = {};
  const loadDetails = id => details[id] || (details[id] = new Promise(res => {
    const s = document.createElement('script');
    s.src = `cars/${id}/car.js`;
    s.onload = () => { const d = window.CAR_DATA; window.CAR_DATA = undefined; res(d); };
    s.onerror = () => res(null);
    document.body.appendChild(s);
  }));

  function card(c, d) {
    const el = document.createElement('article');
    el.className = 'mg-card' + (c.hidden ? ' is-hidden' : '');
    const spots = d && d.spots ? d.spots : [];
    const anims = spots.filter(s => s.anim).map(s => s.label.replace(/ \(.*\)$/, ''));
    const parts = d && d.groups ? Object.values(d.groups).map(g => g.label) : [];
    const size = (d && d.size) || c.size;
    const rows = [
      ['Type', c.kind === 'upload' ? (Garage.shared ? 'Uploaded · view only' : 'Your upload') : 'Built-in'],
      ['Views', `${(d && d.frames) || c.frames || '—'}${size ? ` · ${size[0]}×${size[1]}` : ''}`],
      ['Interactive parts', parts.length ? `${spots.length} dots · ${parts.join(', ')}` : 'None (viewing only)'],
      ['Animations', anims.length ? anims.join(', ') : 'None'],
      ['Source video', (d && d.source) || c.source || '—'],
      [c.kind === 'upload' ? 'Saved' : 'Added', date(c.added)]
    ];
    if (c.kind === 'upload') rows.push(['Storage', mb(c.bytes)]);
    el.innerHTML = `
      <a class="mg-thumb" href="index.html?car=${encodeURIComponent(c.id)}#showroom" title="Open in viewer">
        ${c.thumbUrl ? `<img alt="" loading="lazy" src="${esc(c.thumbUrl)}">` : '<span class="thumb-ph"></span>'}
        <span class="mg-badge ${c.kind}">${c.kind === 'upload' ? 'Upload' : 'Built-in'}</span>
      </a>
      <div class="mg-body">
        <h3 class="mg-name">${esc(c.name)}</h3>
        <p class="mg-sub">${esc(c.subtitle || '360° spin')}</p>
        <dl class="mg-facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="mg-actions"></div>
      </div>`;
    const actions = el.querySelector('.mg-actions');
    const btn = (label, cls, fn) => {
      const b = document.createElement(fn ? 'button' : 'a');
      b.className = 'mg-btn ' + cls; b.textContent = label;
      if (fn) { b.type = 'button'; b.addEventListener('click', fn); }
      return actions.appendChild(b);
    };
    if (c.hidden) {
      btn('Restore', 'primary', () => admin(
        { title: `Restore "${c.name}"?`, text: 'It will be shown in the showroom again' + (Garage.shared ? ' for everyone.' : '.'), ok: 'Restore' },
        pw => Garage.restore(c.id, pw)));
    } else {
      const open = btn('Open in viewer', 'primary');
      open.href = `index.html?car=${encodeURIComponent(c.id)}#showroom`;
      if (c.kind === 'upload' && Garage.rename) btn('Rename', '', async () => {
        const r = await ask({ title: 'Rename', value: c.name, ok: 'Save' });
        if (r && r.value) { await Garage.rename(c, r.value.slice(0, 60)); render(); }
      });
      btn('Remove', 'danger', async () => {
        const where = Garage.shared ? 'for everyone' : 'from this browser';
        const what = c.kind === 'upload' ? `It will be deleted ${where}.` : `It will be hidden from the showroom ${where} (you can restore it here).`;
        admin({ title: `Remove "${c.name}"?`, text: what, ok: 'Remove', danger: true }, pw => Garage.remove(c, pw));
      });
    }
    return el;
  }

  async function render() {
    const cars = await Garage.list();
    const shown = cars.filter(c => !c.hidden), removed = cars.filter(c => c.hidden);
    const info = await Promise.all(cars.map(c => c.kind === 'builtin' ? loadDetails(c.id) : null));
    const byId = Object.fromEntries(cars.map((c, i) => [c.id, info[i]]));
    $('carGrid').replaceChildren(...shown.map(c => card(c, byId[c.id])));
    if (!shown.length) $('carGrid').innerHTML = '<p class="mg-empty">No cars in the showroom. Add one above, or restore a removed one.</p>';
    $('removedGrid').replaceChildren(...removed.map(c => card(c, byId[c.id])));
    $('removedSection').hidden = !removed.length;
    const ups = cars.filter(c => c.kind === 'upload');
    const use = await Garage.storageUse();
    $('summary').textContent = `${shown.length} in the showroom · ${ups.length} uploaded` +
      (removed.length ? ` · ${removed.length} removed` : '') + (use ? ` · ${mb(use)} stored in this browser` : '') +
      (Garage.online() ? '' : " · the shared uploads can't be reached right now");
  }
  $('restoreAll').addEventListener('click', () => admin(
    { title: 'Restore all removed cars?', text: 'They will be shown in the showroom again' + (Garage.shared ? ' for everyone.' : '.'), ok: 'Restore all' },
    pw => Garage.restore(null, pw)));

  // ---------- upload ----------
  const file = $('upFile'), drop = $('drop');
  let chosen = null;
  const choose = f => {
    if (!f) return;
    if (!f.type.startsWith('video/')) { $('dropText').textContent = 'That isn\'t a video file — choose another.'; return; }
    chosen = f;
    $('dropText').innerHTML = `<b>${esc(f.name)}</b> · ${mb(f.size)}`;
    if (!$('upName').value) $('upName').value = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
    $('upBtn').disabled = false;
  };
  file.addEventListener('change', () => choose(file.files[0]));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => choose(e.dataTransfer.files[0]));

  $('upForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!chosen) return;
    const lock = on => ['upBtn', 'upFile', 'upName'].forEach(id => { $(id).disabled = on; });
    lock(true);
    $('upProgress').hidden = false;
    const step = (text, share) => { $('upText').textContent = text; $('upBar').style.width = Math.round(share * 100) + '%'; };
    try {
      const car = await Garage.addVideo(chosen, $('upName').value.trim(), step);
      $('upText').innerHTML = `Added <b>${esc(car.name)}</b> (${car.frames} views). <a href="index.html?car=${encodeURIComponent(car.id)}#showroom">Open it in the viewer →</a>`;
      chosen = null; file.value = ''; $('upName').value = '';
      $('dropText').innerHTML = '<b>Choose a video</b> or drop it here';
      await render();
    } catch (err) {
      $('upText').textContent = (err && err.message) || 'Could not read this video.';
      $('upBar').style.width = '0';
    } finally {
      lock(false); $('upBtn').disabled = !chosen;
    }
  });

  // wording for where uploads go
  if (Garage.shared) {
    $('upInfo').innerHTML = 'Upload a video of <b>one full turn</b> of the car. Your browser turns it into a 360° spin ' +
      '(view only: no dots or animations) and adds it to the showroom for <b>everyone</b>. Only the still views are ' +
      'sent, not the video.';
    $('footNote').textContent = 'Anyone can add a car. Removing a car, or restoring a removed one, needs the admin password.';
  }

  render().catch(e => { $('summary').textContent = 'Could not load the cars: ' + e.message; });
})();
