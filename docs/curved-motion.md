# Keep the curve, fix the labels

Kinetyl 0.2 carries explicit cubic Bézier motion through layout, browser editing and native video. A Bézier segment describes a curve using two endpoints and two control points. Kinetyl preserves those points and their times while choosing constant label offsets and a static camera scale.

## Try the complete example

```sh
kinetyl example curved-crossing --out curves
kinetyl compile curves/curved-crossing.scene.json --out compiled
kinetyl verify compiled/plan.json
kinetyl export compiled/plan.json --out studio
python -m http.server 8000 --directory studio
```

Open the studio, choose **Before**, then **Jump to collision**. Alpha and Beta follow the same arch in opposite directions. Their original labels overlap; compilation places one above and one below. Switch to portrait: the exact world paths, event times and measured label sizes stay fixed. The camera scale changes. Origin is a stationary reference. This is an authored illustration, not a measured physical simulation.

The source is [editable JSON](../examples/curved-crossing.intent.json), with a [retained generator](../tools/build_curved_example.py). Run that generator in the optional pinned rendering environment to remeasure the typography and rebuild both aspects. The measured example works without installing a renderer.

The browser editor exposes each object's `keyframes` and `controls`. Edit a control coordinate, compile, and download the independently checked plan. Invalid edits retain the previous document and pause downloads until recovery or successful compilation. Imports remain data and execute no callbacks. Exported studios include every module and a portable ZIP.

## Author a segment

```json
{
  "keyframes": [[0, -2, -1], [6, 2, -1]],
  "controls": [[-2, 2, 2, 2]]
}
```

Use scene/intent version 2 and supply one controls row per segment for every object. Segment time is linear. Straight smoothstep motion can be represented with its first control at the start and its second at the end. General easing, CSS timing curves and a cubic curve composed with cubic easing require different representations and are not accepted as equivalent.

## What the continuous check adds

Endpoint checks can miss a curved excursion. Regular frame checks can miss a short overlap. Kinetyl converts the declared motion on each shared subinterval into rational polynomials. It searches the sign intervals between their roots, and returns an actual rational time for a conflict. A Sturm sequence is a polynomial calculation that counts real roots without approximating their positions. Exact tangency is permitted; any strict overlap is a conflict. The compiler and imported-plan verifier recompute label/label, label/marker and viewport constraints.

The validation includes 700 polynomial cases whose generating roots define an independent oracle, irrational root boundaries, tangency, different segment times, changed-control refusals, and a constructed overlap window missed by a 60 fps grid. That last case is an arithmetic stress test with tiny envelopes, not evidence of a perceptible rendering defect. Python and browser results agree on the native-measured wide and portrait example. Native de Casteljau evaluation is compared separately with the polynomial kernel.

Actual native outputs: [wide MP4](native/curved-wide.mp4), [portrait MP4](native/curved-portrait.mp4), with [wide](native/curved-wide.json) and [portrait](native/curved-portrait.json) receipts. Each observes 145 ID-pass frames and 145 normal-color frames at 24 fps, with the existing four-pixel tolerance. Both MP4s decode as H.264. Native pixels are sampled observations; the continuous theorem concerns declared envelopes.

## Choose the right tool

[AnimaGeo](https://github.com/ivaleo/animageo) already provides GeoGebra construction import, dynamic label placement, easing and several export formats. Its source-reported breadth is greater than Kinetyl's restricted scene model; no runtime superiority comparison is claimed. [Trajectory-based labeling research](https://i11www.iti.kit.edu/en/projects/geovis/dynlab) already studies whole-motion labeling. Kinetyl's contribution here is an integrated, inspectable workflow preserving explicit curves and fixed presentation geometry, with bounded exact checks. Bézier geometry, Sturm methods and continuous labeling are established ideas.

Only 1–8 markers, fixed axis-aligned envelopes, declared cubic segments, twelve constant offsets and a finite scale list are searched. A three-moving-stream example had no portrait solution in this family. NoSolution means that family is exhausted; it does not mean readable placement is impossible. Budget or arithmetic exhaustion is inconclusive. Measurements are unsigned declarations. Rotation, morphing labels, perspective, 3D, general accessibility, viewer understanding and outside adoption remain unestablished.
