// scrape-details.mjs — fetch each posting's detail page and extract the rich fields
// the list API (LoadJobs) omits or leaves null: exact address, the REAL salary
// (often null in the list), employment type, length of work year, openings, and
// contact info.
//
// Why the detail page: salary appears in two shapes — a structured "Pay Range"
// AND a free-text "Pay dependent on experience" + "Add'l Salary Info" range that
// isn't in the JSON-LD at all. So we scrape the visible sidebar, whose
// `<h5 class="botspace">LABEL</h5> → <div class="controls">VALUE</div>` pattern is
// consistent across every variant. The street address comes from the JSON-LD.
//
// Concurrent (async pool), resumable (cached by postingID, versioned), polite.
// Output: data/details.json = { [postingID]: { ...fields } | null }

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapDoc } from "./lib/serialize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const JOBS = join(ROOT, "data", "jobs.json");
const OUT = join(ROOT, "data", "details.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CONCURRENCY = Number(process.env.CONCURRENCY || 12); // async fetches in flight
const SCHEMA_VERSION = 2; // bump to force re-scrape when fields change
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripTags = (s) =>
  (s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// generic sidebar field: <h5 class="botspace">LABEL</h5> <div class="controls...">VALUE</div>
function sidebar(html, label) {
  const L = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `botspace"[^>]*>\\s*${L}\\s*</h5>\\s*<div[^>]*class="controls[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    "i",
  );
  const m = html.match(re);
  return m ? stripTags(m[1]) || null : null;
}

// JSON-LD jobLocation address
function address(html) {
  const block = html.match(/"jobLocation"\s*:\s*\[([\s\S]*?)\]/);
  const scope = block ? block[1] : "";
  const f = (n) => {
    const m = scope.match(new RegExp(`"${n}"\\s*:\\s*"([^"]*)"`));
    return m ? m[1].trim() : "";
  };
  return { street: f("streetAddress"), city: f("addressLocality"), region: f("addressRegion"), zip: f("postalCode") };
}

function jsonLdEmail(html) {
  const m = html.match(/"contactPoint"\s*:\s*\{[^}]*?"email"\s*:\s*"([^"]+)"/);
  return m ? m[1].trim() : null;
}

// Contact sidebar block holds name (as a link) then phone on the next line.
function contact(html) {
  const raw = html.match(/botspace"[^>]*>\s*Contact\s*<\/h5>\s*<div[^>]*class="controls[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (!raw) return { name: null, phone: null };
  const text = stripTags(raw[1]);
  const phoneM = text.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  const phone = phoneM ? phoneM[0].trim() : null;
  const name = phone ? text.replace(phone, "").trim() || null : text || null;
  return { name, phone };
}

function extract(html) {
  const addr = address(html);
  const c = contact(html);
  const rec = {
    _v: SCHEMA_VERSION,
    street: addr.street,
    city: addr.city,
    region: addr.region,
    zip: addr.zip,
    salary: sidebar(html, "Salary"),
    salaryAddl: sidebar(html, "Add'l Salary Info"),
    workYear: sidebar(html, "Length of Work Year"),
    employmentType: sidebar(html, "Employment Type"),
    openings: sidebar(html, "Number of Openings"),
    deadline: sidebar(html, "Application Deadline"),
    contactName: c.name,
    contactPhone: c.phone,
    contactEmail: jsonLdEmail(html),
  };
  // null only if we got truly nothing useful
  const any = Object.entries(rec).some(([k, v]) => k !== "_v" && v);
  return any ? rec : null;
}

async function fetchDetail(id, attempt = 1) {
  try {
    const res = await fetch(`https://www.edjoin.org/Home/JobPosting/${id}`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return extract(await res.text());
  } catch (err) {
    if (attempt < 3) {
      await sleep(800 * attempt);
      return fetchDetail(id, attempt + 1);
    }
    return undefined; // failed -> retry on next run
  }
}

async function main() {
  const { jobs } = JSON.parse(await readFile(JOBS, "utf8"));
  const cache = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : {};

  // re-scrape anything missing or from an older schema version
  const todo = jobs
    .map((j) => j.id)
    .filter((id) => {
      const c = cache[String(id)];
      return c === undefined || (c && c._v !== SCHEMA_VERSION);
    });
  console.log(`${jobs.length} postings; ${todo.length} need detail fetch (concurrency ${CONCURRENCY}).`);
  if (todo.length === 0) return;

  let done = 0, withSalary = 0, failed = 0, cursor = 0;
  async function worker() {
    while (cursor < todo.length) {
      const id = todo[cursor++];
      const rec = await fetchDetail(id);
      if (rec === undefined) failed++;
      else {
        cache[String(id)] = rec;
        if (rec && (rec.salary || rec.salaryAddl)) withSalary++;
      }
      if (++done % 250 === 0) {
        await writeFile(OUT, mapDoc(cache));
        console.log(`  ${done}/${todo.length}  (with-salary ${withSalary}, failed ${failed})`);
      }
      await sleep(40);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await writeFile(OUT, mapDoc(cache));
  console.log(`\n✓ details cached: ${Object.keys(cache).length} total (this run: with-salary ${withSalary}, failed ${failed}) -> ${OUT}`);
  if (failed) console.log(`  ${failed} failed — rerun to retry.`);
}

main().catch((e) => {
  console.error("\n✗ detail scrape failed:", e);
  process.exit(1);
});
