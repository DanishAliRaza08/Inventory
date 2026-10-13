# 6. User roles & permissions matrix

Source of truth: `packages/core/src/permissions.ts` (seeded into the `permissions`, `roles` and
`role_permissions` tables). This table is generated from that file.

## How enforcement works

* Every API route declares its required permissions with `@RequirePermissions(...)`. A global guard
  resolves the session, then rejects the request with **403** if any permission is missing. The web
  app hides controls the user cannot use, but the **backend is the authority**.
* Listing lifecycle events are additionally checked by the pure state machine
  (`listing-lifecycle.ts`), so a permission check cannot be bypassed by calling a service directly.
* Sensitive data is split by permission: customer names/addresses (`orders.customer_pii`, stored in
  a separate table), financial data (`finance.read`, `costs.read`), staff administration
  (`users.manage`), marketplace connections (`integrations.manage`).
* Only an Owner can grant the Owner role. Users cannot disable themselves or remove their own
  Owner role. Disabling a user revokes all their sessions.
* Separation of duties: by default a draft cannot be approved by the person who submitted it
  (`listings.allow_self_approval = false`). Compliance sign-off for restricted products requires
  `listings.approve`.
* Custom roles: `PUT /api/roles/:key` with any subset of permissions (the Owner role is locked).
* MFA (TOTP): roles marked *MFA required* must enrol when `MFA_ENFORCE_FOR_PRIVILEGED=true`
  (always on in production). Users with MFA enabled must complete it on every new session.

## Matrix

| Permission | Description | Owner | Inventory Manager | Listing Manager | Listing Approver | Order Manager | Finance Manager | Viewer |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `products.read` | View products, SKUs and variations | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `products.write` | Create and edit products, SKUs and variations | ✔ | ✔ |  |  |  |  |  |
| `products.delete` | Archive / delete products | ✔ |  |  |  |  |  |  |
| `inventory.read` | View inventory levels and movements | ✔ | ✔ | ✔ | ✔ | ✔ |  | ✔ |
| `inventory.adjust` | Adjust stock and run stock checks | ✔ | ✔ |  |  |  |  |  |
| `suppliers.read` | View suppliers and supplier products | ✔ | ✔ | ✔ |  | ✔ |  |  |
| `suppliers.write` | Create and edit suppliers and supplier products | ✔ | ✔ |  |  |  |  |  |
| `costs.read` | View product costs and cost history | ✔ | ✔ |  | ✔ |  | ✔ |  |
| `costs.write` | Edit product costs and supplier prices | ✔ | ✔ |  |  |  |  |  |
| `fees.write` | Configure marketplace fee rules | ✔ |  |  |  |  | ✔ |  |
| `finance.read` | View profit, fees, expenses and financial reports | ✔ |  |  |  |  | ✔ |  |
| `finance.reconcile` | Import and reconcile actual fees and settlements | ✔ |  |  |  |  | ✔ |  |
| `expenses.write` | Record business expenses | ✔ |  |  |  |  | ✔ |  |
| `fx.write` | Manage exchange rates | ✔ |  |  |  |  | ✔ |  |
| `listings.read` | View marketplace listings and drafts | ✔ | ✔ | ✔ | ✔ |  |  | ✔ |
| `listings.write` | Create and edit listing drafts, upload images | ✔ |  | ✔ |  |  |  |  |
| `listings.submit` | Submit drafts for approval | ✔ |  | ✔ |  |  |  |  |
| `listings.approve` | Approve or reject drafts | ✔ |  |  | ✔ |  |  |  |
| `listings.publish` | Publish approved listings to marketplaces | ✔ |  |  | ✔ |  |  |  |
| `listings.end` | Pause or end live listings | ✔ |  |  | ✔ |  |  |  |
| `orders.read` | View orders | ✔ | ✔ |  |  | ✔ | ✔ | ✔ |
| `orders.manage` | Manage orders, fulfilment and tracking | ✔ |  |  |  | ✔ |  |  |
| `orders.customer_pii` | View customer names and shipping addresses | ✔ |  |  |  | ✔ |  |  |
| `returns.manage` | Handle returns and refunds | ✔ |  |  |  | ✔ |  |  |
| `imports.run` | Run bulk imports | ✔ | ✔ | ✔ |  |  |  |  |
| `exports.run` | Run bulk exports | ✔ | ✔ |  |  |  | ✔ |  |
| `reports.read` | View analytics and reports | ✔ |  |  |  |  | ✔ |  |
| `automation.manage` | Create and edit automation rules | ✔ |  |  |  |  |  |  |
| `integrations.manage` | Connect marketplace and supplier accounts | ✔ |  |  |  |  |  |  |
| `users.manage` | Manage staff accounts and roles | ✔ |  |  |  |  |  |  |
| `audit.read` | View the audit log | ✔ |  |  |  |  | ✔ |  |
| `settings.manage` | Manage system settings and emergency controls | ✔ |  |  |  |  |  |  |
| *MFA required* | | yes |  |  | yes |  | yes |  |

## Who did what

Every important change writes an append-only `audit_logs` row: actor, action, entity, before/after
snapshot, IP and user agent. Listing workflow steps are also stored in `listing_status_history`
and on the `listing_versions` row (`created_by`, `submitted_by`, `approved_by`, `rejected_by`).
Cost changes store `created_by` / `verified_by`; inventory movements store `created_by`.
