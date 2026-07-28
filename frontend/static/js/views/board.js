import { initItinerary } from '/static/js/itinerary.js';

export async function init(container, ctx) {
  const board = document.createElement('div');
  board.id = 'board';
  board.className = 'board';
  container.appendChild(board);

  await initItinerary(ctx);

  return () => {
    container.innerHTML = '';
  };
}