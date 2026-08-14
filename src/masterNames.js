export const MASTER_NAMES_MARKER = 'Master names:';

function cleanName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,\s]+$/, '');
}

function uniqueNames(names) {
  const seen = new Set();
  const result = [];

  for (const name of names.map(cleanName)) {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;

    seen.add(key);
    result.push(name);
  }

  return result;
}

export function formatMasterNamesForStorage(names) {
  const cleanNames = uniqueNames(names).slice(0, 40);
  return cleanNames.length === 0 ? '' : `${MASTER_NAMES_MARKER} ${cleanNames.join('; ')}`;
}

export function parseStoredMasterNames(text) {
  const value = String(text ?? '');
  const start = value.toLowerCase().indexOf(MASTER_NAMES_MARKER.toLowerCase());
  if (start === -1) return [];

  const afterMarker = value.slice(start + MASTER_NAMES_MARKER.length);
  const segment = afterMarker.split('|')[0];
  return uniqueNames(segment.split(';'));
}

export function extractMasterNamesFromOpportunity(opportunity) {
  const storedNames = parseStoredMasterNames(opportunity.snippet);
  if (storedNames.length > 0) return storedNames;

  const title = cleanName(opportunity.title);
  if (/\bmaster\b/i.test(title) && !/^candidature master$/i.test(title)) {
    return [title];
  }

  return [];
}

function normalizeFocusText(value) {
  return cleanName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b`\u00b4]/g, "'")
    .toLowerCase();
}

const englishStudyPattern =
  /\benglish\b|\benglish\s+studies\b|\benglish\s+(?:language\s+)?teaching\b|\benglish\s+for\s+specific\s+purposes\b|\btesol\b|\btefl\b|\banglo[- ]american\b|\bamerican\s+studies\b|\bbritish\s+studies\b|\banglais(?:e|es)?\b|\betudes?\s+anglaises?\b|\blangue\s+et\s+litteratures?\s+anglaises?\b|\banglophone\b|\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a|\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a|\u0625\u0646\u062c\u0644\u064a\u0632\u064a|\u0627\u0646\u062c\u0644\u064a\u0632\u064a|\u062f\u0631\u0627\u0633\u0627\u062a\s+\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u062f\u0631\u0627\u0633\u0627\u062a\s+\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0644\u063a\u0629\s+\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0644\u063a\u0629\s+\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629/i;

const strongEnglishStudyPattern =
  /\benglish\s+studies\b|\benglish\s+(?:language\s+)?teaching\b|\bteaching\s+english\b|\benglish\s+for\s+specific\s+purposes\b|\btesol\b|\btefl\b|\banglo[- ]american\b|\bamerican\s+studies\b|\bbritish\s+studies\b|\betudes?\s+anglaises?\b|\blangue\s+(?:anglaise|et\s+litteratures?\s+anglaises?)\b|\benseignement(?:\s+secondaire)?\s*:?\s*langue\s+anglaise\b|\boption\s+anglais\b|\banglophone\b|\u062f\u0631\u0627\u0633\u0627\u062a\s+(?:\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629)|\u0644\u063a\u0629\s+(?:\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629)|\u062a\u062e\u0635\u0635\s+\u0627\u0644\u0644\u063a\u0629\s+\u0627\u0644\u0627?\u0646\u062c\u0644\u064a\u0632\u064a\u0629/i;

const incidentalEnglishPattern =
  /(?:courses?|classes?|modules?|programme|program|formation|master|cours|enseignements?)\s+(?:.{0,70}\s)?(?:are\s+)?(?:taught|delivered|dispensed|dispenses?|dispensees?)\s+(?:in|en)\s+(?:english|anglais)|(?:test|epreuve|examen|matiere|niveau)\s+.{0,60}(?:english|anglais)|(?:english|anglais)\s+(?:test|epreuve|exam|level)/i;

const linguisticsPattern =
  /\blinguistics?\b|\blinguistique?s?\b|\blinguistic\s+approaches?\b|\u0627\u0644\u0644\u0633\u0627\u0646\u064a\u0627\u062a|\u0644\u0633\u0627\u0646\u064a\u0627\u062a|\u0627\u0644\u0644\u0633\u0627\u0646\u064a|\u0644\u0633\u0627\u0646\u064a/i;

const explicitlyNonEnglishLanguagePattern =
  /\barabic\b|\barabe?s?\b|\bamazighe?s?\b|\bberbere?s?\b|\bfrench\b|\bfrancais\b|\bhispanic\b|\bespagnol\b|\u0627\u0644\u0639\u0631\u0628\u064a\u0629|\u0627\u0644\u0627\u0645\u0627\u0632\u064a\u063a\u064a\u0629|\u0627\u0644\u0641\u0631\u0646\u0633\u064a\u0629|\u0627\u0644\u0627\u0633\u0628\u0627\u0646\u064a\u0629/i;

const translationPattern =
  /\btranslation\b|\btraduction\b|\btranslate\b|\btranslator\b|\besrft\b|\broi\s+fahd\s+de\s+traduction\b|\becole\s+superieure\s+roi\s+fahd\s+de\s+traduction\b|\u0627\u0644\u062a\u0631\u062c\u0645\u0629|\u062a\u0631\u062c\u0645\u0629|\u0645\u062a\u0631\u062c\u0645|\u0645\u062a\u0631\u062c\u0645\u0629|\u0644\u063a\u0627\u062a\s+\u0648\u0627\u0644\u062a\u0631\u062c\u0645\u0629/i;

const teachingPattern =
  /\bdidactics?\b|\bdidactique\b|\bteaching\b|\blanguage\s+teaching\b|\benseignement\b|\u062a\u062f\u0631\u064a\u0633|\u0627\u0644\u062a\u062f\u0631\u064a\u0633|\u062a\u0639\u0644\u064a\u0645|\u0627\u0644\u062a\u0639\u0644\u064a\u0645/i;

const licenceProfessionnellePattern =
  /\blicence\s+professionnelle\b|\blicence\s+professionnalisante\b|\blicence\s+pro\b|\bprofessional\s+(?:bachelor|licen[cs]e)\b|\u0627\u0644\u0625\u062c\u0627\u0632\u0629\s+\u0627\u0644\u0645\u0647\u0646\u064a\u0629|\u0627\u0644\u0627\u062c\u0627\u0632\u0629\s+\u0627\u0644\u0645\u0647\u0646\u064a\u0629|\u0625\u062c\u0627\u0632\u0629\s+\u0645\u0647\u0646\u064a\u0629|\u0627\u062c\u0627\u0632\u0629\s+\u0645\u0647\u0646\u064a\u0629/i;

const licenceExcellencePattern =
  /\blicence\s+d[' ]excellence\b|\bparcours\s+d[' ]excellence\b|\bparcours\s+excellence\b|\u0627\u0644\u0625\u062c\u0627\u0632\u0629\s+\u0645\u0633\u0627\u0631\s+\u0627\u0644\u062a\u0645\u064a\u0632|\u0627\u0644\u0627\u062c\u0627\u0632\u0629\s+\u0645\u0633\u0627\u0631\s+\u0627\u0644\u062a\u0645\u064a\u0632|\u0645\u0633\u0627\u0631\s+\u0627\u0644\u062a\u0645\u064a\u0632/i;

const masterPattern = /\bmasters?\b|\bmast(?:e|\u00e8)re\b|\u0645\u0627\u0633\u062a\u0631/i;
const programTypeTokenPattern =
  /\bmasters?\b|\bmast(?:e|e)re\b|licence\s+professionnelle|licence\s+professionnalisante|licence\s+pro\b|professional\s+(?:bachelor|licen[cs]e)|licence\s+d[' ]excellence|parcours\s+d[' ]excellence|\u0645\u0627\u0633\u062a\u0631|\u0627\u0644\u0625\u062c\u0627\u0632\u0629\s+\u0627\u0644\u0645\u0647\u0646\u064a\u0629|\u0645\u0633\u0627\u0631\s+\u0627\u0644\u062a\u0645\u064a\u0632/gi;

const eligibilityStartPattern =
  /\b(?:conditions?\s+d[' ]admission|diplomes?\s+requis|diplome\s*\(s\)\s*requis|prerequis|titulaires?|deug\s+en|admission\s+requirements?|eligible\s+degrees?)\b|\u0634\u0631\u0648\u0637\s+\u0627\u0644\u0648\u0644\u0648\u062c|\u0627\u0644\u0634\u0647\u0627\u062f\u0627\u062a\s+\u0627\u0644\u0645\u0637\u0644\u0648\u0628\u0629/i;

const subjectFocusPatterns = [
  { label: 'English Studies', pattern: englishStudyPattern },
  { label: 'Linguistics', pattern: linguisticsPattern },
  { label: 'Translation', pattern: translationPattern }
];

const focusPatterns = [
  ...subjectFocusPatterns,
  { label: 'Teaching / Didactics', pattern: teachingPattern },
  { label: 'Licence Professionnelle', pattern: licenceProfessionnellePattern },
  { label: "Licence d'Excellence", pattern: licenceExcellencePattern }
];

export function classifyProgramFocuses(name) {
  const value = normalizeFocusText(name);
  return focusPatterns
    .filter(({ label, pattern }) => {
      if (label === 'English Studies') return hasEnglishSubjectFocus(value);
      if (label === 'Translation') {
        return pattern.test(value) && !(
          explicitlyNonEnglishLanguagePattern.test(value) && !hasEnglishSubjectFocus(value)
        );
      }
      return pattern.test(value);
    })
    .map(({ label }) => label);
}

function hasEnglishSubjectFocus(value) {
  const normalized = normalizeFocusText(value);
  if (!englishStudyPattern.test(normalized)) return false;
  if (strongEnglishStudyPattern.test(normalized)) return true;
  if (incidentalEnglishPattern.test(normalized)) return false;
  return /\b(?:master|licence|bachelor)\b.{0,80}\b(?:english|anglais)\b|\b(?:english|anglais)\b.{0,80}\b(?:master|licence|bachelor)\b/i.test(normalized);
}

function hasSubjectFocus(value) {
  const normalized = normalizeFocusText(value);
  if (hasEnglishSubjectFocus(normalized)) return true;
  if (translationPattern.test(normalized)) {
    return !explicitlyNonEnglishLanguagePattern.test(normalized);
  }
  if (!linguisticsPattern.test(normalized)) return false;
  return !explicitlyNonEnglishLanguagePattern.test(normalized);
}

function hasProgramType(value) {
  const normalized = normalizeFocusText(value);
  return (
    masterPattern.test(normalized) ||
    licenceProfessionnellePattern.test(normalized) ||
    licenceExcellencePattern.test(normalized)
  );
}

export function isRelevantProgramName(name) {
  return hasSubjectFocus(name);
}

function hasNearbySubjectAndProgramType(value, radius = 140) {
  const normalized = normalizeFocusText(value);
  for (const match of normalized.matchAll(programTypeTokenPattern)) {
    const segment = normalized.slice(
      Math.max(0, match.index - radius),
      Math.min(normalized.length, match.index + match[0].length + radius)
    );
    const eligibilityStart = segment.search(eligibilityStartPattern);
    const programmeEvidence = eligibilityStart >= 0 ? segment.slice(0, eligibilityStart) : segment;
    if (hasSubjectFocus(programmeEvidence)) return true;
  }
  return false;
}

function isCorroboratedProgramName(name, opportunity) {
  const normalizedName = normalizeFocusText(name);
  if (hasProgramType(normalizedName)) return true;
  if (/english\s+(?:language\s+)?teaching|teaching\s+english|tesol|tefl|enseignement\s+secondaire\s*:\s*langue\s+anglaise|option\s+anglais/.test(normalizedName)) {
    return true;
  }

  const snippet = String(opportunity.snippet ?? '');
  const markerIndex = snippet.toLowerCase().indexOf(MASTER_NAMES_MARKER.toLowerCase());
  const evidenceText = markerIndex >= 0
    ? snippet.slice(snippet.indexOf('|', markerIndex) + 1)
    : snippet;
  const normalizedEvidence = normalizeFocusText(evidenceText);
  const nameIndex = normalizedEvidence.indexOf(normalizedName);
  if (nameIndex < 0) return isRelevantProgramName(opportunity.title);

  const context = normalizedEvidence.slice(Math.max(0, nameIndex - 180), nameIndex + normalizedName.length + 80);
  const eligibilityStart = context.search(eligibilityStartPattern);
  if (eligibilityStart >= 0 && eligibilityStart < context.indexOf(normalizedName)) return false;

  return /\b(?:master|licence|filiere|parcours|programme|program)\b|\u0645\u0627\u0633\u062a\u0631|\u0645\u0633\u0644\u0643|\u0634\u0639\u0628\u0629/.test(context) ||
    isRelevantProgramName(opportunity.title);
}

function removeStoredNames(value) {
  const text = String(value ?? '');
  const markerIndex = text.toLowerCase().indexOf(MASTER_NAMES_MARKER.toLowerCase());
  if (markerIndex < 0) return text;
  const separatorIndex = text.indexOf('|', markerIndex);
  return separatorIndex >= 0 ? `${text.slice(0, markerIndex)} ${text.slice(separatorIndex + 1)}` : text.slice(0, markerIndex);
}

export function extractRelevantProgramNames(opportunity) {
  const names = extractMasterNamesFromOpportunity(opportunity);
  const relevantNames = names.filter((name) =>
    isRelevantProgramName(name) && isCorroboratedProgramName(name, opportunity)
  );

  if (relevantNames.length > 0) return relevantNames;

  const title = cleanName(opportunity.title);
  const fallbackEvidence = `${title} ${removeStoredNames(opportunity.snippet)}`;
  if (isRelevantProgramName(title)) {
    return title && !/^candidature master$/i.test(title) ? [title] : [];
  }

  // Nearby body evidence can establish that an announcement is relevant, but
  // it must not turn a generic page heading such as "January 2026" into a
  // programme name.
  if (hasNearbySubjectAndProgramType(fallbackEvidence)) return [];

  return [];
}

export function matchesUserInterest(opportunity) {
  const text = `${opportunity.title} ${removeStoredNames(opportunity.snippet)}`;
  return extractRelevantProgramNames(opportunity).length > 0 ||
    (hasProgramType(text) && hasNearbySubjectAndProgramType(text));
}

export function classifyOpportunityFocuses(opportunity) {
  const labels = new Set();
  for (const name of extractRelevantProgramNames(opportunity)) {
    for (const label of classifyProgramFocuses(name)) {
      labels.add(label);
    }
  }

  if (labels.size === 0) {
    for (const label of classifyProgramFocuses(`${opportunity.title} ${opportunity.snippet}`)) {
      labels.add(label);
    }
  }

  return [...labels];
}
