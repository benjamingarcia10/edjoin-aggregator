// geocode-exact.mjs — turn scraped street addresses into precise coordinates and
// merge them into data/jobs.geo.json (replacing city-level points where possible).
//
// Tiered precision, best first:
//   1. "address" — exact street address via the US Census batch geocoder
//                  (free, keyless, up to 10k addresses per request, no rate limit)
//   2. "zip"     — ZIP centroid via Nominatim (cached) when the street doesn't match
//   3. "city"    — existing city geocache (data/geocache.json) as a last resort
//
// Caches: data/geocache-exact.json keyed by normalized address and "zip:NNNNN".
// Re-running only geocodes what isn't cached.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arrayDoc, mapDoc } from "./lib/serialize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const JOBS = join(ROOT, "data", "jobs.json");
const ADDR = join(ROOT, "data", "details.json"); // rich detail records (address + salary + …)
const CITY_CACHE = join(ROOT, "data", "geocache.json");
const EXACT_CACHE = join(ROOT, "data", "geocache-exact.json");
const OUT = join(ROOT, "data", "jobs.geo.json");

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const BATCH = 150; // the endpoint 500s on large batches despite the documented 10k limit
const UA = "edjoin-aggregator/1.0 (personal job-map project)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const zip5 = (z) => (z ? String(z).trim().slice(0, 5) : "");
const norm = (a) =>
  `${(a.street || "").toLowerCase().replace(/\s+/g, " ").trim()}|${(a.city || "").toLowerCase().trim()}|${zip5(a.zip)}`;

/* ---- tiny CSV line parser (handles quoted fields with commas) ---- */
function parseCsvLine(line) {
  const out = [];
  let cur = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* ---- US Census batch geocoder ---- */
async function censusBatch(rows, attempt = 1) {
  // rows: [{key, street, city, state, zip}]  -> Map key -> {lat,lon}
  const csv = rows
    .map((r) => {
      const cell = (s) => `"${String(s || "").replace(/"/g, "")}"`;
      return [cell(r.key), cell(r.street), cell(r.city), cell(r.state || "CA"), cell(zip5(r.zip))].join(",");
    })
    .join("\n");

  const fd = new FormData();
  fd.append("benchmark", "Public_AR_Current");
  fd.append("addressFile", new Blob([csv], { type: "text/csv" }), "addr.csv");

  let res;
  try {
    res = await fetch(CENSUS_URL, { method: "POST", body: fd, headers: { "User-Agent": UA } });
  } catch (e) {
    if (attempt < 2) { await sleep(700 * attempt); return censusBatch(rows, attempt + 1); }
    throw e;
  }
  if (!res.ok) {
    if (attempt < 2) { await sleep(700 * attempt); return censusBatch(rows, attempt + 1); }
    throw new Error(`census HTTP ${res.status}`);
  }
  const text = await res.text();

  const found = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    // columns: id, input, status, matchType, matchedAddr, "lon,lat", tigerId, side
    const id = f[0];
    const status = f[2];
    if (status === "Match" && f[5]) {
      const [lon, lat] = f[5].split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lon)) found.set(id, { lat, lon });
    }
  }
  return found;
}

/* ---- Nominatim ZIP fallback (cached) ---- */
async function geocodeZip(zip, attempt = 1) {
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=us&format=json&limit=1`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    if (arr.length) return { lat: Number(arr[0].lat), lon: Number(arr[0].lon) };
    return null;
  } catch {
    if (attempt < 3) { await sleep(1500 * attempt); return geocodeZip(zip, attempt + 1); }
    return null;
  }
}

/* ---- Nominatim county fallback (cached) — for postings with only a county ---- */
async function geocodeCounty(county, attempt = 1) {
  const q = encodeURIComponent(`${county} County, California, USA`);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    if (arr.length) return { lat: Number(arr[0].lat), lon: Number(arr[0].lon) };
    return null;
  } catch {
    if (attempt < 3) { await sleep(1500 * attempt); return geocodeCounty(county, attempt + 1); }
    return null;
  }
}

async function main() {
  const { jobs } = JSON.parse(await readFile(JOBS, "utf8"));
  const addrs = existsSync(ADDR) ? JSON.parse(await readFile(ADDR, "utf8")) : {};
  const cityCache = existsSync(CITY_CACHE) ? JSON.parse(await readFile(CITY_CACHE, "utf8")) : {};
  const exact = existsSync(EXACT_CACHE) ? JSON.parse(await readFile(EXACT_CACHE, "utf8")) : {};

  console.log(`${jobs.length} jobs; ${Object.keys(addrs).length} have scraped address records.`);

  // 1. unique addresses needing Census geocoding
  const uniq = new Map(); // normKey -> {street,city,state,zip}
  for (const j of jobs) {
    const a = addrs[String(j.id)];
    if (a && a.street) {
      const k = norm(a);
      if (!(k in exact) && !uniq.has(k)) uniq.set(k, { key: k, street: a.street, city: a.city, state: "CA", zip: a.zip });
    }
  }
  const uniqRows = [...uniq.values()];
  console.log(`${uniqRows.length} unique street addresses to geocode via Census (batched ${BATCH}).`);

  // A single malformed address can 500 an entire Census batch regardless of size.
  // So on a hard failure we split the chunk and recurse — a bad row is isolated to
  // size 1 (skipped, picked up by the ZIP fallback) instead of losing 150 addresses.
  async function geocodeChunk(chunk) {
    let found;
    try {
      found = await censusBatch(chunk);
    } catch (e) {
      if (chunk.length === 1) {
        exact[chunk[0].key] = null; // ungeocodable address — fall through to ZIP
        return { matched: 0, total: 1 };
      }
      const mid = Math.floor(chunk.length / 2);
      const a = await geocodeChunk(chunk.slice(0, mid));
      const b = await geocodeChunk(chunk.slice(mid));
      return { matched: a.matched + b.matched, total: a.total + b.total };
    }
    for (const r of chunk) {
      const hit = found.get(r.key);
      exact[r.key] = hit ? { ...hit, precision: "address" } : null;
    }
    return { matched: found.size, total: chunk.length };
  }

  let mTot = 0;
  for (let i = 0; i < uniqRows.length; i += BATCH) {
    const chunk = uniqRows.slice(i, i + BATCH);
    const { matched, total } = await geocodeChunk(chunk);
    mTot += matched;
    await writeFile(EXACT_CACHE, mapDoc(exact));
    console.log(`  census batch ${Math.floor(i / BATCH) + 1}: matched ${matched}/${total} (running ${mTot})`);
  }

  // 2. ZIP fallback for addresses Census couldn't match
  const zipsNeeded = new Set();
  for (const j of jobs) {
    const a = addrs[String(j.id)];
    if (!a) continue;
    const k = a.street ? norm(a) : null;
    const matched = k && exact[k];
    const z = zip5(a.zip);
    if (!matched && z && !(`zip:${z}` in exact)) zipsNeeded.add(z);
  }
  if (zipsNeeded.size) {
    console.log(`ZIP fallback: ${zipsNeeded.size} unique ZIPs via Nominatim (1/sec)…`);
    let n = 0;
    for (const z of zipsNeeded) {
      const hit = await geocodeZip(z);
      exact[`zip:${z}`] = hit ? { ...hit, precision: "zip" } : null;
      if (++n % 20 === 0) { await writeFile(EXACT_CACHE, mapDoc(exact)); console.log(`  zip ${n}/${zipsNeeded.size}`); }
      await sleep(1100);
    }
    await writeFile(EXACT_CACHE, mapDoc(exact));
  }

  // helper: does this job already have address/zip/city coordinates?
  const hasCoords = (j) => {
    const a = addrs[String(j.id)];
    if (a && a.street && exact[norm(a)]) return true;
    if (a && zip5(a.zip) && exact[`zip:${zip5(a.zip)}`]) return true;
    if (j.city && cityCache[`${j.city.trim()}, ${j.state || "California"}`]) return true;
    return false;
  };

  // 2b. COUNTY fallback — many postings (e.g. county-wide staffing pools) list a
  //     county but no city/street. Place them at the county centroid as a last resort.
  const countiesNeeded = new Set();
  for (const j of jobs) {
    if (!hasCoords(j) && j.county && !(`county:${j.county}` in exact)) countiesNeeded.add(j.county);
  }
  if (countiesNeeded.size) {
    console.log(`County fallback: ${countiesNeeded.size} unique counties via Nominatim (1/sec)…`);
    let n = 0;
    for (const cty of countiesNeeded) {
      const hit = await geocodeCounty(cty);
      exact[`county:${cty}`] = hit ? { ...hit, precision: "county" } : null;
      if (++n % 10 === 0) { await writeFile(EXACT_CACHE, mapDoc(exact)); console.log(`  county ${n}/${countiesNeeded.size}`); }
      await sleep(1100);
    }
    await writeFile(EXACT_CACHE, mapDoc(exact));
  }

  // 3. merge: best precision available per job + the rich detail fields the
  //    list API omits (salary is often null in the list but present on the page)
  const counts = { address: 0, zip: 0, city: 0, county: 0, none: 0 };
  const clean = (s) => (s && String(s).trim() ? String(s).trim() : null);
  const geoJobs = jobs.map((j) => {
    const a = addrs[String(j.id)];
    let geo = null;
    if (a && a.street && exact[norm(a)]) geo = exact[norm(a)];
    if (!geo && a && zip5(a.zip) && exact[`zip:${zip5(a.zip)}`]) geo = exact[`zip:${zip5(a.zip)}`];
    if (!geo && j.city) {
      const c = cityCache[`${j.city.trim()}, ${j.state || "California"}`];
      if (c) geo = { lat: c.lat, lon: c.lon, precision: "city" };
    }
    if (!geo && j.county && exact[`county:${j.county}`]) geo = exact[`county:${j.county}`];
    counts[geo ? geo.precision : "none"]++;

    const detail = a
      ? {
          street: clean(a.street),
          salary: clean(a.salary),
          salaryAddl: clean(a.salaryAddl),
          workYear: clean(a.workYear),
          employmentType: clean(a.employmentType),
          openings: clean(a.openings),
          contactName: clean(a.contactName),
          contactPhone: clean(a.contactPhone),
          contactEmail: clean(a.contactEmail),
        }
      : null;

    return {
      ...j,
      geo: geo ? { lat: geo.lat, lon: geo.lon, precision: geo.precision } : null,
      detail,
    };
  });

  const placed = counts.address + counts.zip + counts.city + counts.county;
  await writeFile(
    OUT,
    arrayDoc(
      { builtAt: new Date().toISOString(), count: geoJobs.length, placed, precision: counts },
      "jobs",
      geoJobs,
    ),
  );
  console.log(`\n✓ ${placed}/${geoJobs.length} placed -> ${OUT}`);
  console.log(`  precision: address ${counts.address}, zip ${counts.zip}, city ${counts.city}, county ${counts.county}, unplaced ${counts.none}`);
}

main().catch((e) => {
  console.error("\n✗ exact geocode failed:", e);
  process.exit(1);
});
