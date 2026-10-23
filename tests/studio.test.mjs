import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createStudio, editedScene, glyphPath, pointAt, trajectoryPath, number, parseDocument} from '../src/kinetyl/assets/studio.mjs';
import {compileScene, verifyPlan, normalizeScene, inspectLayout, NoSolution, SearchBudgetExceeded} from '../src/kinetyl/assets/geometry.mjs';

const IDS = ['proof-before', 'proof-compiled', 'proof-title', 'proof-status', 'proof-before-title', 'proof-after-title', 'stage', 'repaired', 'original', 'aspect', 'envelopes', 'stage-label', 'scale-label', 'play', 'time', 'time-label', 'witness', 'status-title', 'status-detail', 'metrics', 'notice', 'save-plan', 'save-scene', 'load', 'file', 'paths', 'apply', 'restore', 'restore-verified', 'edit-status'];
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.files = [];
    this.classes = new Set(); this.classList = {toggle: (key, force) => force ? this.classes.add(key) : this.classes.delete(key)};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text ?? ''; }
  set innerHTML(_value) { throw new Error('Controller must construct DOM nodes, not interpolate markup'); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  emit(type) { return Promise.all((this.listeners.get(type) ?? []).map(fn => fn({type, target: this, preventDefault() {}}))); }
  click() { return this.disabled ? Promise.resolve([]) : this.emit('click'); }
}
class FakeDocument {
  constructor() { this.elements = Object.fromEntries(IDS.map(id => [id, new FakeElement(['stage','proof-before','proof-compiled'].includes(id) ? 'svg' : 'div')])); this.body = new FakeElement('body'); this.elements.time.value = '0'; this.elements.aspect.value = 'wide'; }
  getElementById(id) { return this.elements[id]; }
  createElement(tag) { return new FakeElement(tag); }
  createElementNS(_ns, tag) { return new FakeElement(tag); }
}
function scene() {
  return {schema: 'kinetyl-scene/1', duration: 3, nodes: [0, 1].map(i => ({id: `node${i}`, text: `Label ${i}`, font_size: 28,
    color: '#ABCDEF', radius: '3/20', keyframes: [[0, i ? 2 : -2, 0], [3, i ? -2 : 2, 0]],
    envelope: {width: '11/5', height: '2/5', measurement: {engine: 'declared-controller-test', version: '1', font: 'test'},
      glyph_paths: [[['M', '-1/10', '-1/10'], ['L', '1/10', '-1/10'], ['L', '1/10', '1/10'], ['Z']]]}})),
    export: {width: 1280, height: 720, frame_rate: 24, frame_height: 8}, margin: '1/10', camera_scales: [1, '4/5', '3/5', '2/5'], min_font_size: 24};
}
function harness(overrides = {}) {
  const doc = new FakeDocument(), downloads = [], frames = new Map(), canceled = []; let nextFrame = 1;
  const dependencies = {requestAnimationFrame: fn => { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => { frames.delete(id); canceled.push(id); },
    download: (value, filename) => downloads.push({value: structuredClone(value), filename}), ...overrides};
  const studio = createStudio(doc, dependencies);
  return {doc, el: doc.elements, studio, downloads, frames, canceled,
    tick(now) { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(now); }};
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const turn = () => new Promise(resolve => setImmediate(resolve));
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

test('first-use proof shows the bundled 3.00 s collision and keeps the authored preview controls independent', async () => {
  const bundled = JSON.parse(readFileSync(new URL('../docs/plan.json', import.meta.url), 'utf8'));
  const h = harness();
  assert.equal(await h.studio.loadDocument(bundled), true);
  assert.equal(h.el['proof-title'].textContent, 'The crossing at 3.00 s');
  for (const id of ['proof-before', 'proof-compiled']) {
    const box = h.el[id].getAttribute('viewBox').split(' ').map(Number);
    for (let i = 0; i < 4; i++) assert.ok(Math.abs(box[i]-[-2.6,-2.45,5.2,2.4][i]) < 1e-12);
  }
  assert.match(h.el['proof-status'].textContent, /full-trajectory checks/);
  assert.equal(h.el.time.value, '0');
  assert.equal(h.studio.getState().mode, 'compiled');
  const paths = id => descendants(h.el[id]).filter(n => n.tagName === 'path' && n.getAttribute('fill-rule') === 'nonzero');
  assert.equal(paths('proof-before').length, 3);
  assert.equal(paths('proof-compiled').length, 3);
  assert.notDeepEqual(paths('proof-before').map(n => n.parentNode.getAttribute('transform')), paths('proof-compiled').map(n => n.parentNode.getAttribute('transform')));
  assert.deepEqual(h.studio.getState().scene.nodes.map(n => n.keyframes), bundled.scene.nodes.map(n => n.keyframes));
  h.el.paths.value += ' ';
  await h.el.paths.emit('input');
  assert.match(h.el['proof-status'].textContent, /Previous verified document/);
  assert.equal(h.el['save-plan'].disabled, true);
});

test('imported proof crop follows the projected camera point when scale is below one', async () => {
  const source = scene();
  source.camera_scales = ['2/5'];
  source.nodes.forEach(node => node.keyframes.forEach(frame => { frame[1] += 6; }));
  const plan = await compileScene(source);
  assert.equal(plan.layout.camera_scale, '2/5');
  assert.equal((await verifyPlan(plan)).valid, true);
  const h = harness();
  assert.equal(await h.studio.loadDocument(plan), true);
  const worldX = pointAt(plan.scene.nodes[0].keyframes, 1.5)[0];
  assert.equal(worldX, 6);
  for (const id of ['proof-before', 'proof-compiled']) {
    const [left, , width] = h.el[id].getAttribute('viewBox').split(' ').map(Number);
    assert.equal(left + width / 2, worldX * number(plan.layout.camera_scale));
    assert.ok(left <= worldX * number(plan.layout.camera_scale) && worldX * number(plan.layout.camera_scale) <= left + width);
  }
});

test('imported marker overlap uses neutral proof copy instead of claiming two labels collided', async () => {
  const source = scene();
  source.nodes[0].keyframes = [[0, 0, 0], [3, 0, 0]];
  source.nodes[1].keyframes = [[0, 1, '9/20'], [3, 1, '9/20']];
  const plan = await compileScene(source);
  assert.equal((await verifyPlan(plan)).valid, true);
  assert.equal(inspectLayout(plan.scene).collisions[0].kind, 'label-dot');
  const h = harness();
  assert.equal(await h.studio.loadDocument(plan), true);
  assert.equal(h.el['proof-title'].textContent, 'The first overlap at 1.50 s');
  assert.equal(h.el['proof-before-title'].textContent, 'Placement overlaps');
  assert.equal(h.el['proof-after-title'].textContent, 'Placement clears');
});

test('verified wide imported labels remain visible in the compiled proof crop', async () => {
  const source = scene();
  source.camera_scales = [1];
  source.nodes.forEach(node => {
    node.keyframes = [[0, 0, '7/2'], [3, 0, '7/2']];
    node.envelope.width = '6';
  });
  const plan = await compileScene(source);
  assert.equal((await verifyPlan(plan)).valid, true);
  assert.deepEqual(plan.layout.offsets.map(row => row.x), ['13/4', '-13/4']);
  const h = harness();
  assert.equal(await h.studio.loadDocument(plan), true);
  const [x0, y0, width, height] = h.el['proof-compiled'].getAttribute('viewBox').split(' ').map(Number);
  for (let i = 0; i < plan.scene.nodes.length; i++) {
    const node = plan.scene.nodes[i], center = pointAt(node.keyframes, 1.5);
    const x = center[0]*number(plan.layout.camera_scale)+number(plan.layout.offsets[i].x);
    const y = center[1]*number(plan.layout.camera_scale)+number(plan.layout.offsets[i].y);
    const hx = number(node.envelope.width)/2, hy = number(node.envelope.height)/2;
    assert.ok(x-hx >= x0 && x+hx <= x0+width, `${node.id} label fits proof width`);
    assert.ok(y-hy >= -(y0+height) && y+hy <= -y0, `${node.id} label fits proof height`);
    assert.ok(center[0] >= x0 && center[0] <= x0+width, `${node.id} marker fits proof width`);
  }
  assert.match(h.el['proof-status'].textContent, /outside the declared canvas/);
});

test('bundled plan is independently checked before controls enable or downloads emit', async () => {
  const plan = await compileScene(scene()), verificationGate = deferred(), verified = [];
  const h = harness({fetch: async name => { assert.equal(name, 'plan.json'); return {ok: true, text: async () => JSON.stringify(plan)}; },
    verifyPlan: async p => { verified.push(structuredClone(p)); await verificationGate.promise; return verifyPlan(p); }});
  const loading = h.studio.start(); await turn();
  assert.equal(h.studio.getState().plan, null); assert.equal(h.el['save-plan'].disabled, true);
  verificationGate.resolve(); assert.equal(await loading, true);
  assert.equal(verified.length, 1); assert.equal(h.studio.getState().dirty, false);
  assert.equal(h.el['save-plan'].disabled, false); assert.equal(h.el['save-scene'].disabled, false);
  assert.equal(h.el['status-title'].textContent, 'Full trajectory checked');
  assert.match(h.el['status-detail'].textContent, /(?:3\/2|1\.500) s/); assert.equal(h.el.metrics.children.length, 10);
  await h.el['save-plan'].click(); await h.el['save-scene'].click();
  assert.deepEqual(h.downloads.map(d => d.filename), ['kinetyl-plan.json', 'kinetyl-scene.json']);
  assert.equal((await verifyPlan(h.downloads[0].value)).valid, true);
  assert.deepEqual(h.downloads[1].value, plan.scene);
});
test('dirty editor disables both downloads, labels prior preview, and successful compilation resumes', async () => {
  const h = harness(); await h.studio.loadDocument(scene()); const before = h.studio.getState();
  const rows = JSON.parse(h.el.paths.value); rows[0].keyframes[0][1] = '-3/2';
  h.el.paths.value = JSON.stringify(rows); await h.el.paths.emit('input');
  assert.equal(h.studio.getState().dirty, true); assert.equal(h.el['save-plan'].disabled, true); assert.equal(h.el['save-scene'].disabled, true);
  assert.match(h.el['stage-label'].textContent, /Previous document/); assert.deepEqual(h.studio.getState().scene, before.scene);
  // Force dispatch despite disabled controls to verify the save guard itself.
  await h.el['save-plan'].emit('click'); await h.el['save-scene'].emit('click'); assert.equal(h.downloads.length, 0);
  await h.el.apply.click(); assert.equal(h.studio.getState().dirty, false);
  assert.equal(h.studio.getState().scene.nodes[0].keyframes[0][1], '-3/2');
  assert.equal(h.el['save-plan'].disabled, false); assert.equal(h.el['save-scene'].disabled, false);
  assert.deepEqual(h.studio.getState().scene.nodes[0].envelope, before.scene.nodes[0].envelope);
});
test('failed edited parsing preserves recoverable prior scene and cannot export stale result', async () => {
  const h = harness(); await h.studio.loadDocument(scene()); const prior = h.studio.getState();
  h.el.paths.value = '[broken'; await h.el.paths.emit('input'); await h.el.apply.click();
  assert.equal(h.studio.getState().dirty, true); assert.deepEqual(h.studio.getState().scene, prior.scene); assert.deepEqual(h.studio.getState().plan, prior.plan);
  assert.match(h.el['status-detail'].textContent, /Edited paths were refused/);
  await h.el['save-plan'].emit('click'); assert.equal(h.downloads.length, 0);
  await h.el.restore.click(); assert.equal(h.studio.getState().dirty, false);
  assert.deepEqual(h.studio.getState().scene, prior.scene); assert.equal(h.el['save-plan'].disabled, false);
});
test('candidate-family failure is explicit, retains previous document, and restoration recompiles', async () => {
  const calls = [], h = harness({compileScene: async next => { calls.push(structuredClone(next)); return compileScene(next); }});
  await h.studio.loadDocument(scene()); const prior = h.studio.getState();
  const impossible = scene(); impossible.export.width = 540; impossible.export.height = 960;
  impossible.nodes[0].envelope.width = '8';
  assert.equal(await h.studio.compile(impossible), false);
  assert.equal(h.el['status-title'].textContent, 'No layout in this family'); assert.match(h.el['status-detail'].textContent, /candidate family/);
  assert.equal(h.studio.getState().dirty, true); assert.deepEqual(h.studio.getState().plan, prior.plan);
  assert.match(h.el.notice.textContent, /Previous document retained/); await h.el['save-scene'].emit('click'); assert.equal(h.downloads.length, 0);
  await h.el.restore.click(); assert.equal(calls.length, 3); assert.deepEqual(calls[2], prior.scene); assert.equal(h.studio.getState().dirty, false);
});
test('budget exhaustion displays inconclusive outcome rather than infeasibility', async () => {
  let fail = false;
  const h = harness({compileScene: next => fail ? Promise.reject(new SearchBudgetExceeded('Exact work exhausted')) : compileScene(next)});
  await h.studio.loadDocument(scene()); fail = true; await h.el.apply.click();
  assert.equal(h.el['status-title'].textContent, 'Search is inconclusive'); assert.equal(h.el['status-detail'].textContent, 'Exact work exhausted');
  assert.equal(h.studio.getState().dirty, true); assert.equal(h.el['save-plan'].disabled, true); assert.equal(h.el['save-scene'].disabled, true);
});
test('malformed scene/plan/file import preserves prior document and restore identity', async () => {
  const h = harness(); await h.studio.loadDocument(scene()); const prior = h.studio.getState();
  const invalid = structuredClone(prior.plan); invalid.layout.projected_tracks[0].keyframes[0][1] = '0';
  assert.equal(await h.studio.loadDocument(invalid), false); assert.equal(h.el['status-title'].textContent, 'Import refused');
  assert.deepEqual(h.studio.getState().scene, prior.scene); assert.equal(h.el['save-plan'].disabled, true);
  assert.equal(await h.studio.loadDocument({schema: 'kinetyl-scene/1'}), false); assert.deepEqual(h.studio.getState().plan, prior.plan);
  h.el.file.files = [{size: 3, text: async () => '{x'}]; h.el.file.value = 'malformed.json';
  await h.el.file.emit('change'); assert.equal(h.el.file.value, ''); assert.equal(h.el['status-title'].textContent, 'Import refused');
  assert.deepEqual(h.studio.getState().scene, prior.scene);
  await h.el.restore.click(); assert.deepEqual(h.studio.getState().scene, prior.scene); assert.equal(h.studio.getState().dirty, false);
});
test('aspect change recompiles with same trajectories, event times, measured glyphs and typography', async () => {
  const calls = [], h = harness({compileScene: async next => { calls.push(structuredClone(next)); return compileScene(next); }});
  await h.studio.loadDocument(scene()); const prior = h.studio.getState();
  h.el.aspect.value = 'portrait'; await h.el.aspect.emit('change'); const portrait = h.studio.getState();
  assert.equal(calls.length, 2); assert.equal(portrait.scene.export.width, 540); assert.equal(portrait.scene.export.height, 960);
  assert.deepEqual(portrait.scene.nodes, prior.scene.nodes); assert.equal(portrait.scene.duration, prior.scene.duration);
  assert.equal(portrait.plan.layout.camera_scale, '2/5'); assert.equal(portrait.dirty, false); assert.ok(h.el.stage.classes.has('portrait'));
  assert.equal((await verifyPlan(portrait.plan)).valid, true);
  h.el.aspect.value = 'square'; await h.el.aspect.emit('change'); const square = h.studio.getState();
  assert.equal(square.scene.export.width, 720); assert.equal(square.scene.export.height, 720); assert.deepEqual(square.scene.nodes, prior.scene.nodes);
  assert.ok(h.el.stage.classes.has('square')); assert.ok(!h.el.stage.classes.has('portrait'));
});
test('timeline, before/compiled toggles, witness jump, bounds and playback update preview state', async () => {
  const h = harness(); await h.studio.loadDocument(scene());
  await h.el.witness.click(); assert.equal(h.el.time.value, '1.5'); assert.equal(h.studio.getState().mode, 'before');
  assert.equal(h.el.original.getAttribute('aria-pressed'), 'true'); assert.equal(h.el.repaired.getAttribute('aria-pressed'), 'false');
  assert.equal(h.el['time-label'].textContent, '1.50 s'); assert.match(h.el['stage-label'].textContent, /Before/);
  await h.el.repaired.click(); assert.equal(h.studio.getState().mode, 'compiled'); assert.equal(h.el.repaired.getAttribute('aria-pressed'), 'true');
  const outlinesBefore = descendants(h.el.stage).filter(n => n.tagName === 'rect').length;
  h.el.envelopes.checked = true; await h.el.envelopes.emit('change');
  assert.ok(descendants(h.el.stage).filter(n => n.tagName === 'rect').length > outlinesBefore);
  h.el.time.value = '0'; await h.el.time.emit('input'); await h.el.play.click(); assert.equal(h.frames.size, 1);
  assert.equal(h.el.play.getAttribute('aria-label'), 'Pause animation'); h.tick(1000); h.tick(1500);
  assert.equal(h.el['time-label'].textContent, '0.50 s');
  h.el.time.value = '2.25'; await h.el.time.emit('input'); assert.equal(h.frames.size, 0); assert.equal(h.el['time-label'].textContent, '2.25 s');
  assert.equal(h.el.play.getAttribute('aria-label'), 'Play animation'); assert.ok(h.canceled.length);
});
test('older asynchronous compilation success or failure cannot replace newer document', async () => {
  const gates = [];
  const h = harness({compileScene: next => { const gate = deferred(); gates.push({gate, next: structuredClone(next)}); return gate.promise; }});
  const oldSource = scene(), newSource = scene(); newSource.nodes[0].text = 'Newest';
  const oldLoad = h.studio.loadDocument(oldSource); const newLoad = h.studio.loadDocument(newSource);
  gates[1].gate.resolve(await compileScene(gates[1].next)); assert.equal(await newLoad, true);
  const accepted = h.studio.getState(); gates[0].gate.resolve(await compileScene(gates[0].next)); assert.equal(await oldLoad, false);
  assert.deepEqual(h.studio.getState(), accepted); assert.equal(h.studio.getState().scene.nodes[0].text, 'Newest');
  const staleFailure = h.studio.compile(oldSource), latest = h.studio.compile(newSource);
  gates[3].gate.resolve(await compileScene(gates[3].next)); assert.equal(await latest, true);
  const status = h.el['status-title'].textContent; gates[2].gate.reject(new NoSolution('Old request failed')); assert.equal(await staleFailure, false);
  assert.equal(h.el['status-title'].textContent, status); assert.equal(h.studio.getState().dirty, false);
});
test('editing while verification is pending invalidates its result and downloads stay paused', async () => {
  const gate = deferred(); let delay = false;
  const h = harness({verifyPlan: async plan => { if (delay) await gate.promise; return verifyPlan(plan); }});
  await h.studio.loadDocument(scene()); const prior = h.studio.getState(); delay = true;
  const pending = h.studio.compile(scene()); await turn();
  h.el.paths.value += ' '; await h.el.paths.emit('input'); gate.resolve(); assert.equal(await pending, false);
  assert.deepEqual(h.studio.getState().scene, prior.scene); assert.equal(h.studio.getState().dirty, true); assert.equal(h.el['save-plan'].disabled, true);
});
test('slow file read and bundled fetch cannot overwrite a newer import', async () => {
  const fileGate = deferred(), fetchGate = deferred();
  const h = harness({fetch: async () => { await fetchGate.promise; return {ok: true, text: async () => JSON.stringify(await compileScene(scene()))}; }});
  await h.studio.loadDocument(scene());
  h.el.file.files = [{size: 2000, text: () => fileGate.promise}]; const oldFile = h.el.file.emit('change');
  const newest = scene(); newest.nodes[0].text = 'Current import'; await h.studio.loadDocument(newest);
  fileGate.resolve(JSON.stringify(scene())); await oldFile; assert.equal(h.studio.getState().scene.nodes[0].text, 'Current import');
  const oldStart = h.studio.start(); const newer = scene(); newer.nodes[0].text = 'Later than fetch'; await h.studio.loadDocument(newer);
  fetchGate.resolve(); assert.equal(await oldStart, false); assert.equal(h.studio.getState().scene.nodes[0].text, 'Later than fetch');
});
test('file import enforces announced and actual byte limits before replacing prior document', async () => {
  const h = harness(); await h.studio.loadDocument(scene()); const prior = h.studio.getState(); let read = false;
  h.el.file.files = [{size: 4194305, text: async () => { read = true; return '{}'; }}]; await h.el.file.emit('change');
  assert.equal(read, false); assert.match(h.el['status-detail'].textContent, /4 MiB/); assert.deepEqual(h.studio.getState().scene, prior.scene);
  h.el.file.files = [{size: 1, text: async () => '🧭'.repeat(1048577)}]; await h.el.file.emit('change');
  assert.match(h.el['status-detail'].textContent, /4 MiB/); assert.deepEqual(h.studio.getState().plan, prior.plan);
});
test('editing allows only trajectories and preserves geometry; preview uses data-built SVG paths', async () => {
  const source = normalizeScene(scene()), rows = source.nodes.map(n => ({id: n.id, keyframes: n.keyframes}));
  assert.deepEqual(editedScene(source, JSON.stringify(rows)), source);
  for (const bad of [[...rows].reverse(), [], [{...rows[0], color: '#FFFFFF'}, rows[1]], [{...rows[0], id: 'other'}, rows[1]]]) assert.throws(() => editedScene(source, JSON.stringify(bad)));
  assert.throws(() => editedScene(source, ' '.repeat(262145)), /256 KiB/);
  assert.deepEqual(pointAt([['0', '-2', '0'], ['3', '2', '0']], 1.5), [0, 0]);
  assert.equal(glyphPath(source.nodes[0].envelope.glyph_paths), 'M-0.1 -0.1 L0.1 -0.1 L0.1 0.1 Z');
  const h = harness(); await h.studio.loadDocument(source);
  const paths = descendants(h.el.stage).filter(n => n.tagName === 'path' && n.getAttribute('fill-rule') === 'nonzero'); assert.equal(paths.length, 2);
  assert.ok(paths.every(p => p.getAttribute('d') === glyphPath(source.nodes[0].envelope.glyph_paths) && p.getAttribute('fill-rule') === 'nonzero'));
  const fallback = scene(); fallback.nodes[0].envelope.glyph_paths = []; fallback.nodes[0].text = '<img src=x onerror=alert(1)>';
  await h.studio.loadDocument(fallback); assert.equal(h.el.notice.hidden, false); assert.match(h.el.notice.textContent, /illustrative/);
  assert.ok(descendants(h.el.stage).some(n => n.tagName === 'text' && n.textContent === fallback.nodes[0].text));
});

test('tiny valid camera scales and widest viewport have bounded preview grid work', async () => {
  const source = scene(); source.nodes = source.nodes.slice(0, 1);
  source.camera_scales = [`1/${2n ** 250n}`];
  source.export.width = 4096; source.export.height = 64;
  const h = harness(); assert.equal(await h.studio.loadDocument(source), true);
  assert.equal((await verifyPlan(h.studio.getState().plan)).valid, true);
  const nodes = descendants(h.el.stage), lines = nodes.filter(n => n.tagName === 'line');
  assert.ok(lines.length <= 25 + 9 + 1, `Bounded grid and connector count: ${lines.length}`);
  assert.ok(nodes.every(n => Array.from(n.attributes.values()).every(v => !v.includes('NaN') && !v.includes('Infinity'))));
  await h.el.original.click(); assert.ok(descendants(h.el.stage).filter(n => n.tagName === 'line').length <= 35);
});
test('drawing conversion handles 1024-bit rational operands without overflow or lost sign', () => {
  const numerator = 3n * 2n ** 1022n + 1n, denominator = 2n ** 1023n + 1n;
  assert.equal(numerator.toString(2).length, 1024); assert.equal(denominator.toString(2).length, 1024);
  assert.ok(Number.isFinite(number(`${numerator}/${denominator}`)));
  assert.ok(Math.abs(number(`${numerator}/${denominator}`) - 1.5) < 1e-14);
  assert.ok(Math.abs(number(`${-numerator}/${denominator}`) + 1.5) < 1e-14);
  assert.equal(number(`0/${denominator}`), 0);
  assert.ok(number(`1/${2n ** 1023n}`) > 0);
});

test('document parser accepts JSON primitives, arrays, escapes and independent object key scopes', () => {
  for (const raw of ['null', 'true', 'false', '0', '-0', '-12.5e+2', '  [1, true, null, {"id":"a"}, {"id":"b"}]\n',
    '{}', '[]', '""', '"轨迹 🧭"', '"quote: \\" and slash: \\\\ and solidus: \\/"',
    '"\\u0061\\n\\r\\t\\b\\f\\ud83d\\ude00"', '{"a":{"x":1},"b":{"x":2}}']) {
    assert.deepEqual(parseDocument(raw), JSON.parse(raw), raw);
  }
});
test('document parser rejects duplicate fields at every level, including decoded equivalent keys', () => {
  const repeated = ['{"duration":3,"duration":3}', '{"scene":{"nodes":[],"nodes":[]}}',
    '{"id":"node0","\\u0069d":"node1"}', '{"a":{"x":0,"\\u0078":1}}',
    '[{"nested":{"a":0,"\\u0061":1}}]', '{"😀":1,"\\ud83d\\ude00":2}',
    '{"__proto__":{},"__proto__":{}}'];
  for (const raw of repeated) assert.throws(() => parseDocument(raw), /Duplicate JSON field/, raw);
});
test('document parser rejects malformed grammar, excessive depth and actual UTF8 byte excess', () => {
  for (const raw of ['', ' ', '[1,]', '{"a":1,}', '{"a" 1}', '{"a":}', '[1', '{"a":1',
    '"unclosed', '"bad\\q"', '"bad\\u12xz"', '"line\nbreak"', '01', '+1', '.1', '1.', '1e', 'NaN',
    'true false', '[1]x', '{"a":1}{}', '\u00a0null']) assert.throws(() => parseDocument(raw), undefined, raw);
  const depth64 = '['.repeat(64) + '0' + ']'.repeat(64);
  assert.deepEqual(parseDocument(depth64), JSON.parse(depth64));
  assert.throws(() => parseDocument('['.repeat(65) + '0' + ']'.repeat(65)), /nesting exceeds 64/);
  assert.equal(parseDocument('"🧭"', 6), '🧭');
  assert.throws(() => parseDocument('"🧭"', 5), /byte budget/);
  assert.throws(() => parseDocument(null), /byte budget/);
});
test('duplicate file and editor fields are actually refused while previous source remains recoverable', async () => {
  const h = harness(); await h.studio.loadDocument(scene()); const prior = h.studio.getState();
  const normalized = JSON.stringify(prior.scene);
  const duplicateTop = normalized.replace('"duration":"3"', '"duration":"3","\\u0064uration":"3"');
  h.el.file.files = [{size: new TextEncoder().encode(duplicateTop).length, text: async () => duplicateTop}];
  await h.el.file.emit('change');
  assert.equal(h.el['status-title'].textContent, 'Import refused'); assert.match(h.el['status-detail'].textContent, /Duplicate JSON field: duration/);
  assert.deepEqual(h.studio.getState().scene, prior.scene); assert.equal(h.el['save-plan'].disabled, true); assert.equal(h.el['save-scene'].disabled, true);
  await h.el['save-plan'].emit('click'); assert.equal(h.downloads.length, 0);
  await h.el.restore.click(); assert.equal(h.studio.getState().dirty, false); assert.deepEqual(h.studio.getState().scene, prior.scene);
  const duplicateNested = JSON.stringify(prior.plan).replace('"half_height":"4"', '"half_height":"4","half_height":"4"');
  h.el.file.files = [{size: duplicateNested.length, text: async () => duplicateNested}]; await h.el.file.emit('change');
  assert.match(h.el['status-detail'].textContent, /Duplicate JSON field: half_height/); assert.deepEqual(h.studio.getState().plan, prior.plan);
  await h.el.restore.click();
  h.el.paths.value = h.el.paths.value.replace('"id": "node0"', '"id": "node0", "\\u0069d": "node0"');
  await h.el.paths.emit('input'); await h.el.apply.click();
  assert.match(h.el['status-detail'].textContent, /Duplicate JSON field: id/); assert.deepEqual(h.studio.getState().scene, prior.scene);
  assert.equal(h.studio.getState().dirty, true); assert.equal(h.el['save-plan'].disabled, true); assert.equal(h.el['save-scene'].disabled, true);
  await h.el.restore.click(); assert.equal(h.studio.getState().dirty, false); assert.deepEqual(h.studio.getState().scene, prior.scene);
});
test('bundled plan duplicate fields are refused before initial acceptance', async () => {
  const plan = await compileScene(scene());
  const raw = JSON.stringify(plan).replace('"input_sha256":', '"input_sha256":"discarded","input_sha256":');
  const h = harness({fetch: async () => ({ok: true, text: async () => raw})});
  assert.equal(await h.studio.start(), false); assert.equal(h.studio.getState().plan, null);
  assert.equal(h.el['status-title'].textContent, 'No verified plan loaded'); assert.match(h.el['status-detail'].textContent, /Duplicate JSON field: input_sha256/);
});


test('cubic editor, path preview, aspect change and downloads preserve actual controls', async () => {
  const source = scene(); source.schema = 'kinetyl-scene/2';
  source.nodes.forEach((n, i) => { n.envelope.width = '1'; n.keyframes = [[0, i ? 2 : -2, -1], [3, i ? -2 : 2, -1]]; n.controls = [[i ? 2 : -2, 2, i ? -2 : 2, 2]]; });
  assert.deepEqual(pointAt(source.nodes[0].keyframes, 1.5, source.nodes[0].controls), [0, 1.25]);
  assert.match(trajectoryPath(source.nodes[0]), /^M -2 -1 C -2 2 2 2 2 -1$/);
  const h = harness(); assert.equal(await h.studio.loadDocument(source), true);
  const before = h.studio.getState();
  const rows = JSON.parse(h.el.paths.value); rows[0].controls[0][1] = '3/2';
  h.el.paths.value = JSON.stringify(rows); await h.el.paths.emit('input');
  assert.equal(h.el['save-plan'].disabled, true);
  await h.el.apply.click(); assert.equal(h.studio.getState().dirty, false);
  const edited = h.studio.getState();
  assert.equal(edited.scene.nodes[0].controls[0][1], '3/2');
  assert.deepEqual(edited.scene.nodes[0].envelope, before.scene.nodes[0].envelope);
  h.el.aspect.value = 'portrait'; await h.el.aspect.emit('change');
  assert.equal(h.studio.getState().dirty, false);
  assert.deepEqual(h.studio.getState().scene.nodes.map(n => [n.keyframes, n.controls]), edited.scene.nodes.map(n => [n.keyframes, n.controls]));
  await h.el['save-plan'].click(); assert.equal(h.downloads[0].value.schema, 'kinetyl-plan/2');
  assert.equal((await verifyPlan(h.downloads[0].value)).valid, true);
  const bad = JSON.parse(h.el.paths.value); delete bad[0].controls;
  h.el.paths.value = JSON.stringify(bad); await h.el.paths.emit('input'); await h.el.apply.click();
  assert.equal(h.el['save-plan'].disabled, true);
  assert.deepEqual(h.studio.getState().scene, h.downloads[0].value.scene);
});


test('recovery restores the last compiled edit while preserving the imported-original action', async () => {
  const h = harness();
  await h.studio.loadDocument(scene());
  const imported = h.studio.getState().scene;
  const edited = structuredClone(imported);
  edited.nodes[0].keyframes[0][1] = '-3/2';
  assert.equal(await h.studio.compile(edited), true);
  const compiled = h.studio.getState().plan;
  assert.equal(h.el['restore-verified'].disabled, true);
  h.el.paths.value = '[invalid'; await h.el.paths.emit('input'); await h.el.apply.click();
  assert.equal(h.el['restore-verified'].disabled, false);
  await h.el['restore-verified'].click();
  assert.deepEqual(h.studio.getState().plan, compiled);
  assert.equal(h.studio.getState().dirty, false);
  assert.equal(h.el['restore-verified'].disabled, true);
  await h.el['save-plan'].click();
  assert.deepEqual(h.downloads[0].value, compiled);
  await h.el.restore.click();
  assert.deepEqual(h.studio.getState().scene, imported);
});

test('recovery supersedes a pending compile so its late result cannot replace the recovered edit', async () => {
  const gate = deferred(); let pending = false;
  const h = harness({compileScene: async next => { if (pending) await gate.promise; return compileScene(next); }});
  await h.studio.loadDocument(scene());
  const compiled = h.studio.getState().plan;
  const next = structuredClone(compiled.scene); next.nodes[0].keyframes[0][1] = '-3/2';
  pending = true;
  const solving = h.studio.compile(next);
  await h.el['restore-verified'].click();
  gate.resolve();
  assert.equal(await solving, false);
  assert.deepEqual(h.studio.getState().plan, compiled);
  assert.equal(h.studio.getState().dirty, false);
});
