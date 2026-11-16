"""One source-bound motion build using the existing independent checks."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
import io
import zipfile
import zlib

from . import core
from .io import _pairs, bundle, data

MAX_JSON = 4 * 1024 * 1024
MAX_MOVIE = 256 * 1024 * 1024
_HANDOFF_README = b'Kinetyl data-only handoff. Import scene.json or plan.json in the studio; compose remeasures text. Records are unsigned and do not authenticate origin.\n'


def _bytes(path, limit):
    if not hasattr(os, 'O_NONBLOCK') or not hasattr(os, 'O_NOFOLLOW'):
        raise ValueError('Safe input admission requires nonblocking no-follow file support')
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError('Input must be a bounded regular file')
        chunks, total = [], 0
        while True:
            part = os.read(fd, min(65536, limit + 1 - total))
            if not part:
                break
            total += len(part)
            if total > limit:
                raise ValueError('Input exceeds its byte budget')
            chunks.append(part)
        return b''.join(chunks)
    finally:
        os.close(fd)


def _json(raw):
    def nonfinite(_):
        raise ValueError('Nonfinite JSON value')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs, parse_constant=nonfinite)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _previous_plan(directory):
    directory = Path(directory)
    manifest = _json(_bytes(directory / 'manifest.json', MAX_JSON))
    if not isinstance(manifest, dict) or manifest.get('schema') != 'kinetyl-files/1':
        raise ValueError('Prior build manifest is invalid')
    records = manifest.get('files')
    if not isinstance(records, dict):
        raise ValueError('Prior build manifest is invalid')
    record = records.get('plan.json')
    raw = _bytes(directory / 'plan.json', MAX_JSON)
    if not isinstance(record, dict) or type(record.get('bytes')) is not int or record['bytes'] != len(raw) or record.get('sha256') != _sha(raw):
        raise ValueError('Prior plan bytes do not match its manifest')
    plan = _json(raw)
    core.verify_plan(plan)
    return plan


def _source_intent(source):
    document = _json(source)
    schema = document.get('schema') if isinstance(document, dict) else None
    if schema in ('kinetyl-intent/1', 'kinetyl-intent/2'):
        source_kind = 'intent'
        intent = core.validate_intent(document)
        intent_raw = source
    elif schema in ('kinetyl-scene/1', 'kinetyl-scene/2', 'kinetyl-plan/1', 'kinetyl-plan/2'):
        source_kind = 'plan' if schema.startswith('kinetyl-plan/') else 'scene'
        if source_kind == 'plan':
            core.verify_plan(document)
            document = document['scene']
        imported = core.validate_scene(document)
        # Imported text envelopes are never trusted as fresh measurements.
        intent = core.validate_intent({**imported, 'schema': imported['schema'].replace('scene', 'intent'),
                                      'nodes': [{k: v for k, v in node.items() if k != 'envelope'}
                                                for node in imported['nodes']]})
        intent_raw = data(intent)
    else:
        raise ValueError('Compose requires an intent, measured scene or verified plan')
    return source_kind, intent, intent_raw



def _handoff(files):
    names = ('source.json','intent.json','scene.json','plan.json','verification.json')
    entries = {name:files[name] for name in names}
    entries['README.txt'] = _HANDOFF_README
    entries['manifest.json'] = data({'schema':'kinetyl-handoff/1','files':{
        name:{'bytes':len(raw),'sha256':_sha(raw)} for name,raw in sorted(entries.items())}})
    out = io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,raw in sorted(entries.items()):
            entry=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0))
            entry.compress_type=zipfile.ZIP_DEFLATED
            entry.external_attr=0o100644<<16
            archive.writestr(entry,raw)
    return out.getvalue()


def compose(intent_path, output, *, reuse=None, render=False, work_budget=250000,
            pixel_budget=400000000, progress=None):
    """Create a new complete build; previous outputs are never replaced.

    Reuse accepts only an independently verified candidate matching the freshly
    measured scene. The verifier does not certify its compiler optimality.
    """
    def update(stage):
        if progress is not None:
            progress(stage)

    output = Path(output)
    if os.path.lexists(output):
        raise FileExistsError('Output already exists; choose a new destination')
    if not output.parent.is_dir():
        raise ValueError('Output parent must already exist')
    if type(work_budget) is not int or not 1 <= work_budget <= 1000000:
        raise ValueError('work budget must be an integer in 1..1000000')
    source = _bytes(intent_path, MAX_JSON)
    source_kind, intent, intent_raw = _source_intent(source)
    from .manimgx_adapter import measure_scene, render_plan
    update('Measuring text')
    scene = measure_scene(intent)
    origin = 'fresh-compile'
    if reuse is not None:
        update('Checking prior candidate')
        prior = _previous_plan(reuse)
        if prior['scene'] == scene and prior['input_sha256'] == core.scene_identity(scene):
            plan = prior
            origin = 'reused-independently-verified-candidate'
        else:
            update('Compiling changed scene')
            plan = core.compile_scene(scene, work_budget=work_budget)
            origin = 'scene-changed-fresh-compile'
    else:
        update('Compiling scene')
        plan = core.compile_scene(scene, work_budget=work_budget)
    update('Independently verifying plan')
    verification = core.verify_plan(plan)
    from .cli import export
    with tempfile.TemporaryDirectory(prefix='.kinetyl-compose-', dir=output.parent) as directory:
        root = Path(directory)
        update('Exporting portable studio')
        export(plan, root / 'portable')
        portable = _bytes(root / 'portable' / 'portable.zip', MAX_MOVIE)
        scene_raw, plan_raw = data(scene), data(plan)
        files = {'source.json': source, 'intent.json': intent_raw, 'scene.json': scene_raw, 'plan.json': plan_raw,
                 'verification.json': data(verification), 'portable.zip': portable}
        files['handoff.zip'] = _handoff(files)
        if render:
            update('Rendering checked native movie')
            render_plan(plan, root / 'native', pixel_budget=pixel_budget)
            files['movie.mp4'] = _bytes(root / 'native' / 'movie.mp4', MAX_MOVIE)
            files['native.json'] = _bytes(root / 'native' / 'native.json', MAX_JSON)
            files['native-SHA256SUMS'] = _bytes(root / 'native' / 'SHA256SUMS', MAX_JSON)
        receipt = {'schema': 'kinetyl-compose/1', 'source_kind': source_kind, 'source_sha256': _sha(source),
                   'intent_sha256': _sha(intent_raw),
                   'scene_sha256': _sha(scene_raw), 'scene_identity': core.scene_identity(scene),
                   'plan_sha256': _sha(plan_raw), 'portable_sha256': _sha(portable),
                   'handoff_sha256': _sha(files['handoff.zip']),
                   'layout_origin': origin, 'work_budget': work_budget, 'rendered': bool(render),
                   'completion': 'Valid only with the complete, verified manifest.json',
                   'movie_sha256': _sha(files['movie.mp4']) if render else None,
                   'scope': 'Fresh native text measurement; independently verified declared motion geometry. '
                            'A reused candidate is valid but its compiler selection optimality is not established. '
                            'Native receipt output path is the temporary staging path; movie.mp4 is the delivered copy. '
                            'No physical, continuous raster or viewer-comprehension claim.'}
        files['build.json'] = data(receipt)
        update('Publishing complete build')
        bundle(output, files)
    return receipt


def _same(a, b):
    return json.dumps(a, sort_keys=True, separators=(',', ':'), allow_nan=False) == json.dumps(b, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _zip_envelope(raw):
    end=raw.rfind(b'PK\x05\x06')
    if end<0 or end+22>len(raw):
        raise ValueError('ZIP has no complete end record')
    disk,central_disk,local_count,total_count,size,offset,comment=struct.unpack_from('<HHHHIIH',raw,end+4)
    if disk or central_disk or local_count!=total_count or end+22+comment!=len(raw) or offset+size!=end:
        raise ValueError('ZIP has trailing or inconsistent records')


def check_build(directory):
    """Check captured output bytes and independent geometry; do not rerender video."""
    directory = Path(directory)
    manifest = _json(_bytes(directory / 'manifest.json', MAX_JSON))
    if not isinstance(manifest, dict) or manifest.get('schema') != 'kinetyl-files/1' or not isinstance(manifest.get('files'), dict):
        raise ValueError('Invalid build manifest')
    names = {'source.json','intent.json','scene.json','plan.json','verification.json','portable.zip','handoff.zip','build.json'}
    optional = {'movie.mp4','native.json','native-SHA256SUMS'}
    records = manifest['files']
    if set(records) not in (names, names | optional):
        raise ValueError('Unexpected or incomplete build files')
    captured = {}
    for name, record in records.items():
        raw = _bytes(directory / name, MAX_MOVIE if name in ('movie.mp4','portable.zip','handoff.zip') else MAX_JSON)
        if not isinstance(record, dict) or type(record.get('bytes')) is not int or record['bytes'] != len(raw) or record.get('sha256') != _sha(raw):
            raise ValueError('Build file mismatch: ' + name)
        captured[name] = raw
    receipt = _json(captured['build.json'])
    receipt_fields = {'schema', 'source_kind', 'source_sha256', 'intent_sha256',
                      'scene_sha256', 'scene_identity', 'plan_sha256', 'portable_sha256',
                      'handoff_sha256', 'layout_origin', 'work_budget', 'rendered',
                      'completion', 'movie_sha256', 'scope'}
    if not isinstance(receipt, dict) or set(receipt) != receipt_fields or receipt.get('schema') != 'kinetyl-compose/1':
        raise ValueError('Unsupported compose receipt schema')
    if receipt['layout_origin'] not in ('fresh-compile', 'scene-changed-fresh-compile',
                                         'reused-independently-verified-candidate'):
        raise ValueError('Invalid layout origin')
    if type(receipt['work_budget']) is not int or not 1 <= receipt['work_budget'] <= 1000000:
        raise ValueError('Invalid receipt work budget')
    if receipt['completion'] != 'Valid only with the complete, verified manifest.json' or receipt['scope'] != (
            'Fresh native text measurement; independently verified declared motion geometry. '
            'A reused candidate is valid but its compiler selection optimality is not established. '
            'Native receipt output path is the temporary staging path; movie.mp4 is the delivered copy. '
            'No physical, continuous raster or viewer-comprehension claim.'):
        raise ValueError('Invalid receipt scope or completion')
    source_kind, intent, intent_raw = _source_intent(captured['source.json'])
    scene = core.validate_scene(_json(captured['scene.json']))
    derived = core.validate_intent({**scene, 'schema':scene['schema'].replace('scene','intent'),
                                    'nodes':[{k:v for k,v in node.items() if k!='envelope'} for node in scene['nodes']]})
    plan = _json(captured['plan.json']); verified = core.verify_plan(plan)
    if not _same(intent, derived) or not _same(plan['scene'], scene) or captured['intent.json'] != intent_raw:
        raise ValueError('Source, intent, scene or plan differs')
    if not _same(_json(captured['verification.json']), verified):
        raise ValueError('Verification record differs')
    checks = {'source_kind':source_kind, 'source_sha256':_sha(captured['source.json']),
              'intent_sha256':_sha(intent_raw), 'scene_sha256':_sha(captured['scene.json']),
              'scene_identity':core.scene_identity(scene), 'plan_sha256':_sha(captured['plan.json']),
              'portable_sha256':_sha(captured['portable.zip']), 'handoff_sha256':_sha(captured['handoff.zip']), 'rendered':set(records)==names|optional,
              'movie_sha256':_sha(captured['movie.mp4']) if 'movie.mp4' in captured else None}
    if any(type(receipt.get(k)) is not type(v) or receipt.get(k) != v for k,v in checks.items()):
        raise ValueError('Compose receipt differs from captured outputs')
    _zip_envelope(captured['portable.zip'])
    try:
        with zipfile.ZipFile(io.BytesIO(captured['portable.zip'])) as archive:
            expected={'index.html','studio.css','studio.mjs','authoring.mjs','geometry.mjs','polynomial.mjs',
                      'README.txt','LICENSE.txt','NOTO-LICENSE.txt','plan.json','scene.json','verification.json'}
            infos=archive.infolist()
            if len(infos)!=len(expected) or {i.filename for i in infos}!=expected or any(i.file_size>MAX_JSON for i in infos):
                raise ValueError('Portable archive has unexpected entries')
            for name in ('plan.json','scene.json','verification.json'):
                if archive.read(name)!=captured[name]:
                    raise ValueError('Portable archive differs from checked '+name)
            assets=Path(__file__).with_name('assets')
            for name in expected-{'plan.json','scene.json','verification.json'}:
                if archive.read(name)!=(assets/name).read_bytes():
                    raise ValueError('Portable studio asset differs from this installation: '+name)
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError, NotImplementedError, zlib.error) as exc:
        raise ValueError('Portable archive is invalid') from exc
    try:
        _zip_envelope(captured['handoff.zip'])
        with zipfile.ZipFile(io.BytesIO(captured['handoff.zip'])) as archive:
            names_in_handoff={'source.json','intent.json','scene.json','plan.json','verification.json','README.txt','manifest.json'}
            infos=archive.infolist()
            if len(infos)!=len(names_in_handoff) or {i.filename for i in infos}!=names_in_handoff or any(i.file_size>MAX_JSON for i in infos):
                raise ValueError('Data-only handoff differs from checked source and plan')
            payload={name:archive.read(name) for name in names_in_handoff-{'manifest.json'}}
            if payload.pop('README.txt')!=_HANDOFF_README or any(payload[name]!=captured[name] for name in payload):
                raise ValueError('Data-only handoff differs from checked source and plan')
            payload['README.txt']=_HANDOFF_README
            expected={'schema':'kinetyl-handoff/1','files':{name:{'bytes':len(raw),'sha256':_sha(raw)} for name,raw in payload.items()}}
            if not _same(_json(archive.read('manifest.json')),expected):
                raise ValueError('Data-only handoff manifest differs')
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError, NotImplementedError, zlib.error, ValueError) as exc:
        raise ValueError('Data-only handoff differs from checked source and plan') from exc
    if 'native.json' in captured:
        native=_json(captured['native.json'])
        if not isinstance(native, dict) or native.get('video_sha256')!=_sha(captured['movie.mp4']) or type(native.get('video_bytes')) is not int or native['video_bytes']!=len(captured['movie.mp4']) or native.get('input_sha256')!=verified['input_sha256']:
            raise ValueError('Native receipt differs from movie or plan')
        expected_sums=(f"{_sha(captured['movie.mp4'])}  movie.mp4\n{_sha(captured['native.json'])}  native.json\n").encode('ascii')
        if captured['native-SHA256SUMS']!=expected_sums:
            raise ValueError('Native checksum record differs')
    return {'schema':'kinetyl-compose-check/1','byte_integrity':'passed','exact_geometry':'passed',
            'source_kind':source_kind,'scene_identity':checks['scene_identity'],
            'native_video':'receipt and bytes checked; rendering not replayed' if checks['rendered'] else 'not rendered',
            'scope':'Unsigned local records; layout origin, budget and execution history are unverified claims. No fresh typography measurement, native pixel replay, authentication or physical accuracy claim.'}
