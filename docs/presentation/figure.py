"""Source-derived, common-scale detail at t=3; no sampled proof or pixel claim."""
from pathlib import Path
from fractions import Fraction as F
import json,html,hashlib
P=Path(__file__).resolve().parent
plan=json.loads((P/'edited-wide.plan.json').read_text());s=plan['scene'];out=[]
def n(x):return float(F(str(x)))
def at(node):
 a,b=node['keyframes'];c=node['controls'][0];u=F(1,2)
 return [float((1-u)**3*F(a[k+1])+3*(1-u)**2*u*F(c[k])+3*(1-u)*u*u*F(c[k+2])+u**3*F(b[k+1])) for k in range(2)]
def text(x,y,t,size=15,color='#edeef0'):return f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}">{html.escape(t)}</text>'
def draw(mobile):
 W=375 if mobile else 1200;H=880 if mobile else 570;parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc"><title id="title">One edited trajectory, two placements</title><desc id="desc">Common-scale cropped detail of the actual edited wide plan at three seconds. The actual studio Before places labels above their markers; Alpha and Beta envelopes overlap. Compiled offsets separate the labels. World curves and time are identical. This illustration is not the continuous verification.</desc><rect width="100%" height="100%" fill="#101214"/><g font-family="Arial, Helvetica, sans-serif">']
 parts +=[text(22,36,'KINETYL / MOTION CONSTRAINTS',13,'#efbe7a'),text(22,72,'Keep the path. Move the label.',22 if mobile else 34)]
 for k in range(2):
  x=18 if mobile else 22+k*585;y=112+k*325 if mobile else 112;w=339 if mobile else 563;h=300
  parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="2" fill="#191c20" stroke="#424750"/>');parts +=[text(x+16,y+27,'02 / COMPILED' if k else'01 / BEFORE · ABOVE MARKER',13,'#efbe7a' if k else'#b9bec7'),text(x+16,y+53,'Same source. Separate labels.' if k else'Overlapping label envelopes.',17)]
  # One uniform world-to-screen scale, identical between compared panels.
  scale=(w-36)/(6.4 if mobile else 8.4);cx=x+w/2;cy=y+(181 if mobile else 194);parts.append(f'<g transform="translate({cx} {cy}) scale({scale} {-scale})">')
  for i,node in enumerate(s['nodes'][:2]):
   color=['#c1b5ff','#efbe7a'][i];a,b=node['keyframes'];c=node['controls'][0];d='M '+' '.join(str(n(z)) for z in a[1:])+' C '+' '.join(str(n(z)) for z in c)+' '+' '.join(str(n(z)) for z in b[1:]);parts.append(f'<path class="trajectory" data-node="{node["id"]}" d="{d}" fill="none" stroke="{color}" stroke-width="{1.5/scale}" opacity=".6"/>')
   px,py=at(node);off=plan['layout']['offsets'][i] if k else{'x':'0','y':str(F(node['envelope']['height'])/2+F(node['radius'])+F(s['margin']))};lx=px+n(off['x']);ly=py+n(off['y']);ww=n(node['envelope']['width']);hh=n(node['envelope']['height']);r=n(node['radius']);parts.append(f'<rect class="marker" x="{px-r}" y="{py-r}" width="{2*r}" height="{2*r}" fill="{color}"/><rect class="envelope" data-node="{node["id"]}" x="{lx-ww/2}" y="{ly-hh/2}" width="{ww}" height="{hh}" fill="none" stroke="{color}" stroke-width="{1/scale}"/>')
   # Keep all contours in one path, preserving counters with native winding.
   gd=' '.join(op[0]+' '+' '.join(str(n(v)) for v in op[1:]) for contour in node['envelope']['glyph_paths'] for op in contour);parts.append(f'<path class="glyph" data-node="{node["id"]}" d="{gd}" transform="translate({lx} {ly})" fill="{color}" fill-rule="nonzero"/>')
  parts.append('</g>');parts +=[text(x+16,y+278,'t = 3.00 s / same world-to-screen scale',12,'#b9bec7')]
 if mobile:
  for yy,t in [(793,'Authored control y: 2 → 3/2.'),(817,'Compilation retains that edited curve.'),(847,'Cropped geometry detail, not native pixels.')]:parts.append(text(22,yy,t,13,'#b9bec7'))
 else:
  parts +=[text(22,460,'THE EDIT',13,'#efbe7a'),text(22,489,'Alpha control y: 2 → 3/2. Every other source field is retained.',20),text(22,523,'The solver checks the complete 0–6 s interval; these two drawings show only t = 3 s.',16,'#b9bec7'),text(22,550,'Cropped declared geometry detail. Camera ×1; imported Noto outlines. Native video pixels were not rerendered.',13,'#b9bec7')]
 parts.append('</g></svg>');return ''.join(parts)
for mobile in [False,True]:(P/('motion-mobile.svg' if mobile else'motion.svg')).write_text(draw(mobile))
print(json.dumps({'scene':s['schema'],'sourceEdit':['alpha',0,1,'2','3/2'],'positionsAt3':{n['id']:at(n) for n in s['nodes']},'wideScale':plan['layout']['camera_scale'],'portraitScale':json.loads((P/'edited-portrait.plan.json').read_text())['layout']['camera_scale'],'verification':plan['verification']},indent=2))
