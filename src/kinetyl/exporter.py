"""Assemble a portable inspection studio from an independently verified plan."""
from pathlib import Path
import zipfile
import io as buffer

from . import core
from .io import data, bundle

ASSETS = Path(__file__).with_name("assets")


def export(plan,out):
    verification=core.verify_plan(plan)
    names=["index.html","studio.css","studio.mjs","authoring.mjs","geometry.mjs","polynomial.mjs","README.txt","LICENSE.txt","NOTO-LICENSE.txt"]
    files={name:(ASSETS/name).read_bytes() for name in names}
    files.update({"plan.json":data(plan),"scene.json":data(plan["scene"]),"verification.json":data(verification)})
    raw=buffer.BytesIO()
    with zipfile.ZipFile(raw,"w",zipfile.ZIP_DEFLATED) as archive:
        for name,content in sorted(files.items()):
            entry=zipfile.ZipInfo(name,date_time=(2026,1,1,0,0,0))
            entry.compress_type=zipfile.ZIP_DEFLATED
            entry.external_attr=0o100644<<16
            archive.writestr(entry,content)
    files["portable.zip"]=raw.getvalue()
    bundle(out,files)
