// Diff-friendly JSON serializers: one record per line, but each record is compact.
// This keeps files valid JSON and parseable by JSON.parse, while making `git diff`
// show exactly which records changed — and it's ~the same size as minified JSON
// (newlines simply replace the commas that would join records on one line), so
// there's no meaningful page-load cost for the runtime file.

// { ...meta, [arrayKey]: [ one compact object per line ] }
export function arrayDoc(meta, arrayKey, arr) {
  const head = Object.entries(meta)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(",\n");
  const items = arr.map((x) => JSON.stringify(x)).join(",\n");
  return `{\n${head},\n${JSON.stringify(arrayKey)}:[\n${items}\n]\n}\n`;
}

// { one compact "key": value entry per line }
// Keys are emitted in a stable, numeric-aware order so the file is deterministic
// run-to-run (e.g. ID keys "9" < "10"; city/address keys alphabetical) — diffs
// then reflect only real adds/removes/changes, not insertion-order churn.
export function mapDoc(obj) {
  const entries = Object.entries(obj)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "en", { numeric: true }))
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(",\n");
  return `{\n${entries}\n}\n`;
}
