// Trigger matching supports individual keywords and full phrases, case-insensitive and ё-normalized.
export function normalizeText(value) {
  return String(value ?? '')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseKeywords(raw) {
  const seen = new Set();
  const list = [];
  for (const part of String(raw ?? '').split(/[\n,;]+/)) {
    const shown = part.trim();
    const norm = normalizeText(shown);
    if (!norm || norm.length > 100 || seen.has(norm)) continue;
    seen.add(norm);
    list.push({ shown, norm });
    if (list.length >= 200) break;
  }
  return list;
}

export function parsePhrases(raw) {
  const seen = new Set();
  const list = [];
  for (const part of String(raw ?? '').split(/[\n,;]+/)) {
    const shown = part.trim().replace(/\s+/g, ' ');
    const norm = normalizeText(shown);
    if (!norm || norm.length < 2 || norm.length > 250 || seen.has(norm)) continue;
    seen.add(norm);
    list.push({ shown, norm });
    if (list.length >= 200) break;
  }
  return list;
}
/** Returns the matching trigger text, '*' for any-message mode, or null. */
export function matchTrigger(text, settings) {
  const body = normalizeText(text);
  if (!body) return null;
  if (settings?.matchAny) return '*';
  const mode = settings?.matchMode || 'keywords';
  const candidates = [];
  if (mode === 'keywords' || mode === 'both') candidates.push(...parseKeywords(settings?.keywords));
  if (mode === 'phrases' || mode === 'both') candidates.push(...parsePhrases(settings?.phrases));
  for (const item of candidates) if (body.includes(item.norm)) return item.shown;
  return null;
}
