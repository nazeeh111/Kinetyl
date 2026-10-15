"""Optional native typography and rendering for Kinetyl's declared 2D model.

This adapter is original Kinetyl code. ManimGX 0.1.1, its renderer and bundled
fonts are by Academa and their respective contributors. Their licenses remain
with the separately installed dependency. Pixel observations are bounded native
checks, not a continuous raster theorem or a viewer-comprehension certificate.
"""
from __future__ import annotations

from contextlib import contextmanager
from fractions import Fraction
import hashlib
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import tempfile
import threading

ENGINE_VERSION = "0.1.1"
FONT = "Noto Sans"
BACKGROUND = "#0B1220"
PADDING = Fraction(3, 100)
MIN_CONTRAST = 4.5
DEFAULT_PIXEL_BUDGET = 200_000_000
MAX_PIXEL_BUDGET = 1_000_000_000
MAX_COMMANDS_PER_NODE = 8192
MAX_CONTOURS_PER_NODE = 512
MAX_COMMANDS_TOTAL = 32768
PIXEL_TOLERANCE = 4
_LOCK = threading.RLock()
_ID_COLORS = (
    "#28E078", "#F04164", "#468CF5", "#F0D228",
    "#BE50EB", "#28DCDC", "#F5872D", "#9BE14B",
)


class AdapterError(ValueError):
    """Native work was refused or could not establish its declared check."""


class RendererUnavailable(AdapterError):
    """The explicit supported optional renderer is absent or incompatible."""


def _core():
    return importlib.import_module(".core", __package__)


def _load_renderer():
    try:
        version = importlib.metadata.version("manimgx")
    except importlib.metadata.PackageNotFoundError as exc:
        raise RendererUnavailable(
            "Native measurement/rendering requires the optional ManimGX 0.1.1 dependency."
        ) from exc
    if version != ENGINE_VERSION:
        raise RendererUnavailable(
            f"This adapter supports ManimGX {ENGINE_VERSION}; installed version is {version}."
        )
    try:
        return importlib.import_module("manimgx")
    except ImportError as exc:
        raise RendererUnavailable("The installed ManimGX dependency could not be imported.") from exc


def _rgb(color):
    if not isinstance(color, str) or len(color) != 7 or not color.startswith("#"):
        raise AdapterError("Native colors must be #RRGGBB.")
    try:
        return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))
    except ValueError as exc:
        raise AdapterError("Native colors must be #RRGGBB.") from exc


def _luminance(color):
    channels = [c / 255 for c in _rgb(color)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return sum(a * b for a, b in zip(linear, (0.2126, 0.7152, 0.0722)))


def _check_colors(nodes):
    background = _luminance(BACKGROUND)
    ratios = {}
    for node in nodes:
        foreground = _luminance(node["color"])
        ratio = (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
        if ratio < MIN_CONTRAST:
            raise AdapterError(
                f"Label {node['id']} contrast against the fixed background is {ratio:.2f}; "
                f"native rendering requires at least {MIN_CONTRAST}."
            )
        ratios[node["id"]] = ratio
    return ratios


@contextmanager
def _configuration(renderer, export=None):
    # Keep the original config object and its exact stored values, including the
    # distinction between default and explicitly selected frame height.
    saved = dict(vars(renderer.config))
    try:
        if export is not None:
            renderer.config.pixel_width = export["width"]
            renderer.config.pixel_height = export["height"]
            renderer.config.frame_rate = export["frame_rate"]
        renderer.config.frame_height = 8.0
        renderer.config.background_color = BACKGROUND
        yield
    finally:
        vars(renderer.config).clear()
        vars(renderer.config).update(saved)


def _rational(value):
    value = float(value)
    if not math.isfinite(value):
        raise AdapterError("Native typography produced a nonfinite coordinate.")
    result = Fraction(value)
    if max(result.numerator.bit_length(), result.denominator.bit_length()) > 256:
        raise AdapterError("Native typography exceeded the rational coordinate bound.")
    return result


def _glyph_geometry(text):
    """Return centered cubic contours and their conservative control hull.

    Command overflow omits all optional outlines. It never returns a truncated
    font outline. The dimensions remain measured and the empty list makes no
    portable exact-font-outline claim.
    """
    center = text.get_center()
    paths = []
    commands = 0
    hx = _rational(text.width) / 2
    hy = _rational(text.height) / 2
    overflow = False
    for leaf in text.family_members_with_points():
        if not hasattr(leaf, "get_subpaths"):
            raise AdapterError("Native text has an unsupported non-vector glyph.")
        for points in leaf.get_subpaths():
            if len(points) == 0:
                continue
            if len(points) % 4:
                raise AdapterError("Native text has an unsupported cubic contour.")
            path = []
            coordinates = []
            for point in points:
                x, y = _rational(point[0] - center[0]), _rational(point[1] - center[1])
                hx, hy = max(hx, abs(x)), max(hy, abs(y))
                coordinates.append((x, y))
            path.append(["M", *(str(v) for v in coordinates[0])])
            for at in range(0, len(coordinates), 4):
                # ManimGX stores a cubic's start followed by its two controls
                # and endpoint. Start positions belong to the preceding move.
                if at and coordinates[at] != coordinates[at - 1]:
                    raise AdapterError("Native text contour is discontinuous.")
                path.append(["C", *(str(v) for pair in coordinates[at + 1:at + 4] for v in pair)])
            path.append(["Z"])
            commands += len(path)
            if commands > MAX_COMMANDS_PER_NODE or len(paths) >= MAX_CONTOURS_PER_NODE:
                overflow = True
            if not overflow:
                paths.append(path)
    if hx <= 0 or hy <= 0:
        raise AdapterError("Native text has no positive visible geometry.")
    return ([] if overflow else paths), 2 * (hx + PADDING), 2 * (hy + PADDING)


def measure_scene(data: object) -> dict:
    """Measure an intent with the actual pinned native font engine, without GPU draws."""
    core = _core()
    intent = core.validate_intent(data)
    _check_colors(intent["nodes"])
    try:
        with _LOCK:
            renderer = _load_renderer()
            with _configuration(renderer):
                nodes = []
                total_commands = 0
                for node in intent["nodes"]:
                    text = renderer.Text(node["text"], font=FONT, font_size=node["font_size"], color=node["color"])
                    paths, width, height = _glyph_geometry(text)
                    count = sum(len(path) for path in paths)
                    if total_commands + count > MAX_COMMANDS_TOTAL:
                        paths = []
                        count = 0
                    total_commands += count
                    envelope = {
                        "width": str(width), "height": str(height),
                        "measurement": {"engine": "ManimGX", "version": ENGINE_VERSION, "font": FONT},
                        "glyph_paths": paths,
                    }
                    nodes.append({**node, "envelope": envelope})
    except AdapterError:
        raise
    except Exception as exc:
        raise AdapterError(f"Native text measurement failed ({type(exc).__name__}).") from exc
    return core.validate_scene({**intent, "schema": intent["schema"].replace("intent", "scene"), "nodes": nodes})


def _point(keyframes, time, controls=None):
    frames = [[Fraction(v) for v in frame] for frame in keyframes]
    if time <= frames[0][0]:
        return frames[0][1], frames[0][2]
    for i, (left, right) in enumerate(zip(frames, frames[1:])):
        if time <= right[0]:
            u = (time - left[0]) / (right[0] - left[0])
            if controls is not None:
                c = list(map(Fraction, controls[i]))
                # de Casteljau evaluation, distinct from the power-basis kernel.
                def coordinate(k):
                    points = [left[k+1], c[k], c[k+2], right[k+1]]
                    while len(points) > 1:
                        points = [(1-u)*a + u*b for a, b in zip(points, points[1:])]
                    return points[0]
                return coordinate(0), coordinate(1)
            return left[1] + u * (right[1] - left[1]), left[2] + u * (right[2] - left[2])
    return frames[-1][1], frames[-1][2]


def _render_scene(renderer, scene, layout, colors):
    scale = Fraction(layout["camera_scale"])
    offsets = {x["node_id"]: (Fraction(x["x"]), Fraction(x["y"])) for x in layout["offsets"]}

    class CompiledScene(renderer.Scene):
        def construct(self):
            self.camera.frame.scale(1 / float(scale))
            dots, labels = [], []
            for node, color in zip(scene["nodes"], colors):
                x, y = _point(node["keyframes"], Fraction(0), node.get("controls"))
                dx, dy = offsets[node["id"]]
                dot = renderer.Dot((float(x), float(y), 0), radius=float(Fraction(node["radius"]) / scale), color="#FFFFFF")
                label = renderer.Text(node["text"], font=FONT, font_size=node["font_size"], color=color).scale(1 / float(scale))
                label.move_to((float(x + dx / scale), float(y + dy / scale), 0))
                dots.append(dot)
                labels.append(label)
            self.add(*dots, *labels)
            if scene["schema"].endswith("/2"):
                animations = []
                duration = Fraction(scene["duration"])
                for node, dot, label in zip(scene["nodes"], dots, labels):
                    dx, dy = offsets[node["id"]]
                    for mob, offset in ((dot, (Fraction(0), Fraction(0))), (label, (dx/scale, dy/scale))):
                        def update(target, alpha, n=node, off=offset):
                            x, y = _point(n["keyframes"], Fraction(alpha)*duration, n["controls"])
                            target.move_to((float(x+off[0]), float(y+off[1]), 0))
                        animations.append(renderer.UpdateFromAlphaFunc(mob, update, rate_func=renderer.linear))
                self.play(*animations, run_time=duration)
                return
            boundaries = sorted({Fraction(frame[0]) for node in scene["nodes"] for frame in node["keyframes"]})
            for start, end in zip(boundaries, boundaries[1:]):
                animations = []
                for node, dot, label in zip(scene["nodes"], dots, labels):
                    x, y = _point(node["keyframes"], end)
                    dx, dy = offsets[node["id"]]
                    animations.extend([
                        dot.animate(rate_func=renderer.linear).move_to((float(x), float(y), 0)),
                        label.animate(rate_func=renderer.linear).move_to((float(x + dx / scale), float(y + dy / scale), 0)),
                    ])
                self.play(*animations, run_time=end - start)
    return CompiledScene()


def _pixel_work(scene):
    settings = scene["export"]
    duration_frames = Fraction(scene["duration"]) * settings["frame_rate"]
    frames = math.ceil(duration_frames) + 1
    return frames, 2 * frames * settings["width"] * settings["height"]


def _hash_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _publish_bundle(staged, destination, receipt):
    receipt_bytes = (json.dumps(receipt, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    receipt_hash = hashlib.sha256(receipt_bytes).hexdigest()
    manifest = (f"{receipt['video_sha256']}  movie.mp4\n{receipt_hash}  native.json\n").encode("ascii")
    try:
        destination.mkdir()
    except FileExistsError as exc:
        raise AdapterError("Output appeared during rendering; the existing path was preserved.") from exc
    except OSError as exc:
        raise AdapterError(f"Could not reserve output directory ({type(exc).__name__}).") from exc
    try:
        os.link(staged, destination / "movie.mp4")
        with (destination / "native.json").open("xb") as stream:
            stream.write(receipt_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        with (destination / "SHA256SUMS").open("xb") as stream:
            stream.write(manifest)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception as exc:
        raise AdapterError(
            f"Native checks passed but bundle publication failed ({type(exc).__name__}). "
            f"Created files were preserved at {destination}; verify the complete SHA256SUMS before treating it as complete."
        ) from exc


def render_plan(plan: object, output_path: str | os.PathLike, pixel_budget: int = DEFAULT_PIXEL_BUDGET) -> dict:
    """Render the verified recipe into a fresh, recoverable output directory.

    Both native ID-color and normal-color passes consume every RGBA frame before
    the next callback. The ID pass checks projected envelopes; normal output
    keeps the author's colors. This function never chooses an alternate GPU
    backend, installs packages, or overwrites an existing output.
    """
    core = _core()
    verified = core.verify_plan(plan)
    scene = core.validate_scene(plan["scene"])
    contrast = _check_colors(scene["nodes"])
    if type(pixel_budget) is not int or not 1 <= pixel_budget <= MAX_PIXEL_BUDGET:
        raise AdapterError(f"pixel_budget must be an integer in 1..{MAX_PIXEL_BUDGET}.")
    expected_frames, required_pixels = _pixel_work(scene)
    if required_pixels > pixel_budget:
        raise AdapterError(f"Both complete native passes require {required_pixels} pixels, above budget {pixel_budget}.")
    destination = Path(output_path)
    if os.path.lexists(destination):
        raise AdapterError("Native output already exists; no bytes were overwritten.")
    if not destination.parent.is_dir():
        raise AdapterError("The native output parent directory must already exist.")
    # Remeasure the exact text and outlines with this package/font version. A
    # forged provenance label or same-width replacement glyph cannot pass by
    # supplying a convenient mathematical rectangle alone.
    intent = {**scene, "schema": scene["schema"].replace("scene", "intent"), "nodes": [{k: v for k, v in node.items() if k != "envelope"} for node in scene["nodes"]]}
    native_scene = measure_scene(intent)
    if native_scene != scene:
        raise AdapterError("Plan typography does not match fresh pinned native font measurement.")
    settings, layout = scene["export"], plan["layout"]
    width, height, fps = settings["width"], settings["height"], settings["frame_rate"]
    scale = Fraction(layout["camera_scale"])
    half_width, half_height = Fraction(layout["viewport"]["half_width"]), Fraction(layout["viewport"]["half_height"])
    offsets = [(Fraction(x["x"]), Fraction(x["y"])) for x in layout["offsets"]]
    duration = Fraction(scene["duration"])
    rows = []
    pixel_digest = hashlib.sha256()
    normal_callbacks = 0
    normal_frames = 0

    with _LOCK:
        renderer = _load_renderer()
        np = importlib.import_module("numpy")  # installed ManimGX dependency, lazy
        def id_frame(frame):
            raw = frame.pixels()
            if len(raw) != width * height * 4:
                raise AdapterError("Native frame has an unexpected RGBA cardinality.")
            image = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 4))
            rgb = image[:, :, :3].astype(np.int16)
            boxes, counts = [], []
            for color in _ID_COLORS[:len(scene["nodes"])]:
                values = np.array(_rgb(color), dtype=np.int16)
                mask = (np.abs(rgb - values).max(axis=2) <= 24) & (image[:, :, 3] >= 240)
                ys, xs = np.nonzero(mask)
                if not len(xs):
                    raise AdapterError("An ID-pass label has no observable opaque ink.")
                boxes.append([int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())])
                counts.append(int(len(xs)))
            if type(frame.index) is not int or type(frame.repeat) is not int or frame.repeat < 1:
                raise AdapterError("Native frame index/repeat is invalid.")
            for index in range(frame.index, frame.index + frame.repeat):
                if index != len(rows) or index >= expected_frames:
                    raise AdapterError("Native ID frames are incomplete or out of order.")
                time = min(Fraction(index, fps), duration)
                for node, offset, box in zip(scene["nodes"], offsets, boxes):
                    x, y = _point(node["keyframes"], time, node.get("controls"))
                    x, y = x * scale + offset[0], y * scale + offset[1]
                    hx, hy = Fraction(node["envelope"]["width"]) / 2, Fraction(node["envelope"]["height"]) / 2
                    predicted = [float((x - hx + half_width) * width / (2 * half_width)),
                                 float((half_height - y - hy) * height / (2 * half_height)),
                                 float((x + hx + half_width) * width / (2 * half_width)),
                                 float((half_height - y + hy) * height / (2 * half_height))]
                    if not (box[0] >= predicted[0] - PIXEL_TOLERANCE and box[1] >= predicted[1] - PIXEL_TOLERANCE and
                            box[2] <= predicted[2] + PIXEL_TOLERANCE and box[3] <= predicted[3] + PIXEL_TOLERANCE):
                        raise AdapterError("Native ID pixels exceed the declared projected envelope.")
                    if box[0] <= 0 or box[1] <= 0 or box[2] >= width - 1 or box[3] >= height - 1:
                        raise AdapterError("Native ID-pass label touches the image boundary.")
                for at, a in enumerate(boxes):
                    for b in boxes[at + 1:]:
                        if not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1]):
                            raise AdapterError("Native ID-pass label ink bounds intersect.")
                rows.append({"index": index, "time": str(time), "label_boxes": boxes, "label_ink_pixels": counts})

        def normal_frame(frame):
            nonlocal normal_callbacks, normal_frames
            raw = frame.pixels()
            if (len(raw) != width * height * 4 or type(frame.index) is not int or
                    type(frame.repeat) is not int or frame.repeat < 1 or frame.index != normal_frames):
                raise AdapterError("Native normal-color frames have invalid cardinality/order.")
            normal_callbacks += 1
            normal_frames += frame.repeat
            if normal_frames > expected_frames:
                raise AdapterError("Native normal-color frame count exceeded the declared timeline.")
            pixel_digest.update(raw)

        with _configuration(renderer, settings), tempfile.TemporaryDirectory(prefix=".kinetyl-render-", dir=destination.parent) as temporary:
            staged = Path(temporary) / "output.mp4"
            try:
                _render_scene(renderer, scene, layout, _ID_COLORS).render(frames=id_frame)
                if len(rows) != expected_frames:
                    raise AdapterError("Native ID pass did not cover the complete frame grid.")
                _render_scene(renderer, scene, layout, [n["color"] for n in scene["nodes"]]).render(video=staged, frames=normal_frame)
                if normal_frames != expected_frames or not staged.is_file() or staged.stat().st_size == 0:
                    raise AdapterError("Native normal-color render was incomplete.")
                digest, size = _hash_file(staged), staged.stat().st_size
                receipt = {
                    "schema": "kinetyl-native-render/1", "renderer": "ManimGX", "renderer_version": ENGINE_VERSION,
                    "font": FONT, "input_sha256": verified["input_sha256"], "output": str(destination / "movie.mp4"),
                    "video_bytes": size, "video_sha256": digest, "pixels": [width, height], "frame_rate": fps,
                    "frames": normal_frames, "normal_pixel_callbacks": normal_callbacks,
                    "normal_callback_rgba_sha256": pixel_digest.hexdigest(), "charged_pixels": required_pixels,
                    "contrast_premise": {"background": BACKGROUND, "minimum_ratio": MIN_CONTRAST, "ratios": contrast},
                    "id_pixel_tolerance": PIXEL_TOLERANCE, "id_pass_rows": rows,
                    "world_trajectories_changed": False,
                    "publication": "Exclusive new directory, exclusive files, completion manifest last; recoverable, not atomic directory visibility.",
                    "scope": "Exact declared-envelope verification plus sampled native ID-pass pixel bounds. Normal MP4 retains author colors. No continuous raster, general accessibility or viewer-comprehension certification.",
                }
                # Reserve only after all native checks. A competing path, even
                # an empty directory or dangling symlink, is never replaced.
                _publish_bundle(staged, destination, receipt)
            except AdapterError:
                raise
            except Exception as exc:
                raise AdapterError(f"Native render failed ({type(exc).__name__}); no output was published.") from exc
    return receipt
