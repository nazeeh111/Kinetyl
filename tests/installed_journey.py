"""Run with -I from outside the source checkout after installing the wheel."""
from importlib.resources import files
from pathlib import Path
import tempfile
import json
import hashlib
import zipfile
from kinetyl.cli import main

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp); example=root/'scene.json'
    assert main(['example','eigenvalue-crossing','--out',str(root/'examples')])==0
    example.write_bytes((root/'examples/eigenvalue-crossing.scene.json').read_bytes())
    assert main(['compile',str(example),'--out',str(root/'compiled')])==0
    assert main(['verify',str(root/'compiled/plan.json')])==0
    assert main(['export',str(root/'compiled/plan.json'),'--out',str(root/'studio')])==0
    manifest=json.loads((root/'studio/manifest.json').read_text())
    for name,row in manifest['files'].items():
        raw=(root/'studio'/name).read_bytes()
        assert len(raw)==row['bytes'] and hashlib.sha256(raw).hexdigest()==row['sha256']
    with zipfile.ZipFile(root/'studio/portable.zip') as archive:
        assert archive.testzip() is None
        assert set(archive.namelist())==set(manifest['files'])-{'portable.zip'}
    assert main(['compile',str(example),'--out',str(root/'compiled')])==2
    assert main(['compile',str(example),'--out',str(root/'budget'),'--work-budget','1'])==2
    assert not (root/'budget').exists()
    print('Installed dependency-free compile/verify/export/hash/refusal journey PASS')

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp)
    for suffix in ([], ['--portrait']):
        name='curved-crossing'+('-portrait' if suffix else '')
        assert main(['example','curved-crossing',*suffix,'--out',str(root/name)])==0
        assert main(['compile',str(root/name/(name+'.scene.json')),'--out',str(root/(name+'-compiled'))])==0
        plan=json.loads((root/(name+'-compiled')/'plan.json').read_text())
        assert plan['schema']=='kinetyl-plan/2'
        assert main(['verify',str(root/(name+'-compiled')/'plan.json')])==0
        assert main(['export',str(root/(name+'-compiled')/'plan.json'),'--out',str(root/(name+'-studio'))])==0
        studio=root/(name+'-studio')
        assert (studio/'polynomial.mjs').is_file()
        assert (studio/'authoring.mjs').read_bytes()==files('kinetyl').joinpath('assets/authoring.mjs').read_bytes()
        assert "from './authoring.mjs'" in (studio/'studio.mjs').read_text()
        with zipfile.ZipFile(studio/'portable.zip') as archive:
            assert archive.testzip() is None
            assert 'polynomial.mjs' in archive.namelist()
        assert plan['scene']['nodes'][0]['controls']==[['-2','2','2','2']]
    print('Installed cubic wide/portrait compile, independent verify and complete portable export PASS')
