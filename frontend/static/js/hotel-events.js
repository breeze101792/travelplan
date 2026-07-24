/* hotel-events.js — generates virtual check-in / check-out items from hotel
 * data so they appear alongside regular items on every view (board, timeline,
 * navigation, map).
 *
 * Each hotel that has a check_in_time / check_out_time produces two single-day
 * virtual items with `_hotelEvent` set to `'check-in'` or `'check-out'` and
 * `_hotelId` pointing back to the parent hotel.  Real (spanning) hotels are
 * left untouched — the caller still sees them in the returned list.
 */

export function expandHotelEvents(items) {
  const extra = [];
  for (const item of items) {
    if (item.item_type !== 'hotel') continue;
    if (!item.end_date) continue;
    const d = item.details || {};
    const hotelLabel = d.hotel_name || item.title || 'Hotel';

    if (d.check_in_time) {
      extra.push({
        id: `_checkin_${item.id}`,
        _hotelId: item.id,
        _hotelEvent: 'check-in',
        item_type: 'hotel',
        title: `Check-in: ${hotelLabel}`,
        item_date: item.item_date,
        details: { time: d.check_in_time },
        status: item.status,
      });
    }

    if (d.check_out_time) {
      extra.push({
        id: `_checkout_${item.id}`,
        _hotelId: item.id,
        _hotelEvent: 'check-out',
        item_type: 'hotel',
        title: `Check-out: ${hotelLabel}`,
        item_date: item.end_date,
        details: { time: d.check_out_time },
        status: item.status,
      });
    }
  }
  return items.concat(extra);
}
