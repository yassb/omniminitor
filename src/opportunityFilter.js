import {
  MASTER_NAMES_MARKER,
  extractRelevantProgramNames,
  matchesUserInterest
} from './masterNames.js';

export const TARGET_OPPORTUNITY_YEAR = 2026;
const NEXT_ACADEMIC_YEAR = TARGET_OPPORTUNITY_YEAR + 1;
const PREVIOUS_ACADEMIC_YEAR = TARGET_OPPORTUNITY_YEAR - 1;

export function normalizeOpportunityText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b`\u00b4]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function yearsInOpportunityText(value) {
  return [...new Set(
    [...normalizeOpportunityText(value).matchAll(/\b(20\d{2})\b/g)]
      .map((match) => Number.parseInt(match[1], 10))
      .filter(Number.isFinite)
  )];
}

const opportunityActionPattern = new RegExp([
  'appel(?:s)?\\s+(?:a|aux|de)?\\s*candidatures?',
  'candidatures?',
  'pre[- ]?(?:candidature|inscription)',
  'inscriptions?\\s+(?:ouvertes?|en ligne)',
  'ouverture\\s+(?:des?\\s+)?(?:candidatures?|inscriptions?)',
  'concours(?:\\s+d[\' ]acces)?',
  'date\\s+limite',
  'dernier\\s+delai',
  'depot\\s+(?:des?\\s+)?dossiers?',
  'prolongation',
  'prorogation',
  'call\\s+for\\s+applications?',
  'applications?\\s+(?:are\\s+)?open',
  'registration\\s+(?:is\\s+)?open',
  'application\\s+deadline',
  'apply\\s+(?:now|online)',
  '[\\u0627\\u0625]\\u0644\\u062a\\u0631\\u0634\\u064a\\u062d',
  '\\u062a\\u0631\\u0634\\u064a\\u062d',
  '[\\u0627\\u0625]\\u0644\\u062a\\u0633\\u062c\\u064a\\u0644\\s+(?:[\\u0627\\u0625]\\u0644\\u0642\\u0628\\u0644\\u064a|[\\u0627\\u0625]\\u0644\\u0627\\u0648\\u0644\\u064a)',
  '\\u062a\\u0633\\u062c\\u064a\\u0644\\s+(?:\\u0642\\u0628\\u0644\\u064a|[\\u0627\\u0625]\\u0648\\u0644\\u064a)',
  '\\u0641\\u062a\\u062d\\s+\\u0628\\u0627\\u0628',
  '[\\u0627\\u0625]\\u064a\\u062f\\u0627\\u0639\\s+(?:\\u0637\\u0644\\u0628\\u0627\\u062a\\s+)?[\\u0627\\u0625]\\u0644\\u062a\\u0631\\u0634\\u064a\\u062d',
  '\\u0645\\u0628\\u0627\\u0631\\u0627\\u0629\\s+[\\u0627\\u0625]\\u0644\\u0648\\u0644\\u0648\\u062c',
  '[\\u0627\\u0625]\\u062e\\u0631\\s+[\\u0627\\u0625]\\u062c\\u0644',
  '\\u062a\\u0645\\u062f\\u064a\\u062f\\s+(?:\\u0641\\u062a\\u0631\\u0629|[\\u0627\\u0625]\\u062c\\u0644)'
].join('|'), 'i');

const negativeNoticePattern = new RegExp([
  'resultats?',
  'liste\\s+(?:des?\\s+)?(?:admis|admissibles|retenus|selectionnes)',
  'pre[- ]?selection',
  'convocations?',
  'candidats?\\s+convoques?',
  'liste\\s+d[\' ]attente',
  'waiting\\s+list',
  'waitlist',
  'planning\\s+(?:des?\\s+)?(?:epreuves|entretiens|examens)',
  'emploi\\s+du\\s+temps',
  '\\u0646\\u062a\\u0627(?:\\u0626|\\u064a)\\u062c',
  '\\u0644\\u0627(?:\\u0626|\\u064a)\\u062d\\u0629\\s+(?:\\u0627\\u0644\\u0645\\u062a\\u0631\\u0634\\u062d\\u064a\\u0646|\\u0627\\u0644\\u0646\\u0627\\u062c\\u062d\\u064a\\u0646|\\u0627\\u0644\\u0645\\u062f\\u0639\\u0648\\u064a\\u0646|\\u0627\\u0644\\u0645\\u0646\\u062a\\u0642\\u064a\\u0646|\\u0627\\u0644\\u0645\\u0642\\u0628\\u0648\\u0644\\u064a\\u0646)',
  '\\u0644\\u0627(?:\\u0626|\\u064a)\\u062d\\u0629\\s+\\u0627\\u0644\\u0627\\u0646\\u062a\\u0638\\u0627\\u0631',
  '\\u0627\\u0644\\u0646\\u062a\\u0627(?:\\u0626|\\u064a)\\u062c\\s+\\u0627\\u0644\\u0646\\u0647\\u0627(?:\\u0626|\\u064a)\\u064a\\u0629',
  '\\u0627\\u0644\\u0644\\u0648\\u0627(?:\\u0626|\\u064a)\\u062d\\s+\\u0627\\u0644\\u0646\\u0647\\u0627(?:\\u0626|\\u064a)\\u064a\\u0629'
].join('|'), 'i');

const negativeLeadPattern = new RegExp([
  'resultats?',
  'liste\\s+(?:des?\\s+)?(?:candidats?|admis|admissibles|retenus|selectionnes)',
  'candidats?\\s+convoques?',
  'liste\\s+d[\' ]attente',
  'waiting\\s+list',
  'waitlist',
  '\\u0646\\u062a\\u0627(?:\\u0626|\\u064a)\\u062c',
  '\\u0644\\u0627(?:\\u0626|\\u064a)\\u062d\\u0629\\s+(?:\\u0627\\u0644\\u0645\\u062a\\u0631\\u0634\\u062d\\u064a\\u0646|\\u0627\\u0644\\u0646\\u0627\\u062c\\u062d\\u064a\\u0646|\\u0627\\u0644\\u0645\\u062f\\u0639\\u0648\\u064a\\u0646|\\u0627\\u0644\\u0645\\u0646\\u062a\\u0642\\u064a\\u0646|\\u0627\\u0644\\u0645\\u0642\\u0628\\u0648\\u0644\\u064a\\u0646)',
  '\\u0644\\u0627(?:\\u0626|\\u064a)\\u062d\\u0629\\s+\\u0627\\u0644\\u0627\\u0646\\u062a\\u0638\\u0627\\u0631'
].join('|'), 'i');

const genericArchiveTitlePattern = new RegExp(
  `^(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december)\\s*,?\\s*${TARGET_OPPORTUNITY_YEAR}$`,
  'i'
);

const deadlineEvidencePattern =
  /date\s+limite|dernier\s+delai|deadline|closing\s+date|application\s+deadline|jusqu'?a|jusqu'?au|avant\s+le|\u0627\u062e\u0631\s+\u0627\u062c\u0644|\u0627\u062e\u0631\s+\u0645\u0648\u0639\u062f/i;

const targetCyclePattern = new RegExp(
  `\\b${TARGET_OPPORTUNITY_YEAR}\\s*[-/]\\s*${NEXT_ACADEMIC_YEAR}\\b`
);
const previousCyclePattern = new RegExp(
  `\\b${PREVIOUS_ACADEMIC_YEAR}\\s*[-/]\\s*${TARGET_OPPORTUNITY_YEAR}\\b`
);

function targetYearWindows(text, radius = 850) {
  const windows = [];
  const targetPattern = new RegExp(`\\b${TARGET_OPPORTUNITY_YEAR}\\b`, 'g');

  for (const match of text.matchAll(targetPattern)) {
    const context = text.slice(Math.max(0, match.index - 35), match.index + 45);
    if (previousCyclePattern.test(context) && !targetCyclePattern.test(context)) continue;
    if (/copyright|all rights reserved|tous droits reserves|\u00a9/.test(context)) continue;

    windows.push(text.slice(
      Math.max(0, match.index - radius),
      Math.min(text.length, match.index + radius)
    ));
  }

  return windows;
}

export function hasApplicationActionEvidence(value) {
  return opportunityActionPattern.test(normalizeOpportunityText(value));
}

export function hasCurrentCycleEvidence(value) {
  const normalized = normalizeOpportunityText(value);
  return targetCyclePattern.test(normalized) || targetYearWindows(normalized).length > 0;
}

function sourceTrustFor(opportunity) {
  const value = String(opportunity.official_url || opportunity.url || '');
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (/almaster-maroc\.com|licence-professionnelle-maroc\.com/.test(host)) {
      return { score: 2, reason: 'Specialist discovery source', type: 'Aggregator' };
    }
    if (/\.ac\.ma$|\.uca\.ma$|\.ump\.ma$|\.uiz\.ac\.ma$|\.um5\.ac\.ma$|\.umi\.ac\.ma$/.test(host)) {
      return { score: 12, reason: 'Official university source', type: 'Official' };
    }
  } catch {
    // A malformed source URL simply receives no trust bonus.
  }
  return { score: 5, reason: 'Direct source page', type: 'Source' };
}

export function hasTargetYearSignal(opportunity) {
  const title = normalizeOpportunityText(opportunity.title);
  const text = `${opportunity.title ?? ''} ${opportunity.snippet ?? ''}`;
  const normalizedText = normalizeOpportunityText(text);

  if (!matchesUserInterest(opportunity)) return false;
  if (genericArchiveTitlePattern.test(title)) return false;
  if (negativeNoticePattern.test(title)) return false;
  if (negativeLeadPattern.test(normalizeOpportunityText(String(opportunity.snippet ?? '').slice(0, 1400)))) {
    return false;
  }
  if (previousCyclePattern.test(title) && !targetCyclePattern.test(title)) return false;

  const windows = targetYearWindows(normalizedText);
  if (windows.length === 0) return false;

  const hasStoredRelevantProgramNames =
    text.includes(MASTER_NAMES_MARKER) && extractRelevantProgramNames(opportunity).length > 0;
  const storedNames = hasStoredRelevantProgramNames
    ? extractRelevantProgramNames(opportunity).join(' ')
    : '';

  return windows.some((window) => {
    const evidence = `${opportunity.title ?? ''} ${storedNames} ${window}`;
    return opportunityActionPattern.test(window) &&
      matchesUserInterest({ title: opportunity.title ?? '', snippet: evidence });
  });
}

export function assessOpportunityMatch(opportunity) {
  const text = `${opportunity.title ?? ''} ${opportunity.snippet ?? ''}`;
  const normalized = normalizeOpportunityText(text);
  const programNames = extractRelevantProgramNames(opportunity);
  const trust = sourceTrustFor(opportunity);

  if (!hasTargetYearSignal(opportunity)) {
    return {
      score: 0,
      level: 'Rejected',
      reasons: ['Missing reliable current-cycle application evidence'],
      sourceType: trust.type
    };
  }

  let score = 48;
  const reasons = ['Current-cycle application wording found'];

  if (targetCyclePattern.test(normalized)) {
    score += 12;
    reasons.push(`${TARGET_OPPORTUNITY_YEAR}-${NEXT_ACADEMIC_YEAR} cycle stated`);
  }
  if (programNames.length > 0) {
    score += Math.min(18, 10 + programNames.length * 2);
    reasons.push('Relevant programme name extracted');
  }
  if (deadlineEvidencePattern.test(normalized) && /\b(?:20)?26\b/.test(normalized)) {
    score += 10;
    reasons.push('Deadline evidence found');
  }
  score += trust.score;
  reasons.push(trust.reason);

  if (/^(?:candidature master|master candidature|admissions?|accueil|home)$/i.test(String(opportunity.title || '').trim())) {
    score -= 7;
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    level: score >= 85 ? 'Strong' : score >= 70 ? 'Good' : 'Review',
    reasons,
    sourceType: trust.type
  };
}
