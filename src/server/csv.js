/** 极简 CSV 序列化：RFC 4180 转义 + UTF-8 BOM（Excel 友好）。 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers, rows, metadata = []) {
  const lines = [];
  lines.push(['﻿# attribution-export'].join(''));
  for (const [k, v] of metadata) lines.push([csvCell(k), csvCell(v)].join(','));
  lines.push('');
  lines.push(headers.map(csvCell).join(','));
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
