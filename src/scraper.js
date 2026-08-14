import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { config } from './config.js';
import { findMatchingKeywords, normalizeText } from './keywords.js';
import { formatMasterNamesForStorage, isRelevantProgramName } from './masterNames.js';
import { hasTargetYearSignal, TARGET_OPPORTUNITY_YEAR } from './opportunityFilter.js';
import { formatStoredOfficialUrl } from './sourceLinks.js';

const USER_AGENT =
  'OpportunityMonitor/2.0 (daily public admissions checker; contact: local dashboard owner)';
const fetchCache = new Map();
const fetchCacheTtlMs = 10 * 60 * 1000;
const MAX_DISCOVERY_LINKS = 600;
const MAX_FEED_ITEMS = 120;
const TEMPORARY_HTTP_ERROR_PATTERN = /^HTTP (?:429|5\d\d)$/i;

const subjectPattern =
  /english|anglais|anglaises|anglophone|etudes? anglaises|linguistics?|linguistique|translation|traduction|didactics?|didactique|tesol|tefl|english language teaching|english for specific purposes|\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0644\u0633\u0627\u0646\u064a\u0627\u062a|\u0627\u0644\u062a\u0631\u062c\u0645\u0629/;
const programTypePattern =
  /\bmasters?\b|\bmast(?:e|è)re\b|licence professionnelle|licence professionnalisante|licence pro\b|licence d[' ]excellence|parcours d[' ]excellence|professional (?:bachelor|licen[cs]e)|\u0645\u0627\u0633\u062a\u0631|\u0627\u0644\u0625\u062c\u0627\u0632\u0629 \u0627\u0644\u0645\u0647\u0646\u064a\u0629|\u0645\u0633\u0627\u0631 \u0627\u0644\u062a\u0645\u064a\u0632/;
const actionPattern =
  /candidature|pre[- ]?(?:candidature|inscription)|inscription en ligne|appel|concours|admission 2026|ouverture|date limite|dernier delai|depot des dossiers|prolongation|prorogation|application|registration|apply now|deadline|\u062a\u0631\u0634\u064a\u062d|\u0627\u0644\u062a\u0631\u0634\u064a\u062d|\u0627\u0644\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u0642\u0628\u0644\u064a|\u0641\u062a\u062d \u0628\u0627\u0628|\u0645\u0628\u0627\u0631\u0627\u0629 \u0627\u0644\u0648\u0644\u0648\u062c|\u0627\u062e\u0631 \u0627\u062c\u0644|\u0622\u062e\u0631 \u0623\u062c\u0644/;
const hubPattern =
  /actualites?|news|announcements?|avis|concours|admissions?|candidatures?|offre de formation|formations?|masters?|licences?|\u0627\u0644\u0627\u0639\u0644\u0627\u0646\u0627\u062a|\u0625\u0639\u0644\u0627\u0646\u0627\u062a|\u0645\u0633\u0627\u0644\u0643/;
const negativeNoticePattern =
  /resultats?|liste (?:des )?(?:candidats|admis|admissibles|retenus|selectionnes)|liste d[' ]attente|waiting list|waitlist|candidats? convoques?|pre[- ]?selection|convocations?|emploi du temps|planning (?:des )?(?:epreuves|examens|entretiens)|\u0646\u062a\u0627(?:\u0626|\u064a)\u062c|\u0644\u0627(?:\u0626|\u064a)\u062d\u0629 (?:\u0627\u0644\u0645\u062a\u0631\u0634\u062d\u064a\u0646|\u0627\u0644\u0646\u0627\u062c\u062d\u064a\u0646|\u0627\u0644\u0645\u062f\u0639\u0648\u064a\u0646|\u0627\u0644\u0645\u0646\u062a\u0642\u064a\u0646|\u0627\u0644\u0645\u0642\u0628\u0648\u0644\u064a\u0646|\u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631)/;
const programSubjectLabelPattern =
  /english studies|english language|teaching english|english for|langue et litteratures? anglaises?|etudes? anglaises?|anglophone|linguistics?|linguistique|translation|traduction|tesol|tefl|\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0644\u0633\u0627\u0646\u064a\u0627\u062a|\u0627\u0644\u062a\u0631\u062c\u0645\u0629/;

function cleanText(value, maxLength = 1000) {
  const cleaned = String(value ?? '')
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}...` : cleaned;
}

function toAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    url.pathname = url.pathname.replace(/\/(?:index\.(?:php|html?))$/i, '/');
    return url.toString();
  } catch {
    return value;
  }
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isAggregatorSource(url) {
  try {
    const host = new URL(url).hostname;
    return /(?:^|\.)almaster-maroc\.com$/i.test(host) ||
      /(?:^|\.)licence-professionnelle-maroc\.com$/i.test(host);
  } catch {
    return false;
  }
}

function fingerprintFor(siteId, candidate) {
  const normalizedUrl = normalizeUrl(candidate.url);
  const normalizedTitle = normalizeText(candidate.title);
  const basisParts = isAggregatorSource(normalizedUrl)
    ? ['aggregator', normalizedUrl, normalizedTitle]
    : [siteId, normalizedUrl, normalizedTitle];

  return crypto.createHash('sha256').update(basisParts.join('|')).digest('hex');
}

function addCandidate(candidates, seen, site, candidate) {
  const title = cleanText(candidate.title, 240);
  const snippet = cleanText(candidate.snippet || candidate.title, 6000);
  const url = normalizeUrl(candidate.url || site.url);
  const matchedKeywords = findMatchingKeywords(`${title} ${snippet}`);

  if (!title || !isHttpUrl(url) || matchedKeywords.length === 0) return undefined;

  const fingerprint = fingerprintFor(site.id, { title, url });
  if (seen.has(fingerprint)) return undefined;

  const savedCandidate = {
    siteId: site.id,
    title,
    url,
    snippet,
    matchedKeywords: JSON.stringify(matchedKeywords),
    fingerprint
  };
  seen.add(fingerprint);
  candidates.push(savedCandidate);
  return savedCandidate;
}

function addTargetCandidate(candidates, seen, site, candidate) {
  const savedCandidate = addCandidate(candidates, seen, site, candidate);
  if (!savedCandidate || hasTargetYearSignal(savedCandidate)) return savedCandidate;

  seen.delete(savedCandidate.fingerprint);
  candidates.splice(candidates.indexOf(savedCandidate), 1);
  return undefined;
}

function decodeBody(buffer, contentType) {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function resourceKind(url, contentType, body) {
  if (/application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(url) || /^%PDF-/.test(body)) return 'pdf';
  if (/json/i.test(contentType)) return 'json';
  if (/rss|atom|xml/i.test(contentType) || /^\s*<\?xml|^\s*<(?:rss|feed)\b/i.test(body)) return 'feed';
  return 'html';
}

async function fetchPublicResource(
  url,
  { timeoutMs = config.requestTimeoutMs, cache = false, accept = '*/*' } = {}
) {
  const cacheKey = normalizeUrl(url);
  const cached = cache ? fetchCache.get(cacheKey) : undefined;
  if (cached && Date.now() - cached.savedAt < fetchCacheTtlMs) {
    return cached.resource;
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept
        }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') || '';
      const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
      const possiblePdf = /application\/pdf/i.test(contentType) || /\.pdf(?:$|[?#])/i.test(response.url);
      const maxBytes = possiblePdf ? config.maxPdfBytes : config.maxHtmlBytes;
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Response is too large (${declaredLength} bytes)`);
      }

      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > maxBytes) throw new Error(`Response is too large (${body.length} bytes)`);

      const text = possiblePdf ? '' : decodeBody(body, contentType);
      const resource = {
        url: normalizeUrl(response.url || url),
        contentType,
        body,
        text,
        kind: resourceKind(response.url || url, contentType, text)
      };

      if (cache) fetchCache.set(cacheKey, { resource, savedAt: Date.now() });
      return resource;
    } catch (error) {
      lastError = error;
      const temporaryFailure =
        error.name === 'AbortError' ||
        TEMPORARY_HTTP_ERROR_PATTERN.test(error.message) ||
        /fetch failed|network|socket|connection|econn/i.test(error.message);
      if (attempt === 2 || !temporaryFailure) throw error;
      await new Promise((resolve) => setTimeout(resolve, 450));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export async function fetchHtml(url, { timeoutMs = config.requestTimeoutMs, cache = false } = {}) {
  const resource = await fetchPublicResource(url, {
    timeoutMs,
    cache,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  });
  if (resource.kind === 'pdf') throw new Error('Expected HTML but received PDF');
  return resource.text;
}

function stripHtml(html, maxLength = 4000) {
  const $ = cheerio.load(String(html ?? ''));
  $('script, style, noscript, template, svg').remove();
  return cleanText($.root().text(), maxLength);
}

function collectStructuredStrings(value, output, depth = 0, key = '') {
  if (depth > 12 || output.length >= 160) return;
  if (typeof value === 'string') {
    const normalizedKey = normalizeText(key);
    const normalizedValue = normalizeText(value);
    if (
      /title|name|headline|description|date|deadline|start|end|academic|program|formation|text/.test(normalizedKey) ||
      new RegExp(`\\b${TARGET_OPPORTUNITY_YEAR}\\b`).test(normalizedValue) ||
      subjectPattern.test(normalizedValue)
    ) {
      const text = cleanText(value, 1200);
      if (text) output.push(text);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectStructuredStrings(item, output, depth + 1, key);
    return;
  }

  for (const [childKey, childValue] of Object.entries(value).slice(0, 120)) {
    collectStructuredStrings(childValue, output, depth + 1, childKey);
  }
}

function parseHtmlDocument(html, pageUrl) {
  const $ = cheerio.load(String(html ?? ''), { decodeEntities: true });
  const links = [];

  $('nav, footer, noscript').remove();

  $('a[href]').each((_, element) => {
    if (links.length >= MAX_DISCOVERY_LINKS) return false;
    const anchor = $(element);
    const href = anchor.attr('href');
    const url = toAbsoluteUrl(href, pageUrl);
    const rawText = cleanText(
      anchor.text() || anchor.attr('title') || anchor.attr('aria-label') || '',
      500
    );
    const container = anchor.closest(
      'article, li, .views-row, .news-item, .post, .card, .item, .subject-wrapper'
    ).first();
    const contextTitle = cleanText(container.find('h1, h2, h3, h4, h5').first().text(), 500);
    const text = /^(?:read more|learn more|details?|plus de details|plus de détails|voir plus|suite)$/i.test(rawText)
      ? contextTitle || rawText
      : rawText;
    links.push({
      url,
      text,
      context: cleanText(container.length ? container.text() : text, 1200)
    });
  });

  const feedUrls = [];
  $('link[rel="alternate"]').each((_, element) => {
    const type = $(element).attr('type') || '';
    const href = $(element).attr('href');
    if (href && /rss|atom|xml/i.test(type)) feedUrls.push(toAbsoluteUrl(href, pageUrl));
  });

  const structuredStrings = [];
  $('script[type="application/ld+json"], script#__NEXT_DATA__').each((_, element) => {
    try {
      collectStructuredStrings(JSON.parse($(element).html() || ''), structuredStrings);
    } catch {
      // Invalid optional metadata must not prevent a page check.
    }
  });

  const metadata = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:title"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('meta[property="article:published_time"]').attr('content'),
    ...structuredStrings
  ].filter(Boolean);

  const title = cleanText(
    $('h1').first().text() ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').first().text(),
    240
  );

  const blocks = [];
  const blockKeys = new Set();
  $('article, .views-row, .news-item, .post-item, .item, .subject-wrapper, li').each((_, element) => {
    if (blocks.length >= 250) return false;
    const item = $(element);
    const text = cleanText(item.text(), 3200);
    if (text.length < 20) return;
    const link = item.find('a[href]').first();
    const blockTitle = cleanText(
      item.find('h1, h2, h3, h4, h5').first().text() || link.text() || text,
      240
    );
    const block = {
      title: blockTitle,
      text,
      url: link.length ? toAbsoluteUrl(link.attr('href'), pageUrl) : pageUrl
    };
    const key = `${normalizeUrl(block.url)}|${normalizeText(block.title)}`;
    if (blockKeys.has(key)) return;
    blockKeys.add(key);
    blocks.push(block);
  });

  $('script, style, template, svg').remove();
  let main = null;
  let mainLength = 0;
  $('main, [role="main"], #content, #main, .main-content, .page-content, .content-area, .single-post, .post-detail, .actualite-detail').each((_, element) => {
    const selection = $(element);
    const length = selection.text().trim().length;
    if (length > mainLength) {
      main = selection;
      mainLength = length;
    }
  });
  const bodyText = cleanText(main && mainLength > 150 ? main.text() : $('body').text(), 50_000);
  const pageText = cleanText([...metadata, bodyText].join(' | '), 50_000);

  return {
    $,
    title,
    pageText,
    metadata: cleanText(metadata.join(' | '), 5000),
    links,
    blocks,
    feedUrls: [...new Set(feedUrls.map(normalizeUrl))]
  };
}

function extractScriptDate(html, name) {
  const pattern = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  return String(html ?? '').match(pattern)?.[1];
}

function cleanProgramName(value) {
  return cleanText(value, 260)
    .replace(/\b(?:pre[- ]?inscription|inscription en ligne|concours d'acc[eè]s|candidature|date limite|deadline|quelles?|conditions? d'acces)\b[\s\S]*$/i, '')
    .replace(/\u0641\u064a\s+\u0627\u0646\u062a\u0638\u0627\u0631[\s\S]*$/i, '')
    .replace(/[|.;,\s]+$/, '')
    .trim();
}

function isLikelyProgramLabel(value) {
  const name = cleanProgramName(value);
  const normalized = normalizeText(name);
  if (!name || name.length > 190 || normalized.split(' ').length > 24) return false;
  const repeatedProgramLabels = (name.match(/master/gi) || []).length +
    (name.match(/\u0645\u0627\u0633\u062a\u0631/g) || []).length;
  if (repeatedProgramLabels > 1 || /^(?:m|module)\s*[-:]?\s*\d+\b/i.test(normalized)) return false;
  if (!isRelevantProgramName(name)) return false;
  if (/test|epreuve|examen|matiere|niveau|score|resultat|selection|admission|aptitude|verbal|document|candidat|contact|telephone|email/.test(normalized)) {
    return false;
  }
  return programTypePattern.test(normalized) || programSubjectLabelPattern.test(normalized);
}

function extractProgramNamesFromText(text) {
  const names = [];
  const programChunks = String(text ?? '')
    .replace(/(?=\b(?:master|licence (?:professionnelle|professionnalisante|d[' ]excellence))\b)/gi, '\n')
    .replace(/(?=\u0645\u0627\u0633\u062a\u0631|\u0627\u062c\u0627\u0632\u0629\s+\u0627\u0644\u062a\u0645\u064a\u0632)/g, '\n')
    .split('\n');

  for (const chunk of programChunks) {
    const name = cleanProgramName(chunk.slice(0, 260));
    if (isLikelyProgramLabel(name)) names.push(name);
  }

  const standalonePattern =
    /(?:educational linguistics|english for specific purposes|english language teaching|enseignement\s+secondaire\s*:\s*langue\s+anglaise|didactique\s+des\s+langues[^|.;]{0,90}option\s+anglais|theoretical and applied linguistics|applied linguistics(?: and [^|.;]{0,90})?|linguistics and advanced english studies|sciences du langage[^|.;]{0,90}|translation and interpreting|langues? et traduction)/gi;
  for (const match of String(text ?? '').matchAll(standalonePattern)) {
    const name = cleanProgramName(match[0]);
    if (isLikelyProgramLabel(name)) names.push(name);
  }

  const seen = new Set();
  return names.filter((name) => {
    const key = normalizeText(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function extractProgramNamesFromHtml(html, fallbackText = '') {
  const $ = cheerio.load(String(html ?? ''));
  const names = [];
  $('h1, h2, h3, h4, h5, p, li, span, div').each((_, element) => {
    const value = cleanProgramName($(element).text());
    const tagName = String(element.tagName || element.name || '').toLowerCase();
    const structuralLabel = /^h[1-5]$/.test(tagName) || programTypePattern.test(normalizeText(value));
    if (structuralLabel && isLikelyProgramLabel(value)) names.push(value);
  });
  if (names.length === 0) names.push(...extractProgramNamesFromText(fallbackText));

  const seen = new Set();
  return names.filter((name) => {
    const key = normalizeText(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function extractProgramNames(html, document) {
  const names = [];
  const special = cheerio.load(String(html ?? ''));
  special('a.link-click, [class*="link-click"]').each((_, element) => {
    const name = cleanProgramName(special(element).text());
    if (name && !/accueil|procedure|inscription|connexion|contactez/i.test(name)) names.push(name);
  });

  for (const block of document.blocks) {
    if (block.text.length <= 900 && isRelevantProgramName(block.text)) {
      names.push(...extractProgramNamesFromText(block.text));
    }
  }
  names.push(...extractProgramNamesFromText(document.pageText));

  const seen = new Set();
  return names.filter((name) => {
    const key = normalizeText(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function extractFocusedSegments(pageText) {
  const normalized = normalizeText(pageText);
  const ranges = [];
  const patterns = [
    new RegExp(`\\b${TARGET_OPPORTUNITY_YEAR}\\b`, 'g'),
    /date limite|date de fermeture|dernier delai|deadline|pre[- ]?inscription|inscription en ligne|candidature|prolongation/g,
    /english|anglais|anglaises|anglophone|tesol|tefl/g,
    /linguistics?|linguistique?s?/g,
    /translation|traduction/g,
    /didactics?|didactique/g,
    /\u0627\u0644\u0625\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632\u064a\u0629|\u0627\u0644\u0644\u0633\u0627\u0646\u064a\u0627\u062a|\u0627\u0644\u062a\u0631\u062c\u0645\u0629|\u0627\u0644\u062a\u0631\u0634\u064a\u062d/g
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const start = Math.max(0, match.index - 520);
      const end = Math.min(pageText.length, match.index + 1050);
      if (ranges.some((range) => Math.abs(range.start - start) < 280)) continue;
      ranges.push({ start, end });
      if (ranges.length >= 8) break;
    }
    if (ranges.length >= 8) break;
  }

  return ranges
    .sort((a, b) => a.start - b.start)
    .map((range) => cleanText(pageText.slice(range.start, range.end), 1600));
}

function extractRelevantPageSnippet(html, document, programNames) {
  const parts = [];
  const namesText = formatMasterNamesForStorage(programNames);
  const openingDate = extractScriptDate(html, 'dateOuverture');
  const closingDate = extractScriptDate(html, 'dateFermeture');

  if (namesText) parts.push(namesText);
  if (openingDate) parts.push(`Date d'ouverture: ${openingDate}`);
  if (closingDate) parts.push(`Date de fermeture de candidature en ligne: ${closingDate}`);
  if (document.metadata) parts.push(document.metadata);

  const focused = extractFocusedSegments(document.pageText);
  parts.push(...(focused.length > 0 ? focused : [document.pageText]));
  return cleanText(parts.join(' | '), 6000);
}

function getPageCandidateTitle(document, fallback, linkTitle = '') {
  const pageTitle = cleanText(document.title || fallback, 240);
  const genericTitle = /^(?:accueil|home|actualites?|news|avis|announcements?|universite|faculte)$/i;
  if (linkTitle && (!pageTitle || genericTitle.test(normalizeText(pageTitle)))) {
    return cleanText(linkTitle, 240);
  }
  const normalizedPageTitle = normalizeText(pageTitle);
  const normalizedLinkTitle = normalizeText(linkTitle);
  if (
    linkTitle &&
    /\b2026\b/.test(normalizedLinkTitle) &&
    actionPattern.test(normalizedLinkTitle) &&
    (!/\b2026\b/.test(normalizedPageTitle) || !actionPattern.test(normalizedPageTitle))
  ) {
    return cleanText(linkTitle, 240);
  }
  if (/^candidature aux masters$/i.test(pageTitle)) return 'Candidature Master';
  return pageTitle || cleanText(linkTitle || fallback, 240);
}

function isLikelyHubPage(document, pageTitle) {
  const normalizedTitle = normalizeText(pageTitle);
  const genericTitle =
    /^(?:accueil|home|actualites?|news|avis|announcements?|admissions?|formations?|offre de formation|masters?|licences?|universite|faculte)$/;
  const linkedBlocks = new Set(
    document.blocks.map((block) => normalizeUrl(block.url)).filter(Boolean)
  );
  const titleLooksLikeOpportunity = actionPattern.test(normalizedTitle) &&
    /\b2026\b/.test(normalizeText(`${pageTitle} ${document.metadata} ${document.pageText.slice(0, 1600)}`));
  if (genericTitle.test(normalizedTitle) && linkedBlocks.size > 1) return true;
  return linkedBlocks.size > 2 && !titleLooksLikeOpportunity;
}

export function extractOpportunities(html, site, { pageUrl = site.url, linkTitle = '' } = {}) {
  const candidates = [];
  const seen = new Set();
  const document = parseHtmlDocument(html, pageUrl);
  const programNames = extractProgramNames(html, document);
  const pageSnippet = extractRelevantPageSnippet(html, document, programNames);
  const pageTitle = getPageCandidateTitle(document, site.name || pageUrl, linkTitle);

  if (!isLikelyHubPage(document, pageTitle)) {
    addTargetCandidate(candidates, seen, site, {
      title: pageTitle,
      snippet: pageSnippet,
      url: pageUrl
    });
  }

  for (const block of document.blocks) {
    if (candidates.length >= config.maxCandidatesPerSite) break;
    addTargetCandidate(candidates, seen, site, {
      title: block.title,
      snippet: block.text,
      url: block.url
    });
  }

  for (const link of document.links) {
    if (candidates.length >= config.maxCandidatesPerSite) break;
    addTargetCandidate(candidates, seen, site, {
      title: link.text,
      snippet: link.context,
      url: link.url
    });
  }

  return candidates.slice(0, config.maxCandidatesPerSite);
}

function organizationRoot(hostname) {
  const labels = hostname.toLowerCase().replace(/^www\./, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.');
  const threePartSuffixes = new Set(['ac.ma', 'co.ma', 'gov.ma', 'org.ma', 'net.ma']);
  return labels.slice(threePartSuffixes.has(suffix) ? -3 : -2).join('.');
}

function sameOrganization(firstUrl, secondUrl) {
  try {
    return organizationRoot(new URL(firstUrl).hostname) === organizationRoot(new URL(secondUrl).hostname);
  } catch {
    return false;
  }
}

function isUnwantedFile(url) {
  try {
    return /\.(?:jpe?g|png|gif|webp|svg|ico|mp4|mp3|zip|rar|7z|docx?|xlsx?|pptx?)(?:$|[?#])/i.test(
      new URL(url).pathname
    );
  } catch {
    return true;
  }
}

function hasOnlyPreviousCycle(text) {
  const normalized = normalizeText(text).replace(/[\u2010-\u2015]/g, '-');
  return /\b2025\s*[-/]\s*2026\b/.test(normalized) && !/\b2026\s*[-/]\s*2027\b/.test(normalized);
}

export function scoreDiscoveryLink(link, sourceUrl) {
  const url = normalizeUrl(link.url);
  if (!isHttpUrl(url) || !sameOrganization(url, sourceUrl) || isUnwantedFile(url)) return -100;

  const normalized = normalizeText(`${link.text || ''} ${link.context || ''} ${url}`)
    .replace(/[\u2010-\u2015]/g, '-');
  if (/mailto:|tel:|javascript:/.test(url)) return -100;
  if (/facebook|instagram|youtube|linkedin|privacy|contact|mentions legales|login|logout/.test(normalized)) {
    return -100;
  }
  if (negativeNoticePattern.test(normalized)) return -100;
  if (hasOnlyPreviousCycle(normalized)) return -80;

  let score = 0;
  if (/\b2026\s*[-/]\s*2027\b/.test(normalized)) score += 42;
  else if (/\b2026\b/.test(normalized)) score += 18;
  if (/\/2026(?:\/|\b)/.test(url)) score += 12;
  if (subjectPattern.test(normalized)) score += 26;
  if (programTypePattern.test(normalized)) score += 14;
  if (actionPattern.test(normalized)) score += 18;
  if (hubPattern.test(normalized)) score += 7;
  if (/\.pdf(?:$|[?#])/i.test(url)) score += 6;
  return score;
}

function rankedDiscoveryLinks(document, sourceUrl, depth) {
  const seen = new Set();
  return document.links
    .map((link) => ({ ...link, depth, score: scoreDiscoveryLink(link, sourceUrl) }))
    .filter((link) => {
      const url = normalizeUrl(link.url);
      if (link.score < 7 || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}

function mergeCandidates(target, candidates) {
  for (const candidate of candidates) {
    if (!target.has(candidate.fingerprint)) target.set(candidate.fingerprint, candidate);
  }
}

async function extractPdfOpportunity(resource, site, item) {
  const parsed = await pdfParse(resource.body, { max: config.maxPdfPages });
  const pageText = cleanText(parsed.text, 40_000);
  const names = extractProgramNamesFromText(pageText);
  const snippet = cleanText([
    formatMasterNamesForStorage(names),
    ...extractFocusedSegments(pageText)
  ].filter(Boolean).join(' | '), 6000);
  const candidates = [];
  const seen = new Set();
  const filename = decodeURIComponent(new URL(resource.url).pathname.split('/').pop() || 'PDF announcement');
  addTargetCandidate(candidates, seen, site, {
    title: cleanText(item.text || filename, 240),
    snippet: snippet || pageText,
    url: resource.url
  });
  return candidates;
}

function xmlChildText($, element, names) {
  for (const child of $(element).children().toArray()) {
    const name = String(child.name || '').toLowerCase();
    if (names.includes(name)) return $(child).text();
  }
  return '';
}

export function extractSyndicationEntries(xml, feedUrl) {
  const $ = cheerio.load(String(xml ?? ''), { xmlMode: true });
  const entries = [];

  $('item, entry').each((_, element) => {
    if (entries.length >= MAX_FEED_ITEMS) return false;
    const item = $(element);
    const alternateLink = item.find('link[rel="alternate"]').attr('href');
    const plainLink = item.find('link').first().text() || item.find('link').first().attr('href');
    const content = xmlChildText($, element, ['content:encoded', 'content', 'description', 'summary']);
    const published = xmlChildText($, element, ['pubdate', 'published', 'updated', 'dc:date']);
    entries.push({
      title: cleanText(item.find('title').first().text(), 240),
      url: toAbsoluteUrl(alternateLink || plainLink || feedUrl, feedUrl),
      content,
      published: cleanText(published, 120)
    });
  });

  return entries;
}

function candidatesFromFeedEntries(entries, site, { requireProgramNames = false } = {}) {
  const candidates = [];
  const seen = new Set();

  for (const entry of entries) {
    if (negativeNoticePattern.test(normalizeText(entry.title))) continue;
    const articleText = stripHtml(entry.content, 35_000);
    const names = extractProgramNamesFromHtml(entry.content, `${entry.title} ${articleText}`);
    const officialSourceUrl = extractOfficialSourceUrl(entry.content, entry.url);
    if (requireProgramNames && names.length === 0) continue;
    const snippet = cleanText([
      formatMasterNamesForStorage(names),
      formatStoredOfficialUrl(officialSourceUrl),
      entry.published ? `Published: ${entry.published}` : '',
      ...extractFocusedSegments(articleText)
    ].filter(Boolean).join(' | '), 6000);
    addTargetCandidate(candidates, seen, site, {
      title: entry.title,
      snippet: snippet || articleText,
      url: entry.url
    });
  }

  return candidates;
}

function officialLinkScore(url, label = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const context = normalizeText(label);
    if (isAggregatorSource(url)) return 0;
    if (/google\.|facebook\.|instagram\.|linkedin\.|youtube\.|tiktok\.|twitter\.|x\.com$/.test(host)) {
      return 0;
    }

    let score = 0;
    if (/(?:^|\.)[^.]+\.ac\.ma$/.test(host) || host.endsWith('.gov.ma')) score += 100;
    if (/(?:^|\.)(?:uca|ump|uiz|umi|um5|usmba|uae|uit|uh1)\.ma$/.test(host)) score += 95;
    if (/ens|flsh|fse|flash|esrft|fpbm|fpl|ecandidature|e-candidature|preinscription/.test(host)) score += 70;
    if (/candidature|inscription|postuler|apply|admission|concours|site officiel|source/.test(context)) score += 25;
    if (/\.pdf(?:$|[?#])/i.test(parsed.pathname)) score += 5;
    return score;
  } catch {
    return 0;
  }
}

export function extractOfficialSourceUrl(html, pageUrl) {
  const $ = cheerio.load(String(html ?? ''));
  const candidates = [];

  $('a[href]').each((_, element) => {
    const href = toAbsoluteUrl($(element).attr('href'), pageUrl);
    if (!isHttpUrl(href)) return;
    const label = cleanText(`${$(element).text()} ${$(element).attr('title') || ''}`, 300);
    const score = officialLinkScore(href, label);
    if (score >= 70) candidates.push({ url: normalizeUrl(href), score });
  });

  return candidates.sort((left, right) => right.score - left.score)[0]?.url || '';
}

function bloggerFeedUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);
  const labelMatch = parsed.pathname.match(/\/search\/label\/([^/]+)/i);
  const labelPath = labelMatch ? `/-/${encodeURIComponent(decodeURIComponent(labelMatch[1]))}` : '';
  return `${parsed.origin}/feeds/posts/default${labelPath}?alt=json&max-results=${config.aggregatorFeedEntries}&orderby=published`;
}

function bloggerEntryValue(value) {
  return typeof value?.$t === 'string' ? value.$t : '';
}

export function extractBloggerFeedOpportunities(feedData, site) {
  const entries = Array.isArray(feedData?.feed?.entry) ? feedData.feed.entry : [];
  const normalizedEntries = entries.map((entry) => ({
    title: bloggerEntryValue(entry.title),
    url: entry.link?.find((link) => link.rel === 'alternate')?.href || site.url,
    content: bloggerEntryValue(entry.content) || bloggerEntryValue(entry.summary),
    published: bloggerEntryValue(entry.published) || bloggerEntryValue(entry.updated)
  }));
  return candidatesFromFeedEntries(normalizedEntries, site, { requireProgramNames: true });
}

function isAggregatorArticleUrl(url) {
  try {
    const parsed = new URL(url);
    return isAggregatorSource(parsed.toString()) &&
      /\/20\d{2}\/\d{2}\//.test(parsed.pathname) &&
      /\.html$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function getAggregatorArticleLinks(html, site) {
  const document = parseHtmlDocument(html, site.url);
  const seen = new Set();
  return document.links
    .filter((link) => isAggregatorArticleUrl(link.url))
    .map((link) => ({ ...link, score: scoreDiscoveryLink(link, site.url) }))
    .filter((link) => {
      const key = normalizeUrl(link.url);
      if (link.score <= 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(config.maxCandidatesPerSite, 20));
}

export async function extractAggregatorOpportunities(html, site) {
  const candidates = new Map();
  const links = getAggregatorArticleLinks(html, site);

  for (let start = 0; start < links.length; start += config.crawlerConcurrency) {
    const batch = links.slice(start, start + config.crawlerConcurrency);
    const results = await Promise.allSettled(batch.map(async (link) => {
      const articleHtml = await fetchHtml(link.url, {
        timeoutMs: config.childRequestTimeoutMs,
        cache: true
      });
      const officialSourceUrl = extractOfficialSourceUrl(articleHtml, link.url);
      return extractOpportunities(articleHtml, site, { pageUrl: link.url, linkTitle: link.text })
        .map((candidate) => ({
          ...candidate,
          snippet: cleanText([
            formatStoredOfficialUrl(officialSourceUrl),
            candidate.snippet
          ].filter(Boolean).join(' | '), 6000)
        }));
    }));
    for (const result of results) {
      if (result.status === 'fulfilled') mergeCandidates(candidates, result.value);
    }
  }

  return [...candidates.values()].slice(0, config.maxCandidatesPerSite);
}

async function discoverOfficialOpportunities(site, rootResource) {
  const found = new Map();
  const visited = new Set([normalizeUrl(rootResource.url), normalizeUrl(site.url)]);
  const queued = new Set();
  const queue = [];
  let requestsUsed = 1;
  let pdfsParsed = 0;

  const enqueue = (item) => {
    const url = normalizeUrl(item.url);
    if (item.depth > 2 || item.score < 7 || visited.has(url) || queued.has(url)) return;
    queued.add(url);
    queue.push({ ...item, url });
  };

  const processResource = async (resource, item) => {
    if (resource.kind === 'pdf') {
      if (pdfsParsed >= 2) return;
      pdfsParsed += 1;
      mergeCandidates(found, await extractPdfOpportunity(resource, site, item));
      return;
    }

    if (resource.kind === 'feed') {
      const entries = extractSyndicationEntries(resource.text, resource.url);
      mergeCandidates(found, candidatesFromFeedEntries(entries, site));
      for (const entry of entries) {
        const link = { url: entry.url, text: entry.title, context: stripHtml(entry.content, 1200) };
        const score = scoreDiscoveryLink(link, site.url);
        enqueue({ ...link, score, depth: item.depth + 1 });
      }
      return;
    }

    mergeCandidates(found, extractOpportunities(resource.text, site, {
      pageUrl: resource.url,
      linkTitle: item.text
    }));
    const document = parseHtmlDocument(resource.text, resource.url);
    for (const link of rankedDiscoveryLinks(document, site.url, item.depth + 1)) enqueue(link);
    for (const feedUrl of document.feedUrls.slice(0, 2)) {
      if (!sameOrganization(feedUrl, site.url)) continue;
      enqueue({ url: feedUrl, text: 'Admissions news feed', context: '', score: 22, depth: item.depth + 1 });
    }
  };

  await processResource(rootResource, { text: site.name || site.url, depth: 0 });

  while (queue.length > 0 && requestsUsed < config.maxPagesPerSite) {
    queue.sort((a, b) => b.score - a.score);
    const remaining = config.maxPagesPerSite - requestsUsed;
    const batch = queue.splice(0, Math.min(config.crawlerConcurrency, remaining));
    requestsUsed += batch.length;
    for (const item of batch) {
      queued.delete(item.url);
      visited.add(item.url);
    }

    const results = await Promise.allSettled(batch.map(async (item) => ({
      item,
      resource: await fetchPublicResource(item.url, {
        timeoutMs: config.childRequestTimeoutMs,
        cache: true,
        accept: 'text/html,application/xhtml+xml,application/pdf,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.7'
      })
    })));

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      try {
        await processResource(result.value.resource, result.value.item);
      } catch {
        // One malformed page or PDF must not invalidate the whole website scan.
      }
    }
  }

  return [...found.values()].slice(0, config.maxCandidatesPerSite);
}

export async function findOpportunitiesForSite(site) {
  if (isAggregatorSource(site.url)) {
    try {
      const feedResource = await fetchPublicResource(bloggerFeedUrl(site.url), {
        timeoutMs: config.requestTimeoutMs,
        cache: true,
        accept: 'application/json,text/json;q=0.9,*/*;q=0.5'
      });
      return extractBloggerFeedOpportunities(JSON.parse(feedResource.text), site);
    } catch {
      const html = await fetchHtml(site.url);
      return extractAggregatorOpportunities(html, site);
    }
  }

  const rootResource = await fetchPublicResource(site.url, {
    timeoutMs: config.requestTimeoutMs,
    accept: 'text/html,application/xhtml+xml,application/pdf,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.7'
  });
  return discoverOfficialOpportunities(site, rootResource);
}
