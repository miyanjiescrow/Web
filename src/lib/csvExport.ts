export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

const escapeCsvCell = (raw: unknown): string => {
  if (raw === null || raw === undefined) return '';
  let str = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Prevent CSV formula injection when opened in Excel
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export function buildCsvContent<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCsvCell(c.header)).join(',');
  const dataLines = rows.map((row) =>
    columns.map((c) => escapeCsvCell(c.value(row))).join(',')
  );
  // Prepend UTF-8 BOM so Microsoft Excel renders Persian RTL text properly
  return `\uFEFF${[headerLine, ...dataLines].join('\r\n')}`;
}

export function downloadCsvFile<T>(filename: string, rows: T[], columns: CsvColumn<T>[]): void {
  const content = buildCsvContent(rows, columns);
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
