import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeScene, compileScene, verifyPlan, inspectLayout, sceneIdentity, canonicalSerialize,
  CUBIC_SCOPE, SCOPE, InvalidScene, InvalidPlan, NoSolution, SearchBudgetExceeded} from '../src/kinetyl/assets/geometry.mjs';
import {polynomialTools, PolynomialLimit} from '../src/kinetyl/assets/polynomial.mjs';

// Independent test rational type, also used to evaluate factored-oracle cells.
class R {
  constructor(n, d = 1n) {
    n = BigInt(n); d = BigInt(d); if (d < 0n) { n = -n; d = -d; }
    let a = n < 0n ? -n : n, b = d; while (b) [a, b] = [b, a % b];
    this.n = n / a; this.d = d / a;
  }
  add(b) { return new R(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b) { return new R(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b) { return new R(this.n * b.n, this.d * b.d); }
  div(b) { return new R(this.n * b.d, this.d * b.n); }
  neg() { return new R(-this.n, this.d); }
  cmp(b) { const n = this.n * b.d - b.n * this.d; return n < 0n ? -1 : n > 0n ? 1 : 0; }
  eq(b) { return this.cmp(b) === 0; }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}
const r = (n, d = 1) => new R(BigInt(n), BigInt(d)), Z = r(0), O = r(1), T = r(2);
function parse(value) { const [n, d = '1'] = String(value).split('/'); return new R(n, d); }
const P = polynomialTools(R);
function budget(limit = 1000000) { return {remaining: limit, spend(n = 1) { this.remaining -= n; if (this.remaining < 0) throw new SearchBudgetExceeded('test budget'); }}; }
const evalP = (p, x) => p.reduceRight((value, c) => value.mul(x).add(c), Z);
function product(a, b) { const out = Array(a.length + b.length - 1).fill(Z); for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] = out[i + j].add(a[i].mul(b[j])); return out; }

function base(v2 = true) {
  return {schema: v2 ? 'kinetyl-scene/2' : 'kinetyl-scene/1', duration: 1,
    nodes: [{id: 'A', text: 'A', font_size: 28, color: '#abcdef', radius: '1/10', keyframes: [[0, -1, 0], [1, 1, 0]],
      envelope: {width: '1', height: '2/5', measurement: {engine: 'declared-test', version: '1', font: 'test'}, glyph_paths: []},
      ...(v2 ? {controls: [['-1/3', '0', '1/3', '0']]} : {})}],
    export: {width: 1280, height: 720, frame_rate: 60, frame_height: 8}, margin: '1/10', camera_scales: [1, '1/2'], min_font_size: 24};
}
function crossing() {
  const scene = base();
  scene.nodes[0].keyframes = [[0, -2, 0], [1, 2, 0]];
  scene.nodes[0].controls = [['-2/3', 2, '2/3', 2]];
  scene.nodes.push({...structuredClone(scene.nodes[0]), id: 'B', text: 'B', keyframes: [[0, 2, 0], [1, -2, 0]], controls: [['2/3', 2, '-2/3', 2]]});
  return scene;
}

test('v1 canonical scene identity and compiled bytes match the retained baseline', async () => {
  const scene = base(false), plan = await compileScene(scene);
  assert.equal(await sceneIdentity(scene), '38fb555c9b0f629203cbb702a76aa2c4bb03e4020ad8d8dc9aeba1a30171bd0a');
  assert.equal(createHash('sha256').update(canonicalSerialize(plan)).digest('hex'), '63a054cf0e8565a77897e698471aba2db06cb41d237ce3b1c16f47f76c259431');
  assert.equal(plan.verification.scope, SCOPE);
  assert.equal('controls' in plan.layout.projected_tracks[0], false);
});
test('v2 controls are required bounded rational data, detached and canonical', () => {
  const scene = base(); scene.nodes[0].controls[0] = ['-2/6', '+0.00', '2/6', 0.1];
  const normalized = normalizeScene(scene);
  assert.deepEqual(normalized.nodes[0].controls, [['-1/3', '0', '1/3', '3602879701896397/36028797018963968']]);
  scene.nodes[0].controls[0][0] = 999;
  assert.equal(normalized.nodes[0].controls[0][0], '-1/3');
  const changes = [s => delete s.nodes[0].controls, s => s.nodes[0].controls = null,
    s => s.nodes[0].controls = [], s => s.nodes[0].controls.push([0, 0, 0, 0]),
    s => s.nodes[0].controls[0] = [0, 0, 0], s => s.nodes[0].controls[0].push(0),
    s => s.nodes[0].controls[0][0] = 10001, s => s.nodes[0].controls[0][0] = `1/${2n ** 257n}`,
    s => s.nodes[0].controls[0][0] = '1/0', s => s.nodes[0].controls[0][0] = NaN,
    s => delete s.nodes[0].controls[0][1], s => s.nodes[0].controls[0].extra = 1,
    s => Object.defineProperty(s.nodes[0].controls[0], '0', {get() { throw Error('getter invoked'); }, enumerable: true}),
    s => s.schema = 'kinetyl-scene/1'];
  for (const change of changes) { const source = base(); change(source); assert.throws(() => normalizeScene(source), InvalidScene); }
});
test('curved crossing has a rational collision witness, compiles and independently verifies', async () => {
  const scene = crossing(), report = inspectLayout(scene);
  assert.deepEqual(report.collisions.find(c => c.kind === 'label-label'), {kind: 'label-label', node_ids: ['A', 'B'], time: '1/2'});
  assert.equal(report.scope, CUBIC_SCOPE);
  const plan = await compileScene(scene);
  assert.equal(plan.schema, 'kinetyl-plan/2');
  assert.equal((await verifyPlan(JSON.parse(JSON.stringify(plan)))).valid, true);
  assert.equal(inspectLayout(plan.scene, {cameraScale: plan.layout.camera_scale, offsets: plan.layout.offsets}).valid, true);
  assert.deepEqual(plan.scene, normalizeScene(scene));
});
test('continuous viewport checks catch curved overshoot while retaining useful safe control hulls', async () => {
  const scene = base(); scene.nodes[0].keyframes = [[0, 0, 0], [1, 0, 0]];
  scene.nodes[0].controls = [[0, 6, 0, 6]];
  assert.ok(inspectLayout(scene).clipping.some(c => c.geometry === 'dot'));
  const plan = await compileScene(scene);
  assert.equal(plan.layout.camera_scale, '1/2');
  assert.deepEqual(plan.layout.projected_tracks[0].controls, [['0', '3', '0', '3']]);
  assert.deepEqual(plan.scene.nodes[0].controls, [['0', '6', '0', '6']]);
  assert.equal(plan.scene.nodes[0].font_size, 28);
  scene.nodes[0].controls = [[0, 5, 0, -5]];
  assert.equal((await compileScene(scene)).layout.camera_scale, '1');
  scene.camera_scales = [1]; scene.nodes[0].controls = [[0, 6, 0, 6]];
  await assert.rejects(compileScene(scene), NoSolution);
});
test('viewport tangency is safe and an arbitrarily small curved penetration is detected', () => {
  const scene = base(); scene.nodes[0].radius = '1/4'; scene.nodes[0].keyframes = [[0, 0, 0], [1, 0, 0]];
  scene.nodes[0].controls = [[0, 5, 0, 5]];
  const offsets = [{node_id: 'A', x: '0', y: '-1'}];
  assert.ok(!inspectLayout(scene, {offsets}).clipping.some(c => c.geometry === 'dot'));
  const d = 2n ** 200n; scene.nodes[0].controls[0][1] = `${5n * d + 1n}/${d}`;
  assert.ok(inspectLayout(scene, {offsets}).clipping.some(c => c.geometry === 'dot'));
});
test('subframe curved collision missed by 60fps gets an actual rational witness', () => {
  const scene = base(), c = r(1, 121), e = r(1, 10000000), a = O.add(c.mul(c)).sub(e.mul(e));
  const value = t => O.add(t.sub(c).mul(t.sub(c))).sub(e.mul(e));
  for (let i = 0; i <= 60; i++) assert.ok(value(r(i, 60)).cmp(O) >= 0);
  scene.margin = '0'; scene.nodes[0].keyframes = [[0, 0, 0], [1, 0, 0]]; scene.nodes[0].controls = [[0, 0, 0, 0]]; scene.nodes[0].envelope.height = '1';
  scene.nodes.push({...structuredClone(scene.nodes[0]), id: 'B', text: 'B',
    keyframes: [[0, 0, String(a)], [1, 0, String(value(O))]],
    controls: [[0, String(a.sub(c.mul(r(2, 3)))), 0, String(a.sub(c.mul(r(4, 3))).add(r(1, 3)))]]});
  const offsets = scene.nodes.map(n => ({node_id: n.id, x: '0', y: '0'}));
  const witness = inspectLayout(scene, {offsets}).collisions.find(hit => hit.kind === 'label-label')?.time;
  assert.ok(witness);
  assert.ok(value(parse(witness)).cmp(O) < 0);
  assert.ok(value(parse(witness)).cmp(O.neg()) > 0);
});
test('v2 verifier rejects changed controls, canonical representation and mismatched version/scope', async () => {
  const plan = await compileScene(crossing());
  const changes = [p => p.schema = 'kinetyl-plan/1', p => p.verification.scope = SCOPE,
    p => delete p.layout.projected_tracks[0].controls, p => p.layout.projected_tracks[0].controls = [],
    p => p.layout.projected_tracks[0].controls[0][0] = '0', p => p.layout.projected_tracks[0].controls[0][1] = 2,
    p => p.layout.projected_tracks[0].controls[0][1] = '4/2',
    p => p.scene.nodes[0].controls[0][1] = '1', p => p.scene.schema = 'kinetyl-scene/1'];
  for (const change of changes) { const forged = structuredClone(plan); change(forged); await assert.rejects(verifyPlan(forged), InvalidPlan); }
  await assert.rejects(compileScene(crossing(), {workBudget: 1}), SearchBudgetExceeded);
  assert.throws(() => inspectLayout(crossing(), {workBudget: 20}), SearchBudgetExceeded);
});

test('exact sign kernel agrees with 700 independently factored sign-cell cases', () => {
  let seed = 20261015;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 700; trial++) {
    const roots = [], polynomials = [];
    for (let j = 0, n = 1 + random(4); j < n; j++) {
      let p = [r(random(2) ? 1 : -1)];
      for (let k = 0, degree = 1 + random(3); k < degree; k++) {
        const root = r(random(11) - 2, [3, 7, 11, 101][random(4)]); roots.push(root); p = product(p, [root.neg(), O]);
      }
      polynomials.push(p);
    }
    const cuts = [Z, O, ...roots.filter(x => x.cmp(Z) > 0 && x.cmp(O) < 0)].sort((a, b) => a.cmp(b)).filter((x, i, rows) => !i || !x.eq(rows[i - 1]));
    const expected = cuts.slice(1).some((x, i) => polynomials.every(p => evalP(p, cuts[i].add(x).div(T)).cmp(Z) < 0));
    const witness = P.negativeWitness(polynomials, Z, O, budget());
    assert.equal(witness !== null, expected, `factored trial ${trial}`);
    if (witness !== null) assert.ok(witness.cmp(Z) >= 0 && witness.cmp(O) <= 0 && polynomials.every(p => evalP(p, witness).cmp(Z) < 0));
  }
});
test('exact kernel handles repeated/tangent/irrational roots and enforces arithmetic limits', () => {
  const cases = [
    {p: [[r(1, 4), r(-1), O]], end: O, hit: false},
    {p: [[r(-1, 2), O], [r(1, 2), r(-1)]], end: O, hit: false},
    {p: [[r(-2), Z, O], [r(3, 2), r(-1)]], end: T, hit: false},
    {p: [[r(-2), Z, O], [r(7, 5), r(-1)]], end: T, hit: true},
    {p: [[Z, Z, r(-1)], [r(-1), O]], end: O, hit: true},
    {p: [[r(-1, 8), r(3, 4), r(-3, 2), O]], end: O, hit: true}
  ];
  for (const {p, end, hit} of cases) {
    const w = P.negativeWitness(p, Z, end, budget()); assert.equal(w !== null, hit);
    if (w !== null) assert.ok(p.every(poly => evalP(poly, w).cmp(Z) < 0));
  }
  assert.throws(() => P.negativeWitness([[new R(1n << 16384n)]], Z, O, budget()), PolynomialLimit);
  assert.throws(() => P.negativeWitness([Array(14).fill(O)], Z, O, budget()), PolynomialLimit);
});

test('Python/browser v2 normalization, identities, plans and merged segment cuts agree', async () => {
  const sources = [base(), crossing(), crossing(), base(), base()];
  sources[2].export.width = 720; sources[2].export.height = 1280;
  sources[3].nodes[0].keyframes = [[0, -1, 0], ['1/3', 0, 1], [1, 1, 0]];
  sources[3].nodes[0].controls = [['-2/3', 0, '-1/3', 1], ['1/3', 2, '2/3', -1]];
  sources[3].nodes.push({...structuredClone(base().nodes[0]), id: 'B', text: 'B', keyframes: [[0, 2, 1], [1, -2, 1]], controls: [[1, 2, -1, -1]]});
  sources[4].nodes[0].controls[0][0] = 0.1;
  sources[4].nodes[0].text = '曲線 🧭';
  const env = {...process.env, PYTHONPATH: fileURLToPath(new URL('../src/', import.meta.url))};
  const result = spawnSync('python3', ['-c', `import json,sys\nfrom kinetyl.core import validate_scene,compile_scene,scene_identity,verify_plan\nprint(json.dumps([{'scene':validate_scene(s),'identity':scene_identity(validate_scene(s)),'plan':compile_scene(s,work_budget=250000)} for s in json.load(sys.stdin)]))`], {input: JSON.stringify(sources), encoding: 'utf8', env});
  assert.equal(result.status, 0, result.stderr);
  const references = JSON.parse(result.stdout), plans = [];
  for (let i = 0; i < sources.length; i++) {
    assert.deepEqual(normalizeScene(sources[i]), references[i].scene);
    assert.equal(await sceneIdentity(sources[i]), references[i].identity);
    const plan = await compileScene(sources[i]); plans.push(plan);
    assert.deepEqual(plan, references[i].plan);
    assert.equal((await verifyPlan(references[i].plan)).valid, true);
  }
  const verified = spawnSync('python3', ['-c', `import json,sys\nfrom kinetyl.core import verify_plan\nprint(json.dumps([verify_plan(p) for p in json.load(sys.stdin)]))`], {input: JSON.stringify(plans), encoding: 'utf8', env});
  assert.equal(verified.status, 0, verified.stderr); assert.ok(JSON.parse(verified.stdout).every(row => row.valid));
});

test('retained native-measured wide and portrait cubic plans match browser compilation', async () => {
  for (const name of ['curved-crossing', 'curved-crossing-portrait']) {
    const fixture = suffix => JSON.parse(readFileSync(new URL(`../src/kinetyl/examples/${name}.${suffix}.json`, import.meta.url), 'utf8'));
    const scene = fixture('scene'), expected = fixture('plan');
    assert.deepEqual(normalizeScene(scene), expected.scene);
    assert.deepEqual(await compileScene(scene), expected);
    assert.equal((await verifyPlan(expected)).valid, true);
    const tampered = structuredClone(expected); tampered.layout.projected_tracks[0].controls[0][1] = '0';
    await assert.rejects(verifyPlan(tampered), InvalidPlan);
  }
});
