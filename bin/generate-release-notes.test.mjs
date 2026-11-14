import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractFromChangelog,
  cleanSubject,
  extractUsername,
  extractContributors,
  formatReleaseNotes,
} = require('./generate-release-notes.js');

describe('generate-release-notes', () => {
  it('extracts release section from CHANGELOG.md for a given tag', () => {
    const changelog = `
# Changelog

## [v0.3.6] - 2026-08-28

This release adds new features.

### Highlights
- Feature 1
- Feature 2

---

## [v0.3.5] - 2026-08-21

Older release notes.
`;

    const section = extractFromChangelog(changelog, 'v0.3.6');
    assert.ok(section);
    assert.match(section, /This release adds new features/);
    assert.match(section, /Feature 1/);
    assert.doesNotMatch(section, /Older release notes/);
  });

  it('cleans commit subjects and transforms PR links', () => {
    const raw = 'feat(composer): expand queued prompts (#12)';
    const cleaned = cleanSubject(raw, 'ompweb-dev/ompweb');
    assert.equal(
      cleaned,
      'Expand queued prompts ([#12](https://github.com/ompweb-dev/ompweb/pull/12))'
    );
  });

  it('extracts username from GitHub noreply emails', () => {
    assert.equal(
      extractUsername('yyxxd', '62706229+2740653660@users.noreply.github.com'),
      '2740653660'
    );
    assert.equal(
      extractUsername('flaribbit', 'flaribbit@users.noreply.github.com'),
      'flaribbit'
    );
  });

  it('extracts and filters contributors excluding owner and bots', () => {
    const commits = [
      {
        author: { name: 'Khaled Ahmed', email: '61059522+kahme247@users.noreply.github.com' },
        coAuthors: [],
      },
      {
        author: { name: 'yyxxd', email: '62706229+2740653660@users.noreply.github.com' },
        coAuthors: [{ name: 'opencode', email: '' }],
      },
      {
        author: { name: 'Grigory Zaripov', email: 'gzarip@users.noreply.github.com' },
        coAuthors: [],
      },
    ];

    const contributors = extractContributors(commits);
    assert.deepEqual(contributors, ['@2740653660', '@gzarip']);
  });

  it('formats release notes from git commits when changelog section is missing', () => {
    const commits = [
      {
        subject: 'feat(ui): add super cool dark mode',
        author: { name: 'Alice', email: 'alice@users.noreply.github.com' },
        coAuthors: [],
      },
      {
        subject: 'fix: resolve race condition in SSE',
        author: { name: 'Bob', email: 'bob@users.noreply.github.com' },
        coAuthors: [],
      },
    ];

    const notes = formatReleaseNotes({
      tag: 'v0.4.0',
      version: '0.4.0',
      commits,
      previousTag: 'v0.3.6',
      repo: 'ompweb-dev/ompweb',
    });

    assert.match(notes, /## Highlights/);
    assert.match(notes, /Add super cool dark mode/);
    assert.match(notes, /## Fixes & Improvements/);
    assert.match(notes, /Resolve race condition in SSE/);
    assert.match(notes, /## Contributors/);
    assert.match(notes, /@alice/);
    assert.match(notes, /@bob/);
    assert.match(notes, /npm install -g @kahme247\/ompweb@0\.4\.0/);
  });
});
