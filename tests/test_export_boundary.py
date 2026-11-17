"""Library composition must work without importing the command-line interface."""
from pathlib import Path
import os
import subprocess
import sys
import unittest


class ExportBoundaryTests(unittest.TestCase):
    def test_compose_exports_complete_build_when_cli_import_is_unavailable(self):
        # Native typography is replaced by the retained measured example, not rerun.
        plan = Path(__file__).parents[1] / 'src/kinetyl/examples/curved-crossing.plan.json'
        script = r'''
import importlib.abc
import json
from pathlib import Path
import sys
import tempfile
class NoCLI(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname == 'kinetyl.cli':
            raise ImportError('CLI layer unavailable to library consumer')
sys.meta_path.insert(0, NoCLI())
from kinetyl.build import compose, check_build
from kinetyl import manimgx_adapter
source = Path(sys.argv[1])
scene = json.loads(source.read_text())['scene']
manimgx_adapter.measure_scene = lambda intent: scene
with tempfile.TemporaryDirectory() as temp:
    output = Path(temp) / 'build'
    compose(source, output)
    checked = check_build(output)
    assert checked['byte_integrity'] == 'passed'
    assert checked['exact_geometry'] == 'passed'
    assert (output / 'portable.zip').is_file()
    assert 'kinetyl.cli' not in sys.modules
print('Complete library build without CLI import')
'''
        result = subprocess.run([sys.executable, '-B', '-c', script, str(plan)],
                                capture_output=True, text=True, env=os.environ, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Complete library build without CLI import', result.stdout)
