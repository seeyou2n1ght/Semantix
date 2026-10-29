const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
    } }).outputText;
    const exported = {};
    vm.runInNewContext(code, { exports: exported, require: name => modules[name] || {}, ...globals });
    return exported;
}

class Element {
    constructor(options = {}) {
        this.attributes = { ...options.attr };
        this.text = options.text || '';
        this.cls = options.cls || '';
        this.children = [];
        this.listeners = {};
        this.style = { setProperty() {} };
    }
    createDiv(options) { return this.add(new Element(options)); }
    createSpan(options) { return this.add(new Element(options)); }
    createEl(_tag, options) { return this.add(new Element(options)); }
    add(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    empty() { this.children = []; }
    removeClass() {}
    addClass() {}
    getBoundingClientRect() { return { left: 500, right: 700, top: 20 }; }
    find(cls) {
        if (this.cls === cls) return this;
        for (const child of this.children) {
            const found = child.find(cls);
            if (found) return found;
        }
        return null;
    }
}

const en = load('src/i18n/locales/en.ts').default;
const zh = load('src/i18n/locales/zh-cn.ts').default;
for (const locale of [en, zh]) {
    assert.match(locale.POPOVER_CLICK_HINT, /Shift\+/);
    assert.match(locale.POPOVER_CLICK_HINT, /Mod\+/);
    assert.match(locale.POPOVER_CLICK_HINT, /🔗/);
}

const document = { body: new Element() };
const window = { innerHeight: 800 };
const modules = {
    obsidian: { ItemView: class {}, Keymap: { isModifier: () => false } },
    '../i18n/helpers': { t: key => en[key] || key }
};
const { RadarView } = load('src/ui/radar-view.ts', modules);
const view = Object.create(RadarView.prototype);
view.renderedItems = new WeakMap();
view.renderHighlightedSnippet = () => {};
view.plugin = { app: {} };
view.popoverPreview = { hide() {}, scheduleShow() {}, cancelShow() {}, scheduleHide() {} };
let opened;
view.handleJumpToNote = (_item, event) => { opened = event; };
const list = new Element();
const item = { title: 'A long note.md', path: 'Folder/A long note.md', snippet: 'snippet', score: 0.8 };
view.renderCardList(list, [item], 'Empty');
const card = list.find('semantix-radar-card');
const title = card.find('semantix-card-title');
const insertButton = card.find('semantix-card-action-btn mod-insert');
const scoreBadge = card.find('semantix-card-score mod-high');
assert.equal(card.attributes.title, undefined);
assert.equal(title.attributes.title, undefined);
assert.equal(insertButton.attributes.title, undefined);
if (scoreBadge) {
    assert.equal(scoreBadge.attributes.title, undefined);
    assert.equal(scoreBadge.attributes['aria-label'], en.SCORE_LEVEL_HIGH);
}
assert.equal(insertButton.attributes['aria-label'], en.CARD_INSERT_LINK);
assert.match(card.attributes['aria-label'], /A long note.*Folder\/A long note.md/);
assert.match(card.attributes['aria-label'], /Shift\+Click/);
card.listeners.click({ shiftKey: true });
assert.equal(opened.shiftKey, true);
card.listeners.keydown({ key: 'Enter', shiftKey: true, preventDefault() {} });
assert.equal(opened.shiftKey, true);

const { PopoverPreview } = load('src/ui/popover-preview.ts', {
    ...modules, '../utils/source-location': { findSourceLines: () => null }
}, { document, window });
const preview = new PopoverPreview();
let previewOpened;
preview.setCallbacks(() => {}, (_item, event) => { previewOpened = event; });
preview.show(card, item);
const popover = document.body.find('semantix-popover-preview is-hidden');
assert.equal(popover.find('semantix-popover-path').attributes.title, undefined);
const previewScore = popover.find('semantix-card-score mod-high semantix-popover-score-badge');
if (previewScore) assert.equal(previewScore.attributes.title, undefined);
assert.equal(popover.find('semantix-popover-footer-hint').text, en.POPOVER_CLICK_HINT);
popover.onclick({ shiftKey: true });
assert.equal(previewOpened.shiftKey, true);
console.log('card and preview hover hints passed');
