/* hotel-events.js — generates virtual check-in / check-out items from hotel
 * data so they appear alongside regular items on every view (board, timeline,
 * navigation, map).
 *
 * Each hotel that has a ``when.start_at`` / ``when.end_at`` produces two
 * single-day virtual items with `_hotelEvent` set to `'check-in'` or
 * `'check-out'` and `_hotelId` pointing back to the parent hotel. Real
 * (spanning) hotels are left untouched — the caller still sees them in the
 * returned list.
 */

function timeToSortKey(time) {
  if (!time) return undefined;
  const [h, m] = String(time).split(':').map(Number);
  if (isNaN(h)) return undefined;
  return h + (isNaN(m) ? 0 : m / 60);
}

export function expandHotelEvents(items) {
  const extra = [];
  for (const item of items) {
    if (item.item_type !== 'hotel') continue;
    if (!item.end_date) continue;
    const d = item.details || {};
    const when = d.when || {};
    const hotelLabel = d.hotel_name || item.title || 'Hotel';

    if (when.start_at) {
      extra.push({
        id: `_checkin_${item.id}`,
        _hotelId: item.id,
        _hotelEvent: 'check-in',
        item_type: 'hotel',
        title: `Check-in: ${hotelLabel}`,
        item_date: item.item_date,
        details: { time: when.start_at },
        sort_key: timeToSortKey(when.start_at),
        status: item.status,
      });
    }

    if (when.end_at) {
      extra.push({
        id: `_checkout_${item.id}`,
        _hotelId: item.id,
        _hotelEvent: 'check-out',
        item_type: 'hotel',
        title: `Check-out: ${hotelLabel}`,
        item_date: item.end_date,
        details: { time: when.end_at },
        sort_key: timeToSortKey(when.end_at),
        status: item.status,
      });
    }
  }
  return items.concat(extra);
}
