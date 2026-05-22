import tempfile
import unittest
from pathlib import Path

from resin_slicer.electron_bridge import _mesh_from_request
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
