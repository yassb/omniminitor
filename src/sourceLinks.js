export const OFFICIAL_SOURCE_MARKER = 'Official source:';

export function cleanHttpUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function formatStoredOfficialUrl(value) {
  const url = cleanHttpUrl(value);
  return url ? `${OFFICIAL_SOURCE_MARKER} ${url}` : '';
}

export function extractStoredOfficialUrl(value) {
  const text = String(value ?? '');
  const markerIndex = text.toLowerCase().indexOf(OFFICIAL_SOURCE_MARKER.toLowerCase());
  if (markerIndex < 0) return '';

  const afterMarker = text.slice(markerIndex + OFFICIAL_SOURCE_MARKER.length).trim();
  const candidate = afterMarker.match(/^https?:\/\/[^\s|<>"']+/i)?.[0] || '';
  return cleanHttpUrl(candidate.replace(/[),.;]+$/, ''));
}

export function removeStoredOfficialUrl(value) {
  return String(value ?? '')
    .replace(/(?:^|\|)\s*Official source:\s*https?:\/\/[^\s|<>"']+\s*(?=\||$)/i, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .replace(/\s*\|\s*\|\s*/g, ' | ')
    .trim();
}
