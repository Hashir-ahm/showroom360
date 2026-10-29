/* Viewer page start-up: vehicle list (built-in + saved uploads, minus removed ones) and which car to show.
   Uploading and removing cars happens on manage.html. */
(() => {
  const $ = id => document.getElementById(id);
  // build stamp that publish.ps1 puts on this script's address; app.js gets the same one
  const BUILD = (document.currentScript && new URL(document.currentScript.src).searchParams.get('v')) || '';
  const q = v => v ? '?v=' + v : '';
  const add = (src, next) => {
    const s = document.createElement('script'); s.src = src; if (next) s.onload = next;
    s.onerror = () => { $('status').textContent = 'Could not load ' + src; };
    document.body.appendChild(s);
  };

  async function start() {
    const cars = (await Garage.list()).filter(c => !c.hidden);
    const want = new URLSearchParams(location.search).get('car');
    const car = cars.find(c => c.id === want) || cars[0];

    const list = $('carList');
    list.replaceChildren();
    for (const c of cars) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'car-item' + (car && c.id === car.id ? ' active' : '');
      b.innerHTML = (c.thumbUrl ? `<img alt="" loading="lazy" src="${c.thumbUrl}">` : '<span class="thumb-ph"></span>') +
        '<span class="car-text"><span class="car-name"></span><span class="car-sub"></span></span>';
      b.querySelector('.car-name').textContent = c.name;
      b.querySelector('.car-sub').textContent = c.subtitle || '360° spin';
      b.addEventListener('click', () => { if (c.id !== car.id) location.href = '?car=' + encodeURIComponent(c.id); });
      list.appendChild(b);
    }

    if (!car) {
      $('status').textContent = 'No vehicles to show. Add one on the Manage cars page.';
      $('loader').classList.add('done');
      $('dragHint').classList.add('gone');
      return;
    }
    if (car.kind === 'upload') {
      const bar = $('loadBar');
      $('status').textContent = 'Loading the spin…';
      const urls = await Garage.frameUrls(car, share => { if (bar) bar.style.width = Math.round(share * 100) + '%'; });
      window.CAR_DATA = {
        id: car.id, name: car.name, subtitle: car.subtitle || 'Your upload', frames: urls.length, size: car.size,
        frame_urls: urls, views: {}, groups: {}, spots: []
      };
      add('app.js' + q(BUILD));
    } else {
      window.CAR_VERSION = car.v || '';                 // app.js adds it to the car's frames and videos
      add(`cars/${car.id}/car.js` + q(car.v), () => add('app.js' + q(BUILD)));
    }
  }

  start().catch(e => { $('status').textContent = 'Could not start: ' + e.message; });
})();
