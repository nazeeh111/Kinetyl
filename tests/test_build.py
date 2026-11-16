import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from kinetyl import core
from kinetyl.build import compose
from kinetyl.cli import main
from kinetyl.io import data


def intent():
    return {'schema':'kinetyl-intent/2','duration':'1','margin':'1/10','camera_scales':['1','3/5'],
            'min_font_size':24,'export':{'width':640,'height':360,'frame_rate':12,'frame_height':'8'},
            'nodes':[{'id':'shape','text':'Motion','font_size':28,'color':'#78DCE8','radius':'1/10',
                      'keyframes':[['0','-1','0'],['1','1','0']], 'controls':[['-1','1','1','1']]}]}


def fake_measure(value):
    value=core.validate_intent(value)
    envelope={'width':'1','height':'1/2','measurement':{'engine':'synthetic','version':'test','font':'test'},'glyph_paths':[]}
    return core.validate_scene({**value,'schema':value['schema'].replace('intent','scene'),
                                'nodes':[{**n,'envelope':copy.deepcopy(envelope)} for n in value['nodes']]})


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.source=self.root/'input.json';self.source.write_bytes(data(intent()))
        patcher=patch('kinetyl.manimgx_adapter.measure_scene',side_effect=fake_measure);self.measure=patcher.start();self.addCleanup(patcher.stop)

    def test_reuse_rechecks_and_invalidates_text_path_and_output(self):
        first=self.root/'first';compose(self.source,first)
        with patch('kinetyl.core.compile_scene',side_effect=AssertionError('compiled')):
            receipt=compose(self.source,self.root/'same',reuse=first)
        self.assertEqual(receipt['layout_origin'],'reused-independently-verified-candidate')
        for n,change in [('text',lambda x:x['nodes'][0].update(text='Other')),
                         ('path',lambda x:x['nodes'][0]['controls'][0].__setitem__(1,'2')),
                         ('output',lambda x:x['export'].update(width=800))]:
            value=intent();change(value);path=self.root/(n+'.json');path.write_bytes(data(value))
            result=compose(path,self.root/n,reuse=first)
            self.assertEqual(result['layout_origin'],'scene-changed-fresh-compile')
            self.assertNotEqual(result['scene_identity'],receipt['scene_identity'])
        self.assertGreaterEqual(self.measure.call_count,5)

    def test_reopen_scene_and_plan_remeasure_and_bind_original_bytes(self):
        first=self.root/'first';compose(self.source,first)
        for name in ['scene','plan']:
            source=first/(name+'.json');target=self.root/('reopen-'+name)
            r=compose(source,target);self.assertEqual(r['source_kind'],name)
            self.assertEqual((target/'source.json').read_bytes(),source.read_bytes())
            self.assertEqual(r['source_sha256'],hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertTrue(core.verify_plan(json.loads((target/'plan.json').read_bytes()))['valid'])

    def test_rehashed_false_prior_is_refused_and_previous_output_retained(self):
        first=self.root/'first';compose(self.source,first);prior=self.root/'prior';prior.mkdir()
        plan=json.loads((first/'plan.json').read_bytes());plan['layout']['projected_tracks'][0]['keyframes'][0][1]='999'
        raw=data(plan);(prior/'plan.json').write_bytes(raw)
        (prior/'manifest.json').write_bytes(data({'schema':'kinetyl-files/1','files':{'plan.json':{'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}}}))
        before=(first/'plan.json').read_bytes()
        with self.assertRaises(ValueError):compose(self.source,self.root/'refused',reuse=prior)
        self.assertFalse((self.root/'refused').exists());self.assertEqual((first/'plan.json').read_bytes(),before)

    def test_stage_failures_no_partial_no_clobber_and_retry(self):
        first=self.root/'first';compose(self.source,first);before=(first/'plan.json').read_bytes()
        for name,target in [('measure','kinetyl.manimgx_adapter.measure_scene'),('compile','kinetyl.core.compile_scene'),('export','kinetyl.cli.export'),('render','kinetyl.manimgx_adapter.render_plan')]:
            out=self.root/name
            with patch(target,side_effect=ValueError('injected '+name)):
                with self.assertRaisesRegex(ValueError,'injected'):compose(self.source,out,render=name=='render')
            self.assertFalse(out.exists());self.assertEqual((first/'plan.json').read_bytes(),before)
        with self.assertRaises(FileExistsError):compose(self.source,first)
        self.assertEqual((first/'plan.json').read_bytes(),before)
        self.assertEqual(compose(self.source,self.root/'retry')['layout_origin'],'fresh-compile')

    def test_publication_failure_cleans_only_the_new_output_and_retry_succeeds(self):
        first=self.root/'first';compose(self.source,first);before=(first/'plan.json').read_bytes()
        target=self.root/'publication-failure';original=Path.open
        def failing(path,*args,**kwargs):
            if path.parent==target and path.name=='plan.json':raise OSError('injected write failure')
            return original(path,*args,**kwargs)
        with patch.object(Path,'open',failing):
            with self.assertRaisesRegex(OSError,'injected write failure'):compose(self.source,target)
        self.assertFalse(target.exists());self.assertEqual((first/'plan.json').read_bytes(),before)
        compose(self.source,target);self.assertTrue((target/'manifest.json').is_file())

    def test_source_snapshot_refusal_and_budget(self):
        from kinetyl import build
        original=self.source.read_bytes();read=build._bytes
        def change_after_capture(path,limit):
            raw=read(path,limit)
            if Path(path)==self.source:self.source.write_bytes(b'changed later')
            return raw
        with patch('kinetyl.build._bytes',side_effect=change_after_capture):r=compose(self.source,self.root/'captured')
        self.assertEqual((self.root/'captured/source.json').read_bytes(),original)
        self.assertEqual(r['source_sha256'],hashlib.sha256(original).hexdigest())
        self.source.write_bytes(original);fifo=self.root/'fifo';os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError,'regular'):compose(fifo,self.root/'fifo-out')
        self.assertEqual(main(['compose',str(self.source),'--out',str(self.root/'budget'),'--work-budget','1']),2)
        self.assertFalse((self.root/'budget').exists())

class CheckBuildTests(unittest.TestCase):
    setUp = BuildTests.setUp
    def test_reopen_integrity_rehashed_tamper_and_type(self):
        from kinetyl.build import check_build
        from shutil import copytree
        first=self.root/'first';compose(self.source,first);self.assertEqual(check_build(first)['exact_geometry'],'passed')
        damaged=self.root/'damaged';copytree(first,damaged);(damaged/'source.json').write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'mismatch'):check_build(damaged)
        false=self.root/'false';copytree(first,false);verification=json.loads((false/'verification.json').read_bytes());verification['valid']=1
        raw=data(verification);(false/'verification.json').write_bytes(raw);manifest=json.loads((false/'manifest.json').read_bytes());manifest['files']['verification.json']={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()};(false/'manifest.json').write_bytes(data(manifest))
        with self.assertRaisesRegex(ValueError,'Verification record differs'):check_build(false)

    def test_receipt_schema_domains_and_valid_modes(self):
        from kinetyl.build import check_build
        first=self.root/'first';compose(self.source,first)
        reused=self.root/'reused';compose(self.source,reused,reuse=first)
        self.assertEqual(check_build(first)['exact_geometry'],'passed')
        self.assertEqual(check_build(reused)['exact_geometry'],'passed')
        original=json.loads((first/'build.json').read_bytes())
        for key,value in [('layout_origin','invented'),('layout_origin',False),
                          ('work_budget',False),('work_budget',0),('work_budget',1000001),
                          ('work_budget',1.0),('work_budget','1'),('rendered',1),
                          ('completion','invented'),('scope','invented'),('extra','invented')]:
            receipt={**original,key:value};raw=data(receipt);(first/'build.json').write_bytes(raw)
            manifest=json.loads((first/'manifest.json').read_bytes())
            manifest['files']['build.json']={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
            (first/'manifest.json').write_bytes(data(manifest))
            with self.subTest(key=key,value=value), self.assertRaises(ValueError):check_build(first)
        raw=data(original);(first/'build.json').write_bytes(raw)
        manifest['files']['build.json']={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
        (first/'manifest.json').write_bytes(data(manifest))
        self.assertEqual(check_build(first)['byte_integrity'],'passed')

    def test_rehashed_portable_script_refused(self):
        from kinetyl.build import check_build
        import io,zipfile
        first=self.root/'first';compose(self.source,first);archive=first/'portable.zip'
        with zipfile.ZipFile(archive) as z:entries={n:z.read(n) for n in z.namelist()}
        entries['studio.mjs']=b'changed script';raw=io.BytesIO()
        with zipfile.ZipFile(raw,'w',zipfile.ZIP_DEFLATED) as z:
            for name,value in entries.items():z.writestr(name,value)
        contents=raw.getvalue();archive.write_bytes(contents);receipt=json.loads((first/'build.json').read_bytes());receipt['portable_sha256']=hashlib.sha256(contents).hexdigest();(first/'build.json').write_bytes(data(receipt))
        manifest=json.loads((first/'manifest.json').read_bytes())
        for name in ['portable.zip','build.json']:
            b=(first/name).read_bytes();manifest['files'][name]={'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
        (first/'manifest.json').write_bytes(data(manifest))
        with self.assertRaisesRegex(ValueError,'asset differs'):check_build(first)

class HandoffTests(unittest.TestCase):
    setUp = BuildTests.setUp

    def test_data_only_handoff_reopens_and_rehashed_mutation_refuses(self):
        from kinetyl.build import check_build
        import io, zipfile
        first=self.root/'first';compose(self.source,first)
        with zipfile.ZipFile(first/'handoff.zip') as z:
            self.assertEqual(set(z.namelist()),{'source.json','intent.json','scene.json','plan.json','verification.json','README.txt','manifest.json'})
            self.assertEqual(z.read('source.json'),self.source.read_bytes())
            self.assertTrue(core.verify_plan(json.loads(z.read('plan.json')))['valid'])
        handoff=first/'handoff.zip';raw=handoff.read_bytes()+b'extra';handoff.write_bytes(raw)
        receipt=json.loads((first/'build.json').read_bytes());receipt['handoff_sha256']=hashlib.sha256(raw).hexdigest();(first/'build.json').write_bytes(data(receipt))
        manifest=json.loads((first/'manifest.json').read_bytes())
        for name in ('handoff.zip','build.json'):
            value=(first/name).read_bytes();manifest['files'][name]={'bytes':len(value),'sha256':hashlib.sha256(value).hexdigest()}
        (first/'manifest.json').write_bytes(data(manifest))
        with self.assertRaisesRegex(ValueError,'handoff differs'):check_build(first)

class MalformedPriorTests(unittest.TestCase):
    setUp = BuildTests.setUp

    def test_malformed_prior_manifest_refuses_without_traceback_or_output(self):
        first=self.root/'first';compose(self.source,first);prior=self.root/'bad-prior';prior.mkdir()
        (prior/'manifest.json').write_bytes(data({'schema':'kinetyl-files/1','files':[]}))
        target=self.root/'out';self.assertEqual(main(['compose',str(self.source),'--reuse',str(prior),'--out',str(target)]),2)
        self.assertFalse(target.exists());self.assertTrue((first/'manifest.json').exists())
