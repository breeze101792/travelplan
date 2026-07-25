const THRESHOLD = 80;
const MAX_PULL = 120;
const VISIBLE_HEIGHT = 50;

let state = { pulling: false, startY: 0, currentY: 0, el: null };

function init() {
  state.el = document.createElement('div');
  state.el.id = 'ptr';
  state.el.innerHTML = '<div id="ptr-indicator"><svg id="ptr-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span id="ptr-text">Pull to refresh</span></div>';
  document.body.prepend(state.el);

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
}

function onTouchStart(e) {
  state.pulling = true;
  state.startY = e.touches[0].clientY;
  state.currentY = state.startY;
  state.el.classList.remove('ptr-releasing', 'ptr-refreshing');
}

function onTouchMove(e) {
  if (!state.pulling) return;
  state.currentY = e.touches[0].clientY;
  const dy = state.currentY - state.startY;
  if (dy <= 0 || window.scrollY > 0) { state.pulling = false; return; }
  e.preventDefault();
  const pull = Math.min(dy, MAX_PULL);
  const progress = Math.min(pull / THRESHOLD, 1);
  state.el.style.setProperty('--ptr-pull', pull + 'px');
  state.el.classList.toggle('ptr-ready', progress >= 1);
  state.el.querySelector('#ptr-icon').style.transform = `rotate(${progress * 180}deg)`;
}

function onTouchEnd() {
  if (!state.pulling) return;
  state.pulling = false;
  const dy = state.currentY - state.startY;
  if (dy >= THRESHOLD && window.scrollY === 0) {
    state.el.classList.add('ptr-refreshing');
    state.el.classList.remove('ptr-ready');
    state.el.querySelector('#ptr-text').textContent = 'Refreshing…';
    location.reload();
  } else {
    state.el.classList.add('ptr-releasing');
    state.el.style.setProperty('--ptr-pull', '0px');
    state.el.querySelector('#ptr-icon').style.transform = 'rotate(0deg)';
    state.el.querySelector('#ptr-text').textContent = 'Pull to refresh';
    setTimeout(() => state.el.classList.remove('ptr-releasing'), 300);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
