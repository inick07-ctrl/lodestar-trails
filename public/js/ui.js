// Small UI helpers: escaping, toast, modal, bottom sheet detents.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ICON = {
  back: '<svg viewBox="0 0 24 24" class="ico"><path d="m15 5-7 7 7 7"/></svg>',
  chev: '<svg viewBox="0 0 24 24" class="ico chev" style="width:16px;height:16px"><path d="m9 5 7 7-7 7"/></svg>',
  share: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v8h14v-8"/></svg>',
  heart: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg>',
  heartF: '<svg viewBox="0 0 24 24" class="ico"><path fill="currentColor" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg>',
  nav: '<svg viewBox="0 0 24 24" class="ico"><path d="m4 11 16-7-7 16-2-7Z"/></svg>',
  car: '<svg viewBox="0 0 24 24" class="ico"><path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v2H3z"/><circle cx="7.5" cy="13" r="1"/><circle cx="16.5" cy="13" r="1"/></svg>',
  dl: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M4 17v3h16v-3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 20h4L19 9l-4-4L4 16Z"/></svg>',
  play: '<svg viewBox="0 0 24 24" class="ico"><path d="M7 4v16l13-8Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="ico"><path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24" class="ico"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 24 24" class="ico"><path d="M12 5v14M5 12h14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" class="ico"><path d="M4 8h3l2-3h6l2 3h3v11H4Z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  route: '<svg viewBox="0 0 24 24" class="ico"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h7a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h7"/></svg>',
};

let toastT;
export function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}

export function modal(html, onMount) {
  const w = $('#modalWrap'), m = $('#modal');
  m.innerHTML = html; w.hidden = false;
  const close = () => { w.hidden = true; m.innerHTML = ''; };
  w.onclick = e => { if (e.target === w) close(); };
  onMount?.(m, close);
  return close;
}
export function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><p class="sub">${esc(text)}</p><div class="row" style="margin-top:16px"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`, (m, close) => {
      m.querySelector('[data-x]').onclick = () => { close(); res(false); };
      m.querySelector('[data-ok]').onclick = () => { close(); res(true); };
    });
  });
}
export function promptBox(title, value = '', placeholder = '') {
  return new Promise(res => {
    modal(`<h2>${esc(title)}</h2><input class="input" id="pbv" value="${esc(value)}" placeholder="${esc(placeholder)}"><div class="row" style="margin-top:14px"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`, (m, close) => {
      const i = m.querySelector('#pbv'); setTimeout(() => i.focus(), 50);
      m.querySelector('[data-x]').onclick = () => { close(); res(null); };
      m.querySelector('[data-ok]').onclick = () => { close(); res(i.value.trim()); };
      i.onkeydown = e => { if (e.key === 'Enter') { close(); res(i.value.trim()); } };
    });
  });
}

// Bottom sheet with three detents: peek / half / full
export function initSheet(onChange) {
  const sheet = $('#sheet'), body = $('#sheetBody');
  const order = ['peek', 'half', 'full'];
  let startY = 0, startT = 0, dragging = false, lastY = 0, lastT = 0, vel = 0, fromBody = false;
  const curY = () => new DOMMatrix(getComputedStyle(sheet).transform).m42;
  const set = d => { sheet.dataset.detent = d; onChange?.(d); };
  const down = (e, fb) => {
    if (fb && !(sheet.dataset.detent !== 'full' || body.scrollTop <= 0)) return;
    fromBody = fb; dragging = false; startY = lastY = e.clientY; startT = curY(); lastT = performance.now(); vel = 0;
    const move = ev => {
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < 6) return;
        if (fromBody && sheet.dataset.detent === 'full' && (dy < 0 || body.scrollTop > 0)) { cleanup(); return; }
        dragging = true; sheet.classList.add('dragging');
      }
      const now = performance.now(); vel = (ev.clientY - lastY) / Math.max(1, now - lastT); lastY = ev.clientY; lastT = now;
      sheet.style.transform = `translateY(${Math.max(0, startT + dy)}px)`; ev.preventDefault?.();
    };
    const up = () => {
      cleanup();
      if (!dragging) return;
      sheet.classList.remove('dragging'); const y = curY(); sheet.style.transform = '';
      const H = sheet.offsetHeight, pos = { full: 0, half: H - innerHeight * 0.52, peek: H - (parseFloat(getComputedStyle(sheet).getPropertyValue('--peek')) || 170) - (parseFloat(getComputedStyle(document.querySelector('.tabbar')).height) || 56) };
      let target;
      const near = order.reduce((b, d) => Math.abs(pos[d] - y) < Math.abs(pos[b] - y) ? d : b, 'peek');
      const cur = order.indexOf(sheet.dataset.detent);
      if (vel < -0.45) target = order[Math.min(2, cur + 1)];
      else if (vel > 0.45) target = order[Math.max(0, cur - 1)];
      else target = near;
      set(target);
    };
    const cleanup = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  $('#grab').addEventListener('pointerdown', e => down(e, false));
  body.addEventListener('pointerdown', e => { if (e.target.closest('input,textarea,select,.chips,canvas.profile')) return; down(e, true); });
  $('#grab').addEventListener('click', () => set(sheet.dataset.detent === 'peek' ? 'half' : sheet.dataset.detent === 'half' ? 'full' : 'peek'));
  return { set, get: () => sheet.dataset.detent, body };
}

// Make an emoji marker image for the map (works offline: drawn with system emoji font)
export function emojiImage(emoji, bg = '#ffffff', ring = '#2f7d4f', size = 64) {
  const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
  x.beginPath(); x.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2); x.fillStyle = bg; x.fill(); x.lineWidth = 4; x.strokeStyle = ring; x.stroke();
  x.font = `${size * 0.48}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(emoji, size / 2, size / 2 + 2);
  return x.getImageData(0, 0, size, size);
}
