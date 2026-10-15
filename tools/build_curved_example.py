"""Regenerate the illustrative cubic examples with pinned native typography.

Run with PYTHONPATH=src and the optional ManimGX 0.1.1 environment.
Both aspects retain exactly the same world motion and timing.
"""
import json
from pathlib import Path
from kinetyl import compile_scene
from kinetyl.manimgx_adapter import measure_scene
root=Path(__file__).resolve().parents[1]/'src/kinetyl/examples'
scene={'schema':'kinetyl-intent/2','duration':'6','export':{'width':960,'height':540,'frame_rate':24,'frame_height':'8'},'margin':'1/10','camera_scales':['1','4/5','3/5','2/5','1/4'],'min_font_size':24,'nodes':[]}
for id,text,color,frames,controls in [
('alpha','Alpha','#78DCE8',[[0,-2,-1],[6,2,-1]],[[-2,2,2,2]]),
('beta','Beta','#FFD866',[[0,2,-1],[6,-2,-1]],[[2,2,-2,2]]),
('origin','Origin','#A9DC76',[[0,0,'-5/2'],[6,0,'-5/2']],[[0,'-5/2',0,'-5/2']])]:
    scene['nodes'].append({'id':id,'text':text,'color':color,'font_size':28,'radius':'3/25','keyframes':frames,'controls':controls})
for portrait in (False,True):
    intent=json.loads(json.dumps(scene))
    if portrait: intent['export'].update(width=540,height=960)
    name='curved-crossing'+('-portrait' if portrait else '')
    measured=measure_scene(intent)
    plan=compile_scene(measured,work_budget=1000000)
    for kind,value in [('intent',intent),('scene',measured),('plan',plan)]:
        (root/f'{name}.{kind}.json').write_text(json.dumps(value,indent=2)+'\n')
    print(name,plan['layout']['camera_scale'],plan['layout']['offsets'])
