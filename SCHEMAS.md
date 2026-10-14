# Kinetyl data contract, version 1

All documents are ordinary JSON data. Unknown keys and missing keys are rejected. APIs return newly allocated normalized documents; numeric geometry is emitted as reduced rational strings (`"1/2"`, `"8"`). Finite JSON numbers and bounded integer, decimal or numerator/denominator strings are accepted. Booleans, nonfinite numbers, malformed Unicode, callbacks, arbitrary SVG strings and executable content are unsupported. Finite binary64 input is preserved as its exact supplied value; this does not recover an ideal decimal or certify rasterized pixels.

## Intent and measured scene

Top-level exact keys: `schema`, `duration`, `nodes`, `export`, `margin`, `camera_scales`, `min_font_size`.

- Intent schema: `kinetyl-intent/1`. Measured scene schema: `kinetyl-scene/1`.
- `duration`: rational, greater than zero and at most 60 seconds.
- `export`: exact keys `width`, `height`, `frame_rate`, `frame_height`. Width and height are integers 64..4096; frame_rate integer 1..60; frame_height rational exactly 8.
- `margin`: rational 0..2, applied per axis (square clearance).
- `camera_scales`: 1..8 distinct rational values in (0,1], in author preference order. First feasible scale takes priority over slot costs.
- `min_font_size`: integer 1..256. Font size is the native renderer's declared size parameter, not a measured pixel-height guarantee.
- `nodes`: 1..8 objects. Intent node exact keys: `id`, `text`, `font_size`, `color`, `radius`, `keyframes`. Scene nodes additionally require `envelope`.
- `id`: unique ASCII identifier `[A-Za-z][A-Za-z0-9_-]{0,31}`.
- `text`: nonempty valid Unicode, at most 256 code points and 1024 UTF-8 bytes; at most three lines. Control characters except newline are rejected.
- `font_size`: integer between min_font_size and 256. `color`: `#RRGGBB`, normalized uppercase. `radius`: rational greater than zero and at most 4, in fixed presentation units.
- `keyframes`: 2..16 arrays `[time,x,y]`. Times strictly increase, first time is 0, last is duration. Coordinates have magnitude at most 10000. World paths and event times are preserved exactly.

Scene `envelope` exact keys: `width`, `height`, `measurement`, `glyph_paths`. Width is in (0,64], height in (0,16]. Dimensions describe a fixed axis-aligned presentation rectangle centered on the label. `measurement` exact keys `engine`, `version`, `font`, each nonempty Unicode string at most 128 characters without controls. Metadata is declared provenance, not authenticated evidence. Native adapter uses real measurement; core trusts the supplied rectangle.

`glyph_paths` is an array of contours, each an array of commands: `["M",x,y]`, `["L",x,y]`, `["Q",cx,cy,x,y]`, `["C",c1x,c1y,c2x,c2y,x,y]`, `["Z"]`. Contours begin with M, contain no other M, and may close once with terminal Z. At most 512 contours and 8192 total commands per node, and 32768 commands across the scene. Coordinates and curve control points must lie inside the declared envelope. Empty paths are allowed and mean no native vector-outline claim. These arrays are data; consumers construct drawing commands, never evaluate input or interpolate arbitrary SVG markup.

Envelopes, glyph coordinates, marker radii, margin and offsets use **projected scene units with frame height 8**. They remain fixed as camera scale changes. World-center projection is `world_center * camera_scale`; a renderer can inverse-scale presentation objects to preserve those dimensions. The viewport half-height is 4; half-width is `4 * export.width / export.height`. Camera is static, centered and axis aligned. Only piecewise-linear 2D centers and fixed geometry are supported. Dot obstacles are enclosing squares.

All input rational numerator/denominator bit lengths are at most 256, and numeric strings at most 160 characters. Derived plan values may grow by exact multiplication or addition and are capped at 1024 bits and 1024 characters when imported. Sizes, cardinalities and control-point bounds are checked before the solver. Exactness concerns the declared geometry, not fonts, native float transformations or continuous pixels.

## Plan

Exact top keys: `schema`, `scene`, `input_sha256`, `layout`, `verification`; schema `kinetyl-plan/1`. `scene` is the normalized full measured scene. Identity is SHA256 of UTF-8 JSON with sorted keys, compact separators and `ensure_ascii=False` over the normalized scene.

`layout` exact keys:

- `camera_scale`: one of the declared scene camera scales.
- `offsets`: exactly one object per node, in scene order, with exact keys `node_id`, `x`, `y`. Offset must belong to that node's finite candidate family.
- `projected_tracks`: exactly one object per node, in scene order, with exact keys `node_id`, `keyframes`. Times equal world times; centers equal world centers times camera_scale. No modified trajectory or identity is accepted.
- `viewport`: exact keys `half_width`, `half_height`, recomputed from export geometry.

`verification` exact keys `label_pair_checks`, `label_dot_checks`, `viewport_checks`, `scope`. Counts are N(N-1)/2, N² and 2N respectively. Scope is exactly `Exact declared rectangles; piecewise-linear centers; fixed presentation geometry; static axis-aligned camera; square clearance.` These fields are not trusted success flags: imported plans are independently recomputed and checked.

Candidate family for half-envelope (hx,hy), marker radius r and margin g: let X=hx+r+g and Y=hy+r+g. Offsets in preference order: `(0,Y),(0,-Y),(X,0),(-X,0),(X,Y),(-X,Y),(X,-Y),(-X,-Y),(0,2Y),(0,-2Y),(2X,0),(-2X,0)`. Slot cost is its one-based index. The compiler minimizes summed slot cost within the first feasible scale. `NoSolution` concerns only this family; it is not universal geometric infeasibility.

## APIs and refusals

`validate_intent(data)` and `validate_scene(data)` return normalized new JSON data or raise `InvalidScene`. `compile_scene(scene, work_budget=50000)` validates input and returns a plan or raises `NoSolution` or `SearchBudgetExceeded`. Work budget is an integer 1..1000000; it charges interval-piece inequality work and finite-search steps, not wall-clock milliseconds. Budget exhaustion is inconclusive and never returned as infeasibility. `verify_plan(plan)` recomputes all geometry and returns `{valid: true, input_sha256, checks: {...}, scope}` or raises `InvalidPlan`. Exceptions derive from `KinetylError(ValueError)`.

The verifier is independent of compiler success claims and checks scene identity, node order/cardinality, exact projected coordinates, permitted scale/offsets, viewport inclusion for labels and dots, every label pair, and every label-dot pair across the whole time domain. It does not authenticate measurement metadata or establish native pixel fidelity.
