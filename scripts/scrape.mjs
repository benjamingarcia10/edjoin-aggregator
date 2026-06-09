// scrape.mjs — pull all California Edjoin job postings via the public LoadJobs JSON endpoint.
//
// Edjoin's own search calls GET /Home/LoadJobs. It needs no auth/cookies/key.
// The UI caps page size at 10; we request rows=1000. Numeric params MUST be 0
// (empty -> server NullReferenceException) and onlineApps must be empty.
//
// Output: data/jobs.json = { scrapedAt, count, jobs: [...] }

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { arrayDoc } from "./lib/serialize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data", "jobs.json");

const ROWS = 1000;
const BASE = "https://www.edjoin.org/Home/LoadJobs";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse .NET "/Date(1780876800000)/" -> ISO string (or null).
function netDateToISO(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/\/Date\((-?\d+)\)\//);
  if (!m) return null;
  return new Date(Number(m[1])).toISOString();
}

let reqSeq = 0;
function buildUrl(page, order) {
  const p = new URLSearchParams({
    rows: String(ROWS),
    page: String(page),
    sort: "postingDate",
    sortVal: "0",
    order,
    keywords: "",
    location: "",
    searchType: "all",
    regions: "",
    jobTypes: "",
    days: "0",
    empType: "",
    catID: "0",
    onlineApps: "",
    recruitmentCenterID: "0",
    stateID: "0",
    regionID: "0",
    districtID: "0",
    searchID: "0",
    _: `${Date.now()}-${reqSeq++}`, // unique per request so each pass reads fresh (no cached page)
  });
  return `${BASE}?${p.toString()}`;
}

async function fetchPage(page, order, attempt = 1) {
  const url = buildUrl(page, order);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: "https://www.edjoin.org/Home/Jobs",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.startsWith("<")) throw new Error("got HTML (server error), not JSON");
    return JSON.parse(text);
  } catch (err) {
    if (attempt < 4) {
      const wait = 1000 * attempt;
      console.warn(`  page ${page} failed (${err.message}); retry ${attempt} in ${wait}ms`);
      await sleep(wait);
      return fetchPage(page, order, attempt + 1);
    }
    throw err;
  }
}

function normalize(r) {
  return {
    id: r.postingID,
    title: (r.positionTitle || "").trim(),
    district: r.districtName || null,
    city: r.city || null,
    county: r.countyName || null,
    state: r.stateName || null,
    salaryInfo: r.salaryInfo || null,
    beginningSalary: r.beginningSalary ?? null,
    endingSalary: r.endingSalary ?? null,
    jobType: r.jobType || null,
    category: r.categoryName || null,
    openings: r.numberOpenings ?? null,
    fullPartTime: r.FullTimePartTime || null,
    posted: netDateToISO(r.postingDate),
    closes: netDateToISO(r.displayUntil),
    summary: r.JobSummary || null,
    url: `https://www.edjoin.org/Home/JobPosting/${r.postingID}`,
  };
}

// One full paginated pass in a given sort order, merged into `byId`.
// Returns { pages, total, added } where `total` is the server's reported
// totalRecords and `added` is how many postings were new to the union.
async function onePass(byId, order) {
  const first = await fetchPage(1, order);
  const total = first.totalRecords ?? 0;
  const pagesNeeded = Math.ceil(total / ROWS);
  const before = byId.size;
  for (const r of first.data || []) byId.set(r.postingID, normalize(r));
  for (let page = 2; page <= pagesNeeded; page++) {
    await sleep(400); // be polite
    const batch = (await fetchPage(page, order)).data || [];
    for (const r of batch) byId.set(r.postingID, normalize(r));
    if (batch.length === 0) break;
  }
  return { pages: pagesNeeded, total, added: byId.size - before };
}

// The API paginates by offset over a list that mutates during the ~15s scrape,
// so any single pass skips ~a dozen postings at a shifting page boundary. Rather
// than guess a fixed number of passes, we LOOP until a full pass discovers nothing
// new (the real completeness signal), alternating sort order each pass so the page
// boundaries land on different postings and skips don't correlate. Capped so a
// constantly-churning list can't loop forever.
const MAX_PASSES = 6;
async function main() {
  console.log("Edjoin scraper — paging until the set converges\n");
  const byId = new Map();
  const orders = ["desc", "asc"];
  let maxTotal = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const order = orders[(pass - 1) % orders.length];
    const { pages, total, added } = await onePass(byId, order);
    maxTotal = Math.max(maxTotal, total);
    console.log(`pass ${pass} (${order}, ${pages}p): +${added} new → union ${byId.size} (server total ${total})`);
    if (added === 0 && pass >= 2) {
      console.log(`✓ converged after ${pass} passes — a full pass found nothing new`);
      break;
    }
    if (pass === MAX_PASSES) console.warn(`! hit MAX_PASSES (${MAX_PASSES}); union may still be missing a few`);
    await sleep(600);
  }

  const jobs = [...byId.values()].sort((a, b) => a.id - b.id);
  const gap = maxTotal - jobs.length;
  console.log(`\nunion ${jobs.length} vs peak server total ${maxTotal} (Δ ${gap})`);

  // Sort by postingID so the on-disk order is stable run-to-run (the API doesn't
  // break postingDate ties deterministically). The app re-sorts client-side, so
  // this only affects the file — making git diffs show real changes, not reshuffles.
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, arrayDoc({ scrapedAt: new Date().toISOString(), count: jobs.length }, "jobs", jobs));
  console.log(`✓ wrote ${jobs.length} unique jobs -> ${OUT}`);
}

main().catch((e) => {
  console.error("\n✗ scrape failed:", e);
  process.exit(1);
});
