/*
 * D1882 registration columns (Institution.dicomNames, dicomAets): one text column holds a comma-separated list.
 * A value is written with "\" and "," escaped by "\", so a spelling a hospital really sends with a comma in it stays one
 * value. DICOM InstitutionName (LO) and AE titles exclude "\" (PS3.5 6.2), so a column written before the escape reads
 * exactly as it did. Every reader of these columns parses them here; a second split would cut an escaped spelling in two.
 */

/** The stored column as its trimmed, non-empty values. */
export function institutionValues(stored: unknown): string[] {
  const text = String(stored ?? ''), out: string[] = [];
  let value = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) value += text[++i];
    else if (text[i] === ',') { out.push(value); value = ''; }
    else value += text[i];
  }
  out.push(value);
  return out.map(s => s.trim()).filter(Boolean);
}

/** The stored column with one more value; what was stored before is kept as it was. */
export function withInstitutionValue(stored: unknown, value: string): string {
  const text = String(stored ?? ''), escaped = value.replace(/[\\,]/g, ch => '\\' + ch);
  return text.trim() ? `${text},${escaped}` : escaped;
}
