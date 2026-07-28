import { initOverview } from '/static/js/overview.js';

export async function init(container, ctx) {
  const root = document.createElement('div');
  root.id = 'overview-root';
  root.className = 'overview-page';
  container.appendChild(root);

  await initOverview(ctx);

  return () => {
    container.innerHTML = '';
  };
}