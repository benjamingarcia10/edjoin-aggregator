// geocode.mjs — resolve each job's city to lat/long and merge into data/jobs.geo.json.
//
// City-level geocoding (v1). Uses Nominatim (OpenStreetMap) — keyless, but we MUST
// respect its policy: <=1 req/sec and a descriptive User-Agent. Results are cached in
// data/geocache.json so reruns only fetch cities we haven't seen.
//
// Later: a `--exact` mode can fetch /Home/JobPosting/{id} detail pages and geocode the
// street address from their schema.org JSON-LD, writing the same output schema.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arrayDoc, mapDoc } from "./lib/serialize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const JOBS = join(ROOT, "data", "jobs.json");
const CACHE = join(ROOT, "data", "geocache.json");
const OUT = join(ROOT, "data", "jobs.geo.json");

const UA = "edjoin-aggregator/1.0 (personal job-map project; contact: local user)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cityKey = (job) =>
  job.city ? `${job.city.trim()}, ${job.state || "California"}` : null;

async function loadCache() {
  if (existsSync(CACHE)) {
    try {
      return JSON.parse(await readFile(CACHE, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

async function geocodeCity(key, attempt = 1) {
  const q = encodeURIComponent(`${key}, USA`);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429 || res.status === 503) throw new Error(`rate-limited ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length) {
      return { lat: Number(arr[0].lat), lon: Number(arr[0].lon) };
    }
    return null; // not found
  } catch (err) {
    if (attempt < 4) {
      await sleep(2000 * attempt);
      return geocodeCity(key, attempt + 1);
    }
    console.warn(`  ! ${key}: ${err.message}`);
    return null;
  }
}

async function main() {
  const { jobs } = JSON.parse(await readFile(JOBS, "utf8"));
  const cache = await loadCache();

  const keys = new Set();
  for (const j of jobs) {
    const k = cityKey(j);
    if (k) keys.add(k);
  }
  const todo = [...keys].filter((k) => !(k in cache));
  console.log(`${keys.size} unique cities; ${todo.length} need geocoding (rest cached).`);

  let i = 0;
  for (const key of todo) {
    i++;
    const hit = await geocodeCity(key);
    cache[key] = hit; // store null too, so we don't re-query dead cities every run
    if (i % 20 === 0 || i === todo.length) {
      await writeFile(CACHE, mapDoc(cache)); // checkpoint
      console.log(`  geocoded ${i}/${todo.length} (${key} -> ${hit ? "ok" : "not found"})`);
    }
    await sleep(1100); // respect Nominatim 1 req/sec
  }
  await writeFile(CACHE, mapDoc(cache));

  // Merge coordinates into jobs.
  let placed = 0;
  const geoJobs = jobs.map((j) => {
    const k = cityKey(j);
    const c = k ? cache[k] : null;
    if (c) placed++;
    return { ...j, geo: c ? { lat: c.lat, lon: c.lon, precision: "city" } : null };
  });

  await writeFile(
    OUT,
    arrayDoc({ builtAt: new Date().toISOString(), count: geoJobs.length, placed }, "jobs", geoJobs),
  );
  console.log(`\n✓ ${placed}/${geoJobs.length} jobs placed on map -> ${OUT}`);
}

main().catch((e) => {
  console.error("\n✗ geocode failed:", e);
  process.exit(1);
});
