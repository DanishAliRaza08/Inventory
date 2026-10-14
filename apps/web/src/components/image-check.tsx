'use client';

export interface ImageCheckResult { source: 'claude' | 'demo' | 'skipped'; hasText: boolean; hasWatermark: boolean; hasBorderOrCollage: boolean; backgroundIsPlainWhite: boolean; showsProductClearly: boolean; notes: string[] }

/** Compact summary of an automated image check. Problems are listed with a symbol, never colour alone. */
export function ImageCheck({ result, checkedAt }: { result: ImageCheckResult | null | undefined; checkedAt?: string | null }) {
  if (!result) return <div className="text-xs text-muted">Not checked</div>;
  if (result.source !== 'claude') return <div className="text-xs text-muted" title={result.notes.join(' ')}>{result.source === 'demo' ? 'Demo check (not analysed)' : 'Not checked automatically'}</div>;
  const problems = [
    result.hasText && 'Text on image',
    result.hasWatermark && 'Watermark / logo',
    result.hasBorderOrCollage && 'Border or collage',
    !result.backgroundIsPlainWhite && 'Background not white',
    !result.showsProductClearly && 'Product not clear',
  ].filter(Boolean) as string[];
  return (
    <div className="text-xs" title={[...result.notes, checkedAt ? `Checked ${new Date(checkedAt).toLocaleString('en-GB')}` : ''].filter(Boolean).join('\n')}>
      {problems.length === 0 ? <span style={{ color: 'var(--good-text, var(--good))' }}>✓ Checks passed</span> : problems.map((p) => <div key={p} style={{ color: 'var(--serious)' }}>▲ {p}</div>)}
    </div>
  );
}
