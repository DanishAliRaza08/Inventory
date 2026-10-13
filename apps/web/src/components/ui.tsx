'use client';
import { ReactNode, useEffect, useRef } from 'react';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Stat tile: sentence-case label, value, optional note. */
export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'critical' | 'warning' | 'good' }) {
  const icon = tone === 'critical' ? '⚠' : tone === 'warning' ? '!' : tone === 'good' ? '✓' : null;
  return (
    <div className="card p-3">
      <div className="flex items-center gap-1 text-xs text-ink2">
        {icon && <span aria-hidden style={{ color: `var(--${tone === 'warning' ? 'serious' : tone})` }}>{icon}</span>}
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {note && <div className="mt-0.5 text-xs text-muted">{note}</div>}
    </div>
  );
}

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | 'info' | 'neutral'> = {
  ACTIVE: 'good', APPROVED: 'good', COMPLETED: 'good', CONNECTED: 'good', SUCCEEDED: 'good', IN_STOCK: 'good', confirmed: 'good',
  AWAITING_APPROVAL: 'info', PUBLISHING: 'info', IMPORTING: 'info', VALIDATED: 'info', QUEUED: 'info', RUNNING: 'info', partially_reconciled: 'info',
  DRAFT: 'neutral', INCOMPLETE: 'warning', PAUSED: 'warning', LOW_STOCK: 'warning', COMPLETED_WITH_ERRORS: 'warning', NOT_CONNECTED: 'warning', estimated: 'warning', UPLOADED: 'neutral',
  VALIDATION_FAILED: 'critical', PUBLICATION_FAILED: 'critical', FAILED: 'critical', OUT_OF_STOCK: 'critical', EXPIRED: 'critical', ERROR: 'critical', FAILED_PERMANENT: 'critical',
  ENDED: 'neutral', ARCHIVED: 'neutral', UNKNOWN: 'neutral', DISCONTINUED: 'neutral', UNSUPPORTED: 'warning',
};

/** Status shown with icon + label so it never relies on colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? 'neutral';
  const style: Record<string, { icon: string; color: string }> = {
    good: { icon: '●', color: 'var(--good)' },
    warning: { icon: '▲', color: 'var(--serious)' },
    critical: { icon: '■', color: 'var(--critical)' },
    info: { icon: '◆', color: 'var(--brand)' },
    neutral: { icon: '○', color: 'var(--text-muted)' },
  };
  const s = style[tone]!;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-xs text-ink">
      <span aria-hidden style={{ color: s.color }}>{s.icon}</span>
      {status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
    </span>
  );
}

export function Alert({ tone = 'warning', children }: { tone?: 'warning' | 'critical' | 'info' | 'good'; children: ReactNode }) {
  const color = tone === 'critical' ? 'var(--critical)' : tone === 'info' ? 'var(--brand)' : tone === 'good' ? 'var(--good)' : 'var(--serious)';
  const icon = tone === 'critical' ? '■' : tone === 'info' ? 'ℹ' : tone === 'good' ? '✓' : '▲';
  return (
    <div role={tone === 'critical' ? 'alert' : 'status'} className="flex gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm" style={{ borderLeft: `4px solid ${color}` }}>
      <span aria-hidden style={{ color }}>{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className="w-[min(640px,calc(100vw-32px))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40">
      <div className="border-b border-line px-4 py-3 font-semibold">{title}</div>
      <div className="max-h-[70vh] overflow-auto p-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
    </dialog>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-ink2">
      <span>
        {total.toLocaleString()} result{total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-2">
        <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-8 text-center text-sm text-ink2">{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert tone="critical">{error instanceof Error ? error.message : String(error)}</Alert>;
}
