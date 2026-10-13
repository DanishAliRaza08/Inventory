'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { useMe } from '@/lib/session';
import { Alert } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  perm?: string;
  phase?: number;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: '▦' },
  { href: '/products', label: 'Products & Inventory', icon: '▤', perm: 'products.read' },
  { href: '/listings', label: 'Marketplace Listings', icon: '☰', perm: 'listings.read' },
  { href: '/listings/new', label: 'Listing Builder', icon: '✎', perm: 'listings.write' },
  { href: '/orders', label: 'Orders', icon: '⧉', perm: 'orders.read', phase: 4 },
  { href: '/profit', label: 'Profit & Loss', icon: '£', perm: 'costs.read' },
  { href: '/finance', label: 'Costs & Expenses', icon: '¤', perm: 'finance.read' },
  { href: '/suppliers', label: 'Suppliers', icon: '⛟', perm: 'suppliers.read' },
  { href: '/stock', label: 'Stock Monitoring', icon: '◫', perm: 'inventory.read' },
  { href: '/returns', label: 'Returns & Refunds', icon: '↺', perm: 'orders.read', phase: 4 },
  { href: '/reports', label: 'Analytics & Reports', icon: '◔', perm: 'exports.run' },
  { href: '/imports', label: 'Import & Export', icon: '⇅', perm: 'imports.run' },
  { href: '/users', label: 'Users & Permissions', icon: '⚇', perm: 'users.manage' },
  { href: '/automation', label: 'Automation Rules', icon: '⚙', perm: 'automation.manage', phase: 6 },
  { href: '/integrations', label: 'Integrations', icon: '⇄', perm: 'listings.read' },
  { href: '/settings', label: 'Settings', icon: '⚑' },
  { href: '/audit', label: 'Activity & Audit Logs', icon: '⌚', perm: 'audit.read' },
];

interface SearchResult {
  products: Array<{ id: string; title: string; code: string }>;
  variants: Array<{ id: string; sku: string; productId: string; product: { title: string } }>;
  listings: Array<{ id: string; sku: string; marketplace: string; externalListingId: string | null }>;
  orders: Array<{ id: string; orderNumber: number; externalOrderId: string; marketplace: string }>;
  suppliers: Array<{ id: string; name: string }>;
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const router = useRouter();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data } = useSWR<SearchResult>(debounced.length >= 2 ? `/search?q=${encodeURIComponent(debounced)}` : null, fetcher);
  const go = (href: string) => {
    setQ('');
    router.push(href);
  };
  const items = data
    ? [
        ...data.products.map((p) => ({ key: p.id, label: `${p.code} · ${p.title}`, kind: 'Product', href: `/products/${p.id}` })),
        ...data.variants.map((v) => ({ key: v.id, label: `${v.sku} · ${v.product.title}`, kind: 'SKU', href: `/products/${v.productId}` })),
        ...data.listings.map((l) => ({ key: l.id, label: `${l.sku} ${l.externalListingId ?? ''}`, kind: l.marketplace, href: `/listings/${l.id}` })),
        ...data.orders.map((o) => ({ key: o.id, label: `#${o.orderNumber} · ${o.externalOrderId}`, kind: 'Order', href: `/orders` })),
        ...data.suppliers.map((s) => ({ key: s.id, label: s.name, kind: 'Supplier', href: `/suppliers/${s.id}` })),
      ]
    : [];
  return (
    <div className="relative w-full max-w-md">
      <input
        className="input"
        placeholder="Search products, SKUs, orders, suppliers, listing IDs…"
        aria-label="Global search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && items[0] && go(items[0].href)}
      />
      {debounced.length >= 2 && q && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-line bg-surface shadow-lg">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink2">{data ? 'No matches' : 'Searching…'}</div>
          ) : (
            items.slice(0, 12).map((i) => (
              <button key={i.kind + i.key} className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-plane" onClick={() => go(i.href)}>
                <span className="truncate">{i.label}</span>
                <span className="shrink-0 text-xs text-muted">{i.kind}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const { data, mutate } = useSWR<Array<{ id: string; title: string; body: string; severity: string; readAt: string | null; createdAt: string; entityType: string | null; entityId: string | null }>>('/notifications', fetcher, { refreshInterval: 60_000 });
  const unread = data?.filter((n) => !n.readAt).length ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button className="btn" aria-label={`Notifications (${unread} unread)`} onClick={() => setOpen(!open)}>
        🔔{unread > 0 && <span className="rounded-full px-1.5 text-xs text-white" style={{ background: 'var(--critical)' }}>{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 max-h-96 w-80 overflow-auto rounded-md border border-line bg-surface shadow-lg">
          {!data?.length && <div className="p-3 text-sm text-ink2">No notifications</div>}
          {data?.map((n) => (
            <div key={n.id} className={`border-b border-line px-3 py-2 text-sm ${n.readAt ? 'opacity-60' : ''}`}>
              <div className="font-medium">{n.title}</div>
              {n.body && <div className="text-xs text-ink2">{n.body}</div>}
              <div className="mt-1 flex gap-3 text-xs">
                {n.entityType === 'listing' && n.entityId && <Link className="text-brand underline" href={`/listings/${n.entityId}`} onClick={() => setOpen(false)}>Open</Link>}
                {!n.readAt && (
                  <button className="text-brand underline" onClick={async () => { await api.post(`/notifications/${n.id}/read`); void mutate(); }}>
                    Mark read
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => setOpen(!open)} aria-haspopup="menu">
        <span className="hidden sm:inline">{me.name}</span>
        <span className="sm:hidden">☺</span>
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border border-line bg-surface p-1 shadow-lg" role="menu">
          <div className="px-2 py-1.5 text-xs text-ink2">{me.email}<br />{me.roles.join(', ')}</div>
          <Link className="block rounded px-2 py-1.5 text-sm hover:bg-plane" href="/settings/account" onClick={() => setOpen(false)}>Security & MFA</Link>
          <button
            className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-plane"
            onClick={async () => {
              await api.post('/auth/logout');
              window.location.href = '/login';
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('fr.sidebar') === 'collapsed');
    } catch {}
  }, []);
  useEffect(() => setMobileOpen(false), [path]);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('fr.sidebar', c ? 'open' : 'collapsed');
      } catch {}
      return !c;
    });
  };
  const nav = NAV.filter((n) => !n.perm || me.permissions.includes(n.perm));
  const isActive = (href: string) => (href === '/' ? path === '/' : path === href || (path.startsWith(href + '/') && !(href === '/listings' && path.startsWith('/listings/new'))));

  return (
    <div className="flex min-h-screen">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-surface transition-all md:sticky md:top-0 md:h-screen ${collapsed ? 'md:w-14' : 'md:w-60'} ${mobileOpen ? 'w-64' : 'hidden md:flex'}`}
        aria-label="Main navigation"
      >
        <div className="flex h-12 items-center justify-between border-b border-line px-3">
          {!collapsed && <span className="text-sm font-bold">Fashion Rockstar</span>}
          <button className="hidden rounded px-1 text-ink2 hover:bg-plane md:block" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? '»' : '«'}
          </button>
          <button className="md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close menu">✕</button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              title={collapsed ? n.label : undefined}
              className={`mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm ${isActive(n.href) ? 'bg-plane font-semibold text-ink' : 'text-ink2 hover:bg-plane'}`}
              aria-current={isActive(n.href) ? 'page' : undefined}
            >
              <span aria-hidden className="w-5 text-center">{n.icon}</span>
              {(!collapsed || mobileOpen) && (
                <span className="flex-1 truncate">
                  {n.label}
                  {n.phase && <span className="ml-1 text-xs text-muted">· Phase {n.phase}</span>}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMobileOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
          <button className="btn md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">☰</button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <Notifications />
            <AccountMenu />
          </div>
        </header>
        {me.demoMode && (
          <div className="border-b border-line px-4 py-1.5 text-xs" style={{ background: 'color-mix(in srgb, var(--warning) 18%, transparent)' }}>
            ▲ Demonstration mode: DEMO accounts never contact a marketplace and demo fee rates are examples, not actual fees.
          </div>
        )}
        {me.mfaEnrolmentRequired && (
          <div className="px-4 pt-3">
            <Alert tone="critical">
              Your role requires multi-factor authentication. <Link className="underline" href="/settings/account">Set it up now</Link> to continue.
            </Alert>
          </div>
        )}
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
