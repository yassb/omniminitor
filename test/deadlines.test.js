import test from 'node:test';
import assert from 'node:assert/strict';
import { extractConfirmedDeadline, findConfirmedDeadline } from '../src/deadlines.js';

test('uses the end of a numeric application range', () => {
  const result = findConfirmedDeadline(
    'Master Applied Linguistics and English Teaching. Preinscription en ligne du 01/08/2026 au 08/09/2026.'
  );

  assert.equal(result?.date.getFullYear(), 2026);
  assert.equal(result?.date.getMonth(), 8);
  assert.equal(result?.date.getDate(), 8);
  assert.equal(result?.evidence, 'application range');
});

test('associates a deadline with the English programme instead of a later unrelated programme', () => {
  const result = extractConfirmedDeadline(`
    Master Applied Linguistics & Foreign Language Teaching.
    Preinscription en ligne du 01/08/2026 au 08/09/2026.
    Master Cooperacion Sur Sur Marruecos America Latina.
    Preinscription en ligne du 07/08/2026 au 10/09/2026.
  `);

  assert.equal(result?.getFullYear(), 2026);
  assert.equal(result?.getMonth(), 8);
  assert.equal(result?.getDate(), 8);
});

test('supports a French word-date range with a shared year', () => {
  const result = extractConfirmedDeadline(
    'Candidature au Master English Studies du 10 aout au 10 septembre 2026.'
  );

  assert.equal(result?.getFullYear(), 2026);
  assert.equal(result?.getMonth(), 8);
  assert.equal(result?.getDate(), 10);
});

test('does not guess from an unlabelled publication date', () => {
  const result = extractConfirmedDeadline(
    'Master English Studies. Announcement published 05/08/2026. Read the official page for details.'
  );

  assert.equal(result, null);
});

test('chooses the closing date and rejects the nearby opening date', () => {
  const result = extractConfirmedDeadline(
    "Master English Studies | Date d'ouverture: 19-06-2026 | Date de fermeture de candidature en ligne: 11-07-2026"
  );

  assert.equal(result?.getFullYear(), 2026);
  assert.equal(result?.getMonth(), 6);
  assert.equal(result?.getDate(), 11);
});

test('does not treat a range start as the deadline when the closing date is missing', () => {
  const result = extractConfirmedDeadline(
    'Master English Studies. Preinscription en ligne du 20/07/2026 au --/--/2026.'
  );

  assert.equal(result, null);
});

test('rejects a debut inscription date in favour of fin inscription', () => {
  const result = extractConfirmedDeadline(
    "Master Translation. Debut d'inscription : 26-06-2026 Fin d'inscription : 20-08-2026"
  );

  assert.equal(result?.getFullYear(), 2026);
  assert.equal(result?.getMonth(), 7);
  assert.equal(result?.getDate(), 20);
});
