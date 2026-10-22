// Linked world-path authoring. Drawing floats never replace untouched source.
import {normalizeScene} from './geometry.mjs';

export const pathRows = scene => scene.nodes.map(n => ({id:n.id, keyframes:structuredClone(n.keyframes), ...(n.controls ? {controls:structuredClone(n.controls)} : {})}));
export function handles(scene) {
  return scene.nodes.flatMap((n,node) => [
    ...n.keyframes.map((p,index) => ({node,kind:'keyframe',index,part:0,label:`${n.id} · keyframe ${index+1} · t=${p[0]}`,x:p[1],y:p[2]})),
    ...(n.controls ?? []).flatMap((p,index) => [0,1].map(part => ({node,kind:'control',index,part,label:`${n.id} · segment ${index+1} · control ${part+1}`,x:p[part*2],y:p[part*2+1]})))
  ]);
}
function fraction(n,d=1n) { let a=n<0n?-n:n,b=d; while(b)[a,b]=[b,a%b]; n/=a;d/=a;return d===1n?String(n):`${n}/${d}`; }
export function nudge(value,steps) { const [n,d='1']=value.split('/');return fraction(BigInt(n)*20n+BigInt(steps)*BigInt(d),BigInt(d)*20n); }
export function snapped(value) { if(!Number.isFinite(value)||Math.abs(value)>10000)throw Error('Point exceeds the supported world range');return fraction(BigInt(Math.round(value*20)),20n); }
export function setPoint(scene,handle,x,y) {
  const next=structuredClone(scene), node=next.nodes[handle.node];
  if (!node || !handles(scene).some(h=>h.node===handle.node&&h.kind===handle.kind&&h.index===handle.index&&h.part===handle.part)) throw Error('Select an existing endpoint or control');
  const row=handle.kind==='keyframe'?node.keyframes[handle.index]:node.controls[handle.index], at=handle.kind==='keyframe'?1:handle.part*2;
  row[at]=x;row[at+1]=y;return normalizeScene(next);
}
export function createPathDraft(source) {
  let scene=normalizeScene(source), past=[], future=[];
  const snapshot=()=>pathRows(scene);
  function restore(rows) { const next=structuredClone(scene);rows.forEach((r,i)=>{next.nodes[i].keyframes=r.keyframes;if(r.controls)next.nodes[i].controls=r.controls;});scene=normalizeScene(next); }
  return {
    get:()=>structuredClone(scene),
    replace(next,{history=true}={}) { next=normalizeScene(next);if(JSON.stringify(pathRows(next))!==JSON.stringify(snapshot())&&history){past.push(snapshot());if(past.length>50)past.shift();future=[];}scene=next; },
    move(handle,x,y,history=true) { this.replace(setPoint(scene,handle,x,y),{history}); },
    checkpoint(rows) { if(JSON.stringify(rows)!==JSON.stringify(snapshot())){past.push(rows);if(past.length>50)past.shift();future=[];} },
    undo(){if(!past.length)return false;future.push(snapshot());restore(past.pop());return true;},
    redo(){if(!future.length)return false;past.push(snapshot());restore(future.pop());return true;},
    get canUndo(){return !!past.length;},get canRedo(){return !!future.length;}
  };
}

// Optional DOM adapter. Separate SVG means layout camera/aspect cannot move handles.
export function createAuthoring(doc,{number,onDraft,onDirty}) {
  const stage=doc.getElementById('author-stage');if(!stage)return null;
  const ids=['point','point-x','point-y','point-apply','point-cancel','path-undo','path-redo','author-mode','author-status','author-fit'];
  const el=Object.fromEntries(ids.map(id=>[id,doc.getElementById(id)]));
  let draft=null,selected=0,blocked=false,pending=false,drag=null,box=null;
  const ns='http://www.w3.org/2000/svg';
  const status=t=>{el['author-status'].textContent=t;};
  function point(){return draft?handles(draft.get())[selected]:null;}
  function syncFields(){const h=point();el['point-x'].value=h?.x??'';el['point-y'].value=h?.y??'';}
  function choices(){const hs=handles(draft.get());selected=Math.min(selected,hs.length-1);el.point.replaceChildren();hs.forEach((h,i)=>{const o=doc.createElement('option');o.value=String(i);o.textContent=h.label;el.point.appendChild(o);});el.point.value=String(selected);}
  function availability(){const locked=blocked||!draft;el.point.disabled=locked;for(const id of ['point-x','point-y','point-apply'])el[id].disabled=locked||!el['author-mode'].checked;el['author-fit'].disabled=locked||pending;el['path-undo'].disabled=locked||pending||!draft.canUndo;el['path-redo'].disabled=locked||pending||!draft.canRedo;}
  function svg(tag,attrs,parent=stage){const n=doc.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));parent.appendChild(n);return n;}
  function fit(){if(!draft)return;const hs=handles(draft.get()),xs=hs.map(h=>number(h.x)),ys=hs.map(h=>number(h.y));const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const pad=Math.max(1,(maxX-minX)/8,(maxY-minY)/8);box=[minX-pad,-maxY-pad,Math.max(2,maxX-minX+2*pad),Math.max(2,maxY-minY+2*pad)];}
  function draw(){stage.replaceChildren();if(!draft||!box)return;stage.setAttribute('viewBox',box.join(' '));
    const scene=draft.get(), hs=handles(scene),unit=Math.max(box[2],box[3])/90;
    svg('line',{x1:box[0],x2:box[0]+box[2],y1:0,y2:0,class:'author-axis'});svg('line',{x1:0,x2:0,y1:box[1],y2:box[1]+box[3],class:'author-axis'});
    scene.nodes.forEach((n,i)=>{let d=`M ${number(n.keyframes[0][1])} ${-number(n.keyframes[0][2])}`;n.keyframes.slice(1).forEach((p,j)=>{const c=n.controls?.[j];d+=c?` C ${number(c[0])} ${-number(c[1])} ${number(c[2])} ${-number(c[3])} ${number(p[1])} ${-number(p[2])}`:` L ${number(p[1])} ${-number(p[2])}`;if(c){for(const [pnt,at]of [[n.keyframes[j],0],[p,2]])svg('line',{x1:number(pnt[1]),y1:-number(pnt[2]),x2:number(c[at]),y2:-number(c[at+1]),class:'construction'});}});svg('path',{d,fill:'none',class:`author-curve series-${i%4}`});});
    hs.forEach((h,i)=>{const circle=svg('circle',{cx:number(h.x),cy:-number(h.y),r:unit*(i===selected?1.5:1),class:`handle ${h.kind} ${i===selected?'selected':''}`,tabindex:'0',role:'button','aria-label':h.label+`, x=${h.x}, y=${h.y}`});
      circle.addEventListener('pointerdown',event=>{if(!el['author-mode'].checked||blocked||pending||drag)return;event.preventDefault();select(i);drag={id:event.pointerId,scene:draft.get(),rows:pathRows(draft.get())};stage.focus?.();stage.setPointerCapture?.(event.pointerId);onDirty('Pointer edit in progress. Release to commit or Escape to cancel.');status('Dragging on 1/20 world-unit grid. Escape cancels.');});
      circle.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter',' '].includes(event.key))return;event.preventDefault();if(blocked||pending||drag)return;select(i);if(!el['author-mode'].checked)return;if(event.key.startsWith('Arrow')){const p=point(),dx=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0,dy=event.key==='ArrowDown'?-1:event.key==='ArrowUp'?1:0;draft.move(p,dx?nudge(p.x,dx):p.x,dy?nudge(p.y,dy):p.y);changed('Moved one 1/20 world-unit step.');const active=stage.querySelectorAll?.('.handle')[i];active?.focus();}});
      circle.addEventListener('click',()=>{if(!blocked&&!pending&&!drag)select(i);});
    });
  }
  function select(i){if(!draft)return;selected=i;el.point.value=String(i);syncFields();draw();}
  function changed(message){syncFields();availability();draw();onDraft(draft.get());status(message+' Draft needs compilation.');}
  function cancel(){if(drag){draft.replace(drag.scene,{history:false});const id=drag.id;drag=null;if(stage.hasPointerCapture?.(id))stage.releasePointerCapture(id);onDraft(draft.get());}pending=false;syncFields();availability();draw();status('Uncommitted point edit cancelled.');}
  function commitDrag(event){if(!drag||drag.id!==event.pointerId)return;const rows=drag.rows;drag=null;draft.checkpoint(rows);changed('Drag committed.');}
  stage.addEventListener('pointermove',event=>{if(!drag||blocked||event.pointerId!==drag.id)return;try{const p=stage.createSVGPoint();p.x=event.clientX;p.y=event.clientY;const ctm=stage.getScreenCTM();if(!ctm)throw Error('Editor transform unavailable');const q=p.matrixTransform(ctm.inverse());draft.move(point(),snapped(q.x),snapped(-q.y),false);changed('Dragging on 1/20 grid.');}catch(error){status(error.message+'; release or Escape to cancel.');}});
  stage.addEventListener('pointerup',commitDrag);stage.addEventListener('pointercancel',cancel);stage.addEventListener('lostpointercapture',()=>{if(drag)cancel();});
  stage.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();cancel();}});
  el.point.addEventListener('change',()=>{if(blocked||pending||drag){el.point.value=String(selected);status('Apply or cancel the pending point edit first.');return;}select(Number(el.point.value));});
  for(const id of ['point-x','point-y'])el[id].addEventListener('input',()=>{pending=true;onDirty('Coordinate fields are pending. Apply or cancel before compiling.');availability();});
  el['point-apply'].addEventListener('click',()=>{if(!draft||blocked||drag||!el['author-mode'].checked)return;try{draft.move(point(),el['point-x'].value.trim(),el['point-y'].value.trim());pending=false;changed('Exact coordinates applied.');}catch(e){status('Point refused: '+e.message+'; correct the fields or cancel.');}});
  for(const id of ['point-x','point-y'])el[id].addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();cancel();}if(e.key==='Enter'){e.preventDefault();el['point-apply'].click();}});
  el['point-cancel'].addEventListener('click',cancel);
  for(const [id,method]of [['path-undo','undo'],['path-redo','redo']])el[id].addEventListener('click',()=>{if(draft&&!blocked&&!pending&&!drag&&draft[method]()){choices();changed(method==='undo'?'Undid path edit.':'Redid path edit.');}});
  el['author-fit'].addEventListener('click',()=>{if(!drag&&!pending&&!blocked){fit();draw();status('World view fitted explicitly; coordinates unchanged.');}});
  el['author-mode'].addEventListener('change',()=>{if(drag)cancel();availability();draw();status(el['author-mode'].checked?'Path authoring enabled. This deliberately changes source motion.':'Path authoring off.');});
  return {
    load(scene,reset=false){if(reset||!draft){draft=createPathDraft(scene);selected=0;fit();}else draft.replace(scene,{history:false});blocked=false;pending=false;drag=null;choices();syncFields();availability();draw();},
    block(){blocked=true;availability();status('Source JSON has pending text. Apply JSON or discard it before a visual edit.');},
    unblock(){blocked=false;availability();status('JSON draft discarded. Visual draft retained.');},
    get:()=>draft?.get(), hasPending:()=>pending||!!drag,
    adopt(scene,message='JSON paths applied.'){if(pending||drag)throw Error('Apply or cancel the pending point edit first');draft.replace(scene);blocked=false;choices();changed(message);},
    verified(){status('Current source paths are compiled.');},
    cancel, getState:()=>({selected:point(),pending,blocked,dragging:!!drag,viewBox:box?.slice(),scene:draft?.get()})
  };
}
