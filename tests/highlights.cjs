const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
    } }).outputText;
    const exported = {};
    vm.runInNewContext(code, { exports: exported, require: name => modules[name] || {}, console });
    return exported;
}

const { RadarView } = load('src/ui/radar-view.ts', { obsidian: { ItemView: class {} } });
const view = Object.create(RadarView.prototype);
function render(text, terms) {
    const marks = [];
    let output = '';
    const paragraph = {
        setText: value => { output = value; },
        appendText: value => { output += value; },
        createEl: (_, { text }) => { marks.push(text); output += text; }
    };
    view.renderHighlightedSnippet({ createEl: () => paragraph }, text, terms);
    assert.equal(output, text, 'rendering must preserve the original snippet');
    return marks;
}
assert.deepEqual(render('partial ART artful art', ['art']), ['ART', 'art']);
assert.deepEqual(render('知识图谱与知识', ['知识', '知识图谱']), ['知识图谱', '知识']);
assert.deepEqual(render('a+b and aab', ['a+b']), ['a+b']);
assert.deepEqual(render('因为所以 API', []), []);
assert.deepEqual(render('API知识图谱', ['api', '知识', '图谱']), ['API', '知识', '图谱']);
assert.deepEqual(render('a', ['a', '']), []);

const { ResultStabilizer } = load('src/core/result-stabilizer.ts');
const stabilizer = new ResultStabilizer();
const card = { id: 'a', path: 'a.md', labels: [], score: 0.9, matched_terms: ['old'] };
stabilizer.stabilize([card], [], 'NEW_FILE');
let result = stabilizer.stabilize([], [], 'SAME_PARAGRAPH');
assert.equal(result.related.length, 0, 'obsolete cards must disappear without waiting for another response');
result = stabilizer.stabilize([{ ...card, matched_terms: ['new'] }], [], 'SAME_PARAGRAPH');
assert.equal(result.related[0].matched_terms[0], 'new');
result = stabilizer.stabilize([{ ...card, labels: ['DEEP_SEMANTIC'] }], [card], 'SAME_PARAGRAPH');
assert.equal(result.related[0].labels[0], 'DEEP_SEMANTIC');
assert.equal(result.discover.length, 0, 'both channels must remain exclusive');

const { mergeNoteResults } = load('src/core/note-scan.ts');
const merged = mergeNoteResults([
    { related: [card], discover: [] },
    { related: [{ ...card, score: 1, matched_terms: ['winning'] }], discover: [] }
], 4);
assert.equal(merged.related[0].matched_terms[0], 'winning');
console.log('snippet highlighting, retained evidence and scan merge passed');
