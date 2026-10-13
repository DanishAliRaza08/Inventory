# 2. Front-end page structure & wireframes

Implementation: `apps/web` (Next.js App Router, React 19, TypeScript, Tailwind). All pages are
responsive (desktop, tablet, phone ≥ 360px) and support light and dark mode. The browser talks to
the API through the same origin (`/api/*` is proxied), so the httpOnly session cookie is
first-party and **no token is ever handled by front-end code**. Every state-changing request sends
the CSRF header. The UI hides actions the user lacks permission for, but the API enforces them.

## 2.1 Shell

```
┌──────────────┬──────────────────────────────────────────────────────────────────────┐
│ Fashion      │ [ Search products, SKUs, orders, suppliers, listing IDs…   ]  🔔3  Owner▾│
│ Rockstar   « ├──────────────────────────────────────────────────────────────────────┤
│              │ ▲ Demonstration mode banner (demo only) / MFA enrolment banner         │
│ ▦ Dashboard  ├──────────────────────────────────────────────────────────────────────┤
│ ▤ Products   │                                                                      │
│ ☰ Listings   │   Page header  ·  subtitle                         [actions]          │
│ ✎ Builder    │                                                                      │
│ ⧉ Orders     │   Page content                                                        │
│ £ Profit     │                                                                      │
│ ¤ Costs      │                                                                      │
│ ⛟ Suppliers  │                                                                      │
│ ◫ Stock      │                                                                      │
│ ↺ Returns    │                                                                      │
│ ◔ Reports    │                                                                      │
│ ⇅ Import     │                                                                      │
│ ⚇ Users      │                                                                      │
│ ⚙ Automation │                                                                      │
│ ⇄ Integr.    │                                                                      │
│ ⚑ Settings   │                                                                      │
│ ⌚ Audit      │                                                                      │
└──────────────┴──────────────────────────────────────────────────────────────────────┘
```

* Sidebar collapses to icons (remembered per browser); on phones it is a drawer behind ☰.
* Navigation items are filtered by permission. Screens that belong to a later phase are labelled
  "· Phase N" and say so on the page rather than showing simulated data.
* Global search (debounced) covers product titles, `FRP-` numbers, master/alias/supplier SKUs,
  barcodes, marketplace listing IDs, order numbers and suppliers — results respect permissions.
* Notifications (approvals waiting, rejections, publication failures, supplier price increases).
* Account menu: Security & MFA, sign out.

## 2.2 Pages

| Route | Page | Status |
|---|---|---|
| `/login` | Sign-in, then TOTP step if enabled | built |
| `/` | Dashboard: date presets (today … this year, custom), marketplace filter, catalogue/listing/stock KPIs, financial KPIs (gross sales, product cost, fees, shipping, refunds, other expenses, net profit, margin, estimated vs confirmed profit), sales & profit line chart (daily/weekly/monthly, table view), net profit by marketplace, last sync + stale/incomplete-data warnings | built |
| `/products` | Catalogue table: search, status, fulfilment, stock, listed/not-listed-on filters, saved view, multi-select, bulk edit, bulk draft creation, export | built |
| `/products/new` | Product + variations (SKU, size, colour, material, barcode, cost, opening stock) | built |
| `/products/[id]` | Images (upload, dimensions), per-SKU availability, suppliers (price, stock status, source, checked/verified time), effective-dated cost history, update cost, stock check, listings | built |
| `/listings` | Status tabs with counts, search, marketplace filter, validation state, last marketplace error, bulk approve, **bulk publish with confirmation summary** | built |
| `/listings/new` | Listing builder step 1: products, account, template, pricing strategy (target margin / profit / fixed) | built |
| `/listings/[id]` | Listing editor: marketplace-specific fields, title counter against marketplace limit, item specifics with "verified" flags, image order, workflow actions by status/permission, checks panel, preview, history, marketplace operations | built |
| `/profit` | Order-line calculator (SKU or manual costs), full breakdown, fee lines, FX rates used, tax assumptions, alerts, minimum profitable price, reverse price calculator, demonstration example | built |
| `/finance` | Fee rules, exchange rates, business expenses | built |
| `/suppliers`, `/suppliers/[id]` | Suppliers, contact & reliability, supplied SKUs with price/stock freshness | built |
| `/stock` | Out of stock, low supplier stock, costs needing verification | built (polling arrives with connectors) |
| `/imports` | 4-step wizard: upload → map → validate & preview → import with progress; history; error downloads; exports | built |
| `/users` | Staff, roles × permissions matrix, custom roles | built |
| `/integrations` | Accounts, connection status, capability matrix per marketplace | built (connect in Phase 3) |
| `/settings` | Emergency controls, thresholds, tax/finance settings; `/settings/account` MFA, password, sessions | built |
| `/audit` | Filterable audit log with before/after | built |
| `/reports` | Exports available now; order-based reports listed as Phase 4–5 | partial |
| `/orders`, `/returns`, `/automation` | Phase 4 / 4 / 6 placeholders (no simulated data) | planned |

## 2.3 Key wireframes

### Listing builder (`/listings/[id]`)

```
E2E Satin Slip Dress Green Size 10                                   ◆ Awaiting approval
eBay UK · eBay UK (main) · SKU FR-10001-10 · version 2 · Marketplace ID 1234567890
▲ You are editing a revision. The live listing keeps the published version until republished.
┌ Content ──────────────────────────── [Save draft] ┐ ┌ Workflow ─────────────────────┐
│ Title (64/80) [.................................] │ │ [Review note .............]   │
│ Description  [..................................] │ │ [ Approve ]  [ Reject ]       │
│ Price £[29.99] Category [63861] Condition [New ▾] │ ├ Checks ───────────────────────┤
│ Dispatch [2] Qty policy [Sync ▾] Ship [..] Ret [..]│ │ ■ Title contains "free        │
│ Brand [...]  GTIN [...]  Keywords [...........]   │ │   shipping" (blocks approval) │
├ Item specifics ───────────────────────────────────┤ │ ▲ Price below minimum         │
│ Size   [10]     Required  ☑ verified              │ │   profitable price £14.20     │
│ Colour [Green]  Required  ☑ verified              │ ├ Preview ──────────────────────┤
├ Images ───────────────────────────────────────────┤ │ [image] title  £29.99         │
│ [main][2][3]  ◀ reorder   + add from product      │ ├ History ──────────────────────┤
└───────────────────────────────────────────────────┘ │ submit → awaiting approval …  │
                                                      └───────────────────────────────┘
```

### Bulk publish confirmation

```
┌ Confirm publication ─────────────────────────────────────────┐
│ 48 of 50 selected listings will be published:                │
│ Account              Environment   Listings   Listed value   │
│ eBay UK (main)       PRODUCTION    30         £899.70        │
│ TikTok Shop UK       PRODUCTION    18         £431.82        │
│ ▸ Prices per listing                                         │
│ ▲ 2 listings will be skipped (not approved / no price)       │
│                                    [Cancel] [Publish 48]     │
└──────────────────────────────────────────────────────────────┘
```

### Import wizard

```
(1 Upload) → (2 Map columns) → (3 Validate & preview) → (4 Import)
Map: Master SKU* [Item SKU ▾]  Title* [Product Title ▾]  Supplier price [Unit Cost ▾] …
Validate: 5,300 rows · 5,296 new · 0 updates · 4 errors [Download errors]
Preview: Row 2 create UK-0 · Row 3 create UK-1 · Row 9 update FR-10001 — title "x" → "y"
Import: ███████████░░░░ 3,400 / 5,296 · 3,400 created · 0 failed
```

## 2.4 Visual & accessibility rules

* System font, neutral surfaces, one accent colour; dark mode via `prefers-color-scheme`.
* Status is always **icon + label** (never colour alone); statuses use a fixed status palette
  distinct from chart series colours.
* Charts: one y-axis, thin 2px lines, legend + direct labels, crosshair tooltip, "show table" view.
* All form fields are labelled; dialogs use native `<dialog>`; focus rings visible; no horizontal
  page scroll at phone width (checked by the e2e suite).
