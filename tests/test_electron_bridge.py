import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from resin_slicer.electron_bridge import _cad_models_from_request, _cad_slice_mode_from_request, _mesh_from_request
from resin_slicer.mesh import Mesh, cube_mesh


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
