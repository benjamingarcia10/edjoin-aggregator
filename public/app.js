/* ============================================================
   Edjoin Radius — client app
   Loads the geocoded job snapshot, draws a radius on a Leaflet
   map, and keeps a distance-sorted result list in sync.
   ============================================================ */

const DATA_URL = "data/jobs.geo.json"; // relative so it works at a GitHub Pages subpath too
const DEFAULT_CENTER = { lat: 37.3382, lon: -121.8863, label: "San Jose, CA" };
const PAGE = 120; // cards rendered per batch; more load on scroll (no hard cap)

const el = (id) => document.getElementById(id);
const app = el("app");

const state = {
  jobs: [],          // all geocoded jobs
  unmapped: [],      // postings with no usable location (shown in a side list)
  center: { ...DEFAULT_CENTER },
  radius: 25,        // miles
  filters: { kw: "", jobtype: "", sort: "distance" },
  matches: [],       // current filtered + in-radius jobs (with .dist)
  rendered: 0,       // how many of matches are currently in the DOM
  activeId: null,
};

let map, tiles, ring, centerMarker, cluster;
const markerById = new Map();

/* ---------- geo helpers ---------- */
function haversineMiles(a, b) {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- formatting ---------- */
const fmtInt = (n) => (n ?? 0).toLocaleString("en-US");
function fmtDist(mi) {
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}
// Salary: prefer the detail-page values (the list API leaves salary null for many
// postings). Returns { primary, addl } or null. `primary` is the salary line
// (e.g. "Pay Range $4,811 - $5,990 Monthly" or "Pay dependent on experience");
// `addl` is the extra range some postings carry (e.g. "$68,463-$139,224").
function getSalary(j) {
  const d = j.detail || {};
  let primary = d.salary || null;
  const addl = d.salaryAddl || null;
  if (!primary) {
    const a = Number(j.beginningSalary), b = Number(j.endingSalary);
    if (a && b && a !== b) primary = `$${fmtInt(a)} – $${fmtInt(b)}`;
    else if (a) primary = `$${fmtInt(a)}`;
    else if (j.salaryInfo && j.salaryInfo.trim()) primary = j.salaryInfo.trim();
  }
  if (!primary && !addl) return null;
  return { primary, addl };
}
function hasSalary(j) {
  return !!getSalary(j);
}
// compact salary for the card tag — favors a concrete $range when available
function salaryShort(j) {
  const s = getSalary(j);
  if (!s) return "";
  if (s.addl && /\$/.test(s.addl)) return s.addl;
  return s.primary || s.addl || "";
}
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
// truncate a free-text value (some fields like workYear hold long schedules)
const short = (s, n) => {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
};

/* ---------- data load ---------- */
async function loadData() {
  setVeil("Loading the field survey…");
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`could not load ${DATA_URL} (${res.status})`);
  const payload = await res.json();
  const all = payload.jobs || [];
  state.jobs = all.filter((j) => j.geo && Number.isFinite(j.geo.lat));
  state.unmapped = all.filter((j) => !(j.geo && Number.isFinite(j.geo.lat)));

  el("statTotal").textContent = fmtInt(payload.count);
  el("statMapped").textContent = fmtInt(state.jobs.length);
  el("statDate").textContent = payload.builtAt ? fmtDateTime(payload.builtAt) : "—";
  el("statDate").title = payload.builtAt ? new Date(payload.builtAt).toString() : "";

  renderUnmapped();
}

// Postings with no usable location can't appear on the map or in radius search,
// so surface them in a small always-available disclosure.
function renderUnmapped() {
  const det = el("unmapped");
  if (!state.unmapped.length) {
    det.hidden = true;
    return;
  }
  det.hidden = false;
  el("unmappedCount").textContent = fmtInt(state.unmapped.length);
  const list = el("unmappedList");
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const j of state.unmapped) {
    const li = document.createElement("li");
    const where = [j.city, j.county ? `${j.county} County` : null, j.state].filter(Boolean);
    li.innerHTML = `
      <b>${esc(j.title)}</b>
      ${esc(j.district || "")}${where.length ? " · " + where.map(esc).join(", ") : ""}
      <br /><a href="${esc(j.url)}" target="_blank" rel="noopener">View on Edjoin ↗</a>`;
    frag.appendChild(li);
  }
  list.appendChild(frag);
}

// Rebuild the job-type dropdown from the jobs currently in the search area, with
// per-type counts. Only types with results appear. A previously-selected type that
// no longer has results in the area is cleared (so you never select an empty filter).
// The DOM is only rewritten when the option set actually changes (cheap during slider drags).
let lastTypeSig = "";
function refreshJobTypes(inArea) {
  const counts = new Map();
  for (const j of inArea) if (j.jobType) counts.set(j.jobType, (counts.get(j.jobType) || 0) + 1);

  if (state.filters.jobtype && !counts.has(state.filters.jobtype)) state.filters.jobtype = "";

  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sig = `${state.filters.jobtype}|${inArea.length}|${entries.map((e) => e[0] + e[1]).join(",")}`;
  if (sig === lastTypeSig) return;
  lastTypeSig = sig;

  const sel = el("jobtype");
  sel.innerHTML =
    `<option value="">All types (${fmtInt(inArea.length)})</option>` +
    entries.map(([t, n]) => `<option value="${esc(t)}">${esc(t)} (${fmtInt(n)})</option>`).join("");
  sel.value = state.filters.jobtype;
}

/* ---------- map ---------- */
function initMap() {
  map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(
    [state.center.lat, state.center.lon],
    9,
  );
  tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a> · job data from edjoin.org',
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(map);

  cluster = L.markerClusterGroup({
    chunkedLoading: true,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    maxClusterRadius: 48,
  });
  map.addLayer(cluster);

  // build all job markers once
  for (const j of state.jobs) {
    const m = L.marker([j.geo.lat, j.geo.lon], {
      icon: L.divIcon({
        className: "pin-wrap",
        html: `<span class="pin-job" data-id="${j.id}"></span>`,
        iconSize: [15, 15],
        iconAnchor: [7.5, 7.5],
        popupAnchor: [0, -8],
      }),
    });
    m.bindPopup(() => popupHtml(j), { closeButton: true, autoPan: true });
    m.on("click", () => setActive(j.id, { fromMap: true }));
    markerById.set(j.id, m);
  }

  ring = L.circle([state.center.lat, state.center.lon], {
    radius: state.radius * 1609.34,
    color: "#1f9e96",
    weight: 1.5,
    fillColor: "#2bb8af",
    fillOpacity: 0.07,
    dashArray: "5 6",
  }).addTo(map);

  centerMarker = L.marker([state.center.lat, state.center.lon], {
    icon: L.divIcon({
      className: "pin-wrap",
      html: `<span class="pin-center"></span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    zIndexOffset: 1000,
    draggable: true,
  }).addTo(map);
  centerMarker.on("dragend", () => {
    const p = centerMarker.getLatLng();
    state.center = { lat: p.lat, lon: p.lng, label: "custom point" };
    el("locInput").value = "";
    recompute({ fit: false });
  });

  map.on("click", (e) => {
    // On mobile with the sheet expanded, the map is just a thin strip peeking
    // above the sheet — a tap there means "let me see the map", not "move the
    // center". Collapse the sheet first; only reposition the center once the map
    // is actually the focus (sheet collapsed). On desktop this guard is inert.
    if (isMobile() && sheet.expanded) {
      sheet.collapse();
      return;
    }
    state.center = { lat: e.latlng.lat, lon: e.latlng.lng, label: "map point" };
    el("locInput").value = "";
    el("clearLoc").hidden = false;
    recompute({ fit: false });
  });

  // the map height is viewport-relative (52vh) on mobile, so it changes on
  // rotation/resize — Leaflet needs to recompute its pixel size or tiles misalign
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => map.invalidateSize(), 200);
  });
}

function popupHtml(j) {
  const dist = haversineMiles(state.center, j.geo);
  const d = j.detail || {};
  const s = getSalary(j);
  const sal = s
    ? `<p class="pop__row pop__salary">${esc(s.primary || "")}${s.addl ? ` <span>· ${esc(s.addl)}</span>` : ""}</p>`
    : "";
  const meta = [
    d.employmentType,
    d.workYear,
    d.openings && Number(d.openings) > 1 ? `${d.openings} openings` : null,
  ].filter(Boolean);
  const contactBits = [d.contactName, d.contactPhone, d.contactEmail].filter(Boolean);
  // location line, honest about how precisely we placed the pin
  const prec = j.geo?.precision;
  let loc = "";
  if (prec === "address" && d.street) loc = `${esc(d.street)}, ${esc(j.city || "")}`;
  else if (j.city) loc = `${esc(j.city)} <span class="pop__approx">(${prec === "zip" ? "ZIP-area" : "city-level"})</span>`;
  else if (j.county) loc = `${esc(j.county)} County <span class="pop__approx">(county-level, approx.)</span>`;
  return `
    <div>
      <p class="pop__title">${esc(j.title)}</p>
      <p class="pop__sub">${esc(j.district || "")}</p>
      <p class="pop__row"><b>${fmtDist(dist)}</b> from center${j.jobType ? " · " + esc(j.jobType) : ""}</p>
      ${loc ? `<p class="pop__row pop__addr">${loc}</p>` : ""}
      ${sal}
      ${meta.length ? `<p class="pop__row">${meta.map(esc).join(" · ")}</p>` : ""}
      ${j.closes ? `<p class="pop__row">closes <b>${fmtDate(j.closes)}</b></p>` : ""}
      ${contactBits.length ? `<p class="pop__row pop__contact">${contactBits.map(esc).join(" · ")}</p>` : ""}
      <a class="pop__link" href="${esc(j.url)}" target="_blank" rel="noopener">View on Edjoin ↗</a>
    </div>`;
}

/* ---------- core recompute ---------- */
function recompute({ fit = false } = {}) {
  const { kw, sort } = state.filters;
  const kwLow = kw.trim().toLowerCase();
  const c = state.center;

  // move ring + center marker
  ring.setLatLng([c.lat, c.lon]).setRadius(state.radius * 1609.34);
  centerMarker.setLatLng([c.lat, c.lon]);

  // jobs within radius + keyword, IGNORING the job-type filter — this set drives
  // the job-type dropdown so it only ever lists types present in the current area.
  const inArea = [];
  for (const j of state.jobs) {
    if (kwLow) {
      const hay = `${j.title} ${j.district || ""} ${j.city || ""} ${j.category || ""}`.toLowerCase();
      if (!hay.includes(kwLow)) continue;
    }
    const dist = haversineMiles(c, j.geo);
    if (dist > state.radius) continue;
    j._dist = dist;
    inArea.push(j);
  }

  // rebuild the type dropdown from what's actually here (may clear a stale selection)
  refreshJobTypes(inArea);
  const type = state.filters.jobtype;
  const matches = type ? inArea.filter((j) => j.jobType === type) : inArea;

  sortMatches(matches, sort);
  state.matches = matches;

  renderMarkers(matches);
  renderList(matches);
  updateCount(matches.length);

  if (fit) {
    centerMap([c.lat, c.lon], zoomForRadius(state.radius));
  }
}

// Recenter the map on a point. On mobile the bottom sheet covers the lower part
// of the map, so the geometric center sits under it (cutting off the marker/ring).
// Shift the view up by half the covered height so the point lands in the middle
// of the VISIBLE map. On desktop the rail is a side panel, so no offset is needed.
function bottomInsetPx() {
  if (!isMobile()) return 0;
  const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-peek")) || 210;
  // clamp so a tall sheet on a short (landscape) screen can't pan the point off-screen
  const mapH = map.getContainer().offsetHeight || 0;
  return mapH ? Math.min(raw, mapH * 0.4) : raw;
}
function centerMap(latlng, zoom) {
  map.setView(latlng, zoom, { animate: false });
  const inset = bottomInsetPx();
  if (inset) map.panBy([0, Math.round(inset / 2)], { animate: false });
}

function sortMatches(arr, sort) {
  const cmp = {
    distance: (a, b) => a._dist - b._dist,
    posted: (a, b) => (b.posted || "").localeCompare(a.posted || ""),
    title: (a, b) => a.title.localeCompare(b.title),
    district: (a, b) => (a.district || "").localeCompare(b.district || ""),
  }[sort];
  arr.sort(cmp);
}

function zoomForRadius(mi) {
  if (mi <= 5) return 11;
  if (mi <= 15) return 10;
  if (mi <= 30) return 9;
  if (mi <= 60) return 8;
  return 7;
}

/* ---------- render: markers ---------- */
function renderMarkers(matches) {
  cluster.clearLayers();
  const layers = [];
  for (const j of matches) layers.push(markerById.get(j.id));
  cluster.addLayers(layers);
}

/* ---------- render: list (incremental — renders PAGE at a time, more on scroll) ---------- */
function buildCard(j, i) {
  const li = document.createElement("li");
  li.className = "jobcard";
  li.dataset.id = j.id;
  if (i < 14) li.style.animationDelay = `${i * 18}ms`;
  li.innerHTML = `
    <div class="jobcard__top">
      <h3 class="jobcard__title">${esc(j.title)}</h3>
      <span class="jobcard__dist">${fmtDist(j._dist)}</span>
    </div>
    <p class="jobcard__district">${esc(j.district || "—")}${j.city ? " · " + esc(j.city) : ""}</p>
    ${hasSalary(j) ? `<p class="jobcard__salary">${esc(salaryShort(j))}</p>` : ""}
    <div class="jobcard__meta">
      ${j.jobType ? `<span class="tag tag--type">${esc(j.jobType)}</span>` : ""}
      ${j.detail?.employmentType ? `<span class="tag">${esc(short(j.detail.employmentType, 22))}</span>` : ""}
      ${j.detail?.workYear ? `<span class="tag">${esc(short(j.detail.workYear, 22))}</span>` : ""}
    </div>
    <div class="jobcard__foot">
      <span class="jobcard__posted">${j.posted ? "posted " + fmtDate(j.posted) : ""}${j.closes ? " · closes " + fmtDate(j.closes) : ""}</span>
      <a class="jobcard__link" href="${esc(j.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Edjoin ↗</a>
    </div>`;
  li.addEventListener("click", () => setActive(j.id, { fromList: true }));
  li.addEventListener("mouseenter", () => highlightMarker(j.id, true));
  li.addEventListener("mouseleave", () => highlightMarker(j.id, false));
  return li;
}

// append matches[from..to) to the DOM
function appendCards(from, to) {
  const list = el("results");
  const frag = document.createDocumentFragment();
  for (let i = from; i < to; i++) frag.appendChild(buildCard(state.matches[i], i));
  list.appendChild(frag);
}

// full reset to the first page
function renderList(matches) {
  el("results").innerHTML = "";
  el("resultsEmpty").hidden = matches.length > 0;
  const scroller = document.querySelector(".results__scroll");
  if (scroller) scroller.scrollTop = 0;
  state.rendered = Math.min(PAGE, matches.length);
  appendCards(0, state.rendered);
  updateMore();
}

// grow the rendered window by at least one page, up to `target` items
function growList(target = state.rendered + PAGE) {
  const to = Math.min(target, state.matches.length);
  if (to <= state.rendered) return;
  appendCards(state.rendered, to);
  state.rendered = to;
  updateMore();
}

// the "load more" sentinel text; an IntersectionObserver (see setupInfiniteScroll) grows the list
function updateMore() {
  const more = el("resultsMore");
  const total = state.matches.length;
  if (state.rendered >= total) {
    more.hidden = total === 0;
    more.textContent = total === 0 ? "" : `— all ${fmtInt(total)} shown —`;
  } else {
    more.hidden = false;
    more.textContent = `showing ${fmtInt(state.rendered)} of ${fmtInt(total)} · scroll for more`;
  }
}

// True on phones / short landscape, where the rail is a bottom sheet over a
// full-screen map (kept in sync with the CSS breakpoint).
const mqMobile = window.matchMedia("(max-width: 720px), (orientation: landscape) and (max-height: 480px)");
const isMobile = () => mqMobile.matches;

function setupInfiniteScroll() {
  // The list scrolls inside .results__scroll on both desktop (the rail) and
  // mobile (the bottom sheet), so that element is always the observer root.
  const root = document.querySelector(".results__scroll");
  const obs = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && state.rendered < state.matches.length) growList();
    },
    { root, rootMargin: "400px" },
  );
  obs.observe(el("resultsMore"));
}

/* ---------- mobile bottom sheet ----------
   The rail (filters + results) becomes a draggable sheet over a persistent
   full-screen map. Two snap states — collapsed (peek: just the count) and
   expanded (filters + list) — plus free-drag with snap-to-nearest. Tapping a
   list card collapses the sheet so the map is visible; the map is therefore
   always one drag/tap away rather than a long scroll. */
const sheet = {
  expanded: false,
  el: null,
  setExpanded(v) {
    this.expanded = v;
    this.el.style.transform = ""; // hand control back to the CSS class
    this.el.classList.toggle("sheet--expanded", v);
    el("sheetHandle").setAttribute("aria-expanded", String(v));
  },
  expand() { if (isMobile()) this.setExpanded(true); },
  collapse() { if (isMobile()) this.setExpanded(false); },
};

function setupBottomSheet() {
  const rail = document.querySelector(".rail");
  sheet.el = rail;
  const handle = el("sheetHandle");
  const bar = document.querySelector(".resultsbar");
  const mapControls = document.querySelector(".controls--map");
  const grabZones = [handle, bar];

  // size the collapsed peek to exactly reveal handle + map controls + count,
  // so the location/radius controls sit just above the count over the live map
  const sizePeek = () => {
    if (!isMobile()) return;
    const h = handle.offsetHeight + mapControls.offsetHeight + bar.offsetHeight;
    document.documentElement.style.setProperty("--sheet-peek", `${Math.round(h)}px`);
  };
  sizePeek();
  requestAnimationFrame(sizePeek); // re-measure once fonts/layout settle

  const peekPx = () =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sheet-peek")) || 210;
  const collapsedY = () => rail.getBoundingClientRect().height - peekPx();

  let dragging = false, startY = 0, startT = 0, moved = false;

  const onDown = (e) => {
    if (!isMobile()) return;
    // let the Reset-center button (and any future buttons) work as buttons
    if (e.target.closest(".btn") && !e.target.closest(".sheet-handle")) return;
    dragging = true; moved = false;
    startY = e.clientY;
    startT = sheet.expanded ? 0 : collapsedY();
    rail.classList.add("sheet--dragging");
    handle.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const y = Math.min(Math.max(startT + dy, 0), collapsedY());
    rail.style.transform = `translateY(${y}px)`;
    e.preventDefault();
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove("sheet--dragging");
    handle.releasePointerCapture?.(e.pointerId);
    if (!moved) {
      sheet.setExpanded(!sheet.expanded); // tap toggles
      return;
    }
    const y = startT + (e.clientY - startY);
    sheet.setExpanded(y < collapsedY() * 0.5); // snap to nearer state
  };

  for (const z of grabZones) {
    z.addEventListener("pointerdown", onDown);
    z.addEventListener("pointermove", onMove);
    z.addEventListener("pointerup", onUp);
    z.addEventListener("pointercancel", onUp);
  }

  // leaving mobile (e.g. rotate to a wide landscape / resize): clear any inline
  // transform and sheet state so the desktop layout isn't left shifted
  mqMobile.addEventListener("change", (e) => {
    if (!e.matches) {
      rail.style.transform = "";
      rail.classList.remove("sheet--expanded", "sheet--dragging");
      sheet.expanded = false;
    } else {
      sizePeek();
    }
    if (map) setTimeout(() => map.invalidateSize(), 60);
  });

  // the peek height tracks the controls' height; re-measure on resize/rotate
  let peekTimer;
  window.addEventListener("resize", () => {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(sizePeek, 200);
  });
}

function updateCount(n) {
  const bar = el("resultCount");
  bar.innerHTML =
    n === 0
      ? `No postings within <b>${state.radius}</b> mi`
      : `<b>${fmtInt(n)}</b> posting${n === 1 ? "" : "s"} within <b>${state.radius}</b> mi`;
}

/* ---------- active / highlight sync ---------- */
function highlightMarker(id, on) {
  const m = markerById.get(id);
  if (!m) return;
  const node = m.getElement()?.querySelector(".pin-job");
  if (node) node.classList.toggle("is-active", on);
}

function setActive(id, { fromMap = false, fromList = false } = {}) {
  if (state.activeId && state.activeId !== id) {
    document.querySelector(`.jobcard[data-id="${state.activeId}"]`)?.classList.remove("is-active");
    highlightMarker(state.activeId, false);
  }
  state.activeId = id;

  // clicking a marker may target a job past the rendered window — grow the list to reveal it
  if (fromMap) {
    const idx = state.matches.findIndex((j) => j.id === id);
    if (idx >= state.rendered) growList(idx + 1);
  }

  const card = document.querySelector(`.jobcard[data-id="${id}"]`);
  if (card) {
    card.classList.add("is-active");
    if (fromMap) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  highlightMarker(id, true);

  const m = markerById.get(id);
  if (m && fromList) {
    // on mobile the map is a full-screen layer behind the sheet — collapse the
    // sheet so the pin/popup are visible instead of silently updating a hidden map
    if (isMobile()) sheet.collapse();
    // zoom to marker through any cluster, then open popup
    cluster.zoomToShowLayer(m, () => m.openPopup());
  }
}

/* ---------- geocoding the search box ---------- */
async function geocodeQuery(q) {
  const zip = q.trim().match(/^\d{5}$/);
  const base = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us";
  const url = zip
    ? `${base}&postalcode=${zip[0]}`
    : `${base}&q=${encodeURIComponent(q + ", California, USA")}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const arr = await res.json();
  if (!arr.length) return null;
  return { lat: Number(arr[0].lat), lon: Number(arr[0].lon), label: arr[0].display_name };
}

async function onLocate(e) {
  e?.preventDefault();
  const q = el("locInput").value.trim();
  if (!q) return;
  const btn = el("locBtn");
  btn.disabled = true;
  el("resultCount").textContent = "Locating…";
  try {
    const hit = await geocodeQuery(q);
    if (!hit) {
      el("resultCount").innerHTML = `Couldn't find “${esc(q)}”. Try a ZIP or “City, CA”.`;
      return;
    }
    state.center = hit;
    el("clearLoc").hidden = false;
    recompute({ fit: true });
  } catch (err) {
    el("resultCount").textContent = "Geocoding failed — check your connection.";
  } finally {
    btn.disabled = false;
  }
}

/* ---------- wiring ---------- */
let kwTimer;
function wireControls() {
  el("controls").addEventListener("submit", onLocate);

  el("radius").addEventListener("input", (e) => {
    state.radius = Number(e.target.value);
    el("radiusOut").textContent = `${state.radius} mi`;
    recompute({ fit: false });
  });

  el("kw").addEventListener("input", (e) => {
    clearTimeout(kwTimer);
    const v = e.target.value;
    kwTimer = setTimeout(() => {
      state.filters.kw = v;
      recompute({ fit: false });
    }, 160);
  });

  el("jobtype").addEventListener("change", (e) => {
    state.filters.jobtype = e.target.value;
    recompute({ fit: false });
  });
  el("sort").addEventListener("change", (e) => {
    state.filters.sort = e.target.value;
    sortMatches(state.matches, e.target.value);
    renderList(state.matches);
  });
  el("clearLoc").addEventListener("click", () => {
    state.center = { ...DEFAULT_CENTER };
    el("locInput").value = "";
    el("clearLoc").hidden = true;
    recompute({ fit: true });
  });
}

/* ---------- veil ---------- */
function setVeil(msg) {
  el("veilMsg").textContent = msg;
  app.dataset.state = "loading";
}
function clearVeil() {
  app.dataset.state = "ready";
}

/* ---------- boot ---------- */
async function boot() {
  try {
    await loadData();
    initMap();
    wireControls();
    setupInfiniteScroll();
    setupBottomSheet();
    recompute({ fit: true });
    clearVeil();
    window.__edjoin = { state, setActive, map }; // debug handle
  } catch (err) {
    console.error(err);
    el("veilMsg").innerHTML =
      `Couldn't start: ${esc(err.message)}<br/><span style="opacity:.7">Run the scraper + geocoder, then <code>npm run serve</code>.</span>`;
  }
}

boot();
