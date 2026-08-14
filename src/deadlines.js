const monthIndexes = new Map([
  ['janvier', 0], ['janv', 0], ['jan', 0], ['january', 0],
  ['fevrier', 1], ['fev', 1], ['february', 1], ['feb', 1],
  ['mars', 2], ['march', 2], ['mar', 2],
  ['avril', 3], ['avr', 3], ['april', 3], ['apr', 3],
  ['mai', 4], ['may', 4],
  ['juin', 5], ['june', 5], ['jun', 5],
  ['juillet', 6], ['july', 6], ['jul', 6],
  ['aout', 7], ['august', 7], ['aug', 7],
  ['septembre', 8], ['sept', 8], ['sep', 8], ['september', 8],
  ['octobre', 9], ['october', 9], ['oct', 9],
  ['novembre', 10], ['november', 10], ['nov', 10],
  ['decembre', 11], ['december', 11], ['dec', 11],
  ['\u064a\u0646\u0627\u064a\u0631', 0],
  ['\u0641\u0628\u0631\u0627\u064a\u0631', 1],
  ['\u0645\u0627\u0631\u0633', 2],
  ['\u0627\u0628\u0631\u064a\u0644', 3],
  ['\u0645\u0627\u064a', 4],
  ['\u064a\u0648\u0646\u064a\u0648', 5],
  ['\u064a\u0648\u0644\u064a\u0648\u0632', 6],
  ['\u064a\u0648\u0644\u064a\u0648', 6],
  ['\u063a\u0634\u062a', 7],
  ['\u0627\u063a\u0633\u0637\u0633', 7],
  ['\u0634\u062a\u0646\u0628\u0631', 8],
  ['\u0633\u0628\u062a\u0645\u0628\u0631', 8],
  ['\u0627\u0643\u062a\u0648\u0628\u0631', 9],
  ['\u0646\u0648\u0646\u0628\u0631', 10],
  ['\u0646\u0648\u0641\u0645\u0628\u0631', 10],
  ['\u062f\u062c\u0646\u0628\u0631', 11],
  ['\u062f\u064a\u0633\u0645\u0628\u0631', 11]
]);

const monthPattern = [...monthIndexes.keys()].join('|');

const deadlineLabelPattern =
  /date limite|date de fermeture|fermeture de candidature|dernier delai|deadline|last date|closing date|closes?|cloture|avant le|jusqu'?a|jusqu'?au|au plus tard|fin d'inscription|fin de l'inscription|fin des inscriptions|fin de candidature|fin des candidatures|limite de depot|limite d'inscription|registration deadline|application deadline|\u0627\u062e\u0631\s+\u0627\u062c\u0644|\u0627\u062e\u0631\s+\u0645\u0648\u0639\u062f|\u0646\u0647\u0627\u064a\u0629\s+\u0627\u0644\u062a\u0633\u062c\u064a\u0644|\u0627\u0644\u062a\u0627\u0631\u064a\u062e\s+\u0627\u0644\u0646\u0647\u0627\u064a\u064a/;
const applicationActionPattern =
  /appel\s+(?:a|aux|de)?\s*candidature|candidature|pre[- ]?inscription|inscription\s+en\s+ligne|depot\s+(?:du|de)\s+dossier|apply|application|registration|\u0627\u0644\u062a\u0631\u0634\u064a\u062d|\u0627\u0644\u062a\u0633\u062c\u064a\u0644/;
const rangePattern =
  /(?:\bdu|\bfrom|\u0645\u0646)\b[\s\S]{0,100}(?:\bau|\bto|\u0627\u0644\u0649|\u0625\u0644\u0649)\b/;
const rangeEndPrefixPattern =
  /(?:\bau|\bto|jusqu'?a(?:u)?|\u0627\u0644\u0649|\u0625\u0644\u0649)\s*$/;
const rangeStartPrefixPattern = /(?:\bdu|\bfrom|\u0645\u0646)\s*$/;
const openingDatePrefixPattern =
  /(?:date\s+d[' ]ouverture|date\s+de\s+debut|debut\s+d[' ]inscription|opening\s+date|registration\s+opens?)\s*:?\s*$/;
const targetProgrammePattern =
  /english|anglais|anglaise|\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|linguistics?|linguistique|tesol|\belt\b|foreign language teaching|translation studies|traduction[^.!|]{0,45}anglais|didacti(?:c|que)[^.!|]{0,45}anglais/;
const unrelatedProgrammePattern =
  /(?:master|licence)[^.!|]{0,90}(?:espagnol|spanish|hispan|cooperacion|francais|arabe|amazigh)/;

export function normalizeDeadlineText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b`\u00b4]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseDateCandidate(day, month, year) {
  const numericDay = Number.parseInt(day, 10);
  const numericYear = Number.parseInt(year, 10);
  const cleanMonth = String(month).toLowerCase().replace(/\.$/, '');
  const numericMonth = /^\d+$/.test(cleanMonth)
    ? Number.parseInt(cleanMonth, 10) - 1
    : monthIndexes.get(cleanMonth);

  if (!numericDay || !numericYear || numericMonth === undefined || numericMonth < 0 || numericMonth > 11) {
    return null;
  }

  const date = new Date(numericYear, numericMonth, numericDay);
  if (
    date.getFullYear() !== numericYear ||
    date.getMonth() !== numericMonth ||
    date.getDate() !== numericDay
  ) {
    return null;
  }

  return date;
}

function candidateScore(text, index, length) {
  const context = text.slice(Math.max(0, index - 150), Math.min(text.length, index + length + 150));
  const prefix = text.slice(Math.max(0, index - 100), index);
  const hasTargetProgramme = targetProgrammePattern.test(context);
  let score = 0;
  let evidence = '';

  if (openingDatePrefixPattern.test(prefix)) return null;
  if (rangeStartPrefixPattern.test(prefix)) return null;

  if (deadlineLabelPattern.test(context)) {
    score = 100;
    evidence = 'deadline label';
  } else if (applicationActionPattern.test(context) && rangePattern.test(context)) {
    score = 80;
    evidence = 'application range';
  } else if (applicationActionPattern.test(context) && rangeEndPrefixPattern.test(prefix)) {
    score = 75;
    evidence = 'application range';
  } else {
    return null;
  }

  if (rangeEndPrefixPattern.test(prefix)) score += 18;
  if (hasTargetProgramme) score += 24;
  if (!hasTargetProgramme && unrelatedProgrammePattern.test(context)) score -= 30;

  return { score, evidence };
}

export function findConfirmedDeadline(value) {
  const text = normalizeDeadlineText(value);
  const patterns = [
    {
      regex: /\b([0-3]?\d)[./-]([01]?\d)[./-]((?:20)?\d{2})\b/g,
      parse: (match) => parseDateCandidate(
        match[1],
        match[2],
        match[3].length === 2 ? `20${match[3]}` : match[3]
      )
    },
    {
      regex: new RegExp(`\\b([0-3]?\\d)\\s+(${monthPattern})\\.?\\s+((?:20)?\\d{2})\\b`, 'gi'),
      parse: (match) => parseDateCandidate(
        match[1],
        match[2],
        match[3].length === 2 ? `20${match[3]}` : match[3]
      )
    },
    {
      regex: new RegExp(`\\b(${monthPattern})\\.?\\s+([0-3]?\\d),?\\s+((?:20)?\\d{2})\\b`, 'gi'),
      parse: (match) => parseDateCandidate(
        match[2],
        match[1],
        match[3].length === 2 ? `20${match[3]}` : match[3]
      )
    }
  ];
  const candidates = [];

  for (const { regex, parse } of patterns) {
    let match;
    while ((match = regex.exec(text))) {
      const date = parse(match);
      const scored = candidateScore(text, match.index, match[0].length);
      if (date && scored) {
        candidates.push({ date, index: match.index, ...scored });
      }
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.index - right.index;
  });

  return candidates[0] || null;
}

export function extractConfirmedDeadline(value) {
  return findConfirmedDeadline(value)?.date || null;
}
