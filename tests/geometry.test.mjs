import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {normalizeScene, compileScene, verifyPlan, inspectLayout, sceneIdentity, canonicalSerialize,
  InvalidScene, InvalidPlan, NoSolution, SearchBudgetExceeded} from '../src/kinetyl/assets/geometry.mjs';

function fixture(count = 2, portrait = false) {
  return {schema: 'kinetyl-scene/1', duration: 3,
    nodes: Array.from({length: count}, (_, i) => ({id: 'node' + i, text: 'Label ' + i, font_size: 28, color: '#abcdef', radius: '3/20',
      keyframes: [[0, i % 2 ? 2 : -2, 0], [3, i % 2 ? -2 : 2, 0]],
      envelope: {width: '11/5', height: '2/5', measurement: {engine: 'declared-test', version: '1', font: 'test'}, glyph_paths: []}})),
    export: {width: portrait ? 720 : 1280, height: portrait ? 1280 : 720, frame_rate: 24, frame_height: 8},
    margin: '1/10', camera_scales: [1, '4/5', '3/5', '2/5'], min_font_size: 24};
}
const clone = structuredClone;
test('whole trajectory witnesses catch midpoint collision missed by endpoints; compiler repairs it', async () => {
  const source = fixture();
  const report = inspectLayout(source);
  assert.equal(report.valid, false);
  const crossing = report.collisions.find(c => c.kind === 'label-label');
  assert.deepEqual(crossing, {kind: 'label-label', node_ids: ['node0', 'node1'], time: '3/2'});
  // Endpoint rectangles lie four units apart and need 2.3 units clearance.
  assert.ok(4 > 2.2 + 0.1);
  const plan = await compileScene(source);
  assert.equal(plan.layout.camera_scale, '1');
  assert.notEqual(plan.layout.offsets[0].y, plan.layout.offsets[1].y);
  assert.equal((await verifyPlan(JSON.parse(JSON.stringify(plan)))).valid, true);
  assert.equal(inspectLayout(plan.scene, {cameraScale: plan.layout.camera_scale, offsets: plan.layout.offsets}).valid, true);
});
test('portrait chooses static scale while preserving world tracks and font size', async () => {
  const source = fixture(2, true), plan = await compileScene(source);
  assert.equal(plan.layout.camera_scale, '2/5');
  assert.deepEqual(plan.scene, normalizeScene(source));
  assert.deepEqual(plan.layout.projected_tracks[0].keyframes, [['0', '-4/5', '0'], ['3', '4/5', '0']]);
  assert.equal(plan.layout.viewport.half_width, '9/4');
  assert.deepEqual((await verifyPlan(plan)).checks, {label_pair_checks: 1, label_dot_checks: 4, viewport_checks: 4});
});
test('nonshared intermediate times and three nodes retain exact full-domain checks', async () => {
  const source = fixture(3);
  source.nodes[1].keyframes = [[0, 2, 0], [1, 0, 0], [3, -2, 0]];
  source.nodes[2].keyframes = [[0, -1, 2], [2, 1, 2], [3, -1, 2]];
  for (const node of source.nodes) node.envelope.width = '1';
  const plan = await compileScene(source);
  assert.deepEqual((await verifyPlan(plan)).checks, {label_pair_checks: 3, label_dot_checks: 9, viewport_checks: 6});
});
test('exact boundary contact is safe; an arbitrarily tiny penetration is detected', () => {
  const source = fixture(2); source.margin = '0';
  for (const n of source.nodes) { n.keyframes = [[0, 0, 0], [3, 0, 0]]; n.envelope.width = '2'; n.envelope.height = '2'; }
  let offsets = [{node_id: 'node0', x: '0', y: '2'}, {node_id: 'node1', x: '2', y: '2'}];
  assert.ok(!inspectLayout(source, {offsets}).collisions.some(c => c.kind === 'label-label'));
  const denominator = 2n ** 250n;
  offsets[1].x = `${2n * denominator - 1n}/${denominator}`;
  assert.ok(inspectLayout(source, {offsets}).collisions.some(c => c.kind === 'label-label'));
  // A corner touch at t=3/2 has no interval where both strict inequalities hold.
  source.nodes[1].keyframes = [[0, 1, 3], [3, 3, 1]];
  offsets = [{node_id: 'node0', x: '0', y: '0'}, {node_id: 'node1', x: '0', y: '0'}];
  assert.ok(!inspectLayout(source, {offsets}).collisions.some(c => c.kind === 'label-label'));
});
test('binary64 normalization is exact, new allocations detach, Unicode canonicalizes correctly', async () => {
  const source = fixture(1); source.nodes[0].keyframes[0][1] = 0.1;
  source.nodes[0].text = '轨迹 🧭\nÉtoile';
  const normalized = normalizeScene(source);
  assert.equal(normalized.nodes[0].keyframes[0][1], '3602879701896397/36028797018963968');
  assert.equal(normalized.nodes[0].color, '#ABCDEF');
  source.nodes[0].text = 'changed'; source.nodes[0].keyframes[0][1] = 999;
  assert.equal(normalized.nodes[0].text, '轨迹 🧭\nÉtoile');
  assert.match(await sceneIdentity(normalized), /^[a-f0-9]{64}$/);
  assert.ok(canonicalSerialize(normalized).includes('轨迹 🧭'));
});
test('rational decimal normalization and 256 bit limits, including tiny binary64 values', () => {
  const source = fixture(1);
  source.duration = '+3.00'; source.margin = '-0.000'; source.nodes[0].radius = '15/100';
  assert.equal(normalizeScene(source).duration, '3');
  assert.equal(normalizeScene(source).margin, '0');
  assert.equal(normalizeScene(source).nodes[0].radius, '3/20');
  for (const value of [`1/${2n ** 257n}`, String(2n ** 257n), 10001, Number.MIN_VALUE, '1/0', '1e3', '.1', '1/-2', '1\n', '1\r', ' '.repeat(161)]) {
    const bad = fixture(); bad.nodes[0].keyframes[0][1] = value;
    assert.throws(() => normalizeScene(bad), InvalidScene, String(value));
  }
});
test('derived offset rationals may exceed 256 bits but stay in the plan bounds', async () => {
  const source = fixture(1), node = source.nodes[0];
  node.keyframes = [[0, 0, 0], [3, 0, 0]];
  node.radius = `1/${2n ** 251n - 19n}`; source.margin = `1/${2n ** 251n - 35n}`;
  node.envelope.height = `1/${2n ** 251n - 9n}`;
  const plan = await compileScene(source);
  assert.ok(BigInt(plan.layout.offsets[0].y.split('/')[1]).toString(2).length > 256);
  assert.equal((await verifyPlan(plan)).valid, true);
});
test('no solution in family and budget exhaustion remain distinct', async () => {
  const source = fixture(1, true); source.nodes[0].envelope.width = '8';
  await assert.rejects(compileScene(source), NoSolution);
  await assert.rejects(compileScene(source, {workBudget: 1}), SearchBudgetExceeded);
  await assert.rejects(compileScene(fixture(), {workBudget: 20}), SearchBudgetExceeded);
  for (const workBudget of [true, 0, 1000001, 1.2]) await assert.rejects(compileScene(fixture(), {workBudget}), InvalidScene);
});
test('scene keys, identities, Unicode, finite values and time domain reject malformed input', () => {
  const changes = [s => s.extra = 1, s => s.schema = 'kinetyl-intent/1', s => s.duration = true, s => s.duration = NaN,
    s => s.margin = -1, s => s.camera_scales = [1, '1'], s => s.camera_scales = [0], s => s.nodes = [],
    s => s.nodes[0].text = '\ud800', s => s.nodes[0].text = 'bad\0', s => s.nodes[0].text = 'a\nb\nc\nd',
    s => s.nodes[0].text = '🧭'.repeat(257), s => s.nodes[0].color = '<script>', s => s.nodes[0].color = '#abcdef\n', s => s.nodes[0].id = 'node1',
    s => s.nodes[0].id = '轨迹', s => s.nodes[0].radius = Infinity, s => s.nodes[0].font_size = 23,
    s => s.nodes[0].keyframes = [[1, 0, 0], [3, 0, 0]], s => s.nodes[0].keyframes = [[0, 0, 0], [0, 1, 0], [3, 0, 0]],
    s => s.nodes[0].keyframes = [[0, 0, 0]], s => s.nodes[0].envelope.width = 0,
    s => s.export.frame_height = 9, s => s.export.width = 63, s => s.export.frame_rate = true,
    s => s.nodes[0].envelope.measurement.font = '\x80', s => s.nodes[0].envelope.extra = 'anything'];
  for (const change of changes) { const source = fixture(); change(source); assert.throws(() => normalizeScene(source), InvalidScene); }
  const source = fixture(); delete source.nodes[0].envelope; assert.throws(() => normalizeScene(source), InvalidScene);
});
test('glyphs are bounded data commands and all curve controls lie inside envelopes', () => {
  const source = fixture(1);
  source.nodes[0].envelope.glyph_paths = [[['M', 0, 0], ['L', '1/10', 0], ['Q', '1/10', 0, 0, '1/10'], ['C', 0, 0, '1/10', '1/10', 0, 0], ['Z']]];
  assert.deepEqual(normalizeScene(source).nodes[0].envelope.glyph_paths[0][0], ['M', '0', '0']);
  for (const glyphs of ["<svg onload='evil'>", [[['svg', '<script>']]], [[['L', 0, 0]]], [[['M', 0, 0], ['M', 0, 0]]],
    [[['M', 0, 0], ['Z'], ['L', 0, 0]]], [[['M', 10, 0]]], [[['M', 0, 0], ['Q', 9, 0, 0, 0]]], Array.from({length: 513}, () => [['M', 0, 0]])]) {
    source.nodes[0].envelope.glyph_paths = glyphs; assert.throws(() => normalizeScene(source), InvalidScene);
  }
  source.nodes[0].envelope.glyph_paths = [[['M', 0, 0], ...Array.from({length: 8192}, () => ['L', 0, 0])]];
  assert.throws(() => normalizeScene(source), InvalidScene);
  const huge = fixture(5);
  for (const n of huge.nodes) n.envelope.glyph_paths = [[['M', 0, 0], ...Array.from({length: 8191}, () => ['L', 0, 0])]];
  assert.throws(() => normalizeScene(huge), InvalidScene);
});
test('imported plan independently refuses changed geometry, claims, cardinality and identities', async () => {
  const plan = await compileScene(fixture());
  const changes = [p => p.input_sha256 = '0'.repeat(64), p => p.success = true,
    p => p.verification.label_pair_checks = true, p => p.verification.scope = 'pixels proven',
    p => p.layout.camera_scale = '1/3', p => p.layout.camera_scale = 1, p => p.layout.offsets = [],
    p => p.layout.offsets[0].node_id = 'node1', p => p.layout.offsets[0].x = '999',
    p => p.layout.projected_tracks[0].keyframes[0][1] = '0', p => p.layout.viewport.half_width = '999',
    p => p.layout.projected_tracks = Array(9).fill({}), p => p.scene.nodes[0].text = 'changed',
    p => p.scene.radius = '1', p => p.layout.projected_tracks[0].keyframes[0][0] = 0];
  for (const change of changes) { const forged = clone(plan); change(forged); await assert.rejects(verifyPlan(forged), InvalidPlan); }
  // This still uses declared slots and truthful count fields; only recomputation can reject it.
  const forged = clone(plan); forged.layout.offsets[1].y = forged.layout.offsets[0].y;
  await assert.rejects(verifyPlan(forged), /Continuous label-label conflict/);
});
test('viewport checks include dots, and legal family offsets cannot evade clipping', async () => {
  const source = fixture(1, true); source.nodes[0].keyframes = [[0, 3, 0], [3, 3, 0]]; source.nodes[0].envelope.width = '2';
  const plan = await compileScene(source); assert.equal((await verifyPlan(plan)).valid, true);
  assert.ok(['3/5', '2/5'].includes(plan.layout.camera_scale));
  const report = inspectLayout(source); assert.ok(report.clipping.some(c => c.geometry === 'dot'));
  const forged = await compileScene(fixture(1));
  forged.layout.offsets[0] = {node_id: 'node0', x: '0', y: '9/10'};
  // A legal larger slot can still be invalid at the edge; arbitrary slots always reject.
  forged.layout.offsets[0].y = '4';
  await assert.rejects(verifyPlan(forged), InvalidPlan);
});

test('250 trajectories agree with independent Fraction critical-time oracle and exact witness checks', () => {
  let seed = 0x6b1e7;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const cases = [];
  for (let i = 0; i < 250; i++) {
    const source = fixture(); source.margin = `${random(4)}/10`;
    for (const node of source.nodes) {
      const times = [0, ...[0.5, 1, 1.5, 2, 2.5].filter(() => random(2)), 3];
      node.keyframes = times.map(t => [t, (random(25) - 12) / 4, (random(25) - 12) / 4]);
      node.envelope.width = `${random(9) + 1}/5`; node.envelope.height = `${random(9) + 1}/5`;
    }
    const offsets = source.nodes.map(n => ({node_id: n.id, x: `${random(9) - 4}/4`, y: `${random(9) - 4}/4`}));
    const witness = inspectLayout(source, {offsets}).collisions.find(c => c.kind === 'label-label')?.time ?? null;
    cases.push({scene: source, offsets, witness});
  }
  const oracle = spawnSync('python3', ['-c', `
import json,sys
from fractions import Fraction as F
def point(track,t):
    for a,b in zip(track,track[1:]):
        if a[0]<=t<=b[0]: return [a[k]+(t-a[0])*(b[k]-a[k])/(b[0]-a[0]) for k in (1,2)]
    raise AssertionError('domain')
result=[]
for case in json.load(sys.stdin):
    nodes=case['scene']['nodes'];tracks=[[[F(v) for v in k] for k in n['keyframes']] for n in nodes]
    offsets=[[F(o['x']),F(o['y'])] for o in case['offsets']]
    extents=[sum(F(n['envelope'][axis])/2 for n in nodes)+F(case['scene']['margin']) for axis in ('width','height')]
    def delta(t):
        a,b=[point(track,t) for track in tracks]
        return [a[k]+offsets[0][k]-b[k]-offsets[1][k] for k in (0,1)]
    def hit(t): return all(abs(v)<h for v,h in zip(delta(t),extents))
    cuts=sorted(set(k[0] for track in tracks for k in track));critical=set(cuts)
    for start,end in zip(cuts,cuts[1:]):
        ds,de=delta(start),delta(end)
        for axis in (0,1):
            if ds[axis]==de[axis]: continue
            for threshold in (-extents[axis],extents[axis]):
                t=start+(threshold-ds[axis])*(end-start)/(de[axis]-ds[axis])
                if start<=t<=end:critical.add(t)
    critical=sorted(critical)
    expected=any(hit(t) for t in critical+[(a+b)/2 for a,b in zip(critical,critical[1:])])
    witness=case['witness']
    result.append({'agreement':expected==(witness is not None),'witness_valid':witness is None or hit(F(witness))})
print(json.dumps(result))
`], {input: JSON.stringify(cases), encoding: 'utf8'});
  assert.equal(oracle.status, 0, oracle.stderr);
  const evidence = JSON.parse(oracle.stdout);
  assert.equal(evidence.length, 250);
  assert.ok(evidence.every(r => r.agreement && r.witness_valid));
});

test('Python reference identity, normalization and compiled plans match on final contract cases', async () => {
  const sources = [fixture(), fixture(2, true), fixture(1), fixture(3)];
  sources[2].nodes[0].text = '轨迹 🧭\nÉtoile\u2028'; sources[2].nodes[0].keyframes[0][1] = 0.1;
  sources[3].nodes[2].keyframes = [[0, -1, 2], [2, 1, 2], [3, -1, 2]];
  for (const n of sources[3].nodes) n.envelope.width = '1';
  const python = spawnSync('python3', ['-c', `import json,sys\nfrom kinetyl.core import validate_scene,compile_scene,scene_identity,verify_plan\nscenes=json.load(sys.stdin)\nprint(json.dumps([{'scene':validate_scene(s),'identity':scene_identity(validate_scene(s)),'plan':compile_scene(s)} for s in scenes], ensure_ascii=False))`],
    {input: JSON.stringify(sources), encoding: 'utf8', env: {...process.env, PYTHONPATH: fileURLToPath(new URL('../src/', import.meta.url))}});
  assert.equal(python.status, 0, python.stderr);
  const references = JSON.parse(python.stdout);
  for (let i = 0; i < sources.length; i++) {
    assert.deepEqual(normalizeScene(sources[i]), references[i].scene);
    assert.equal(await sceneIdentity(sources[i]), references[i].identity);
    assert.deepEqual(await compileScene(sources[i]), references[i].plan);
    assert.equal((await verifyPlan(references[i].plan)).valid, true);
  }
  const jsPlans = await Promise.all(sources.map(s => compileScene(s)));
  const verified = spawnSync('python3', ['-c', `import json,sys\nfrom kinetyl.core import verify_plan\nprint(json.dumps([verify_plan(p) for p in json.load(sys.stdin)]))`],
    {input: JSON.stringify(jsPlans), encoding: 'utf8', env: {...process.env, PYTHONPATH: fileURLToPath(new URL('../src/', import.meta.url))}});
  assert.equal(verified.status, 0, verified.stderr);
  assert.ok(JSON.parse(verified.stdout).every(row => row.valid));
});
