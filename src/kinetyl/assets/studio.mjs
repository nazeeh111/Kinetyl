import {normalizeScene, compileScene, verifyPlan, inspectLayout, NoSolution, SearchBudgetExceeded} from './geometry.mjs';
import {createAuthoring, pathRows} from './authoring.mjs';

// Check structure before JSON.parse discards repeated keys. Imports stay data.
export function parseDocument(raw, maxBytes = 4194304) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > maxBytes) throw new Error('JSON exceeds its byte budget');
  let at = 0;
  function whitespace() { while (/[\t\n\r ]/.test(raw[at] ?? '\u0000')) at++; }
  function string() {
    const start = at++;
    while (at < raw.length) {
      const char = raw[at++];
      if (char === '\\') at++;
      else if (char === '"') return JSON.parse(raw.slice(start, at));
    }
    throw new Error('Unterminated JSON string');
  }
  function value(depth) {
    if (depth > 64) throw new Error('JSON nesting exceeds 64');
    whitespace(); const char = raw[at];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      at++; whitespace(); const close = char === '{' ? '}' : ']'; const names = new Set();
      if (raw[at] === close) { at++; return; }
      while (at < raw.length) {
        if (char === '{') {
          whitespace(); if (raw[at] !== '"') throw new Error('Expected JSON object key');
          const name = string(); if (names.has(name)) throw new Error('Duplicate JSON field: ' + name.slice(0, 80)); names.add(name);
          whitespace(); if (raw[at++] !== ':') throw new Error('Expected JSON colon');
        }
        value(depth + 1); whitespace();
        if (raw[at] === close) { at++; return; }
        if (raw[at++] !== ',') throw new Error('Expected JSON comma');
      }
      throw new Error('Unterminated JSON container');
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(at));
    if (!token) throw new Error('Invalid JSON value'); at += token[0].length;
  }
  value(0); whitespace(); if (at !== raw.length) throw new Error('Trailing JSON data');
  return JSON.parse(raw);
}

// Floating-point conversion is only for drawing. Acceptance uses geometry.mjs.
export function number(value) {
  if (typeof value === 'number') return value;
  if (!value.includes('/')) return Number(value);
  const [a, b] = value.split('/').map(BigInt);
  const magnitude = a < 0n ? -a : a;
  const sa = Math.max(0, magnitude.toString(2).length - 53), sb = Math.max(0, b.toString(2).length - 53);
  return (a < 0n ? -1 : 1) * Number(magnitude >> BigInt(sa)) / Number(b >> BigInt(sb)) * 2 ** (sa - sb);
}
export function pointAt(track, time, controls = null) {
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1].map(number), b = track[i].map(number);
    if (time <= b[0]) {
      const u = Math.max(0, Math.min(1, (time - a[0]) / (b[0] - a[0])));
      if (controls) {
        const c = controls[i - 1].map(number);
        return [0, 1].map(k => {
          let points = [a[k + 1], c[k], c[k + 2], b[k + 1]];
          while (points.length > 1) points = points.slice(1).map((v, j) => (1-u)*points[j] + u*v);
          return points[0];
        });
      }
      return [a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])];
    }
  }
  return track.at(-1).slice(1).map(number);
}
export function trajectoryPath(node, scale = 1) {
  const first = node.keyframes[0];
  const parts = [`M ${number(first[1])*scale} ${number(first[2])*scale}`];
  node.keyframes.slice(1).forEach((frame, i) => {
    if (node.controls) parts.push(`C ${node.controls[i].map(v => number(v)*scale).join(' ')} ${number(frame[1])*scale} ${number(frame[2])*scale}`);
    else parts.push(`L ${number(frame[1])*scale} ${number(frame[2])*scale}`);
  });
  return parts.join(' ');
}

export function editedScene(scene, raw) {
  if (new TextEncoder().encode(raw).length > 262144) throw new Error('Path editor exceeds 256 KiB');
  const rows = parseDocument(raw, 262144);
  if (!Array.isArray(rows) || rows.length !== scene.nodes.length) throw new Error('Keep every object identity and its order');
  const next = structuredClone(scene);
  rows.forEach((row, i) => {
    const keys = scene.schema.endsWith('/2') ? ['id', 'keyframes', 'controls'] : ['id', 'keyframes'];
    if (!row || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) || row.id !== scene.nodes[i].id) throw new Error('Keep the original id, keyframes and declared controls');
    next.nodes[i].keyframes = row.keyframes;
    if (scene.schema.endsWith('/2')) next.nodes[i].controls = row.controls;
  });
  return normalizeScene(next);
}
export function glyphPath(contours) {
  // All contours share one path so counters (holes) retain their winding.
  return contours.flatMap(contour => contour.map(([op, ...coordinates]) => op + coordinates.map(number).join(' '))).join(' ');
}

export function createStudio(doc, dependencies = {}) {
  const solve = dependencies.compileScene ?? compileScene;
  const verify = dependencies.verifyPlan ?? verifyPlan;
  const inspect = dependencies.inspectLayout ?? inspectLayout;
  const raf = dependencies.requestAnimationFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const caf = dependencies.cancelAnimationFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
  const fetcher = dependencies.fetch ?? globalThis.fetch?.bind(globalThis);
  const ids = ['stage', 'repaired', 'original', 'aspect', 'envelopes', 'stage-label', 'scale-label', 'play', 'time', 'time-label', 'witness', 'status-title', 'status-detail', 'metrics', 'notice', 'save-plan', 'save-scene', 'load', 'file', 'paths', 'apply', 'restore', 'edit-status'];
  const el = Object.fromEntries(ids.map(id => [id, doc.getElementById(id)]));
  let scene = null, plan = null, original = null, baseline = null, dirty = true;
  let mode = 'compiled', epoch = 0, playing = false, frame = null, startTime = null;
  const ns = 'http://www.w3.org/2000/svg';
  const authoring = createAuthoring(doc, {number,
    onDraft(next) { el.paths.value=JSON.stringify(pathRows(next),null,2);invalidate('Authored paths are a draft. Compile to verify their label layout.');draw(); },
    onDirty(message) { invalidate(message);draw(); }
  });
  let jsonPending=false;
  const write = (id, value) => { el[id].textContent = value; };
  function notice(message = '') { el.notice.hidden = !message; el.notice.textContent = message; }
  function downloads() {
    el['save-plan'].disabled = dirty || !plan;
    el['save-scene'].disabled = dirty || !plan;
  }
  function stop() {
    playing = false; startTime = null;
    if (frame !== null && caf) caf(frame);
    frame = null; write('play', '▶'); el.play.setAttribute('aria-label', 'Play animation');
  }
  function invalidate(message = 'Edited paths are not compiled. Preview still shows the previous document.') {
    epoch++; dirty = true; downloads(); stop();
    write('status-title', 'Changes need compilation'); write('status-detail', message);
    write('edit-status', 'Downloads paused until the current paths are compiled and verified.');
  }
  function svg(tag, attributes = {}, parent = el.stage) {
    const node = doc.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.appendChild(node); return node;
  }
  function draw() {
    el.stage.replaceChildren();
    if (!scene || !plan) return;
    const time = Math.max(0, Math.min(number(scene.duration), Number(el.time.value)));
    const scale = number(mode === 'before' ? baseline.camera_scale : plan.layout.camera_scale);
    const halfW = 4 * scene.export.width / scene.export.height;
    el.stage.setAttribute('viewBox', `${-halfW} -4 ${halfW * 2} 8`);
    el.stage.classList.toggle('portrait', scene.export.width < scene.export.height);
    el.stage.classList.toggle('square', scene.export.width === scene.export.height);
    const world = svg('g', {transform: 'scale(1,-1)'});
    // Grid is presentation geometry, capped even for tiny valid camera scales.
    const gridStep = Math.max(1, Math.ceil(halfW / 12));
    for (let x = Math.ceil(-halfW / gridStep); x <= halfW / gridStep; x++) svg('line', {x1: x * gridStep, x2: x * gridStep, y1: -4, y2: 4, stroke: x ? '#e5e7eb' : '#94a3b8', 'stroke-width': .012}, world);
    for (let y = -4; y <= 4; y++) svg('line', {x1: -halfW, x2: halfW, y1: y, y2: y, stroke: y ? '#e5e7eb' : '#94a3b8', 'stroke-width': .012}, world);
    scene.nodes.forEach((node, i) => {
      const color=['#1d4ed8','#a21caf','#0f766e','#b45309'][i%4];
      const [wx, wy] = pointAt(node.keyframes, time, node.controls), x = wx * scale, y = wy * scale;
      const hx = number(node.envelope.width) / 2, hy = number(node.envelope.height) / 2, r = number(node.radius);
      const offset = mode === 'before' ? [0, hy + r + number(scene.margin)] : [number(plan.layout.offsets[i].x), number(plan.layout.offsets[i].y)];
      svg('path', {d: trajectoryPath(node, scale), fill: 'none', stroke: color, opacity: .25, 'stroke-width': .023, 'stroke-dasharray': '.06 .10'}, world);
      svg('line', {x1: x, y1: y, x2: x + offset[0], y2: y + offset[1], stroke: color, opacity: .38, 'stroke-width': .014}, world);
      svg('rect', {x: x - r, y: y - r, width: 2 * r, height: 2 * r, fill: color}, world);
      const label = svg('g', {transform: `translate(${x + offset[0]},${y + offset[1]})`}, world);
      if (node.envelope.glyph_paths.length) svg('path', {d: glyphPath(node.envelope.glyph_paths), fill: color, 'fill-rule': 'nonzero'}, label);
      else {
        const text = svg('text', {transform: 'scale(1,-1)', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': Math.min(.36, hy * 1.5), fill: color}, label);
        text.textContent = node.text;
      }
      if (el.envelopes.checked) {
        svg('rect', {x: -hx, y: -hy, width: 2 * hx, height: 2 * hy, fill: 'none', stroke: color, opacity: .7, 'stroke-width': .012}, label);
        svg('rect', {x: x - r, y: y - r, width: 2 * r, height: 2 * r, fill: 'none', stroke: '#fff', 'stroke-width': .01}, world);
      }
    });
    write('time-label', `${time.toFixed(2)} s`);
    write('scale-label', `CAMERA × ${mode === 'before' ? baseline.camera_scale : plan.layout.camera_scale}`);
    write('stage-label', `${dirty ? 'Previous document · ' : ''}${mode === 'before' ? 'Before: all labels above their marker' : 'Compiled: declared geometry preview'}`);
  }
  function metrics() {
    el.metrics.replaceChildren();
    for (const [key, value] of [['Objects', scene.nodes.length], ['Label pairs', plan.verification.label_pair_checks], ['Label / marker pairs', plan.verification.label_dot_checks], ['Viewport checks', plan.verification.viewport_checks], ['Duration', `${scene.duration} s`]]) {
      const dt = doc.createElement('dt'), dd = doc.createElement('dd'); dt.textContent = key; dd.textContent = String(value); el.metrics.appendChild(dt); el.metrics.appendChild(dd);
    }
  }
  function aspectValue(s) { return s.export.width === s.export.height ? 'square' : s.export.width > s.export.height ? 'wide' : 'portrait'; }
  function accept(next, first = false) {
    plan = structuredClone(next); scene = structuredClone(plan.scene);
    if (first) original = structuredClone(scene);
    baseline = inspect(scene);
    dirty = false; downloads(); notice(); stop();
    el.paths.value = JSON.stringify(scene.nodes.map(n => ({id: n.id, keyframes: n.keyframes, ...(n.controls ? {controls: n.controls} : {})})), null, 2);
    jsonPending=false;authoring?.load(scene, first);
    el.time.max = String(number(scene.duration)); el.time.value = '0'; el.aspect.value = aspectValue(scene);
    el.witness.disabled = !baseline.collisions.length;
    write('status-title', 'Full trajectory checked');
    const conflict = baseline.collisions[0];
    write('status-detail', conflict ? `Before placement overlaps around ${number(conflict.time).toFixed(3)} s. Compiled label envelopes and marker squares remain separated throughout the declared motion.` : 'The exported layout passes every declared label, marker and viewport constraint across the full time interval.');
    write('edit-status', 'Current source paths are compiled. Native video requires a separate renderer check.');
    if (scene.nodes.some(n => !n.envelope.glyph_paths.length)) notice('Some labels have no native outline. Fallback text is illustrative; only the declared rectangles are checked.');
    const sceneNote = doc.getElementById('scene-note');
    if (sceneNote) sceneNote.textContent = scene.schema.endsWith('/2') ? 'Cubic paths preserve their control points and segment times. Switch Before / Compiled, then change the aspect ratio. Labels keep their measured size.' : 'Piecewise linear motion. World paths and event times stay fixed while label placement and camera scale change.';
    metrics(); draw();
  }
  async function compile(next, first = false) {
    const revision = ++epoch; dirty = true; downloads(); stop();
    write('status-title', 'Solving the declared layout…'); write('status-detail', 'World paths and event times stay fixed. Searching permitted offsets and camera scales.');
    try {
      const result = await solve(next);
      await verify(result);
      if (revision !== epoch) return false;
      accept(result, first); return true;
    } catch (error) {
      if (revision !== epoch) return false;
      write('status-title', error instanceof NoSolution ? 'No layout in this family' : error instanceof SearchBudgetExceeded ? 'Search is inconclusive' : 'Input refused');
      write('status-detail', error.message); write('edit-status', 'No new verified plan. Edit the paths or restore the original.');
      notice(scene ? 'Previous document retained for recovery. Downloads remain disabled.' : 'No verified document loaded.');
      draw(); return false;
    }
  }
  async function loadDocument(data) {
    const revision = ++epoch; dirty = true; downloads(); stop();
    try {
      if (['kinetyl-plan/1', 'kinetyl-plan/2'].includes(data?.schema)) {
        await verify(data);
        if (revision !== epoch) return false;
        accept(data, true); return true;
      }
      const next = normalizeScene(data);
      if (revision !== epoch) return false;
      if(authoring){authoring.load(next,true);el.paths.value=JSON.stringify(pathRows(next),null,2);jsonPending=false;}
      return await compile(next, true);
    } catch (error) {
      if (revision !== epoch) return false;
      write('status-title', 'Import refused'); write('status-detail', error.message);
      notice(scene ? 'Previous document retained for recovery. Restore original to re-enable its downloads.' : 'Import a supported measured scene or independently valid plan.'); draw(); return false;
    }
  }
  function emitDownload(value, filename) {
    if (dependencies.download) return dependencies.download(value, filename);
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], {type: 'application/json'}));
    const anchor = doc.createElement('a'); anchor.href = url; anchor.download = filename;
    doc.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function save(value, filename) { if(!dirty&&plan)emitDownload(value,filename); }
  el.paths.addEventListener('input', () => { const raw=el.paths.value;authoring?.cancel();el.paths.value=raw;jsonPending=true;authoring?.block();invalidate(); draw(); });
  el.apply.addEventListener('click', async () => {
    if (!scene&&!authoring?.get()) return;
    try { if(authoring?.hasPending())throw Error('Apply or cancel the pending point coordinates first');const next=editedScene(authoring?.get()??scene, el.paths.value);if(jsonPending)authoring?.adopt(next);jsonPending=false;await compile(next); }
    catch (error) { invalidate('Edited paths were refused: ' + error.message); write('edit-status', error.message); draw(); }
  });
  el.restore.addEventListener('click', async () => { if (original) {authoring?.cancel();const restored=await compile(original);if(restored)authoring?.load(scene,true);} });
  doc.getElementById('json-apply')?.addEventListener('click',()=>{if(!scene&&!authoring?.get())return;try{const next=editedScene(authoring?.get()??scene,el.paths.value);authoring?.adopt(next);jsonPending=false;write('edit-status','JSON applied to visual draft. Compile to verify.');}catch(error){write('edit-status','JSON refused: '+error.message);}});
  doc.getElementById('json-discard')?.addEventListener('click',()=>{const next=authoring?.get();if(!next)return;el.paths.value=JSON.stringify(pathRows(next),null,2);jsonPending=false;authoring.unblock();invalidate('JSON text discarded. Visual draft retained; compile to verify.');draw();});
  el.aspect.addEventListener('change', async () => {
    if (!scene&&!authoring?.get()) return;
    try {
      if(authoring?.hasPending())throw Error('Apply or cancel pending point coordinates first');
      if(jsonPending)throw Error('Apply or discard pending JSON text before changing the canvas');
      const next = editedScene(authoring?.get()??scene, el.paths.value);
      const sizes = {wide: [960, 540], portrait: [540, 960], square: [720, 720]};
      const size = sizes[el.aspect.value]; if (!size) throw new Error('Unsupported canvas aspect');
      [next.export.width, next.export.height] = size;authoring?.adopt(next);await compile(next);
    } catch (error) { invalidate('Canvas change refused: ' + error.message); draw(); }
  });
  for (const [id, next] of [['original', 'before'], ['repaired', 'compiled']]) el[id].addEventListener('click', () => {
    mode = next; el.original.setAttribute('aria-pressed', String(mode === 'before')); el.repaired.setAttribute('aria-pressed', String(mode === 'compiled')); draw();
  });
  el.envelopes.addEventListener('change', draw);
  el.time.addEventListener('input', () => { stop(); draw(); });
  el.witness.addEventListener('click', () => { if (baseline?.collisions.length) { stop(); el.time.value = String(number(baseline.collisions[0].time)); el.original.click(); draw(); } });
  function tick(now) {
    if (!playing || !scene) return;
    if (startTime === null) startTime = now - Number(el.time.value) * 1000;
    const value = (now - startTime) / 1000;
    el.time.value = String(Math.min(value, number(scene.duration))); draw();
    if (value >= number(scene.duration)) stop(); else frame = raf(tick);
  }
  el.play.addEventListener('click', () => {
    if (playing) return stop();
    if (!scene || !plan || !raf) return;
    if (Number(el.time.value) >= number(scene.duration)) el.time.value = '0';
    playing = true; startTime = null; write('play', 'Ⅱ'); el.play.setAttribute('aria-label', 'Pause animation'); frame = raf(tick);
  });
  el['save-plan'].addEventListener('click', () => save(plan, 'kinetyl-plan.json'));
  el['save-scene'].addEventListener('click', () => save(scene, 'kinetyl-scene.json'));
  doc.getElementById('save-draft')?.addEventListener('click',()=>{const next=authoring?.get();if(!next)return;if(jsonPending||authoring.hasPending()){write('edit-status','Apply or cancel pending point fields and apply/discard JSON text before saving the source draft.');return;}emitDownload(normalizeScene(next),'kinetyl-unverified-draft.scene.json');write('edit-status','Saved source draft, not a verified layout. No compiled plan was exported.');});
  el.load.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', async () => {
    const file = el.file.files?.[0]; if (!file) return;
    const revision = ++epoch; dirty = true; downloads(); stop();
    try {
      if (file.size > 4194304) throw new Error('Import exceeds 4 MiB');
      const text = await file.text();
      if (revision !== epoch) return;
      if (new TextEncoder().encode(text).length > 4194304) throw new Error('Import exceeds 4 MiB');
      await loadDocument(parseDocument(text));
    } catch (error) {
      if (revision !== epoch) return;
      write('status-title', 'Import refused'); write('status-detail', error.message); notice('Previous document retained. Restore original to recover.'); draw();
    } finally { el.file.value = ''; }
  });
  async function start() {
    const revision = ++epoch;
    try {
      const response = await fetcher('plan.json'); if (!response.ok) throw new Error('Could not load the bundled plan');
      const text = await response.text(); if (new TextEncoder().encode(text).length > 4194304) throw new Error('Bundled plan exceeds 4 MiB');
      if (revision !== epoch) return false;
      return await loadDocument(parseDocument(text));
    } catch (error) {
      if (revision !== epoch) return false;
      write('status-title', 'No verified plan loaded'); write('status-detail', error.message); notice('Use a supported browser over HTTPS or localhost, or import a measured scene.'); return false;
    }
  }
  return {start, loadDocument, compile, stop, getAuthoringState:()=>authoring?.getState(), getState: () => ({scene: structuredClone(scene), plan: structuredClone(plan), dirty, mode, epoch})};
}

if (typeof document !== 'undefined') createStudio(document).start();
