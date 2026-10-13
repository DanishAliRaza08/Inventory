'use client';
import { Alert, Card, PageHeader } from '@/components/ui';

const READY = [
  ['Products, costs, stock & prices', '/api/exports/products'],
  ['Marketplace listings & statuses', '/api/exports/listings'],
  ['Cost history (effective-dated)', '/api/exports/costs'],
];
const PLANNED = ['Sales and profit by marketplace / SKU / category / supplier / order', 'Low-margin and loss-making products', 'Best-selling and slow-moving products', 'Supplier stock failures', 'Listing publication success rate', 'Returns and refund rate', 'Actual vs estimated fees', 'Monthly operating profit'];

export default function ReportsPage() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Analytics & reports" />
      <Card title="Available now">
        <ul className="space-y-2">{READY.map(([l, u]) => <li key={u} className="flex items-center justify-between gap-2 text-sm"><span>{l}</span><span className="flex gap-2"><a className="btn" href={`${u}?format=xlsx`}>XLSX</a><a className="btn" href={`${u}?format=csv`}>CSV</a></span></li>)}</ul>
      </Card>
      <Card title="Order-based reports" className="mt-4">
        <Alert tone="info">These reports need order, fee and settlement data from the marketplace connectors (Phases 4–5). Each will state whether its figures are estimated, partially reconciled or confirmed.</Alert>
        <ul className="mt-3 list-disc pl-5 text-sm text-ink2">{PLANNED.map((p) => <li key={p}>{p}</li>)}</ul>
      </Card>
    </div>
  );
}
