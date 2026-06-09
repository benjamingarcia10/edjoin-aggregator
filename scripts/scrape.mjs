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

function buildUrl(page) {
  const p = new URLSearchParams({
    rows: String(ROWS),
    page: String(page),
    sort: "postingDate",
    sortVal: "0",
    order: "desc",
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
    _: String(page), // cache-buster
  });
  return `${BASE}?${p.toString()}`;
}

async function fetchPage(page, attempt = 1) {
  const url = buildUrl(page);
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
      return fetchPage(page, attempt + 1);
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

async function main() {
  console.log("Edjoin scraper — fetching all California job postings\n");

  const first = await fetchPage(1);
  const totalRecords = first.totalRecords ?? 0;
  const totalPages = first.totalPages ?? 1; // pages at rows=1000
  const pagesNeeded = Math.ceil(totalRecords / ROWS);
  console.log(`totalRecords=${totalRecords}  -> ${pagesNeeded} page(s) at rows=${ROWS}\n`);

  const byId = new Map();
  for (const r of first.data || []) byId.set(r.postingID, normalize(r));
  console.log(`page 1: ${first.data?.length || 0} records (total ${byId.size})`);

  for (let page = 2; page <= pagesNeeded; page++) {
    await sleep(700); // be polite
    const data = await fetchPage(page);
    const batch = data.data || [];
    for (const r of batch) byId.set(r.postingID, normalize(r));
    console.log(`page ${page}: ${batch.length} records (total ${byId.size})`);
    if (batch.length === 0) break;
  }

  const jobs = [...byId.values()];
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, arrayDoc({ scrapedAt: new Date().toISOString(), count: jobs.length }, "jobs", jobs));
  console.log(`\n✓ wrote ${jobs.length} unique jobs -> ${OUT}`);
}

main().catch((e) => {
  console.error("\n✗ scrape failed:", e);
  process.exit(1);
});
