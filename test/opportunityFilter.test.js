import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOpportunityMatch, hasTargetYearSignal } from '../src/opportunityFilter.js';

test('accepts a current English-related call even when older archive years are present', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Candidature Master Applied Linguistics 2026-2027',
    snippet: 'Applications are open. Deadline: 31 August 2026. Archives: 2024 and 2025.'
  }), true);
});

test('rejects the previous academic cycle when 2026 only appears in that cycle or copyright', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Candidature Master Applied Linguistics 2025-2026',
    snippet: 'Pre-inscription closed. Copyright 2026 - All rights reserved.'
  }), false);
});

test('rejects results and admitted-list notices', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Resultats Master English Studies 2026-2027',
    snippet: 'Liste des admis apres la candidature au Master English Studies.'
  }), false);
  assert.equal(hasTargetYearSignal({
    title: 'Master Translation 2026-2027',
    snippet: 'Liste des candidats convoques aux epreuves ecrites du concours acces.'
  }), false);
  assert.equal(hasTargetYearSignal({
    title: 'نتائج مباراة ولوج سلك الماستر برسم الموسم الجامعي 2026-2027',
    snippet: 'نشر نتائج مسلك Linguistics and Advanced English Studies.'
  }), false);
});

test('accepts an Arabic 2026-2027 translation Master application notice', () => {
  assert.equal(hasTargetYearSignal({
    title: 'فتح باب الترشيح لماستر اللغات والترجمة 2026-2027',
    snippet: 'آخر أجل لإيداع الترشيح هو 31/08/2026.'
  }), true);
});

test('rejects a catalog page with no application action', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Master English Studies',
    snippet: 'Program catalog for 2026-2027. Modules, faculty, and general admission requirements.'
  }), false);
});

test('accepts a standalone 2026 deadline when the call is explicit', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Call for applications: Master English Language Teaching',
    snippet: 'Apply online. Application deadline: 31/08/2026.'
  }), true);
});

test('rejects an unrelated professional licence that only uses English in an entrance test', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Licence Professionnelle Textile 2026-2027',
    snippet: 'Candidature ouverte. The available programs are logistics and textile production. The written entrance test includes English. Deadline 31/08/2026.'
  }), false);
});

test('rejects explicitly Arabic linguistics while retaining general applied linguistics', () => {
  assert.equal(hasTargetYearSignal({
    title: "Candidature Licence d'Excellence 2026-2027",
    snippet: 'Parcours: Linguistique arabe et communication. Date limite 31/08/2026.'
  }), false);
  assert.equal(hasTargetYearSignal({
    title: 'Candidature Master Theoretical and Applied Linguistics 2026-2027',
    snippet: 'Applications are open until 31/08/2026.'
  }), true);
});

test('rejects a technical Master only because its courses are taught in English', () => {
  assert.equal(hasTargetYearSignal({
    title: 'Master ENSAM Casablanca 2026-2027',
    snippet: 'Candidature ouverte au Master Big Data. Les cours de la deuxieme annee seront dispenses en anglais. Date limite 31/08/2026.'
  }), false);
});

test('rejects an English degree listed only as a prior admission diploma', () => {
  assert.equal(hasTargetYearSignal({
    title: "Licence d'Excellence Tourisme 2026-2027",
    snippet: 'Candidature ouverte. Diplomes requis: DEUG en geographie, histoire, langue et litterature anglaises. Date limite 31/08/2026.'
  }), false);
});

test('accepts real Arabic application wording and rejects real Arabic results wording', () => {
  assert.equal(hasTargetYearSignal({
    title: '\u0641\u062a\u062d \u0628\u0627\u0628 \u0627\u0644\u062a\u0631\u0634\u064a\u062d \u0644\u0645\u0627\u0633\u062a\u0631 \u0627\u0644\u0644\u063a\u0627\u062a \u0648\u0627\u0644\u062a\u0631\u062c\u0645\u0629 2026-2027',
    snippet: '\u0622\u062e\u0631 \u0623\u062c\u0644 \u0644\u0644\u062a\u0631\u0634\u064a\u062d 31/08/2026.'
  }), true);
  assert.equal(hasTargetYearSignal({
    title: '\u0646\u062a\u0627\u0626\u062c \u0645\u0627\u0633\u062a\u0631 \u0627\u0644\u062a\u0631\u062c\u0645\u0629 2026-2027',
    snippet: '\u0644\u0627\u0626\u062d\u0629 \u0627\u0644\u0645\u0642\u0628\u0648\u0644\u064a\u0646 \u0641\u064a \u0627\u0644\u0645\u0628\u0627\u0631\u0627\u0629.'
  }), false);
});

test('rejects a monthly archive page containing an old-cycle waiting-list notice', () => {
  const opportunity = {
    title: 'janvier 2026',
    url: 'https://www.ens.umi.ac.ma/2026/01/',
    snippet: [
      'Master Linguistic and Intercultural Studies for Sustainable Education',
      '\u0644\u0627\u0626\u062d\u0629 \u0627\u0644\u0627\u0646\u062a\u0638\u0627\u0631 \u0644\u0648\u0644\u0648\u062c \u0633\u0644\u0643 \u0627\u0644\u0645\u0627\u0633\u062a\u0631',
      '2025-2026'
    ].join(' ')
  };

  assert.equal(hasTargetYearSignal(opportunity), false);
  assert.equal(assessOpportunityMatch(opportunity).level, 'Rejected');
});
