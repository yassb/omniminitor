import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBloggerFeedOpportunities,
  extractOfficialSourceUrl,
  extractOpportunities,
  extractSyndicationEntries,
  scoreDiscoveryLink
} from '../src/scraper.js';

const site = {
  id: 7,
  name: 'Test University',
  url: 'https://faculty.example.ac.ma/'
};

test('extracts a valid opportunity card and ignores a results card', () => {
  const html = `
    <html><head><title>Admissions</title></head><body><main>
      <article>
        <h2><a href="/news/applied-linguistics-2026">Master Applied Linguistics 2026-2027</a></h2>
        <p>Call for applications is open. Deadline 31 August 2026.</p>
      </article>
      <article>
        <h2><a href="/results/english-2026">Results Master English Studies 2026-2027</a></h2>
        <p>List of admitted candidates after the application process.</p>
      </article>
    </main></body></html>`;

  const opportunities = extractOpportunities(html, site);
  assert.equal(opportunities.length, 1);
  assert.match(opportunities[0].title, /Applied Linguistics/i);
  assert.equal(opportunities[0].url, 'https://faculty.example.ac.ma/news/applied-linguistics-2026');
});

test('prioritizes a current subject-specific call above generic navigation', () => {
  const current = scoreDiscoveryLink({
    url: 'https://faculty.example.ac.ma/news/master-english-2026',
    text: 'Candidature Master English Studies 2026-2027',
    context: 'Applications are open'
  }, site.url);
  const news = scoreDiscoveryLink({
    url: 'https://faculty.example.ac.ma/news',
    text: 'News',
    context: ''
  }, site.url);
  const old = scoreDiscoveryLink({
    url: 'https://faculty.example.ac.ma/master-2025',
    text: 'Master English Studies 2025-2026',
    context: 'Candidature'
  }, site.url);

  assert.ok(current > news);
  assert.ok(news >= 7);
  assert.ok(old < 0);
});

test('rejects result links and links outside the university organization', () => {
  assert.ok(scoreDiscoveryLink({
    url: 'https://faculty.example.ac.ma/results/master-english',
    text: 'Liste des admis Master English 2026-2027',
    context: ''
  }, site.url) < 0);
  assert.ok(scoreDiscoveryLink({
    url: 'https://unrelated.example.com/master',
    text: 'Master English 2026-2027',
    context: 'Call for applications'
  }, site.url) < 0);
});

test('reads full Blogger JSON feed entries supplied by aggregator sites', () => {
  const feed = {
    feed: {
      entry: [{
        title: { $t: 'Master FLSH 2026-2027' },
        published: { $t: '2026-07-25T08:00:00Z' },
        link: [{ rel: 'alternate', href: 'https://www.almaster-maroc.com/2026/07/master-flsh.html' }],
        content: {
          $t: '<p>Call for applications: Master Applied Linguistics. Deadline 31/08/2026.</p><a href="https://fse.um5.ac.ma/candidature/master">Official application</a>'
        }
      }]
    }
  };
  const aggregatorSite = { id: 8, name: 'AlMaster', url: 'https://www.almaster-maroc.com/' };
  const opportunities = extractBloggerFeedOpportunities(feed, aggregatorSite);

  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].url, 'https://www.almaster-maroc.com/2026/07/master-flsh.html');
  assert.match(opportunities[0].snippet, /Applied Linguistics/i);
  assert.match(opportunities[0].snippet, /Official source: https:\/\/fse\.um5\.ac\.ma\/candidature\/master/i);
});

test('prefers an official university application link from an aggregator article', () => {
  const officialUrl = extractOfficialSourceUrl(`
    <a href="https://www.facebook.com/example">Facebook</a>
    <a href="https://www.almaster-maroc.com/archive">Archive</a>
    <a href="https://ens.um5.ac.ma/preinscription-master">Pre-inscription officielle</a>
  `, 'https://www.almaster-maroc.com/2026/08/master.html');

  assert.equal(officialUrl, 'https://ens.um5.ac.ma/preinscription-master');
});

test('does not accept a Blogger article just because its entrance test includes English', () => {
  const feed = {
    feed: {
      entry: [{
        title: { $t: 'Licence Textile 2026-2027' },
        published: { $t: '2026-07-25T08:00:00Z' },
        link: [{ rel: 'alternate', href: 'https://www.licence-professionnelle-maroc.com/2026/07/textile.html' }],
        content: {
          $t: '<p>Licence professionnelle textile. Candidature avant le 31/08/2026. The entrance test includes English.</p>'
        }
      }]
    }
  };
  const aggregatorSite = {
    id: 9,
    name: 'Licence Pro Maroc',
    url: 'https://www.licence-professionnelle-maroc.com/'
  };
  assert.deepEqual(extractBloggerFeedOpportunities(feed, aggregatorSite), []);
});

test('parses RSS and Atom-style entry fields', () => {
  const entries = extractSyndicationEntries(`
    <?xml version="1.0"?>
    <rss><channel><item>
      <title>Master English Studies 2026-2027</title>
      <link>https://faculty.example.ac.ma/master-english</link>
      <description><![CDATA[Call for applications. Deadline 31/08/2026.]]></description>
      <pubDate>Sat, 01 Aug 2026 08:00:00 GMT</pubDate>
    </item></channel></rss>
  `, site.url);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://faculty.example.ac.ma/master-english');
  assert.match(entries[0].content, /Call for applications/);
});
