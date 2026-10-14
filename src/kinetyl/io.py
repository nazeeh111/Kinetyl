"""Strict bounded JSON and recoverable new-directory writes."""
from pathlib import Path
import hashlib
import json


def _pairs(pairs):
    result = {}
    for name,value in pairs:
        if name in result:
            raise ValueError("Duplicate JSON field: " + name[:80])
        result[name] = value
    return result


def read_json(path,limit=4*1024*1024):
    with Path(path).open("rb") as handle:
        raw=handle.read(limit+1)
    if len(raw)>limit:
        raise ValueError("Input exceeds JSON byte budget")
    def nonfinite(value):
        raise ValueError("Nonfinite JSON value")
    return json.loads(raw.decode("utf-8"),object_pairs_hook=_pairs,parse_constant=nonfinite)


def data(value):
    return (json.dumps(value,ensure_ascii=True,allow_nan=False,indent=2)+"\n").encode("utf-8")


def bundle(path,files):
    """Write only a new destination and roll back only files created here."""
    path=Path(path)
    for name,raw in files.items():
        if not isinstance(name,str) or name in ("", ".", "..", "manifest.json") or "/" in name or "\\" in name or type(raw) is not bytes:
            raise ValueError("Output members must be plain filenames and bytes")
    manifest={"schema":"kinetyl-files/1","files":{name:{"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest()} for name,raw in sorted(files.items())}}
    path.mkdir()
    made=[]
    try:
        for name,raw in [*files.items(),("manifest.json",data(manifest))]:
            target=path/name
            with target.open("xb") as handle:
                made.append(target)
                handle.write(raw)
    except BaseException:
        for target in reversed(made):target.unlink(missing_ok=True)
        path.rmdir()
        raise
    return manifest
