# Kinetyl

**Compile moving diagrams that keep their meaning.**

Labels collide between keyframes. Portrait crops erase important points. Kinetyl solves label placement and camera framing across the entire supported straight or cubic motion, while keeping your world paths, event times and projected label sizes fixed.

[Open the studio](https://nazeeh111.github.io/Kinetyl/) · [Download](https://github.com/nazeeh111/Kinetyl/releases) · [Scene format](SCHEMAS.md)

![Kinetyl at 3.00 seconds: Alpha and Beta overlap before compilation, then separate on the same crossing paths](docs/images/first-use.png)

The first view uses the bundled, independently checked curved-crossing plan. The two browser drawings show the same source paths and time, with the labels in their before and compiled positions. They represent declared geometry; native video validation is separate.

![World-path authoring with a selected Bézier control and exact coordinates](docs/images/authoring.jpg)

The studio now has a linked world-path editor. Enable **Edit paths**, choose an endpoint or Bézier control, and drag on the visible 1/20-unit grid or enter exact fractions. Arrow keys move one axis; cancel, undo and redo retain exact source values. Compile the draft, switch canvas, then save and reopen the verified plan. [Authoring and recovery](docs/authoring.md).

The default studio shows two cubic trajectories sharing an arch. Compare the collision at **3.00 s** at the top, then use **Inspect the timeline** to switch **Before / Compiled** or change to **9:16**. The curves and event times stay fixed while labels and camera framing adapt. [Try or author curved motion](docs/curved-motion.md). Actual exports: [wide](docs/native/curved-wide.mp4) and [portrait](docs/native/curved-portrait.mp4).

The retained linear example follows the eigenvalues of `A(u) = diag(u, −u)`: two branches cross and the determinant follows five sampled values. Try **Jump to collision**, switch **Before / Compiled**, then change the canvas to **9:16**. The mathematical coordinates stay the same. The determinant is a piecewise linear approximation between its samples, not a continuous quadratic simulation. Its original [wide](docs/native/wide.mp4) and [portrait](docs/native/portrait.mp4) native exports remain available with their [wide](docs/native/wide.json) and [portrait](docs/native/portrait.json) receipts.

## Use it

Python 3.11+. The compiler, verifier and exported browser studio need no runtime dependencies or paid service.

The `v0.3.1` wheel and studio ZIP include the current first-use comparison and canvas status fix. The existing `v0.3.0` artifacts remain frozen at their tagged source.

```sh
python -m pip install /path/to/kinetyl-0.3.1-py3-none-any.whl
kinetyl example curved-crossing --out examples
kinetyl compile examples/curved-crossing.scene.json --out compiled
kinetyl verify compiled/plan.json
kinetyl export compiled/plan.json --out studio
python -m http.server 8000 --directory studio
```

Open `http://localhost:8000`. Each output command requires a new destination and writes a manifest of file hashes. The export includes an editable plan, measured scene and portable ZIP. Imports are data; no imported code executes. `kinetyl example three-streams --portrait --out streams` provides a second editable case.

For your own text and an actual MP4, install the optional pinned renderer:

```sh
python -m pip install 'kinetyl[render] @ file:///absolute/path/to/kinetyl-0.3.1-py3-none-any.whl'
kinetyl measure examples/curved-crossing.intent.json --out measured
kinetyl compile measured/scene.json --out planned
kinetyl render planned/plan.json --out video
```

Native rendering uses **ManimGX 0.1.1**, Noto Sans and a supported graphics adapter. It remeasures typography, checks an object-ID pass at every rendered frame, and then exports a normal-color MP4 plus a receipt. Both passes count toward the pixel budget. The receipt distinguishes exact envelope geometry from sampled native pixels, with a four-pixel correspondence tolerance.

## What it solves

Kinetyl uses rational arithmetic to check continuous collision constraints on piecewise linear and cubic Bézier paths. Cubic checks use bounded polynomial sign analysis rather than a frame grid. It searches twelve constant label offsets per object, then selects the first feasible declared camera scale and the minimum summed slot cost. An independent verifier recomputes source identity, trajectories, candidate membership, all label pairs, all label–marker pairs and viewport constraints.

The supported model is explicit: 1–8 moving markers, fixed axis-aligned text envelopes, 2–16 keyframes per marker, with explicit cubic controls in version 2, a shared interval of at most 60 seconds, and a static 2D camera. Font size is a renderer parameter; fixed projected geometry does not guarantee a minimum readable screen pixel size. Rotating or morphing objects, arbitrary callbacks, perspective, arbitrary easing and 3D are outside this format.

**No solution** means no solution in the supplied scale/offset family. **Inconclusive** means the work or arithmetic budget ran out. Imported measurements and receipts are unsigned declarations. Exact rectangles do not certify continuous raster pixels, general accessibility or viewer comprehension.

## Development and provenance

```sh
PYTHONPATH=src python -m unittest discover -s tests
node --test tests/*.test.mjs
```

Kinetyl's compiler, verifier, schemas, CLI and studio are original MIT code, developed with Codex assistance. [ManimGX](https://github.com/academa-labs/manimgx) is an optional renderer by Academa Labs and its contributors, distributed separately under its own licenses. Noto font notices accompany the portable outlines. No upstream benchmark is claimed as a Kinetyl result. See [validation](VALIDATION.md), [contributing](CONTRIBUTING.md) and [security](SECURITY.md).
