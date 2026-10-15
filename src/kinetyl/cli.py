"""Compile, independently verify and export supported motion layouts."""
import argparse
from pathlib import Path
import sys
import zipfile
import io as buffer

from . import core
from .io import read_json, data, bundle

ASSETS=Path(__file__).with_name("assets")


def parser():
    result=argparse.ArgumentParser(description="Keep labels readable throughout supported animation paths.")
    result.add_argument("--version",action="version",version="0.2.0")
    commands=result.add_subparsers(dest="command",required=True)
    sample=commands.add_parser("example",help="Write a bundled editable example to a new directory")
    sample.add_argument("name",choices=["eigenvalue-crossing","three-streams","curved-crossing"])
    sample.add_argument("--portrait",action="store_true")
    sample.add_argument("--out",required=True,type=Path)
    for name,description in [("measure","Measure text with the optional native renderer"),
                             ("compile","Solve and verify a measured scene"),
                             ("verify","Independently check an imported plan"),
                             ("export","Export a portable inspection studio"),
                             ("render","Render a verified plan with ManimGX")]:
        sub=commands.add_parser(name,help=description)
        sub.add_argument("input",type=Path)
        if name!="verify":sub.add_argument("--out",required=True,type=Path)
        if name=="compile":sub.add_argument("--work-budget",type=int,default=250000)
        if name=="render":sub.add_argument("--pixel-budget",type=int,default=400000000)
    return result


def export(plan,out):
    verification=core.verify_plan(plan)
    names=["index.html","studio.css","studio.mjs","geometry.mjs","polynomial.mjs","README.txt","LICENSE.txt","NOTO-LICENSE.txt"]
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


def main(argv=None):
    args=parser().parse_args(argv)
    try:
        if args.command!="verify" and (args.out.exists() or args.out.is_symlink()):
            raise FileExistsError("Output already exists; choose a new destination")
        if args.command=="example":
            name=args.name+("-portrait" if args.portrait else "")
            example=Path(__file__).with_name("examples")
            files={f"{name}.{kind}.json":(example/f"{name}.{kind}.json").read_bytes() for kind in ["intent","scene","plan"]}
            scope=example/f"{args.name}.scope.json"
            if scope.exists():files["scope.json"]=scope.read_bytes()
            bundle(args.out,files)
            print("Wrote editable example: "+str(args.out))
            return 0
        document=read_json(args.input)
        if args.command=="verify":
            print(data(core.verify_plan(document)).decode(),end="")
        elif args.command=="compile":
            plan=core.compile_scene(document,work_budget=args.work_budget)
            verified=core.verify_plan(plan)
            bundle(args.out,{"plan.json":data(plan),"scene.json":data(plan["scene"]),"verification.json":data(verified)})
            print("Compiled and verified declared motion geometry: "+str(args.out))
        elif args.command=="measure":
            intent=core.validate_intent(document)  # before importing optional renderer
            from .manimgx_adapter import measure_scene
            scene=measure_scene(intent)
            bundle(args.out,{"scene.json":data(scene)})
            print("Measured native text envelopes: "+str(args.out))
        elif args.command=="export":
            export(document,args.out)
            print("Exported portable studio and ZIP: "+str(args.out))
        elif args.command=="render":
            core.verify_plan(document)  # before optional renderer import/output writes
            from .manimgx_adapter import render_plan
            # Adapter owns no-clobber rendering and its native evidence contract.
            render_plan(document,args.out,pixel_budget=args.pixel_budget)
            print("Rendered native output: "+str(args.out))
        return 0
    except (ValueError,OSError,ImportError,RecursionError) as error:
        print("Refused: "+str(error)[:1000],file=sys.stderr)
        return 2


if __name__=="__main__":raise SystemExit(main())
