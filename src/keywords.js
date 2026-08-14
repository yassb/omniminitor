const rawKeywords = [
  'Master',
  '\u0645\u0627\u0633\u062a\u0631',
  'Licence Professionnelle',
  'Licence professionnelle',
  'Licence Pro',
  '\u0627\u0644\u0625\u062c\u0627\u0632\u0629 \u0627\u0644\u0645\u0647\u0646\u064a\u0629',
  '\u0627\u0644\u0627\u062c\u0627\u0632\u0629 \u0627\u0644\u0645\u0647\u0646\u064a\u0629',
  'Licence d\'Excellence',
  'Licence d Excellence',
  'Parcours Excellence',
  '\u0645\u0633\u0627\u0631 \u0627\u0644\u062a\u0645\u064a\u0632',
  'English',
  'Anglais',
  'Anglaises',
  '\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629',
  '\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629',
  '\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629',
  '\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629',
  'English Studies',
  'Etudes Anglaises',
  '\u062f\u0631\u0627\u0633\u0627\u062a \u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629',
  '\u062f\u0631\u0627\u0633\u0627\u062a \u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629',
  'Linguistics',
  'Linguistique',
  'Linguistiques',
  '\u0627\u0644\u0644\u0633\u0627\u0646\u064a\u0627\u062a',
  '\u0644\u0633\u0627\u0646\u064a\u0627\u062a',
  'Translation',
  'Traduction',
  'ESRFT',
  'Roi Fahd de Traduction',
  '\u0627\u0644\u062a\u0631\u062c\u0645\u0629',
  '\u062a\u0631\u062c\u0645\u0629',
  'Didactics',
  'Didactique',
  'Communication',
  '\u0627\u0644\u062a\u0648\u0627\u0635\u0644',
  'Tourism',
  'Tourisme',
  '\u0627\u0644\u0633\u064a\u0627\u062d\u0629',
  'Culture',
  '\u0627\u0644\u062b\u0642\u0627\u0641\u0629',
  'Media',
  'Medias',
  '\u0627\u0644\u0625\u0639\u0644\u0627\u0645'
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b`\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const KEYWORDS = rawKeywords.map((keyword) => ({
  label: keyword,
  normalized: normalizeText(keyword),
  pattern: /[a-z0-9]/i.test(normalizeText(keyword))
    ? new RegExp(`\\b${escapeRegex(normalizeText(keyword)).replace(/\s+/g, '\\s+')}\\b`, 'i')
    : new RegExp(escapeRegex(normalizeText(keyword)).replace(/\s+/g, '\\s+'), 'i')
}));

export function findMatchingKeywords(text) {
  const normalized = normalizeText(text);
  return KEYWORDS
    .filter((keyword) => keyword.pattern.test(normalized))
    .map((keyword) => keyword.label);
}

export function listKeywordLabels() {
  return KEYWORDS.map((keyword) => keyword.label);
}
