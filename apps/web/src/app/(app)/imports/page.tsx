'use client';
import { useState } from 'react';
import useSWR from 'swr';
import { Alert, Card, ErrorText, PageHeader, StatusBadge } from '@/components/ui';
import { api, fetcher } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface UploadRes { id: string; headers: string[]; totalRows: number; suggestedMapping: Record<string, string>; sample: Array<Record<string, unknown>>; fields: Record<string, { label: string; required: boolean }> }
interface ValidateRes { totalRows: number; validRows: number; errorRows: number; creates: number; updates: number; errors: Array<{ rowNumber: number; errors: Array<{ field: string; message: string }> }>; preview: Array<{ rowNumber: number; sku: string; action: string; changes?: Record<string, [unknown, unknown]> }> }
interface Job { id: string; fileName: string; status: string; totalRows: number; validRows: number; errorRows: number; processedRows: number; createdCount: number; updatedCount: number; failedCount: number; createdAt: string }

const STEPS = ['Upload', 'Map columns', 'Validate & preview', 'Import'];

export default function ImportsPage() {
  const [step, setStep] = useState(0);
  const [upload, setUpload] = useState<UploadRes | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [val, setVal] = useState<ValidateRes | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { data: history, mutate } = useSWR<Job[]>('/imports', fetcher);
  const { data: job } = useSWR<Job>(jobId ? `/imports/${jobId}` : null, fetcher, { refreshInterval: (j) => (j && ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(j.status) ? 0 : 1500) });
  const wrap = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); } };

  return (
    <div>
      <PageHeader title="Import & export" subtitle="Bulk import products, SKUs, suppliers, costs, stock and prices from CSV or XLSX. Nothing is written until you confirm."
        actions={<><a className="btn" href="/api/imports/template?format=xlsx">Download template (XLSX)</a><a className="btn" href="/api/imports/template?format=csv">Template (CSV)</a></>} />
      <ol className="mb-4 flex flex-wrap gap-2 text-sm">{STEPS.map((s, i) => <li key={s} className={`rounded-full border border-line px-3 py-1 ${i === step ? 'bg-brand text-white' : i < step ? 'text-ink' : 'text-muted'}`}>{i + 1}. {s}</li>)}</ol>
      <ErrorText error={error} />
      <div className="mt-3 space-y-4">
        {step === 0 && (
          <Card title="Upload a file">
            <input type="file" accept=".csv,.xlsx" disabled={busy} onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void wrap(async () => { const r = await api.upload<UploadRes>('/imports', file); setUpload(r); setMapping(r.suggestedMapping); setStep(1); });
            }} />
            <p className="mt-2 text-xs text-ink2">Up to 50,000 rows. Large files are processed in the background; you can leave this page.</p>
          </Card>
        )}
        {step === 1 && upload && (
          <Card title={`Map columns — ${upload.totalRows.toLocaleString()} rows`} actions={<button className="btn-primary" disabled={busy || !mapping.sku || !mapping.title} onClick={() => wrap(async () => { setVal(await api.post<ValidateRes>(`/imports/${upload.id}/validate`, { mapping })); setStep(2); })}>Validate</button>}>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(upload.fields).map(([k, f]) => (
                <label key={k} className="block"><span className="label">{f.label}{f.required ? ' *' : ''}</span>
                  <select className="input" value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}>
                    <option value="">— not imported —</option>{upload.headers.map((h) => <option key={h}>{h}</option>)}
                  </select></label>
              ))}
            </div>
          </Card>
        )}
        {step === 2 && val && upload && (
          <Card title="Validation & preview" actions={<div className="flex gap-2"><button className="btn" onClick={() => setStep(1)}>Back to mapping</button>
            <button className="btn-primary" disabled={busy || val.validRows === 0} onClick={() => wrap(async () => { await api.post(`/imports/${upload.id}/commit`); setJobId(upload.id); setStep(3); void mutate(); })}>Import {val.validRows.toLocaleString()} valid rows</button></div>}>
            <div className="mb-3 grid gap-2 sm:grid-cols-4 text-sm">
              <div>Total rows <strong>{val.totalRows}</strong></div><div>New SKUs <strong>{val.creates}</strong></div><div>Updates <strong>{val.updates}</strong></div><div>Rows with errors <strong style={{ color: val.errorRows ? 'var(--critical)' : undefined }}>{val.errorRows}</strong></div>
            </div>
            {val.errorRows > 0 && <Alert>Rows with errors are skipped. <a className="underline" href={`/api/imports/${upload.id}/errors?format=xlsx`}>Download them</a>, correct and re-upload — successful rows are never imported twice.</Alert>}
            {val.errors.length > 0 && <ul className="mt-2 max-h-48 overflow-auto text-xs">{val.errors.map((e) => <li key={e.rowNumber}>Row {e.rowNumber}: {e.errors.map((x) => `${x.field}: ${x.message}`).join('; ')}</li>)}</ul>}
            <h3 className="mb-1 mt-3 text-xs font-semibold text-ink2">Preview (first 100)</h3>
            <ul className="max-h-48 overflow-auto text-xs">{val.preview.map((p) => <li key={p.rowNumber}>Row {p.rowNumber}: {p.action === 'CREATE' ? 'create' : 'update'} {p.sku}{p.changes ? ` — ${Object.entries(p.changes).map(([k, [a, b]]) => `${k}: "${a}" → "${b}"`).join(', ')}` : ''}</li>)}</ul>
          </Card>
        )}
        {step === 3 && job && (
          <Card title="Import progress" actions={<StatusBadge status={job.status} />}>
            <div className="h-2 w-full overflow-hidden rounded bg-plane"><div className="h-2 bg-brand" style={{ width: `${(job.processedRows / Math.max(1, job.validRows)) * 100}%` }} /></div>
            <p className="mt-2 text-sm">{job.processedRows.toLocaleString()} of {job.validRows.toLocaleString()} rows · {job.createdCount} created · {job.updatedCount} updated · {job.failedCount} failed</p>
            {job.failedCount > 0 && <a className="btn mt-2" href={`/api/imports/${job.id}/errors?format=xlsx`}>Download failed rows</a>}
            <button className="btn mt-2" onClick={() => { setStep(0); setUpload(null); setVal(null); setJobId(null); }}>Start another import</button>
          </Card>
        )}
        <Card title="Import history">
          <table className="w-full"><thead><tr>{['File', 'Status', 'Rows', 'Created', 'Updated', 'Failed', 'When', ''].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody>{history?.map((j) => <tr key={j.id}><td className="td text-sm">{j.fileName}</td><td className="td"><StatusBadge status={j.status} /></td><td className="td num">{j.totalRows}</td><td className="td num">{j.createdCount}</td><td className="td num">{j.updatedCount}</td><td className="td num">{j.failedCount + j.errorRows}</td><td className="td text-xs">{dateTime(j.createdAt)}</td><td className="td">{j.failedCount + j.errorRows > 0 && <a className="text-xs underline" href={`/api/imports/${j.id}/errors?format=xlsx`}>Errors</a>}</td></tr>)}</tbody></table>
        </Card>
        <Card title="Exports">
          <div className="flex flex-wrap gap-2">
            <a className="btn" href="/api/exports/products?format=xlsx">Products, costs & stock (XLSX)</a>
            <a className="btn" href="/api/exports/products?format=csv">Products (CSV)</a>
            <a className="btn" href="/api/exports/listings?format=xlsx">Listings (XLSX)</a>
            <a className="btn" href="/api/exports/costs?format=xlsx">Cost history (XLSX)</a>
          </div>
        </Card>
      </div>
    </div>
  );
}
