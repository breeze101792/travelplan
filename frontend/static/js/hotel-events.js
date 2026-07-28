/* hotel-events.js — generates virtual check-in / check-out items from hotel
 * data so they appear alongside regular items on every view (board, timeline,
 * navigation, map).
 *
 * Each hotel that has a ``when.start_at`` / ``when.end_at`` produces two
 * single-day virtual items with `_hotelEvent` set to `'check-in'` or
 * `'check-out'` and `_hotelId` pointing back to the parent hotel. Real
 * (spanning) hotels are left untouched — the caller still sees them in the
 * returned list.
 *
 * The virtual events carry the time in ``details.when.start_at`` /
 * ``details.when.end_at`` (the unified time shape every other reader
 * expects). An earlier version used ``details.time``, which meant the
 * timeline's ``itemTimeWindow`` saw an empty `when` and placed the
 * check-in bar at 00:00 instead of the actual check-in time. Hotels are
 * a special case: the check-in time is the actual time the guest arrives
 * (often 15:00 / 16:00), and the check-out time is the actual time they
 * leave (often 10:00 / 11:00), so the bars must follow those exact
 * times on the day-of-time axis. */
function timeToSortKey(iso) {
  if (!iso) return undefined;
  const m = String(iso).match(/T(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h)) return undefined;
  return h + (Number.isFinite(min) ? min / 60 : 0);
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
      // The virtual event re-exposes the parent's when object so
      // itemTimeWindow() (which reads details.when.start_at) sees the
      // same shape the parent hotel does. We also keep sort_key in
      // sync with the actual time so the chip sorts correctly inside
      // the untimed-list (which uses the time as its sort anchor).
      extra.push({
        id: `_checkin_${item.id}`,
        _hotelId: item.id,
        _hotelEvent: 'check-in',
        item_type: 'hotel',
        title: `Check-in: ${hotelLabel}`,
        item_date: item.item_date,
        details: { when: { start_at: when.start_at } },
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
        details: { when: { start_at: when.end_at } },
        sort_key: timeToSortKey(when.end_at),
        status: item.status,
      });
    }
  }
  return items.concat(extra);
}
