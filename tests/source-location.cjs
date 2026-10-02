const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
function load(file, modules = {}) {
    const exports = {};
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
    } }).outputText;
    vm.runInNewContext(code, { exports, require: name => modules[name] });
    return exports;
}
const markdown = load('src/utils/markdown.ts');
const { findSourceLines } = load('src/utils/source-location.ts', { './markdown': markdown });
const raw = '---\ntitle: sample\n---\n\n# Heading\n\n- **Docker** uses [[containers|containers]].\nSee [the guide](https://example.com).\n\nOther text.';
const found = findSourceLines(raw, 'Docker uses containers.\nSee the guide.');
assert.equal(found.start, 6);
assert.equal(found.end, 7);
assert.equal(findSourceLines('same passage\n\nsame passage', 'same passage'), null);
assert.equal(findSourceLines(raw, 'deleted content'), null);
assert.equal(findSourceLines(raw, 'title: sample'), null);
console.log('source mapping: multiline, formatting, frontmatter, duplicates and changed text passed');
