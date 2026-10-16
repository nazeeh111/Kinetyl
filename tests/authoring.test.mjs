import assert from 'node:assert/strict';
import test from 'node:test';
import {createStudio, editedScene, glyphPath, pointAt, trajectoryPath, number, parseDocument} from '../src/kinetyl/assets/studio.mjs';
import {compileScene, verifyPlan, normalizeScene, NoSolution, SearchBudgetExceeded} from '../src/kinetyl/assets/geometry.mjs';

const IDS = ['author-stage','point','point-x','point-y','point-apply','point-cancel','path-undo','path-redo','author-mode','author-status','author-fit','json-apply','json-discard','save-draft','stage', 'repaired', 'original', 'aspect', 'envelopes', 'stage-label', 'scale-label', 'play', 'time', 'time-label', 'witness', 'status-title', 'status-detail', 'metrics', 'notice', 'save-plan', 'save-scene', 'load', 'file', 'paths', 'apply', 'restore', 'edit-status'];
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
  emit(type, extra={}) { return Promise.all((this.listeners.get(type) ?? []).map(fn => fn({type, target:this, preventDefault(){}, ...extra}))); }
  focus(){this.focused=true;}
  setPointerCapture(id){this.capture=id;}
  hasPointerCapture(id){return this.capture===id;}
  releasePointerCapture(){this.capture=null;}
  getScreenCTM(){return {inverse:()=>({})};}
  createSVGPoint(){return {x:0,y:0,matrixTransform(){return {x:this.x,y:this.y};}};}
  querySelectorAll(){return descendants(this).filter(n=>n.getAttribute('class')?.split(' ').includes('handle'));}
  click() { return this.disabled ? Promise.resolve([]) : this.emit('click'); }
}
class FakeDocument {
  constructor() { this.elements = Object.fromEntries(IDS.map(id => [id, new FakeElement(id === 'stage' ? 'svg' : 'div')])); this.body = new FakeElement('body'); this.elements.time.value = '0'; this.elements.aspect.value = 'wide'; }
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

import {createPathDraft,handles,setPoint,nudge,snapped,pathRows} from '../src/kinetyl/assets/authoring.mjs';
function cubic(){const s=scene();s.schema='kinetyl-scene/2';s.nodes.forEach((n,i)=>{n.envelope.width='1';n.keyframes=[['0',i?'2':'-2','0'],['3',i?'-2':'2','0']];n.controls=[[i?'2':'-2','9007199254740993/9007199254740992',i?'-2':'2','1']];});return normalizeScene(s);}
function handleNode(h,index){return descendants(h.el['author-stage']).filter(n=>n.getAttribute('class')?.split(' ').includes('handle'))[index];}
async function enabled(h){h.el['author-mode'].checked=true;await h.el['author-mode'].emit('change');}
async function select(h,index){h.el.point.value=String(index);await h.el.point.emit('change');}

test('draft edit changes one exact stored point only; undo and redo preserve every other field',()=>{
 const source=cubic(),d=createPathDraft(source),hs=handles(source),p=hs.find(h=>h.kind==='control');
 d.move(p,'7/3','4/3');const expected=structuredClone(source);expected.nodes[0].controls[0][0]='7/3';expected.nodes[0].controls[0][1]='4/3';assert.deepEqual(d.get(),expected);
 assert(d.undo());assert.deepEqual(d.get(),source);assert(d.redo());assert.deepEqual(d.get(),expected);
 const key=handles(d.get()).find(h=>h.kind==='keyframe');d.move(key,'-3/2',key.y);expected.nodes[0].keyframes[0][1]='-3/2';assert.deepEqual(d.get(),expected);
 assert.throws(()=>d.move(key,'1/0','2'));assert.deepEqual(d.get(),expected);
});
test('one-axis exact nudge retains high precision untouched axis; pointer grid affects only supplied point',()=>{
 const s=cubic(),p=handles(s).find(h=>h.kind==='control');const edited=setPoint(s,p,nudge(p.x,1),p.y);
 assert.equal(edited.nodes[0].controls[0][1],'9007199254740993/9007199254740992');assert.equal(edited.nodes[1].controls[0][1],s.nodes[1].controls[0][1]);
 assert.equal(nudge('1/3',1),'23/60');assert.equal(nudge('1/3',-1),'17/60');assert.equal(snapped(1.51),'3/2');assert.equal(snapped(-.49),'-1/2');assert.throws(()=>snapped(Infinity));
 const d=createPathDraft(s);const portrait=structuredClone(s);portrait.export.width=540;portrait.export.height=960;d.replace(portrait,{history:false});assert.equal(d.get().export.width,540);assert.deepEqual(pathRows(d.get()),pathRows(s));
});
test('exact coordinate pending blocks compile, gates downloads, then commit and save verified source',async()=>{
 const h=harness();await h.studio.loadDocument(cubic());await enabled(h);await select(h,2);
 h.el['point-x'].value='7/3';h.el['point-y'].value='4/3';await h.el['point-x'].emit('input');await h.el.apply.click();assert.equal(h.studio.getState().dirty,true);assert.equal(h.el['save-plan'].disabled,true);assert.match(h.el['status-detail'].textContent,/pending point/);
 await h.el['point-apply'].click();assert.equal(JSON.parse(h.el.paths.value)[0].controls[0][0],'7/3');await h.el.apply.click();assert.equal(h.studio.getState().dirty,false);await h.el['save-plan'].click();assert.equal(h.downloads[0].value.scene.nodes[0].controls[0][0],'7/3');assert((await verifyPlan(h.downloads[0].value)).valid);
});
test('pending invalid JSON cannot be overwritten by visual controls; explicit discard recovers visual draft',async()=>{
 const h=harness();await h.studio.loadDocument(cubic());await enabled(h);const prior=h.el.paths.value;
 h.el.paths.value='[incomplete';await h.el.paths.emit('input');assert.equal(h.el['point-apply'].disabled,true);await h.el['point-apply'].emit('click');await handleNode(h,0).emit('keydown',{key:'ArrowRight'});assert.equal(h.el.paths.value,'[incomplete');await h.el['json-apply'].click();assert.match(h.el['edit-status'].textContent,/JSON refused/);assert.equal(h.el.paths.value,'[incomplete');
 await h.el['json-discard'].click();assert.equal(h.el.paths.value,prior);assert.equal(h.el['point-apply'].disabled,false);assert.equal(h.el['save-plan'].disabled,true);await h.el.apply.click();assert.equal(h.studio.getState().dirty,false);
});
test('world view remains stable through exact edits and aspect change; offscreen points retain selection and exact fields',async()=>{
 const h=harness();await h.studio.loadDocument(cubic());await enabled(h);const box=h.studio.getAuthoringState().viewBox;
 h.el['point-x'].value='10000';h.el['point-y'].value='0';await h.el['point-x'].emit('input');await h.el['point-apply'].click();assert.deepEqual(h.studio.getAuthoringState().viewBox,box);assert.equal(h.el['point-x'].value,'10000');assert.equal(h.studio.getAuthoringState().scene.nodes[0].keyframes[0][1],'10000');
 await h.el['path-undo'].click();h.el.aspect.value='portrait';await h.el.aspect.emit('change');assert.deepEqual(h.studio.getAuthoringState().viewBox,box);assert.equal(h.studio.getAuthoringState().scene.export.width,540);assert.equal(h.studio.getAuthoringState().scene.nodes[0].controls[0][1],'9007199254740993/9007199254740992');
});
test('pointer cancel restores exact source and committed pointer matches exact fields; undo/redo retains controls',async()=>{
 const h=harness();await h.studio.loadDocument(cubic());await enabled(h);const initial=h.el.paths.value;
 await handleNode(h,0).emit('pointerdown',{pointerId:1});await h.el['author-stage'].emit('pointermove',{pointerId:1,clientX:1.51,clientY:.49});assert.equal(JSON.parse(h.el.paths.value)[0].keyframes[0][1],'3/2');await h.el['author-stage'].emit('keydown',{key:'Escape'});assert.equal(h.el.paths.value,initial);
 await handleNode(h,0).emit('pointerdown',{pointerId:2});await h.el['author-stage'].emit('pointermove',{pointerId:2,clientX:1.51,clientY:.49});await h.el['author-stage'].emit('pointerup',{pointerId:2});assert.equal(h.el['point-x'].value,'3/2');assert.equal(h.el['point-y'].value,'-1/2');
 await h.el['path-undo'].click();assert.equal(h.el.paths.value,initial);await h.el['path-redo'].click();assert.equal(h.el['point-x'].value,'3/2');assert.equal(h.studio.getAuthoringState().scene.nodes[0].controls[0][1],'9007199254740993/9007199254740992');
});
test('keyboard changes only one axis and v1 endpoint stays supported',async()=>{
 const h=harness();await h.studio.loadDocument(cubic());await enabled(h);const before=h.studio.getAuthoringState().scene;await handleNode(h,2).emit('keydown',{key:'ArrowRight'});const after=h.studio.getAuthoringState().scene;const expected=structuredClone(before);expected.nodes[0].controls[0][0]=nudge(expected.nodes[0].controls[0][0],1);assert.deepEqual(after,expected);
 await h.studio.loadDocument(scene());assert(handles(h.studio.getAuthoringState().scene).every(p=>p.kind==='keyframe'));await handleNode(h,0).emit('keydown',{key:'ArrowRight'});assert.equal(h.studio.getAuthoringState().scene.nodes[0].keyframes[0][1],'-39/20');
});
test('pending coordinate edit during delayed verification cannot replace the newer draft or enable downloads',async()=>{
 const gate=deferred();let delay=false;const h=harness({verifyPlan:async p=>{if(delay)await gate.promise;return verifyPlan(p);}});await h.studio.loadDocument(cubic());await enabled(h);delay=true;const compiling=h.studio.compile(cubic());await turn();h.el['point-x'].value='1/';await h.el['point-x'].emit('input');gate.resolve();assert.equal(await compiling,false);assert.equal(h.el['save-plan'].disabled,true);assert.equal(h.el['point-x'].value,'1/');await h.el['point-cancel'].click();assert.equal(h.el['point-x'].value,'-2');
});
test('shared interior keyframe changes that row only; adjacent controls and times are not linked',()=>{
 const s=cubic();s.nodes.forEach(n=>{n.keyframes.splice(1,0,['3/2','0','1']);n.controls.push(structuredClone(n.controls[0]));});const h=handles(s).find(h=>h.node===0&&h.kind==='keyframe'&&h.index===1);const expected=structuredClone(s);expected.nodes[0].keyframes[1][1]='1/3';assert.deepEqual(setPoint(s,h,'1/3',h.y),expected);
});
test('inconclusive changed draft stays recoverable; unverified draft save never enables or emits stale plan',async()=>{
 let fail=false;const h=harness({compileScene:s=>{if(fail)throw new SearchBudgetExceeded('Inconclusive: exact work exhausted');return compileScene(s);}});await h.studio.loadDocument(cubic());await enabled(h);const prior=h.studio.getState().plan;
 h.el['point-x'].value='-3/2';await h.el['point-x'].emit('input');await h.el['save-draft'].click();assert.equal(h.downloads.length,0);await h.el['point-apply'].click();fail=true;await h.el.apply.click();assert.equal(h.el['status-title'].textContent,'Search is inconclusive');assert.equal(h.el['save-plan'].disabled,true);assert.deepEqual(h.studio.getState().plan,prior);assert.equal(h.studio.getAuthoringState().scene.nodes[0].keyframes[0][1],'-3/2');
 await h.el['save-plan'].emit('click');assert.equal(h.downloads.length,0);await h.el['save-draft'].click();assert.equal(h.downloads.length,1);assert.equal(h.downloads[0].filename,'kinetyl-unverified-draft.scene.json');assert.equal(h.downloads[0].value.nodes[0].keyframes[0][1],'-3/2');assert.equal(h.downloads[0].value.nodes[0].controls[0][1],'9007199254740993/9007199254740992');assert.match(h.el['edit-status'].textContent,/not a verified layout/);
 fail=false;await h.el.restore.click();assert.deepEqual(h.studio.getState().plan,prior);assert.equal(h.studio.getState().dirty,false);
});
test('valid advanced JSON changes rebuild available point identities without silent source loss',async()=>{
 const h=harness();await h.studio.loadDocument(cubic());await enabled(h);let rows=JSON.parse(h.el.paths.value);rows.forEach(n=>{n.keyframes.splice(1,0,['3/2','0','1']);n.controls.push(structuredClone(n.controls[0]));});h.el.paths.value=JSON.stringify(rows);await h.el.paths.emit('input');await h.el['json-apply'].click();assert.equal(h.el.point.children.length,14);assert.equal(h.studio.getAuthoringState().scene.nodes[0].keyframes[1][0],'3/2');assert.equal(h.el['point-apply'].disabled,false);
});
test('valid inconclusive import exposes its unsolved source draft while preserving previous verified document',async()=>{
 let fail=false;const h=harness({compileScene:s=>{if(fail)throw new SearchBudgetExceeded('Exact work exhausted');return compileScene(s);}});await h.studio.loadDocument(cubic());const previous=h.studio.getState().plan;const incoming=cubic();incoming.nodes[0].keyframes[0][1]='-3/2';fail=true;assert.equal(await h.studio.loadDocument(incoming),false);assert.deepEqual(h.studio.getState().plan,previous);assert.equal(h.studio.getAuthoringState().scene.nodes[0].keyframes[0][1],'-3/2');assert.equal(h.el['save-plan'].disabled,true);await h.el['save-draft'].click();assert.equal(h.downloads[0].value.nodes[0].keyframes[0][1],'-3/2');
});

// Controller-state regressions use a stub plan, not another geometry search.
function controllerHarness(solve) {
 const makePlan=s=>({scene:normalizeScene(s),layout:{camera_scale:'1',offsets:s.nodes.map(()=>({x:'0',y:'1'}))},verification:{label_pair_checks:0,label_dot_checks:0,viewport_checks:0}});
 return harness({compileScene:solve??makePlan,verifyPlan:()=>({valid:true}),inspectLayout:()=>({camera_scale:'1',collisions:[]})});
}
async function applyX(h,x){h.el['point-x'].value=x;await h.el['point-x'].emit('input');await h.el['point-apply'].click();}
test('undo and redo rebuild changed JSON point identities and clamp selection',async()=>{
 const h=controllerHarness();await h.studio.loadDocument(scene());await enabled(h);
 const rows=JSON.parse(h.el.paths.value);rows.forEach(n=>n.keyframes.splice(1,0,['3/2','0','1']));
 h.el.paths.value=JSON.stringify(rows);await h.el.paths.emit('input');await h.el['json-apply'].click();await select(h,5);
 await h.el['path-undo'].click();assert.equal(h.el.point.children.length,4);assert(h.studio.getAuthoringState().selected);assert.equal(h.el.point.value,'3');
 await select(h,2);assert.equal(h.el.point.children[2].textContent,'node1 · keyframe 1 · t=0');
 await h.el['path-redo'].click();assert.equal(h.el.point.children.length,6);assert.equal(h.el.point.children[2].textContent,'node0 · keyframe 3 · t=3');
 await h.el['path-undo'].click();await select(h,2);await applyX(h,'7/3');assert.equal(h.studio.getAuthoringState().scene.nodes[1].keyframes[0][1],'7/3');
});
test('stale restore success or failure preserves newer history, selection and world view',async()=>{
 for(const reject of [false,true]){
  let gate=null;const h=controllerHarness(async s=>{const wait=gate;gate=null;if(wait)await wait.promise;return {scene:normalizeScene(s),layout:{camera_scale:'1',offsets:s.nodes.map(()=>({x:'0',y:'1'}))},verification:{label_pair_checks:0,label_dot_checks:0,viewport_checks:0}};});
  await h.studio.loadDocument(scene());await enabled(h);await applyX(h,'-3/2');await h.el.apply.click();
  const pending=deferred();gate=pending;const restore=h.el.restore.click();await turn();await select(h,1);await applyX(h,'5/2');await h.el.apply.click();
  const before=h.studio.getAuthoringState();assert.equal(h.el['path-undo'].disabled,false);
  if(reject)pending.reject(new Error('old restore failed'));else pending.resolve();await restore;
  assert.equal(h.el['path-undo'].disabled,false);assert.deepEqual(h.studio.getAuthoringState(),before);
  await h.el.restore.click();assert.equal(h.studio.getAuthoringState().selected.index,0);assert.equal(h.el['path-undo'].disabled,true);assert.equal(h.studio.getAuthoringState().scene.nodes[0].keyframes[0][1],'-2');
 }
});
