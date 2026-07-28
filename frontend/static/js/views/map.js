import { initMap } from '/static/js/map.js';

export async function init(container, ctx) {
  const page = document.createElement('div');
  page.className = 'map-page';
  page.innerHTML = '<div id="map-container" class="map-container"></div><aside class="map-sidebar"><h2 class="map-sidebar-title">Days</h2><div id="day-list" class="day-list"></div></aside>';
  container.appendChild(page);

  await initMap(ctx);

  return () => {
    container.innerHTML = '';
  };
}