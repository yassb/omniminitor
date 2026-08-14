import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWhatsAppDigestBatches,
  formatWhatsAppOpportunityMessage
} from '../src/whatsapp.js';

const testNow = new Date(2026, 7, 12, 12, 0, 0);

test('formats a WhatsApp opportunity as organized sections with a confirmed deadline', () => {
  const message = formatWhatsAppOpportunityMessage({
    title: 'Candidature Master Applied Linguistics 2026-2027',
    snippet: 'Master names: Master Applied Linguistics | Applications are open. Date limite: 31/08/2026. Submit the online form.',
    matched_keywords: JSON.stringify(['Master', 'Linguistics', 'English Studies']),
    site_name: 'Faculty of Letters Marrakech',
    site_url: 'https://faculty.example.ac.ma',
    url: 'https://faculty.example.ac.ma/master-applied-linguistics'
  }, { now: testNow });

  assert.match(message, /^\*NEW OPPORTUNITY - 2026\/2027\*/);
  assert.match(message, /\*PROGRAM\*[\s\S]*Name: Master Applied Linguistics/);
  assert.match(message, /Type: Master/);
  assert.match(message, /\*APPLICATION\*[\s\S]*Status: Open/);
  assert.match(message, /Deadline: 31 August 2026/);
  assert.match(message, /Time remaining: 19 days remaining/);
  assert.match(message, /\*SOURCE\*[\s\S]*Matched because:/);
  assert.match(message, /https:\/\/faculty\.example\.ac\.ma/);
  assert.doesNotMatch(message, /Master names:/);
});

test('does not invent a deadline when the page has no labelled deadline', () => {
  const message = formatWhatsAppOpportunityMessage({
    title: 'Master English Studies 2026-2027',
    snippet: 'Applications are open for the new academic year.',
    matched_keywords: 'not-json, English Studies',
    site_name: 'Example University',
    url: 'https://example.ac.ma/english-master'
  }, { now: testNow });

  assert.match(message, /Status: Check the source page/);
  assert.match(message, /Deadline: Not confirmed in the announcement text/);
  assert.match(message, /Matched because: not-json; English Studies/);
});

test('recognizes an Arabic Master and a labelled Moroccan Arabic deadline', () => {
  const message = formatWhatsAppOpportunityMessage({
    title: '\u0645\u0627\u0633\u062a\u0631 \u0627\u0644\u062a\u0631\u062c\u0645\u0629 2026-2027',
    snippet: '\u0641\u062a\u062d \u0628\u0627\u0628 \u0627\u0644\u062a\u0631\u0634\u064a\u062d. \u0622\u062e\u0631 \u0623\u062c\u0644: 31 \u063a\u0634\u062a 2026.',
    matched_keywords: JSON.stringify(['Master', 'Translation']),
    site_name: 'ESRFT',
    url: 'https://example.ac.ma/master-translation'
  }, { now: testNow });

  assert.match(message, /Type: Master/);
  assert.match(message, /Deadline: 31 August 2026/);
});

test('uses the end of a French application range when the year is written once', () => {
  const message = formatWhatsAppOpportunityMessage({
    title: 'Master Applied Linguistics FLSH Agadir 2026-2027',
    snippet: 'Appel a candidature du 10 aout au 10 septembre 2026.',
    matched_keywords: JSON.stringify(['Master', 'Linguistics']),
    site_name: 'FLSH Agadir',
    url: 'https://example.ac.ma/master-applied-linguistics'
  }, { now: testNow });

  assert.match(message, /Status: Open/);
  assert.match(message, /Deadline: 10 September 2026/);
  assert.match(message, /Time remaining: 29 days remaining/);
});

test('groups multiple matches into a deadline-sorted digest', () => {
  const opportunities = [
    {
      id: 1,
      title: 'Master English Studies without confirmed deadline 2026-2027',
      snippet: 'Applications are open.',
      matched_keywords: JSON.stringify(['Master', 'English Studies']),
      site_name: 'University C',
      url: 'https://c.example.ac.ma/master'
    },
    {
      id: 2,
      title: 'Master Translation 2026-2027',
      snippet: 'Applications are open. Date limite: 31/08/2026.',
      matched_keywords: JSON.stringify(['Master', 'Translation']),
      site_name: 'University B',
      url: 'https://b.example.ac.ma/master'
    },
    {
      id: 3,
      title: 'Master Applied Linguistics 2026-2027',
      snippet: 'Applications are open. Deadline: 15/08/2026.',
      matched_keywords: JSON.stringify(['Master', 'Linguistics']),
      site_name: 'University A',
      url: 'https://a.example.ac.ma/master'
    }
  ];

  const batches = buildWhatsAppDigestBatches(opportunities, { now: testNow });
  const message = batches.map(({ text }) => text).join('\n');

  assert.equal(batches.flatMap(({ opportunities: items }) => items).length, 3);
  assert.match(message, /\*3 new matches\*/);
  assert.ok(message.indexOf('Master Applied Linguistics') < message.indexOf('Master Translation'));
  assert.ok(message.indexOf('Master Translation') < message.indexOf('without confirmed deadline'));
  assert.match(message, /Time: 3 days remaining/);
});

test('splits a large digest without losing opportunity tracking', () => {
  const opportunities = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    title: `Master English Studies Programme ${index + 1} 2026-2027`,
    snippet: `Applications are open. Date limite: ${20 + (index % 9)}/08/2026.`,
    matched_keywords: JSON.stringify(['Master', 'English Studies']),
    site_name: `Moroccan University ${index + 1}`,
    url: `https://university-${index + 1}.example.ac.ma/master-english-studies`
  }));

  const batches = buildWhatsAppDigestBatches(opportunities, { now: testNow });
  const trackedIds = batches.flatMap(({ opportunities: items }) => items.map(({ id }) => id));

  assert.ok(batches.length > 1);
  assert.ok(batches.every(({ text }) => text.length <= 4000));
  assert.deepEqual([...trackedIds].sort((a, b) => a - b), opportunities.map(({ id }) => id));
});
