/* Kinetyl exact declared-geometry engine. MIT. No dependencies or input execution.
 * Preview drawing may use floats; every constraint below uses reduced BigInt rationals.
 * Metadata and supplied envelopes are declarations, not authenticated pixel evidence.
 */
import {polynomialTools, PolynomialLimit} from './polynomial.mjs';
export const SCOPE = 'Exact declared rectangles; piecewise-linear centers; fixed presentation geometry; static axis-aligned camera; square clearance.';
export const CUBIC_SCOPE = 'Exact declared rectangles; piecewise-cubic Bezier centers with linear segment time; fixed presentation geometry; static axis-aligned camera; square clearance.';
export class KinetylError extends Error { constructor(message) { super(message); this.name = new.target.name; } }
export class InvalidScene extends KinetylError {}
export class InvalidPlan extends KinetylError {}
export class NoSolution extends KinetylError {}
export class SearchBudgetExceeded extends KinetylError {}

const abs = n => n < 0n ? -n : n;
function gcd(a, b) { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; }
class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new InvalidScene('Invalid rational denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d); this.n = n / g; this.d = d / g;
  }
  add(b) { return new Q(this.n * b.d + b.n * this.d, this.d * b.d); }
  sub(b) { return new Q(this.n * b.d - b.n * this.d, this.d * b.d); }
  mul(b) { return new Q(this.n * b.n, this.d * b.d); }
  div(b) { return new Q(this.n * b.d, this.d * b.n); }
  neg() { return new Q(-this.n, this.d); }
  abs() { return new Q(abs(this.n), this.d); }
  cmp(b) { const n = this.n * b.d - b.n * this.d; return n < 0n ? -1 : n > 0n ? 1 : 0; }
  eq(b) { return this.n === b.n && this.d === b.d; }
  toString() { return this.d === 1n ? String(this.n) : `${this.n}/${this.d}`; }
}
const ZERO = new Q(0n), ONE = new Q(1n), TWO = new Q(2n), FOUR = new Q(4n);
const polynomial = polynomialTools(Q);
const sceneScope = scene => scene.schema === 'kinetyl-scene/2' ? CUBIC_SCOPE : SCOPE;
function negativeWitness(polynomials, budget) {
  try { return polynomial.negativeWitness(polynomials, ZERO, ONE, budget); }
  catch (error) { if (error instanceof PolynomialLimit) throw new SearchBudgetExceeded(error.message); throw error; }
}
const bitLength = n => abs(n).toString(2).length;
const fullMatch = (pattern, value) => pattern.exec(value)?.[0] === value;
function numberQ(value) {
  // Decode binary64 directly. Decimal stringification would change supplied geometry.
  if (!Number.isFinite(value)) throw new InvalidScene('Nonfinite geometry');
  if (value === 0) return ZERO;
  const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (exponent) mantissa += 1n << 52n;
  if (bits >> 63n) mantissa = -mantissa;
  const shift = exponent ? exponent - 1023 - 52 : -1074;
  return shift >= 0 ? new Q(mantissa << BigInt(shift)) : new Q(mantissa, 1n << BigInt(-shift));
}
function rational(value, magnitude = 10000, bits = 256, length = 160) {
  let result;
  if (typeof value === 'string') {
    if (value.length > length || !fullMatch(/^[+-]?[0-9]+(?:\/[0-9]+|\.[0-9]+)?$/, value)) throw new InvalidScene('Invalid rational string');
    if (value.includes('/')) { const [n, d] = value.split('/'); result = new Q(BigInt(n), BigInt(d)); }
    else if (value.includes('.')) {
      const negative = value.startsWith('-'), unsigned = value.replace(/^[+-]/, '');
      const [whole, fractional] = unsigned.split('.');
      result = new Q(BigInt(whole + fractional) * (negative ? -1n : 1n), 10n ** BigInt(fractional.length));
    } else result = new Q(BigInt(value));
  } else if (typeof value === 'number') result = numberQ(value);
  else throw new InvalidScene('Expected rational string or finite JSON number');
  if (bitLength(result.n) > bits || bitLength(result.d) > bits || result.abs().cmp(new Q(BigInt(magnitude))) > 0) throw new InvalidScene('Rational exceeds bit or magnitude bound');
  return result;
}
function shape(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new InvalidScene('Missing, unknown or invalid object fields');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new InvalidScene('Only data properties are supported');
  }
}
function array(value, lo, hi) {
  if (!Array.isArray(value) || value.length < lo || value.length > hi ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({length: value.length}, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).some(d => !d || !Object.hasOwn(d, 'value'))) throw new InvalidScene('Invalid array cardinality or data');
  return value;
}
function integer(value, lo, hi) {
  if (!Number.isInteger(value) || value < lo || value > hi) throw new InvalidScene('Invalid integer range');
  return value;
}
function text(value, limit = 128, multiline = false) {
  if (typeof value !== 'string' || value.length > limit * 2) throw new InvalidScene('Invalid text type or length');
  const points = Array.from(value);
  if (!points.length || points.length > limit || new TextEncoder().encode(value).length > limit * 4 ||
      (multiline && value.split('\n').length > 3)) throw new InvalidScene('Invalid text length or line bound');
  for (const c of points) {
    const n = c.codePointAt(0);
    if ((n < 32 && !(multiline && c === '\n')) || (n >= 127 && n <= 159) || (n >= 0xd800 && n <= 0xdfff)) throw new InvalidScene('Invalid Unicode or control characters');
  }
  return value;
}
function glyphs(data, width, height) {
  array(data, 0, 512); const arities = {M: 2, L: 2, Q: 4, C: 6, Z: 0}; let count = 0;
  const paths = data.map(contour => {
    array(contour, 1, 8192); count += contour.length;
    if (count > 8192) throw new InvalidScene('Glyph command budget exceeded');
    return contour.map((command, i) => {
      array(command, 1, 7); const op = command[0];
      if (typeof op !== 'string' || !Object.hasOwn(arities, op) || command.length !== arities[op] + 1 ||
          (i === 0 && op !== 'M') || (i > 0 && op === 'M') || (op === 'Z' && i !== contour.length - 1)) throw new InvalidScene('Invalid glyph command or contour');
      const coordinates = command.slice(1).map(v => rational(v, 64));
      if (coordinates.some((v, j) => v.abs().cmp((j % 2 ? height : width).div(TWO)) > 0)) throw new InvalidScene('Glyph control point outside declared envelope');
      return [op, ...coordinates.map(String)];
    });
  });
  return {paths, count};
}
export function normalizeScene(data) {
  shape(data, ['schema', 'duration', 'nodes', 'export', 'margin', 'camera_scales', 'min_font_size']);
  if (!['kinetyl-scene/1', 'kinetyl-scene/2'].includes(data.schema)) throw new InvalidScene('Unsupported measured scene schema');
  const cubic = data.schema === 'kinetyl-scene/2';
  const duration = rational(data.duration, 60);
  if (duration.cmp(ZERO) <= 0) throw new InvalidScene('Duration must be positive');
  shape(data.export, ['width', 'height', 'frame_rate', 'frame_height']);
  const output = {width: integer(data.export.width, 64, 4096), height: integer(data.export.height, 64, 4096), frame_rate: integer(data.export.frame_rate, 1, 60), frame_height: '8'};
  if (!rational(data.export.frame_height).eq(new Q(8n))) throw new InvalidScene('Version 1 requires frame height 8');
  const margin = rational(data.margin, 2);
  if (margin.cmp(ZERO) < 0) throw new InvalidScene('Margin must be nonnegative');
  const scales = array(data.camera_scales, 1, 8).map(v => rational(v, 1));
  if (scales.some(v => v.cmp(ZERO) <= 0) || new Set(scales.map(String)).size !== scales.length) throw new InvalidScene('Camera scales must be positive and distinct');
  const minFont = integer(data.min_font_size, 1, 256), identities = new Set(); let glyphCount = 0;
  const nodes = array(data.nodes, 1, 8).map(node => {
    shape(node, ['id', 'text', 'font_size', 'color', 'radius', 'keyframes', 'envelope', ...(cubic ? ['controls'] : [])]);
    const id = text(node.id, 32);
    if (!fullMatch(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, id) || identities.has(id)) throw new InvalidScene('Node identities must be unique ASCII identifiers');
    identities.add(id);
    const label = text(node.text, 256, true), font = integer(node.font_size, minFont, 256);
    if (typeof node.color !== 'string' || !fullMatch(/^#[0-9a-fA-F]{6}$/, node.color)) throw new InvalidScene('Color must be #RRGGBB');
    const radius = rational(node.radius, 4);
    if (radius.cmp(ZERO) <= 0) throw new InvalidScene('Marker radius must be positive');
    const track = array(node.keyframes, 2, 16).map(k => array(k, 3, 3).map((v, j) => rational(v, j ? 10000 : 60)));
    if (!track[0][0].eq(ZERO) || !track.at(-1)[0].eq(duration) || track.slice(1).some((k, i) => track[i][0].cmp(k[0]) >= 0)) throw new InvalidScene('Keyframes require shared 0..duration domain and increasing times');
    const controls = cubic ? array(node.controls, track.length - 1, track.length - 1).map(row => array(row, 4, 4).map(v => String(rational(v)))) : null;
    shape(node.envelope, ['width', 'height', 'measurement', 'glyph_paths']);
    const width = rational(node.envelope.width, 64), height = rational(node.envelope.height, 16);
    if (width.cmp(ZERO) <= 0 || height.cmp(ZERO) <= 0) throw new InvalidScene('Measured envelope must have positive dimensions');
    const meta = node.envelope.measurement; shape(meta, ['engine', 'version', 'font']);
    const measurement = {engine: text(meta.engine), version: text(meta.version), font: text(meta.font)};
    const {paths, count} = glyphs(node.envelope.glyph_paths, width, height); glyphCount += count;
    if (glyphCount > 32768) throw new InvalidScene('Scene glyph command budget exceeded');
    return {id, text: label, font_size: font, color: node.color.toUpperCase(), radius: String(radius), keyframes: track.map(k => k.map(String)), envelope: {width: String(width), height: String(height), measurement, glyph_paths: paths}, ...(cubic ? {controls} : {})};
  });
  return {schema: data.schema, duration: String(duration), nodes, export: output, margin: String(margin), camera_scales: scales.map(String), min_font_size: minFont};
}

// Keys in version 1 are ASCII. Values retain their validated Unicode code points.
export function canonicalSerialize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalSerialize).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalSerialize(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function sceneIdentity(scene) {
  const canonical = normalizeScene(scene);
  if (!globalThis.crypto?.subtle) throw new KinetylError('WebCrypto SHA256 requires a supported secure browser context');
  const bytes = new TextEncoder().encode(canonicalSerialize(canonical));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
class Budget {
  constructor(limit) { this.remaining = integer(limit, 1, 1000000); }
  spend(amount = 1) { this.remaining -= amount; if (this.remaining < 0) throw new SearchBudgetExceeded('Inconclusive: exact constraint/search work budget exhausted'); }
}
function point(track, time) {
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i];
    if (a[0].cmp(time) <= 0 && time.cmp(b[0]) <= 0) {
      const u = time.sub(a[0]).div(b[0].sub(a[0]));
      return [a[1].add(u.mul(b[1].sub(a[1]))), a[2].add(u.mul(b[2].sub(a[2])))];
    }
  }
  throw new InvalidScene('Time outside trajectory domain');
}
function overlap(a, ha, oa, b, hb, ob, margin, budget) {
  if (a.controls || b.controls) return overlapCurves(a, ha, oa, b, hb, ob, margin, budget);
  budget.spend();
  const times = new Map([...a, ...b].map(k => [String(k[0]), k[0]]));
  const cuts = Array.from(times.values()).sort((x, y) => x.cmp(y));
  for (let p = 1; p < cuts.length; p++) {
    budget.spend(4);
    const start = cuts[p - 1], end = cuts[p];
    const aa = point(a, start), ba = point(b, start), ae = point(a, end), be = point(b, end);
    let lower = start, upper = end, lowerOpen = false, upperOpen = false, empty = false;
    for (let axis = 0; axis < 2 && !empty; axis++) {
      const extent = ha[axis].add(hb[axis]).add(margin);
      const first = aa[axis].add(oa[axis]).sub(ba[axis]).sub(ob[axis]);
      const last = ae[axis].add(oa[axis]).sub(be[axis]).sub(ob[axis]);
      // Intersect strict slab inequalities -extent < delta(t) < extent.
      for (const sign of [ONE.neg(), ONE]) {
        const v = sign.mul(first).sub(extent), delta = sign.mul(last.sub(first));
        if (delta.eq(ZERO)) { if (v.cmp(ZERO) >= 0) empty = true; }
        else {
          const crossing = start.sub(v.mul(end.sub(start)).div(delta));
          if (delta.cmp(ZERO) > 0) {
            const compare = crossing.cmp(upper);
            if (compare < 0) { upper = crossing; upperOpen = true; }
            else if (compare === 0) upperOpen = true;
          } else {
            const compare = crossing.cmp(lower);
            if (compare > 0) { lower = crossing; lowerOpen = true; }
            else if (compare === 0) lowerOpen = true;
          }
        }
        const compare = lower.cmp(upper);
        if (compare > 0 || (compare === 0 && (lowerOpen || upperOpen))) empty = true;
        if (empty) break;
      }
    }
    if (!empty) return lower.add(upper).div(TWO);
  }
  return null;
}
function segmentPolynomials(track, start, end) {
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i];
    if (a[0].cmp(start) <= 0 && end.cmp(b[0]) <= 0) {
      const length = b[0].sub(a[0]), from = start.sub(a[0]).div(length), to = end.sub(a[0]).div(length);
      return [0, 1].map(axis => {
        const controls = track.controls?.[i - 1];
        const p = controls ? polynomial.bezierPower([a[axis + 1], controls[axis], controls[axis + 2], b[axis + 1]]) : [a[axis + 1], b[axis + 1].sub(a[axis + 1])];
        return polynomial.restrict(p, from, to);
      });
    }
  }
  throw new InvalidScene('Time outside trajectory segment domain');
}
function overlapCurves(a, ha, oa, b, hb, ob, margin, budget) {
  budget.spend();
  const times = new Map([...a, ...b].map(k => [String(k[0]), k[0]])), cuts = Array.from(times.values()).sort((x, y) => x.cmp(y));
  for (let i = 1; i < cuts.length; i++) {
    budget.spend(4); const start = cuts[i - 1], end = cuts[i];
    const pa = segmentPolynomials(a, start, end), pb = segmentPolynomials(b, start, end), inequalities = [];
    for (let axis = 0; axis < 2; axis++) {
      const extent = ha[axis].add(hb[axis]).add(margin);
      const delta = polynomial.add(polynomial.add(pa[axis], pb[axis].map(c => c.neg())), [oa[axis].sub(ob[axis])]);
      inequalities.push(polynomial.add(delta, [extent.neg()]), polynomial.add(delta.map(c => c.neg()), [extent.neg()]));
    }
    const witness = negativeWitness(inequalities, budget);
    if (witness !== null) return start.add(end.sub(start).mul(witness));
  }
  return null;
}
function inside(track, half, offset, viewport, budget) {
  if (track.controls) {
    for (let i = 1; i < track.length; i++) {
      budget.spend(2); const p = segmentPolynomials(track, track[i - 1][0], track[i][0]);
      for (let axis = 0; axis < 2; axis++) for (const sign of [ONE, ONE.neg()]) {
        const inequality = polynomial.add(p[axis].map(c => c.mul(sign).neg()), [viewport[axis].sub(half[axis]).sub(offset[axis].mul(sign))]);
        if (negativeWitness([inequality], budget) !== null) return false;
      }
    }
    return true;
  }
  budget.spend(2 * track.length);
  return track.every(k => [0, 1].every(axis => k[axis + 1].add(offset[axis]).abs().add(half[axis]).cmp(viewport[axis]) <= 0));
}
function slots(half, radius, gap) {
  const x = half[0].add(radius).add(gap), y = half[1].add(radius).add(gap);
  return [[ZERO, y], [ZERO, y.neg()], [x, ZERO], [x.neg(), ZERO], [x, y], [x.neg(), y], [x, y.neg()], [x.neg(), y.neg()], [ZERO, y.mul(TWO)], [ZERO, y.mul(TWO).neg()], [x.mul(TWO), ZERO], [x.mul(TWO).neg(), ZERO]];
}
function geometry(scene, scale) {
  return {tracks: scene.nodes.map(n => {
    const track = n.keyframes.map(k => k.map((v, j) => j ? rational(v).mul(scale) : rational(v)));
    if (n.controls) track.controls = n.controls.map(row => row.map(v => rational(v).mul(scale)));
    return track;
  }),
    halves: scene.nodes.map(n => [rational(n.envelope.width).div(TWO), rational(n.envelope.height).div(TWO)]),
    radii: scene.nodes.map(n => rational(n.radius)), viewport: [FOUR.mul(new Q(BigInt(scene.export.width), BigInt(scene.export.height))), FOUR], gap: rational(scene.margin)};
}
const checks = n => ({label_pair_checks: n * (n - 1) / 2, label_dot_checks: n * n, viewport_checks: 2 * n});
async function makePlan(scene, scale, offsets) {
  const {tracks, viewport} = geometry(scene, scale);
  return {schema: scene.schema === 'kinetyl-scene/2' ? 'kinetyl-plan/2' : 'kinetyl-plan/1', scene, input_sha256: await sceneIdentity(scene), layout: {camera_scale: String(scale),
    offsets: scene.nodes.map((n, i) => ({node_id: n.id, x: String(offsets[i][0]), y: String(offsets[i][1])})),
    projected_tracks: scene.nodes.map((n, i) => ({node_id: n.id, keyframes: tracks[i].map(k => k.map(String)), ...(tracks[i].controls ? {controls: tracks[i].controls.map(row => row.map(String))} : {})})),
    viewport: {half_width: String(viewport[0]), half_height: String(viewport[1])}}, verification: {...checks(scene.nodes.length), scope: sceneScope(scene)}};
}

export async function compileScene(data, {workBudget = 250000} = {}) {
  const scene = normalizeScene(data), budget = new Budget(workBudget), zero = [ZERO, ZERO];
  for (const value of scene.camera_scales) {
    budget.spend(); const scale = rational(value, 1);
    const {tracks, halves, radii, viewport, gap} = geometry(scene, scale), n = tracks.length;
    if (tracks.some((t, i) => !inside(t, [radii[i], radii[i]], zero, viewport, budget))) continue;
    const candidates = halves.map((h, i) => slots(h, radii[i], gap));
    const domains = candidates.map((family, i) => family.map((offset, k) => {
      budget.spend();
      return inside(tracks[i], halves[i], offset, viewport, budget) && tracks.every((t, j) => overlap(tracks[i], halves[i], offset, t, [radii[j], radii[j]], zero, gap, budget) === null) ? k : null;
    }).filter(k => k !== null));
    if (domains.some(d => !d.length)) continue;
    const forbidden = new Set();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (const a of domains[i]) for (const b of domains[j]) {
      if (overlap(tracks[i], halves[i], candidates[i][a], tracks[j], halves[j], candidates[j][b], gap, budget) !== null) forbidden.add(`${i}:${a}:${j}:${b}`);
    }
    const order = Array.from({length: n}, (_, i) => i).sort((a, b) => domains[a].length - domains[b].length), chosen = new Map();
    let best = null, bestCost = Infinity;
    function search(depth, cost) {
      budget.spend(); if (cost >= bestCost) return;
      if (depth === n) { best = new Map(chosen); bestCost = cost; return; }
      const i = order[depth];
      for (const a of domains[i]) {
        budget.spend();
        if (Array.from(chosen).some(([j, b]) => forbidden.has(i < j ? `${i}:${a}:${j}:${b}` : `${j}:${b}:${i}:${a}`))) continue;
        chosen.set(i, a); search(depth + 1, cost + a + 1); chosen.delete(i);
      }
    }
    search(0, 0);
    if (best) {
      const plan = await makePlan(scene, scale, candidates.map((family, i) => family[best.get(i)]));
      await verifyInternal(plan, budget); return plan;
    }
  }
  throw new NoSolution('No layout in the declared camera-scale and constant-offset candidate family');
}
async function verifyInternal(plan, budget) {
  try {
    shape(plan, ['schema', 'scene', 'input_sha256', 'layout', 'verification']);
    if (!['kinetyl-plan/1', 'kinetyl-plan/2'].includes(plan.schema)) throw new InvalidScene('Unsupported plan schema');
    const scene = normalizeScene(plan.scene);
    if (plan.schema !== (scene.schema === 'kinetyl-scene/2' ? 'kinetyl-plan/2' : 'kinetyl-plan/1')) throw new InvalidScene('Scene and plan schema version mismatch');
    const identity = await sceneIdentity(scene);
    if (typeof plan.input_sha256 !== 'string' || plan.input_sha256 !== identity || canonicalSerialize(plan.scene) !== canonicalSerialize(scene)) throw new InvalidScene('Plan scene identity or normalization mismatch');
    shape(plan.layout, ['camera_scale', 'offsets', 'projected_tracks', 'viewport']);
    const layout = plan.layout, scale = rational(layout.camera_scale, 1), n = scene.nodes.length;
    if (!scene.camera_scales.includes(String(scale))) throw new InvalidScene('Undeclared camera scale');
    const offsets = array(layout.offsets, n, n).map((row, i) => {
      shape(row, ['node_id', 'x', 'y']);
      if (row.node_id !== scene.nodes[i].id) throw new InvalidScene('Offset identity/order mismatch');
      return [rational(row.x, 128, 1024, 1024), rational(row.y, 128, 1024, 1024)];
    });
    array(layout.projected_tracks, n, n).forEach((row, i) => {
      shape(row, ['node_id', 'keyframes', ...(scene.schema === 'kinetyl-scene/2' ? ['controls'] : [])]);
      if (row.node_id !== scene.nodes[i].id) throw new InvalidScene('Projected track identity/order mismatch');
      array(row.keyframes, scene.nodes[i].keyframes.length, scene.nodes[i].keyframes.length).forEach(k => array(k, 3, 3).forEach(v => {
        if (typeof v !== 'string') throw new InvalidScene('Plan geometry must use canonical rational strings');
        rational(v, 10000, 1024, 1024);
      }));
      if (scene.schema === 'kinetyl-scene/2') array(row.controls, scene.nodes[i].controls.length, scene.nodes[i].controls.length).forEach(control => array(control, 4, 4).forEach(v => {
        if (typeof v !== 'string') throw new InvalidScene('Plan geometry must use canonical rational strings');
        rational(v, 10000, 1024, 1024);
      }));
    });
    shape(layout.viewport, ['half_width', 'half_height']);
    for (const v of Object.values(layout.viewport)) {
      if (typeof v !== 'string') throw new InvalidScene('Plan viewport must use canonical rational strings');
      rational(v, 256, 1024, 1024);
    }
    const expected = await makePlan(scene, scale, offsets);
    if (canonicalSerialize(layout) !== canonicalSerialize(expected.layout)) throw new InvalidScene('Noncanonical layout, altered trajectory or viewport');
    shape(plan.verification, ['label_pair_checks', 'label_dot_checks', 'viewport_checks', 'scope']);
    for (const [k, v] of Object.entries(checks(n))) if (!Number.isInteger(plan.verification[k]) || plan.verification[k] !== v) throw new InvalidScene('Forged verification counts');
    if (plan.verification.scope !== sceneScope(scene)) throw new InvalidScene('Unsupported verification scope');
    const {tracks, halves, radii, viewport, gap} = geometry(scene, scale), zero = [ZERO, ZERO];
    for (let i = 0; i < n; i++) {
      if (!slots(halves[i], radii[i], gap).some(o => o[0].eq(offsets[i][0]) && o[1].eq(offsets[i][1]))) throw new InvalidScene('Offset outside declared finite family');
      if (!inside(tracks[i], halves[i], offsets[i], viewport, budget) || !inside(tracks[i], [radii[i], radii[i]], zero, viewport, budget)) throw new InvalidScene('Viewport clipping');
      for (let j = 0; j < n; j++) if (overlap(tracks[i], halves[i], offsets[i], tracks[j], [radii[j], radii[j]], zero, gap, budget) !== null) throw new InvalidScene('Continuous label-dot conflict');
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (overlap(tracks[i], halves[i], offsets[i], tracks[j], halves[j], offsets[j], gap, budget) !== null) throw new InvalidScene('Continuous label-label conflict');
    return {valid: true, input_sha256: identity, checks: checks(n), scope: sceneScope(scene)};
  } catch (error) { if (error instanceof InvalidScene) throw new InvalidPlan(error.message); throw error; }
}
export async function verifyPlan(plan) {
  try { return await verifyInternal(plan, new Budget(1000000)); }
  catch (error) { if (error instanceof SearchBudgetExceeded) throw new InvalidPlan(error.message); throw error; }
}

/** Inspect arbitrary constant offsets, including an unsolved original layout.
 * Offsets are optional ordered {node_id,x,y} rows, defaulting to the top slot.
 * Collision times are exact interior witnesses, not sampled estimates.
 */
export function inspectLayout(data, {cameraScale = null, offsets = null, workBudget = 1000000} = {}) {
  const scene = normalizeScene(data), scale = rational(cameraScale ?? scene.camera_scales[0], 1);
  if (!scene.camera_scales.includes(String(scale))) throw new InvalidScene('Undeclared camera scale');
  const {tracks, halves, radii, viewport, gap} = geometry(scene, scale), n = tracks.length, budget = new Budget(workBudget), zero = [ZERO, ZERO];
  const selected = offsets === null ? halves.map((h, i) => slots(h, radii[i], gap)[0]) : array(offsets, n, n).map((row, i) => {
    shape(row, ['node_id', 'x', 'y']); if (row.node_id !== scene.nodes[i].id) throw new InvalidScene('Offset identity/order mismatch');
    return [rational(row.x, 128, 1024, 1024), rational(row.y, 128, 1024, 1024)];
  });
  const collisions = [], clipping = [];
  for (let i = 0; i < n; i++) {
    if (!inside(tracks[i], halves[i], selected[i], viewport, budget)) clipping.push({node_id: scene.nodes[i].id, geometry: 'label'});
    if (!inside(tracks[i], [radii[i], radii[i]], zero, viewport, budget)) clipping.push({node_id: scene.nodes[i].id, geometry: 'dot'});
    for (let j = 0; j < n; j++) {
      const time = overlap(tracks[i], halves[i], selected[i], tracks[j], [radii[j], radii[j]], zero, gap, budget);
      if (time !== null) collisions.push({kind: 'label-dot', node_ids: [scene.nodes[i].id, scene.nodes[j].id], time: String(time)});
    }
    for (let j = i + 1; j < n; j++) {
      const time = overlap(tracks[i], halves[i], selected[i], tracks[j], halves[j], selected[j], gap, budget);
      if (time !== null) collisions.push({kind: 'label-label', node_ids: [scene.nodes[i].id, scene.nodes[j].id], time: String(time)});
    }
  }
  return {valid: !collisions.length && !clipping.length, camera_scale: String(scale), collisions, clipping, checks: checks(n), scope: sceneScope(scene)};
}
