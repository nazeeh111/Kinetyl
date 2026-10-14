"""Exact constraints for declared 2D presentation geometry, not pixel proofs."""
from fractions import Fraction
import hashlib
import itertools
import json
import math
import re

MAX_GLYPH_COMMANDS = 8192
MAX_TOTAL_GLYPH_COMMANDS = 32768
MAX_GLYPH_CONTOURS = 512
SCOPE = ("Exact declared rectangles; piecewise-linear centers; fixed presentation "
         "geometry; static axis-aligned camera; square clearance.")


class KinetylError(ValueError):
    """A refused input or bounded compilation outcome."""


class InvalidScene(KinetylError):
    pass


class InvalidPlan(KinetylError):
    pass


class NoSolution(KinetylError):
    """No layout in the declared finite candidate family."""


class SearchBudgetExceeded(KinetylError):
    """Inconclusive: bounded work exhausted."""


def _shape(value, keys):
    if type(value) is not dict or len(value) != len(keys) or any(type(k) is not str for k in value) or set(value) != set(keys):
        raise InvalidScene("Missing, unknown or invalid object fields")


def _array(value, lo, hi):
    if type(value) is not list or not lo <= len(value) <= hi:
        raise InvalidScene("Invalid array cardinality")
    return value


def _integer(value, lo, hi):
    if type(value) is not int or not lo <= value <= hi:
        raise InvalidScene("Invalid integer range")
    return value


def _text(value, limit=128, multiline=False):
    if type(value) is not str or not 1 <= len(value) <= limit:
        raise InvalidScene("Invalid text length or type")
    if any((ord(c) < 32 and not (multiline and c == "\n")) or
           127 <= ord(c) <= 159 or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        raise InvalidScene("Invalid Unicode or control characters")
    if len(value.encode("utf-8")) > limit * 4 or (multiline and value.count("\n") > 2):
        raise InvalidScene("Text exceeds encoded size or line bound")
    return value


def _q(value, magnitude=10000, bits=256, string_limit=160):
    if type(value) is str:
        if len(value) > string_limit or re.fullmatch(r"[+-]?[0-9]+(?:/[0-9]+|\.[0-9]+)?", value) is None:
            raise InvalidScene("Invalid rational string")
    elif type(value) not in (int, float, Fraction):
        raise InvalidScene("Expected a rational or finite JSON number")
    if type(value) is int and value.bit_length() > bits:
        raise InvalidScene("Rational exceeds bit bound")
    if type(value) is float and not math.isfinite(value):
        raise InvalidScene("Nonfinite geometry")
    try:
        result = Fraction(value)
    except (ValueError, ZeroDivisionError, OverflowError):
        raise InvalidScene("Invalid rational value") from None
    if result.numerator.bit_length() > bits or result.denominator.bit_length() > bits or abs(result) > magnitude:
        raise InvalidScene("Rational exceeds bit or magnitude bound")
    return result


def _glyphs(data, width, height):
    _array(data, 0, MAX_GLYPH_CONTOURS)
    arities = {"M": 2, "L": 2, "Q": 4, "C": 6, "Z": 0}
    out, count = [], 0
    for contour in data:
        _array(contour, 1, MAX_GLYPH_COMMANDS)
        count += len(contour)
        if count > MAX_GLYPH_COMMANDS:
            raise InvalidScene("Glyph command budget exceeded")
        converted = []
        for i, command in enumerate(contour):
            _array(command, 1, 7)
            op = command[0]
            if type(op) is not str or op not in arities or len(command) != arities[op] + 1:
                raise InvalidScene("Invalid glyph command")
            if (i == 0 and op != "M") or (i > 0 and op == "M") or (op == "Z" and i != len(contour) - 1):
                raise InvalidScene("Invalid glyph contour structure")
            coords = [_q(v, 64) for v in command[1:]]
            if any(abs(v) > (width / 2 if j % 2 == 0 else height / 2) for j, v in enumerate(coords)):
                raise InvalidScene("Glyph control point outside declared envelope")
            converted.append([op, *map(str, coords)])
        out.append(converted)
    return out, count


def _validate(data, measured):
    _shape(data, ("schema", "duration", "nodes", "export", "margin", "camera_scales", "min_font_size"))
    if data["schema"] != ("kinetyl-scene/1" if measured else "kinetyl-intent/1"):
        raise InvalidScene("Unsupported scene schema")
    duration = _q(data["duration"], 60)
    if duration <= 0:
        raise InvalidScene("Duration must be positive")
    _shape(data["export"], ("width", "height", "frame_rate", "frame_height"))
    export = {k: _integer(data["export"][k], 1 if k == "frame_rate" else 64,
                          60 if k == "frame_rate" else 4096) for k in ("width", "height", "frame_rate")}
    if _q(data["export"]["frame_height"]) != 8:
        raise InvalidScene("Version 1 requires frame height 8")
    export["frame_height"] = "8"
    margin = _q(data["margin"], 2)
    if margin < 0:
        raise InvalidScene("Margin must be nonnegative")
    scales = [_q(v, 1) for v in _array(data["camera_scales"], 1, 8)]
    if any(v <= 0 for v in scales) or len(set(scales)) != len(scales):
        raise InvalidScene("Camera scales must be positive and distinct")
    min_font = _integer(data["min_font_size"], 1, 256)
    nodes, identities, glyph_count = [], set(), 0
    for node in _array(data["nodes"], 1, 8):
        keys = ["id", "text", "font_size", "color", "radius", "keyframes"]
        _shape(node, keys + (["envelope"] if measured else []))
        identifier = _text(node["id"], 32)
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,31}", identifier) is None or identifier in identities:
            raise InvalidScene("Node identities must be unique ASCII identifiers")
        identities.add(identifier)
        text = _text(node["text"], 256, True)
        font = _integer(node["font_size"], min_font, 256)
        color = node["color"]
        if type(color) is not str or re.fullmatch(r"#[0-9a-fA-F]{6}", color) is None:
            raise InvalidScene("Color must be #RRGGBB")
        radius = _q(node["radius"], 4)
        if radius <= 0:
            raise InvalidScene("Marker radius must be positive")
        track = []
        for keyframe in _array(node["keyframes"], 2, 16):
            _array(keyframe, 3, 3)
            t, x, y = (_q(v, 60 if j == 0 else 10000) for j, v in enumerate(keyframe))
            track.append((t, x, y))
        if track[0][0] != 0 or track[-1][0] != duration or any(a[0] >= b[0] for a, b in zip(track, track[1:])):
            raise InvalidScene("Keyframes require shared 0..duration domain and strictly increasing times")
        item = {"id": identifier, "text": text, "font_size": font, "color": color.upper(),
                "radius": str(radius), "keyframes": [[str(v) for v in k] for k in track]}
        if measured:
            envelope = node["envelope"]
            _shape(envelope, ("width", "height", "measurement", "glyph_paths"))
            width, height = _q(envelope["width"], 64), _q(envelope["height"], 16)
            if width <= 0 or height <= 0:
                raise InvalidScene("Measured envelope must have positive dimensions")
            _shape(envelope["measurement"], ("engine", "version", "font"))
            metadata = {k: _text(envelope["measurement"][k]) for k in ("engine", "version", "font")}
            paths, count = _glyphs(envelope["glyph_paths"], width, height)
            glyph_count += count
            if glyph_count > MAX_TOTAL_GLYPH_COMMANDS:
                raise InvalidScene("Scene glyph command budget exceeded")
            item["envelope"] = {"width": str(width), "height": str(height), "measurement": metadata, "glyph_paths": paths}
        nodes.append(item)
    return {"schema": "kinetyl-scene/1" if measured else "kinetyl-intent/1", "duration": str(duration),
            "nodes": nodes, "export": export, "margin": str(margin), "camera_scales": list(map(str, scales)), "min_font_size": min_font}


def validate_intent(data):
    """Validate unmeasured intent before importing an optional renderer."""
    return _validate(data, False)


def validate_scene(data):
    """Return a detached canonical measured scene; metadata remains unsigned."""
    return _validate(data, True)


def scene_identity(scene):
    return hashlib.sha256(json.dumps(scene, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


class _Budget:
    def __init__(self, limit):
        self.remaining = limit

    def spend(self, amount=1):
        self.remaining -= amount
        if self.remaining < 0:
            raise SearchBudgetExceeded("Inconclusive: exact constraint/search work budget exhausted")


def _point(track, time):
    for a, b in zip(track, track[1:]):
        if a[0] <= time <= b[0]:
            u = (time - a[0]) / (b[0] - a[0])
            return a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])
    raise InvalidScene("Time outside trajectory domain")


def _overlap(a, ha, oa, b, hb, ob, margin, budget):
    budget.spend()
    cuts = sorted({k[0] for k in a} | {k[0] for k in b})
    for start, end in zip(cuts, cuts[1:]):
        budget.spend(4)
        first_a, first_b, last_a, last_b = _point(a, start), _point(b, start), _point(a, end), _point(b, end)
        low, high, lo_open, hi_open = start, end, False, False
        possible = True
        for axis, direction in itertools.product((0, 1), (-1, 1)):
            bound = ha[axis] + hb[axis] + margin
            first = direction * (first_a[axis] + oa[axis] - first_b[axis] - ob[axis]) - bound
            last = direction * (last_a[axis] + oa[axis] - last_b[axis] - ob[axis]) - bound
            slope = (last - first) / (end - start)
            if slope == 0:
                if first >= 0:
                    possible = False
                    break
                continue
            crossing = start - first / slope
            if slope > 0:
                if crossing < high:
                    high, hi_open = crossing, True
                elif crossing == high:
                    hi_open = True
            else:
                if crossing > low:
                    low, lo_open = crossing, True
                elif crossing == low:
                    lo_open = True
            if low > high or (low == high and (lo_open or hi_open)):
                possible = False
                break
        if possible:
            return (low + high) / 2
    return None


def _inside(track, half, offset, viewport, budget):
    budget.spend(2 * len(track))
    return all(abs(p[axis + 1] + offset[axis]) + half[axis] <= viewport[axis] for p in track for axis in (0, 1))


def _slots(half, radius, gap):
    x, y = half[0] + radius + gap, half[1] + radius + gap
    z = Fraction(0)
    return [(z, y), (z, -y), (x, z), (-x, z), (x, y), (-x, y), (x, -y), (-x, -y), (z, 2*y), (z, -2*y), (2*x, z), (-2*x, z)]


def _geometry(scene, scale):
    tracks = [[tuple(Fraction(v) if j == 0 else Fraction(v) * scale for j, v in enumerate(k)) for k in node["keyframes"]] for node in scene["nodes"]]
    halves = [(Fraction(n["envelope"]["width"]) / 2, Fraction(n["envelope"]["height"]) / 2) for n in scene["nodes"]]
    radii = [Fraction(n["radius"]) for n in scene["nodes"]]
    viewport = (Fraction(4 * scene["export"]["width"], scene["export"]["height"]), Fraction(4))
    return tracks, halves, radii, viewport, Fraction(scene["margin"])


def _checks(n):
    return {"label_pair_checks": n*(n-1)//2, "label_dot_checks": n*n, "viewport_checks": 2*n}


def _make_plan(scene, scale, offsets):
    tracks, _, _, viewport, _ = _geometry(scene, scale)
    return {"schema": "kinetyl-plan/1", "scene": scene, "input_sha256": scene_identity(scene),
            "layout": {"camera_scale": str(scale),
                       "offsets": [{"node_id": node["id"], "x": str(o[0]), "y": str(o[1])} for node, o in zip(scene["nodes"], offsets)],
                       "projected_tracks": [{"node_id": n["id"], "keyframes": [[str(v) for v in k] for k in t]} for n, t in zip(scene["nodes"], tracks)],
                       "viewport": {"half_width": str(viewport[0]), "half_height": str(viewport[1])}},
            "verification": {**_checks(len(scene["nodes"])), "scope": SCOPE}}


def compile_scene(scene, work_budget=50000):
    scene = validate_scene(scene)
    _integer(work_budget, 1, 1000000)
    budget, zero = _Budget(work_budget), (Fraction(0), Fraction(0))
    for scale_string in scene["camera_scales"]:
        budget.spend()
        scale = Fraction(scale_string)
        tracks, halves, radii, viewport, gap = _geometry(scene, scale)
        n = len(tracks)
        if any(not _inside(t, (r, r), zero, viewport, budget) for t, r in zip(tracks, radii)):
            continue
        slots = [_slots(h, r, gap) for h, r in zip(halves, radii)]
        domains = []
        for i in range(n):
            domain = []
            for k, offset in enumerate(slots[i]):
                budget.spend()
                if _inside(tracks[i], halves[i], offset, viewport, budget) and all(
                    _overlap(tracks[i], halves[i], offset, t, (r, r), zero, gap, budget) is None for t, r in zip(tracks, radii)):
                    domain.append(k)
            domains.append(domain)
        if any(not d for d in domains):
            continue
        forbidden = set()
        for i, j in itertools.combinations(range(n), 2):
            for a, b in itertools.product(domains[i], domains[j]):
                if _overlap(tracks[i], halves[i], slots[i][a], tracks[j], halves[j], slots[j][b], gap, budget) is not None:
                    forbidden.add((i, a, j, b))
        order = sorted(range(n), key=lambda i: len(domains[i]))
        best, best_cost = None, None

        def search(depth, chosen, cost):
            nonlocal best, best_cost
            budget.spend()
            if best_cost is not None and cost >= best_cost:
                return
            if depth == n:
                best, best_cost = dict(chosen), cost
                return
            i = order[depth]
            for a in domains[i]:
                budget.spend()
                if any((i, a, j, b) in forbidden if i < j else (j, b, i, a) in forbidden for j, b in chosen.items()):
                    continue
                chosen[i] = a
                search(depth + 1, chosen, cost + a + 1)
                del chosen[i]

        search(0, {}, 0)
        if best is not None:
            plan = _make_plan(scene, scale, [slots[i][best[i]] for i in range(n)])
            _verify_plan(plan, budget)
            return plan
    raise NoSolution("No layout in the declared camera-scale and constant-offset candidate family")


def _verify_plan(plan, budget):
    """Recompute serialized evidence and every continuous declared constraint."""
    try:
        _shape(plan, ("schema", "scene", "input_sha256", "layout", "verification"))
        if plan["schema"] != "kinetyl-plan/1":
            raise InvalidScene("Unsupported plan schema")
        scene = validate_scene(plan["scene"])
        # Require canonical scene bytes/values inside a plan: no ambiguous variants.
        if type(plan["input_sha256"]) is not str or plan["input_sha256"] != scene_identity(scene) or plan["scene"] != scene:
            raise InvalidScene("Plan scene identity or normalization mismatch")
        layout = plan["layout"]
        _shape(layout, ("camera_scale", "offsets", "projected_tracks", "viewport"))
        scale = _q(layout["camera_scale"], 1)
        if str(scale) not in scene["camera_scales"]:
            raise InvalidScene("Undeclared camera scale")
        offsets = []
        for node, row in zip(scene["nodes"], _array(layout["offsets"], len(scene["nodes"]), len(scene["nodes"]))):
            _shape(row, ("node_id", "x", "y"))
            if row["node_id"] != node["id"]:
                raise InvalidScene("Offset identity/order mismatch")
            offsets.append((_q(row["x"], 128, 1024, 1024), _q(row["y"], 128, 1024, 1024)))
        for node, row in zip(scene["nodes"], _array(layout["projected_tracks"], len(scene["nodes"]), len(scene["nodes"]))):
            _shape(row, ("node_id", "keyframes"))
            if row["node_id"] != node["id"]:
                raise InvalidScene("Projected track identity/order mismatch")
            for keyframe in _array(row["keyframes"], len(node["keyframes"]), len(node["keyframes"])):
                _array(keyframe, 3, 3)
                for value in keyframe:
                    if type(value) is not str:
                        raise InvalidScene("Plan geometry must use canonical rational strings")
                    _q(value, 10000, 1024, 1024)
        _shape(layout["viewport"], ("half_width", "half_height"))
        for value in layout["viewport"].values():
            if type(value) is not str:
                raise InvalidScene("Plan viewport must use canonical rational strings")
            _q(value, 256, 1024, 1024)
        expected = _make_plan(scene, scale, offsets)
        if layout != expected["layout"]:
            raise InvalidScene("Noncanonical layout, altered trajectory or viewport")
        _shape(plan["verification"], ("label_pair_checks", "label_dot_checks", "viewport_checks", "scope"))
        for k, v in _checks(len(scene["nodes"])).items():
            if type(plan["verification"][k]) is not int or plan["verification"][k] != v:
                raise InvalidScene("Forged verification counts")
        if type(plan["verification"]["scope"]) is not str or plan["verification"]["scope"] != SCOPE:
            raise InvalidScene("Unsupported verification scope")
        tracks, halves, radii, viewport, gap = _geometry(scene, scale)
        zero = (Fraction(0), Fraction(0))
        for i in range(len(tracks)):
            if offsets[i] not in _slots(halves[i], radii[i], gap):
                raise InvalidScene("Offset outside declared finite family")
            if not _inside(tracks[i], halves[i], offsets[i], viewport, budget) or not _inside(tracks[i], (radii[i], radii[i]), zero, viewport, budget):
                raise InvalidScene("Viewport clipping")
            for j in range(len(tracks)):
                if _overlap(tracks[i], halves[i], offsets[i], tracks[j], (radii[j], radii[j]), zero, gap, budget) is not None:
                    raise InvalidScene("Continuous label-dot conflict")
        for i, j in itertools.combinations(range(len(tracks)), 2):
            if _overlap(tracks[i], halves[i], offsets[i], tracks[j], halves[j], offsets[j], gap, budget) is not None:
                raise InvalidScene("Continuous label-label conflict")
        return {"valid": True, "input_sha256": expected["input_sha256"], "checks": _checks(len(tracks)), "scope": SCOPE}
    except InvalidScene as exc:
        raise InvalidPlan(str(exc)) from None


def verify_plan(plan):
    """Independent bounded verification; no compiler status flags are trusted."""
    try:
        return _verify_plan(plan, _Budget(1000000))
    except SearchBudgetExceeded as exc:
        raise InvalidPlan(str(exc)) from None
