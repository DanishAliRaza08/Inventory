import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';

export interface ParsedTable {
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return (v as { text: string }).text;
    if ('hyperlink' in v) return (v as { hyperlink: string }).hyperlink;
    if ('error' in v) return '';
  }
  return v;
}

export async function parseTable(fileName: string, buf: Buffer, maxRows = 50_000): Promise<ParsedTable> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const records = parse(buf, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Array<Record<string, string>>;
    if (records.length > maxRows) throw new Error(`File has ${records.length} rows; the maximum per import is ${maxRows}.`);
    const headers = records.length ? Object.keys(records[0]!) : (parse(buf, { to_line: 1, bom: true }) as string[][])[0] ?? [];
    return { headers, rows: records };
  }
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('The workbook has no worksheets.');
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = String(cellValue(cell.value) ?? '').trim();
    });
    const rows: Array<Record<string, unknown>> = [];
    for (let r = 2; r <= ws.actualRowCount; r++) {
      const row = ws.getRow(r);
      if (!row.hasValues) continue;
      const rec: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (h) rec[h] = cellValue(row.getCell(i + 1).value);
      });
      rows.push(rec);
      if (rows.length > maxRows) throw new Error(`File has more than ${maxRows} rows.`);
    }
    return { headers: headers.filter(Boolean), rows };
  }
  throw new Error('Unsupported file type. Upload a .csv or .xlsx file.');
}

export async function writeTable(format: 'csv' | 'xlsx', headers: string[], rows: Array<Record<string, unknown>>, sheetName = 'Export'): Promise<Buffer> {
  if (format === 'csv') {
    // Prefix cells that spreadsheet apps would interpret as formulas (CSV injection).
    const safe = rows.map((r) => headers.map((h) => {
      const v = r[h] ?? '';
      const s = String(v);
      return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    }));
    return Buffer.from(stringify([headers, ...safe]));
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));
  ws.columns.forEach((c) => (c.width = 18));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
