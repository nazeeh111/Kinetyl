"""Complete dependency-free CLI and export journeys, including refusal recovery."""
from pathlib import Path
from copy import deepcopy
import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from kinetyl.cli import main
from kinetyl.io import read_json

EXAMPLE = Path(__file__).parents[1]/'src/kinetyl/examples/eigenvalue-crossing.scene.json'

class ProductTests(unittest.TestCase):
    def run_cli(self, *args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return main(list(map(str,args)))

    def test_compile_verify_export_complete_zip_and_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            self.assertEqual(self.run_cli('compile',EXAMPLE,'--out',root/'plan'),0)
            self.assertEqual(self.run_cli('verify',root/'plan/plan.json'),0)
            self.assertEqual(self.run_cli('export',root/'plan/plan.json','--out',root/'studio'),0)
            out=root/'studio'; manifest=read_json(out/'manifest.json')
            self.assertEqual(read_json(out/'scene.json'),read_json(root/'plan/scene.json'))
            for name,row in manifest['files'].items():
                raw=(out/name).read_bytes(); self.assertEqual(len(raw),row['bytes']); self.assertEqual(hashlib.sha256(raw).hexdigest(),row['sha256'])
            with zipfile.ZipFile(out/'portable.zip') as archive:
                self.assertEqual(archive.testzip(),None)
                self.assertEqual(set(archive.namelist()),set(manifest['files'])-{'portable.zip'})
                for name in archive.namelist():self.assertEqual(archive.read(name),(out/name).read_bytes())
            self.assertIn('Permission is hereby granted',(out/'LICENSE.txt').read_text())
            self.assertIn('SIL OPEN FONT LICENSE',(out/'NOTO-LICENSE.txt').read_text())

    def test_refused_plan_before_optional_renderer_and_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); source=json.loads(EXAMPLE.read_text()); source['schema']='arbitrary-callback'; p=root/'bad.json';p.write_text(json.dumps(source))
            with patch('kinetyl.manimgx_adapter._load_renderer',side_effect=AssertionError('native import')):
                for cmd in ['measure','render','export','compile']:
                    self.assertEqual(self.run_cli(cmd,p,'--out',root/cmd),2)
                    self.assertFalse((root/cmd).exists())

    def test_budget_and_existing_destination_preserve_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); occupied=root/'occupied';occupied.mkdir();(occupied/'valuable').write_bytes(b'unchanged')
            self.assertEqual(self.run_cli('compile',EXAMPLE,'--out',occupied),2)
            self.assertEqual((occupied/'valuable').read_bytes(),b'unchanged')
            self.assertEqual(self.run_cli('compile',EXAMPLE,'--out',root/'empty','--work-budget',1),2)
            self.assertFalse((root/'empty').exists())
            link=root/'link';link.symlink_to(root/'missing')
            self.assertEqual(self.run_cli('compile',EXAMPLE,'--out',link),2);self.assertTrue(link.is_symlink())

    def test_family_exhaustion_has_no_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); source=json.loads(EXAMPLE.read_text());source['nodes']=source['nodes'][:1];source['nodes'][0]['envelope']['width']='64';source['nodes'][0]['envelope']['glyph_paths']=[]; p=root/'impossible.json';p.write_text(json.dumps(source))
            self.assertEqual(self.run_cli('compile',p,'--out',root/'out'),2);self.assertFalse((root/'out').exists())

    def test_duplicate_nonfinite_and_byte_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'data.json'
            for raw in ['{"x":1,"x":2}','{"x":NaN}']:
                p.write_text(raw)
                with self.assertRaises(ValueError):read_json(p)
            p.write_bytes(b' ' * 11)
            with self.assertRaises(ValueError):read_json(p,limit=10)

if __name__=='__main__':unittest.main()
