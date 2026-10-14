/**
 * Measures API latency on the main list, search, dashboard and report endpoints.
 *
 *   LOAD_BASE_URL=http://localhost:4000 LOAD_EMAIL=… LOAD_PASSWORD=… pnpm --filter @fr/api load:test
 *
 * Runs each request REQUESTS times with CONCURRENCY parallel clients after a warm-up and prints
 * p50 / p95 / max. Target (docs/08): list & search p95 < 300 ms at 20k products / 100k listings /
 * 100k orders per month. Read-only: it never changes data.
 */
const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:4000';
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 60);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 8);
const TARGET_MS = 300;

const ENDPOINTS: Array<[string, string, number?]> = [
  ['Products list', '/api/products?page=1&pageSize=50'],
  ['Products search', '/api/products?search=Hoodie&page=1&pageSize=50'],
  ['SKU search (global)', '/api/search?q=LT-1234'],
  ['Listings list (active)', '/api/listings?status=ACTIVE&page=1&pageSize=50'],
  ['Listings search', '/api/listings?search=LT-777&page=1&pageSize=50'],
  ['Listings page 1,000', '/api/listings?page=1000&pageSize=50'],
  ['Orders list', '/api/orders?page=1&pageSize=50'],
  ['Orders due for dispatch', '/api/orders?dueWithinHours=24&page=1&pageSize=50'],
  ['Orders search', '/api/orders?search=LT-ORDER-5000&page=1&pageSize=50'],
  ['Stock monitoring (out of stock)', '/api/products?stock=out&pageSize=50'],
  // Aggregations over the whole month: reported separately, no list/search target.
  ['Dashboard summary (30 days)', '/api/dashboard/summary?preset=last30', 1],
  ['Dashboard chart (30 days)', '/api/dashboard/timeseries?preset=last30', 1],
  ['Report: sales by marketplace', '/api/reports/sales_by_marketplace?preset=last30', 1],
  ['Report: profit by SKU', '/api/reports/profit_by_sku?preset=last30', 1],
];

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'load-test' }, body: JSON.stringify({ email: process.env.LOAD_EMAIL, password: process.env.LOAD_PASSWORD }) });
  if (!r.ok) throw new Error(`Login failed: ${r.status} ${await r.text()}`);
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

async function main() {
  const cookie = await login();
  const get = async (path: string) => {
    const t = performance.now();
    const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie, 'X-Requested-With': 'load-test' } });
    await r.arrayBuffer();
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return performance.now() - t;
  };
  const rows: Array<{ name: string; p50: number; p95: number; max: number; target: boolean }> = [];
  for (const [name, path, light] of ENDPOINTS) {
    const n = light ? Math.max(5, Math.round(REQUESTS / 6)) : REQUESTS;
    const c = light ? 2 : CONCURRENCY;
    for (let w = 0; w < 8; w++) await get(path); // warm-up (every API process when API_WORKERS > 1)
    const times: number[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: c }, async () => {
      while (next < n) {
        next++;
        times.push(await get(path));
      }
    }));
    rows.push({ name, p50: pct(times, 50), p95: pct(times, 95), max: Math.max(...times), target: !light });
  }
  console.log(`\n${REQUESTS} requests per endpoint, ${CONCURRENCY} concurrent clients, against ${BASE}\n`);
  console.log('Endpoint'.padEnd(32) + 'p50 ms'.padStart(9) + 'p95 ms'.padStart(9) + 'max ms'.padStart(9) + '  result');
  let failed = 0;
  for (const r of rows) {
    const ok = !r.target || r.p95 < TARGET_MS;
    if (!ok) failed++;
    console.log(r.name.padEnd(32) + r.p50.toFixed(0).padStart(9) + r.p95.toFixed(0).padStart(9) + r.max.toFixed(0).padStart(9) + '  ' + (r.target ? (ok ? 'ok' : `OVER ${TARGET_MS} ms`) : 'aggregate'));
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
