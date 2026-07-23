import { apiGet, apiPost, apiPatch, apiDel, apiUpload } from '/static/js/api.js';
const api = { get: apiGet, post: apiPost, patch: apiPatch, del: apiDel, upload: apiUpload };
import { buildDays, wirePlanHeader } from '/static/js/plan-header.js';
import { Staging, moveItemOp, deleteItemOp } from '/static/js/staging.js';
import { el, clear } from '/static/js/util.js';
import { openItemEditor } from '/static/js/item-editor.js';
import { clipboardGet, clipboardSet, serializeItem } from '/static/js/clipboard.js';

const DAY_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
];

function pickColor(i) { return DAY_COLORS[i % DAY_COLORS.length]; }

let map = null;
let dayLayers = {};
let expIndex = null;
let days = [];
let dayCoords = {};
let allItems = [];
let plan = null;
let staging = null;
let settings = null;
let ctx = null;
let selectedItemId = null;

/* ---------- draw ---------- */

function removeDay(dayIndex) {
  const layer = dayLayers[dayIndex];
  if (!layer) return;
  for (const m of layer.markers) map.removeLayer(m);
  if (layer.polyline) map.removeLayer(layer.polyline);
}

function defaultMarkerStyle(coordIdx, total, color) {
  if (total === 1) return { radius: 8, fillColor: color, borderColor: '#fff', borderWidth: 2, labelPrefix: '' };
  if (coordIdx === 0) return { radius: 10, fillColor: '#22c55e', borderColor: '#166534', borderWidth: 3, labelPrefix: 'Start: ' };
  if (coordIdx === total - 1) return { radius: 10, fillColor: '#ef4444', borderColor: '#991b1b', borderWidth: 3, labelPrefix: 'End: ' };
  return { radius: 7, fillColor: color, borderColor: '#fff', borderWidth: 2, labelPrefix: '' };
}

function drawDay(dayIndex, coords, color) {
  removeDay(dayIndex);
  const markers = [];
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    const sty = defaultMarkerStyle(i, coords.length, color);
    const m = L.circleMarker([c.lat, c.lng], {
      radius: sty.radius, fillColor: sty.fillColor, color: sty.borderColor,
      weight: sty.borderWidth, fillOpacity: .9,
    });
    m.bindTooltip(sty.labelPrefix + c.label, { permanent: false, direction: 'top' });
    m.itemId = c.item.id;
    m.coordIdx = i;
    m.addTo(map);
    markers.push(m);
  }
  let polyline = null;
  if (coords.length > 1) {
    polyline = L.polyline(coords.map(c => [c.lat, c.lng]), { color, weight: 3, opacity: .7 });
    polyline.addTo(map);
  }
  dayLayers[dayIndex] = { markers, polyline, visible: true };
  if (coords.length) {
    const lats = coords.map(c => c.lat);
    const lngs = coords.map(c => c.lng);
    map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [50, 50], maxZoom: 14 });
  }
}

function resetMarkerStyle(m, dayIdx) {
  const coords = dayCoords[Number(dayIdx)] || [];
  const sty = defaultMarkerStyle(m.coordIdx, coords.length, pickColor(Number(dayIdx)));
  m.setStyle({ radius: sty.radius, fillColor: sty.fillColor, color: sty.borderColor, weight: sty.borderWidth, fillOpacity: .9 });
}

function highlightMarker(m) {
  m.setStyle({ radius: 14, fillColor: '#fbbf24', color: '#d97706', weight: 4, fillOpacity: 1 });
  m.bringToFront();
}

function highlightItemMarkers(itemId) {
  for (const dayIdx in dayLayers) {
    for (const m of dayLayers[dayIdx].markers) {
      if (m.itemId === itemId) highlightMarker(m);
      else resetMarkerStyle(m, dayIdx);
    }
  }
}

/* ---------- context menu ---------- */

let contextMenuEl = null;

function closeContextMenu() {
  if (contextMenuEl) {
    if (contextMenuEl.remove) contextMenuEl.remove();
    else if (contextMenuEl.parentNode) contextMenuEl.parentNode.removeChild(contextMenuEl);
  }
  contextMenuEl = null;
}

function showContextMenu(x, y, item, dayIdx) {
  closeContextMenu();

  const menu = el('ul', { class: 'context-menu', role: 'menu' });
  const day = days[dayIdx];

  const items = [
    { label: 'Cut', shortcut: '\u2318X', enabled: true, action: () => {
      clipboardSet({ items: [item], action: 'cut' });
      staging.add(deleteItemOp({ itemId: item.id, label: `Cut ${item.title || 'item'}`, sessionId: 'cut-' + item.id }));
      closeContextMenu();
      reloadAll();
    }},
    { label: 'Delete', shortcut: 'Del', enabled: true, danger: true, action: () => {
      staging.add(deleteItemOp({ itemId: item.id, label: `Delete ${item.title || 'item'}` }));
      closeContextMenu();
      reloadAll();
    }},
    { sep: true },
    { label: 'Open detail', enabled: true, action: () => {
      closeContextMenu();
      openItemEditor(ctx, {
        plan, item, settings, members: [], staging, sessionId: 'map-' + item.id,
        onApplied: () => { reloadAll(); },
      });
    }},
  ];

  for (const it of items) {
    if (it.sep) { menu.appendChild(el('li', { class: 'context-menu-sep' })); continue; }
    const li = el('li', { class: 'context-menu-item' + (it.danger ? ' is-danger' : ''), role: 'menuitem' });
    const btn = el('button', { type: 'button', text: it.label });
    btn.disabled = !it.enabled;
    btn.addEventListener('click', (e) => { e.stopPropagation(); it.action(); });
    li.appendChild(btn);
    if (it.shortcut) li.appendChild(el('span', { class: 'context-menu-shortcut', text: it.shortcut }));
    menu.appendChild(li);
  }

  document.body.appendChild(menu);

  let rectW = 200, rectH = 200;
  try { const r = menu.getBoundingClientRect(); if (r) { rectW = r.width || rectW; rectH = r.height || rectH; } } catch (e) {}
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  menu.style.left = Math.max(8, Math.min(x, vw - rectW - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, vh - rectH - 8)) + 'px';
  contextMenuEl = menu;
}

document.addEventListener('click', (e) => {
  if (contextMenuEl && !contextMenuEl.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && contextMenuEl) { closeContextMenu(); return; }
});
document.addEventListener('scroll', closeContextMenu, { capture: true, passive: true });

/* ---------- drag helpers ---------- */

function wireItemDrag(el, itemId) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(itemId));
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));

  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    const t = e.touches[0];
    el._tdrag = {
      itemId, el,
      startX: t.clientX, startY: t.clientY,
      active: false,
      timer: setTimeout(() => {
        el._tdrag.active = true;
        el.classList.add('dragging');
      }, 500),
    };
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    const ds = el._tdrag;
    if (!ds) return;
    const t = e.touches[0];
    const dayList = document.getElementById('day-list');
    if (ds.active) {
      e.preventDefault();
      const hdr = findDayHeaderAt(dayList, t.clientY);
      dayList.querySelectorAll('.day-header.drop-target').forEach(x => x.classList.remove('drop-target'));
      if (hdr) hdr.classList.add('drop-target');
      return;
    }
    const dx = Math.abs(t.clientX - ds.startX);
    const dy = Math.abs(t.clientY - ds.startY);
    if (dx > 12 || dy > 12) {
      clearTimeout(ds.timer);
      delete el._tdrag;
    }
  }, { passive: false });

  el.addEventListener('touchend', async (e) => {
    const ds = el._tdrag;
    if (!ds) return;
    if (!ds.active) {
      clearTimeout(ds.timer);
      delete el._tdrag;
      return;
    }
    e.preventDefault();
    el.classList.remove('dragging');
    const dayList = document.getElementById('day-list');
    dayList.querySelectorAll('.day-header.drop-target').forEach(x => x.classList.remove('drop-target'));
    const t = e.changedTouches[0];
    const hdr = findDayHeaderAt(dayList, t.clientY);
    if (hdr) {
      const targetDate = hdr.dataset.targetDate;
      const item = allItems.find(it => String(it.id) === String(ds.itemId));
      if (item && item.item_date !== targetDate) {
        staging.add(moveItemOp({
          planId: plan.id, itemId: Number(ds.itemId), item_date: targetDate,
        }));
        item.item_date = targetDate;
        await reloadAll();
      }
    }
    delete el._tdrag;
  }, { passive: false });
}

function enableDropZone(container) {
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const hdr = findDayHeaderAt(container, e.clientY);
    container.querySelectorAll('.day-header.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (hdr) hdr.classList.add('drop-target');
  });
  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) {
      container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    }
  });
  container.addEventListener('drop', async (e) => {
    e.preventDefault();
    container.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    const hdr = findDayHeaderAt(container, e.clientY);
    if (!hdr) return;
    const targetDate = hdr.dataset.targetDate;
    const itemId = e.dataTransfer.getData('text/plain');
    if (!itemId || !targetDate) return;
    const item = allItems.find(it => String(it.id) === itemId);
    if (!item || item.item_date === targetDate) return;
    staging.add(moveItemOp({
      planId: plan.id, itemId: Number(itemId), item_date: targetDate,
    }));
    item.item_date = targetDate;
    await reloadAll();
  });
}

function findDayHeaderAt(container, clientY) {
  const headers = [...container.querySelectorAll('.day-header')];
  if (!headers.length) return null;
  for (const h of headers) {
    const r = h.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return h;
  }
  return headers[headers.length - 1];
}

/* ---------- render ---------- */

function renderList() {
  const container = document.getElementById('day-list');
  if (!container) return;
  clear(container);
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (!day) continue;
    const color = pickColor(i);
    const isExpanded = i === expIndex;

    const hdr = document.createElement('div');
    hdr.className = 'day-header' + (isExpanded ? ' expanded' : '') + (i === expIndex ? ' active' : '');
    hdr.dataset.targetDate = day.date;
    hdr.innerHTML = `
      <span class="day-dot" style="background:${color}"></span>
      <span class="day-expand-icon">&#9654;</span>
      <span class="day-label">${day.label}</span>
      <span class="day-count">${dayItemsFor(i).length}</span>
    `;
    hdr.addEventListener('click', () => toggleDay(i));
    container.appendChild(hdr);

    if (isExpanded) {
      const items = dayItemsFor(i);
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'day-item';
        empty.style.cssText = 'cursor:default;opacity:.5;';
        empty.innerHTML = '<span class="di-title">No items</span>';
        container.appendChild(empty);
      } else {
        for (const it of items) {
          const row = document.createElement('div');
          row.className = 'day-item' + (selectedItemId === it.id ? ' selected' : '');
          row.dataset.itemId = it.id;
          row.innerHTML = `
            <span class="di-type">${it.item_type}</span>
            <span class="di-title">${it.title}</span>
          `;
          row.addEventListener('click', (e) => {
            container.querySelectorAll('.day-item.selected').forEach(el => el.classList.remove('selected'));
            selectedItemId = it.id;
            row.classList.add('selected');
            highlightItemMarkers(it.id);
          });
          row.addEventListener('dblclick', () => {
            openItemEditor(ctx, {
              plan, item: it, settings, members: [], staging,
              sessionId: 'map-detail-' + it.id,
              onApplied: () => { reloadAll(); },
            });
          });
          row.addEventListener('contextmenu', (e) => {
            if (ctx.role === 'viewer') return;
            e.preventDefault();
            selectedItemId = it.id;
            container.querySelectorAll('.day-item.selected').forEach(el => el.classList.remove('selected'));
            row.classList.add('selected');
            highlightItemMarkers(it.id);
            showContextMenu(e.clientX, e.clientY, it, i);
          });
          wireItemDrag(row, it.id);
          container.appendChild(row);
        }
      }
    }
  }
}

function dayItemsFor(dayIndex) {
  return allItems.filter(it => it.item_date === days[dayIndex].date && it.item_type !== 'hotel');
}

function toggleDay(index) {
  const wasExpanded = expIndex === index;
  if (wasExpanded) {
    expIndex = null;
    selectedItemId = null;
    for (const idx in dayLayers) removeDay(Number(idx));
    dayLayers = {};
    renderList();
    return;
  }
  expIndex = index;
  selectedItemId = null;
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  const coords = dayCoords[index] || [];
  if (coords.length) drawDay(index, coords, pickColor(index));
  renderList();
  const hdr = document.querySelector('.day-header.active');
  if (hdr) hdr.scrollIntoView({ block: 'nearest' });
}

/* ---------- reload ---------- */

async function reloadAll() {
  selectedItemId = null;
  const res = await apiGet(`/api/plans/${plan.id}/items`);
  allItems = res.items || [];
  dayCoords = {};
  for (let i = 0; i < days.length; i++) {
    const batch = [];
    for (const it of dayItemsFor(i)) {
      for (const g of (it.geocodes || [])) {
        batch.push({ lat: g.lat, lng: g.lng, label: g.label, item: it });
      }
    }
    dayCoords[i] = batch;
  }
  for (const idx in dayLayers) removeDay(Number(idx));
  dayLayers = {};
  renderList();
  if (expIndex !== null) {
    const coords = dayCoords[expIndex] || [];
    if (coords.length) drawDay(expIndex, coords, pickColor(expIndex));
  }
  renderPendingBar();
}

/* ---------- init ---------- */

export async function initMap(c) {
  ctx = c;
  const container = document.getElementById('map-container');
  if (!container) return;

  const settingsRes = await apiGet('/api/settings');
  settings = settingsRes;

  const planRes = await apiGet(`/api/plans/${ctx.planId}`);
  plan = planRes.plan;

  if (!plan.start_date || !plan.end_date) {
    container.innerHTML = '<div class="map-empty">Set a start and end date for this plan to see the map.</div>';
    return;
  }

  staging = new Staging({ planId: ctx.planId });
  wirePlanHeader({ plan, staging, ctx, onChange: () => {} });

  map = L.map(container).setView([35.6762, 139.6503], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);

  days = buildDays(plan);

  // Load items with their persisted geocodes (set via the item editor)
  const itemsRes = await apiGet(`/api/plans/${ctx.planId}/items`);
  allItems = itemsRes.items || [];

  dayCoords = {};
  for (let i = 0; i < days.length; i++) {
    const batch = [];
    for (const it of dayItemsFor(i)) {
      for (const g of (it.geocodes || [])) {
        batch.push({ lat: g.lat, lng: g.lng, label: g.label, item: it });
      }
    }
    dayCoords[i] = batch;
  }

  enableDropZone(document.getElementById('day-list'));
  renderList();
  expIndex = 0;
  toggleDay(0);
  const anyCoords = Object.values(dayCoords).some(c => c.length);
  if (!anyCoords) map.setView([35.6762, 139.6503], 5);
  renderPendingBar();
}

function renderPendingBar() {
  const bar = document.getElementById('pending-bar');
  if (!bar) return;
  clear(bar);
  if (ctx.role === 'viewer') { bar.hidden = true; return; }

  const hasPending = staging.hasPending;
  const canUndo = staging.canUndo;
  const canRedo = staging.canRedo;
  const canSave = hasPending && !staging.saving;
  const failed = staging.failedOpIndex >= 0;
  const lastLabel = hasPending ? staging.ops[staging.pointer - 1].label : '';

  bar.append(
    el('button', { type:'button', class:'pb-btn', text:'↶ Revert', disabled:!canUndo, onclick:()=>{ staging.undo(); renderPendingBar(); reloadAll(); }}),
    el('button', { type:'button', class:'pb-btn', text:'↷ Redo', disabled:!canRedo, onclick:()=>{ staging.redo(); renderPendingBar(); }}),
    el('button', { type:'button', class:'pb-btn pb-save', text:staging.saving?'Saving…':'Save', disabled:!canSave, onclick:async()=>{ await staging.saveAll(api); renderPendingBar(); reloadAll(); }}),
    el('span', { class:'pb-status'+(failed?' pb-failed':''), text:staging.saving?'Saving changes…':failed?`Save failed: ${staging.failedError}`:hasPending?`${staging.pendingCount} pending — last: ${lastLabel}`:'All changes saved' }),
  );
  bar.hidden = !hasPending && !failed;
}
