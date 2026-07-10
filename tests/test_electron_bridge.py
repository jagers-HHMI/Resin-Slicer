import copy
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from resin_slicer.config import SupportConfig, profile
from resin_slicer.electron_bridge import (
    _brace_to_json,
    _cad_models_from_request,
    _cad_slice_mode_from_request,
    _load_support_plan,
    _mesh_from_request,
    _paint_zones_from_request,
    _plan_from_preview_request,
    _preview,
    _raft_preview_to_json,
    _slice,
    _support_from_request,
    _support_plan_cache_key,
    _support_to_json,
)
from resin_slicer.mesh import Mesh, cube_mesh
from resin_slicer.slicing import prepare_mesh
from resin_slicer.supports import plan_supports


class ElectronBridgeTests(unittest.TestCase):
    def test_combines_multiple_arranged_models(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "first.stl"
            second = Path(tmp) / "second.stl"
            _write_ascii_stl(first, cube_mesh(10))
            _write_ascii_stl(second, cube_mesh(10))

            mesh = _mesh_from_request(
                {
                    "models": [
                        {"inputPath": str(first), "transform": {"translateX": 0}},
                        {"inputPath": str(second), "transform": {"translateX": 14}},
                    ]
                }
            )

        bounds = mesh.bounds()
        self.assertEqual(len(mesh.triangles), 24)
        self.assertAlmostEqual(bounds.min_x, 0)
        self.assertAlmostEqual(bounds.max_x, 24)

    def test_brep_mode_collects_step_models_and_omits_them_from_raster_mesh(self) -> None:
        request = {
            "cadSlicingMode": "brep",
            "models": [
                {"inputPath": "cad.step", "transform": {"translateX": 2}},
                {"inputPath": "mesh.stl", "transform": {"translateX": 4}},
            ],
        }

        with patch("resin_slicer.electron_bridge.load_mesh", return_value=cube_mesh(5)) as load_mesh:
            raster_mesh = _mesh_from_request(request, include_step=False)

        self.assertEqual(_cad_slice_mode_from_request(request), "brep")
        self.assertEqual(len(_cad_models_from_request(request)), 1)
        self.assertIsNotNone(raster_mesh)
        self.assertEqual(len(raster_mesh.triangles), 12)
        load_mesh.assert_called_once_with("mesh.stl")

    def test_tessellated_mode_is_default(self) -> None:
        self.assertEqual(_cad_slice_mode_from_request({}), "tessellated")

    def test_slice_preview_uses_full_printer_resolution(self) -> None:
        result = SimpleNamespace(output_path=Path("out.goo"), layer_count=1, support_count=0, material_ml=0.1)

        with (
            patch("resin_slicer.electron_bridge._mesh_from_request", return_value=cube_mesh(1)),
            patch("resin_slicer.electron_bridge._config_from_request", return_value=profile("generic-2k")),
            patch("resin_slicer.electron_bridge.tempfile.mkdtemp", return_value="preview-dir"),
            patch("resin_slicer.electron_bridge._write_json"),
            patch("resin_slicer.electron_bridge.slice_to_file", return_value=result) as slice_to_file,
        ):
            _slice({"outputPath": "out.goo", "format": "goo"})

        self.assertEqual(slice_to_file.call_args.kwargs["preview_scale"], 1)

    def test_slice_passes_manual_only_flag(self) -> None:
        result = SimpleNamespace(output_path=Path("out.goo"), layer_count=1, support_count=0, material_ml=0.1)

        with (
            patch("resin_slicer.electron_bridge._mesh_from_request", return_value=cube_mesh(1)),
            patch("resin_slicer.electron_bridge._config_from_request", return_value=profile("generic-2k")),
            patch("resin_slicer.electron_bridge.tempfile.mkdtemp", return_value="preview-dir"),
            patch("resin_slicer.electron_bridge._write_json"),
            patch("resin_slicer.electron_bridge.slice_to_file", return_value=result) as slice_to_file,
        ):
            _slice({"outputPath": "out.goo", "format": "goo", "manualOnly": True})
            job = slice_to_file.call_args.args[0]
            self.assertTrue(job.manual_support_only)

            _slice({"outputPath": "out.goo", "format": "goo"})
            job = slice_to_file.call_args.args[0]
            self.assertFalse(job.manual_support_only)

    def test_paint_zones_parse_and_skip_invalid_entries(self) -> None:
        zones = _paint_zones_from_request(
            {
                "supportPaint": [
                    {"x": 1.0, "y": 2.0, "z": 3.0, "radius": 2.5, "mode": "exclude"},
                    {"x": 4.0, "y": 5.0, "z": 6.0, "mode": "require"},
                    {"x": 7.0, "y": 8.0, "z": 9.0, "mode": "bogus"},
                    {"y": 1.0, "z": 2.0, "mode": "exclude"},
                    "not-a-dict",
                ]
            }
        )
        self.assertEqual(len(zones), 2)
        self.assertEqual(zones[0].mode, "exclude")
        self.assertEqual(zones[0].radius, 2.5)
        self.assertEqual(zones[1].mode, "require")
        self.assertEqual(zones[1].radius, 2.0)

    def test_paint_zones_default_to_empty(self) -> None:
        self.assertEqual(_paint_zones_from_request({}), ())

    def test_brace_interval_maps_from_request(self) -> None:
        self.assertEqual(_support_from_request({"support": {}}).brace_interval_mm, 0.0)
        self.assertEqual(
            _support_from_request({"support": {"braceInterval": 7.5}}).brace_interval_mm, 7.5
        )

    def test_preview_plan_round_trip_matches_original(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        support_cfg = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        prepared = prepare_mesh(cube_mesh(8), config, z_offset_mm=support_cfg.model_lift_mm)
        plan = plan_supports(prepared, config, support_cfg, prepared.layer_count, include_raft_mask=False)
        self.assertGreater(len(plan.anchors), 0)

        request = {
            "previewPlan": {
                "supports": [_support_to_json(anchor, plan, config, support_cfg) for anchor in plan.anchors],
                "braces": [_brace_to_json(brace, config) for brace in plan.braces],
            }
        }
        rebuilt = _plan_from_preview_request(request, config, support_cfg)
        self.assertEqual(rebuilt, plan)

    def test_preview_plan_absent_without_payload(self) -> None:
        config = profile("small-test")
        support_cfg = SupportConfig(enabled=True)
        self.assertIsNone(_plan_from_preview_request({}, config, support_cfg))

    def test_raft_preview_follows_model_shadow(self) -> None:
        config = profile("small-test")
        support = SupportConfig(enabled=True, bed_interface="raft", raft_margin_mm=1.0)
        # Two cubes on a diagonal: an accurate raft preview has two separate
        # pads, not one bounding rectangle across both.
        triangles = []
        for offset in ((5, 5, 0), (25, 25, 0)):
            triangles.extend(cube_mesh(10).transformed(offset).triangles)
        prepared = prepare_mesh(Mesh(tuple(triangles)), config, preserve_coordinates=True)

        payload = _raft_preview_to_json(prepared, config, support)
        self.assertIsNotNone(payload)
        rects = payload.get("rects")
        self.assertTrue(rects)
        covered = sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in rects)
        box_area = (payload["x1"] - payload["x0"]) * (payload["y1"] - payload["y0"])
        self.assertLess(covered, box_area * 0.5)
        # Rows over the first cube must not stretch to the second cube.
        low_rows = [rect for rect in rects if rect[1] < 12]
        self.assertTrue(low_rows)
        self.assertLess(max(rect[2] for rect in low_rows), 20)

    def test_raft_preview_absent_for_feet_interface(self) -> None:
        config = profile("small-test")
        support = SupportConfig(enabled=True, bed_interface="feet")
        prepared = prepare_mesh(cube_mesh(8), config)
        self.assertIsNone(_raft_preview_to_json(prepared, config, support))

    def test_cache_key_changes_with_paint_zones(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "cube.stl"
            _write_ascii_stl(model, cube_mesh(8))
            request = _cache_request(model, Path(tmp) / "out.goo")
            key = _support_plan_cache_key(request)

            painted = copy.deepcopy(request)
            painted["supportPaint"] = [{"x": 1.0, "y": 2.0, "z": 3.0, "radius": 2.0, "mode": "exclude"}]
            self.assertNotEqual(key, _support_plan_cache_key(painted))

            manual_only = copy.deepcopy(request)
            manual_only["manualOnly"] = True
            self.assertNotEqual(key, _support_plan_cache_key(manual_only))


class SupportPlanCacheTests(unittest.TestCase):
    def test_slice_reuses_previewed_support_plan(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "cube.stl"
            _write_ascii_stl(model, cube_mesh(8))
            output = Path(tmp) / "out.goo"
            request = _cache_request(model, output)

            with patch("resin_slicer.electron_bridge._plan_cache_dir", return_value=Path(tmp) / "plans"):
                with patch("resin_slicer.electron_bridge._write_json"):
                    _preview(request)

                cached = _load_support_plan(_support_plan_cache_key(request))
                self.assertIsNotNone(cached)
                self.assertGreater(len(cached.anchors), 0)

                with (
                    patch("resin_slicer.electron_bridge._write_json"),
                    patch(
                        "resin_slicer.pipeline.plan_supports",
                        side_effect=AssertionError("slice should reuse the previewed support plan"),
                    ),
                ):
                    _slice(request)

            self.assertTrue(output.exists())

    def test_slice_uses_shipped_preview_plan_verbatim(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "cube.stl"
            _write_ascii_stl(model, cube_mesh(8))
            output = Path(tmp) / "out.goo"
            request = _cache_request(model, output)
            messages = []

            with patch("resin_slicer.electron_bridge._plan_cache_dir", return_value=Path(tmp) / "plans"):
                with patch("resin_slicer.electron_bridge._write_json", side_effect=messages.append):
                    _preview(request)
                preview = next(m for m in messages if m["type"] == "preview")
                self.assertGreater(len(preview["supports"]), 1)

                # Ship a trimmed plan (one anchor) to prove the slicer uses the
                # shipped plan verbatim instead of the cache or a fresh analysis.
                sliced = copy.deepcopy(request)
                sliced["previewPlan"] = {"supports": preview["supports"][:1], "braces": []}
                with (
                    patch("resin_slicer.electron_bridge._write_json", side_effect=messages.append),
                    patch(
                        "resin_slicer.pipeline.plan_supports",
                        side_effect=AssertionError("slicing must not replan supports"),
                    ),
                ):
                    _slice(sliced)

            done = next(m for m in messages if m["type"] == "done")
            self.assertEqual(done["supports"], 1)
            self.assertTrue(output.exists())

    def test_cache_key_changes_with_settings_and_model_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "cube.stl"
            _write_ascii_stl(model, cube_mesh(8))
            request = _cache_request(model, Path(tmp) / "out.goo")
            key = _support_plan_cache_key(request)
            self.assertIsNotNone(key)

            respaced = copy.deepcopy(request)
            respaced["support"]["spacing"] = 5.5
            self.assertNotEqual(key, _support_plan_cache_key(respaced))

            renamed_output = copy.deepcopy(request)
            renamed_output["outputPath"] = str(Path(tmp) / "different-name.goo")
            self.assertEqual(key, _support_plan_cache_key(renamed_output))

            future = time.time_ns() + 5_000_000_000
            os.utime(model, ns=(future, future))
            self.assertNotEqual(key, _support_plan_cache_key(request))


def _cache_request(model: Path, output: Path) -> dict:
    return {
        "profile": "small-test",
        "models": [{"inputPath": str(model), "transform": {}}],
        "support": {"enabled": True, "modelLift": 4.0, "spacing": 4.0},
        "outputPath": str(output),
        "format": "goo",
    }


def _write_ascii_stl(path: Path, mesh: Mesh) -> None:
    lines = ["solid test"]
    for triangle in mesh.triangles:
        lines.append("facet normal 0 0 0")
        lines.append("outer loop")
        for x, y, z in triangle:
            lines.append(f"vertex {x} {y} {z}")
        lines.append("endloop")
        lines.append("endfacet")
    lines.append("endsolid test")
    path.write_text("\n".join(lines), encoding="ascii")


if __name__ == "__main__":
    unittest.main()
