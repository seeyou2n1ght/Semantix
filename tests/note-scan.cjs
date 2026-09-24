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

const card = (path, score) => ({ id: path, path, score });
const merged = exported.mergeNoteResults([
    { related: [card('a.md', 0.4)], discover: [card('b.md', 0.7)] },
    { related: [card('a.md', 0.8), card('b.md', 0.6)], discover: [card('c.md', 0.5)] }
], 2);
assert.deepEqual(Array.from(merged.related, item => item.path), ['a.md', 'b.md']);
assert.deepEqual(Array.from(merged.discover, item => item.path), ['c.md']);
assert.equal(merged.related[0].score, 0.8);
console.log('note scan coverage and merge passed');
module.exports = exported;
