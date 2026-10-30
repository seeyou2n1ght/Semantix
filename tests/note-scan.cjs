const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/core/note-scan.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
} }).outputText;
const exported = {};
vm.runInNewContext(code, { exports: exported });

const text = '# Opening\n\n' + 'A'.repeat(700) + '\n\n# Ending\n\nquantum tail';
const queries = exported.splitNoteQueries(text);
assert(queries.length > 2);
assert(queries.every(query => query.length <= 240));
assert(queries.some(query => query.includes('quantum tail')));
assert.equal(exported.splitNoteQueries(('Repeated paragraph. '.repeat(8) + '\n\n').repeat(20)).length, 1);

const card = (path, score) => ({ id: path, path, score });
const merged = exported.mergeNoteResults([
    { related: [card('a.md', 0.4)], discover: [card('b.md', 0.7)] },
    { related: [card('a.md', 0.8), card('b.md', 0.6)], discover: [card('c.md', 0.5)] }
], 2);
assert.deepEqual(Array.from(merged.related, item => item.path), ['a.md', 'b.md']);
assert.deepEqual(Array.from(merged.discover, item => item.path), ['c.md']);
assert.equal(merged.related[0].score, 0.8);

// Stream identity regression: a path present in Related must NOT be reclassified as Discover
// merely because the final Related limit cuts it.
const streamIdentityMerge = exported.mergeNoteResults([
    {
        related: [card('a.md', 0.9), card('b.md', 0.8), card('c.md', 0.7)],
        discover: [card('d.md', 0.6)]
    },
    {
        related: [card('e.md', 0.95), card('f.md', 0.85)],
        discover: [card('c.md', 0.65), card('h.md', 0.5)]
    }
], 3);
assert.deepEqual(Array.from(streamIdentityMerge.related, item => item.path), ['e.md', 'a.md', 'f.md']);
// c.md was cut from Related, but must NEVER spill into Discover!
assert(!streamIdentityMerge.discover.some(item => item.path === 'c.md'), 'c.md should not be reclassified as discover');
assert.deepEqual(Array.from(streamIdentityMerge.discover, item => item.path), ['d.md', 'h.md']);

console.log('note scan coverage and merge passed');
module.exports = exported;
