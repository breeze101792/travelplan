import { initTimeline } from '/static/js/timeline.js';

export async function init(container, ctx) {
  const timeline = document.createElement('div');
  timeline.id = 'timeline';
  timeline.className = 'timeline';
  container.appendChild(timeline);

  await initTimeline(ctx);

  return () => {
    container.innerHTML = '';
  };
}