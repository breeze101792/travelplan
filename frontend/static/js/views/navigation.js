import { initNavigation } from '/static/js/navigation.js';

export async function init(container, ctx) {
  const root = document.createElement('div');
  root.id = 'nav-page';
  container.appendChild(root);

  await initNavigation(ctx);

  return () => {
    container.innerHTML = '';
  };
}