"""Adapter contracts that do not need GPU access or renderer installation."""
from copy import deepcopy
from fractions import Fraction
import importlib.metadata
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from kinetyl import core
from kinetyl import manimgx_adapter as adapter


def intent():
    return {
        "schema": "kinetyl-intent/1", "duration": "2", "margin": "1/10",
        "camera_scales": ["1", "3/5"], "min_font_size": 36,
        "export": {"width": 640, "height": 360, "frame_rate": 12, "frame_height": "8"},
        "nodes": [{"id": "A", "text": "Flow A", "font_size": 36, "color": "#6CE5CF",
                   "radius": "1/10", "keyframes": [["0", "-2", "0"], ["1", "0", "0"], ["2", "2", "0"]]}],
    }


class FakeText:
    width = 1.0
    height = 0.5

    def get_center(self):
        return [0, 0, 0]

    def family_members_with_points(self):
        return [self]

    def get_subpaths(self):
        return [[[-0.5, -0.25, 0], [0.5, -0.25, 0], [0.5, 0.25, 0], [-0.5, -0.25, 0]]]


class AdapterTests(unittest.TestCase):
    def fake_renderer(self):
        return SimpleNamespace(config=SimpleNamespace(pixel_width=777, pixel_height=555, frame_rate=17,
                                                       _frame_height=None, frame_height=13, background_color="#334455"),
                               Text=lambda *args, **kwargs: FakeText())

    def measured(self):
        renderer = self.fake_renderer()
        with patch.object(adapter, "_load_renderer", return_value=renderer):
            return adapter.measure_scene(intent())

    def test_lazy_dependency_missing(self):
        with patch.object(importlib.metadata, "version", side_effect=importlib.metadata.PackageNotFoundError), \
             patch.object(adapter.importlib, "import_module", side_effect=AssertionError("import attempted")):
            with self.assertRaises(adapter.RendererUnavailable):
                adapter._load_renderer()

    def test_dependency_version_is_checked_before_import(self):
        with patch.object(importlib.metadata, "version", return_value="0.2.0"), \
             patch.object(adapter.importlib, "import_module", side_effect=AssertionError("import attempted")):
            with self.assertRaises(adapter.RendererUnavailable):
                adapter._load_renderer()

    def test_measurement_preserves_input_and_configuration(self):
        source = intent()
        original = deepcopy(source)
        renderer = self.fake_renderer()
        before = deepcopy(vars(renderer.config))
        with patch.object(adapter, "_load_renderer", return_value=renderer):
            measured = adapter.measure_scene(source)
        self.assertEqual(source, original)
        self.assertEqual(vars(renderer.config), before)
        self.assertEqual(measured["nodes"][0]["envelope"]["width"], "53/50")
        self.assertEqual(measured["nodes"][0]["envelope"]["height"], "14/25")
        self.assertEqual(measured["nodes"][0]["envelope"]["measurement"],
                         {"engine": "ManimGX", "version": "0.1.1", "font": "Noto Sans"})
        self.assertEqual(measured["nodes"][0]["envelope"]["glyph_paths"][0][0], ["M", "-1/2", "-1/4"])

    def test_configuration_restores_after_native_measurement_error(self):
        renderer = self.fake_renderer()
        before = deepcopy(vars(renderer.config))
        renderer.Text = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("typeset failed"))
        with patch.object(adapter, "_load_renderer", return_value=renderer):
            with self.assertRaisesRegex(adapter.AdapterError, "measurement failed"):
                adapter.measure_scene(intent())
        self.assertEqual(vars(renderer.config), before)

    def test_control_hull_is_inside_envelope(self):
        text = FakeText()
        text.get_subpaths = lambda: [[[-0.5, -0.25, 0], [1.0, -0.25, 0], [1.0, 0.25, 0], [-0.5, -0.25, 0]]]
        paths, width, _ = adapter._glyph_geometry(text)
        self.assertEqual(width, Fraction(103, 50))
        self.assertEqual(paths[0][1][1], "1")

    def test_outline_overflow_omits_all_contours(self):
        with patch.object(adapter, "MAX_COMMANDS_PER_NODE", 2):
            paths, width, height = adapter._glyph_geometry(FakeText())
        self.assertEqual(paths, [])
        self.assertGreater(width, 0)
        self.assertGreater(height, 0)

    def test_low_contrast_fails_before_native_dependency(self):
        source = intent()
        source["nodes"][0]["color"] = adapter.BACKGROUND
        with patch.object(adapter, "_load_renderer", side_effect=AssertionError("dependency loaded")):
            with self.assertRaisesRegex(adapter.AdapterError, "contrast"):
                adapter.measure_scene(source)

    def test_black_white_contrast_and_invalid_colors(self):
        self.assertEqual(adapter._luminance("#000000"), 0)
        self.assertAlmostEqual(adapter._luminance("#FFFFFF"), 1)
        for color in ("red", "#ZZ0000", True):
            with self.assertRaises(adapter.AdapterError):
                adapter._rgb(color)

    def test_piecewise_trajectory_and_outside_domain(self):
        keyframes = [["0", "-2", "0"], ["1", "0", "1"], ["2", "2", "0"]]
        self.assertEqual(adapter._point(keyframes, Fraction(1, 2)), (Fraction(-1), Fraction(1, 2)))
        self.assertEqual(adapter._point(keyframes, Fraction(3, 2)), (Fraction(1), Fraction(1, 2)))
        self.assertEqual(adapter._point(keyframes, Fraction(7)), (Fraction(2), Fraction(0)))

    def test_budget_charges_both_complete_passes(self):
        scene = self.measured()
        self.assertEqual(adapter._pixel_work(scene), (25, 25 * 640 * 360 * 2))
        plan = core.compile_scene(scene)
        with patch.object(adapter, "_load_renderer", side_effect=AssertionError("dependency loaded")):
            with self.assertRaisesRegex(adapter.AdapterError, "above budget"):
                adapter.render_plan(plan, "unused", pixel_budget=1)
            with self.assertRaisesRegex(adapter.AdapterError, "integer"):
                adapter.render_plan(plan, "unused", pixel_budget=True)

    def test_existing_path_and_dangling_symlink_are_preserved(self):
        plan = core.compile_scene(self.measured())
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / "existing"
            existing.write_bytes(b"original")
            dangling = Path(directory) / "dangling"
            dangling.symlink_to(Path(directory) / "missing")
            with patch.object(adapter, "_load_renderer", side_effect=AssertionError("dependency loaded")):
                for destination in (existing, dangling):
                    with self.assertRaisesRegex(adapter.AdapterError, "already exists"):
                        adapter.render_plan(plan, destination)
            self.assertEqual(existing.read_bytes(), b"original")
            self.assertTrue(dangling.is_symlink())

    def test_forged_typography_fails_before_gpu(self):
        scene = self.measured()
        scene["nodes"][0]["envelope"]["measurement"]["version"] = "forged"
        plan = core.compile_scene(scene)
        with tempfile.TemporaryDirectory() as directory, patch.object(adapter, "_load_renderer", return_value=self.fake_renderer()):
            destination = Path(directory) / "new"
            with self.assertRaisesRegex(adapter.AdapterError, "typography"):
                adapter.render_plan(plan, destination)
            self.assertFalse(destination.exists())

    def test_bundle_manifest_matches_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            staged, destination = Path(directory) / "staged", Path(directory) / "new"
            staged.write_bytes(b"unit-test video bytes, not a media validation")
            receipt = {"video_sha256": hashlib.sha256(staged.read_bytes()).hexdigest(), "detail": "λ"}
            adapter._publish_bundle(staged, destination, receipt)
            self.assertEqual(json.loads((destination / "native.json").read_text()), receipt)
            self.assertEqual((destination / "movie.mp4").read_bytes(), staged.read_bytes())
            for line in (destination / "SHA256SUMS").read_text().splitlines():
                digest, name = line.split("  ")
                self.assertEqual(hashlib.sha256((destination / name).read_bytes()).hexdigest(), digest)

    def test_bundle_publication_preserves_racing_empty_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            staged, destination = Path(directory) / "staged", Path(directory) / "new"
            staged.write_bytes(b"unit test")
            destination.mkdir()
            with self.assertRaisesRegex(adapter.AdapterError, "appeared"):
                adapter._publish_bundle(staged, destination, {"video_sha256": "a" * 64})
            self.assertEqual(list(destination.iterdir()), [])

    def test_partial_publication_preserves_created_video(self):
        with tempfile.TemporaryDirectory() as directory:
            staged, destination = Path(directory) / "staged", Path(directory) / "new"
            staged.write_bytes(b"unit test")
            with patch.object(adapter.os, "fsync", side_effect=OSError("simulated flush failure")):
                with self.assertRaisesRegex(adapter.AdapterError, "preserved"):
                    adapter._publish_bundle(staged, destination, {"video_sha256": "a" * 64})
            self.assertEqual((destination / "movie.mp4").read_bytes(), b"unit test")
            self.assertTrue((destination / "native.json").exists())
            self.assertFalse((destination / "SHA256SUMS").exists())

    def test_backend_failure_is_friendly_and_restores_configuration(self):
        renderer = self.fake_renderer()
        with patch.object(adapter, "_load_renderer", return_value=renderer):
            scene = adapter.measure_scene(intent())
        plan = core.compile_scene(scene)
        before = deepcopy(vars(renderer.config))
        original_import = adapter.importlib.import_module
        def modules(name, package=None):
            return object() if name == "numpy" else original_import(name, package)
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(adapter, "_load_renderer", return_value=renderer), \
             patch.object(adapter.importlib, "import_module", side_effect=modules), \
             patch.object(adapter, "_render_scene", side_effect=RuntimeError("GPU unavailable")):
            destination = Path(directory) / "new"
            with self.assertRaisesRegex(adapter.AdapterError, "Native render failed"):
                adapter.render_plan(plan, destination)
            self.assertFalse(destination.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])
        self.assertEqual(vars(renderer.config), before)


if __name__ == "__main__":
    unittest.main()
