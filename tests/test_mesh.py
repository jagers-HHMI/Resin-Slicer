import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from resin_slicer.mesh import Mesh, load_mesh, load_obj


class MeshLoadTests(unittest.TestCase):
    def test_loads_obj_quad_as_two_triangles(self) -> None:
        mesh = _load_obj_text(
            "\n".join(
                [
                    "v 0 0 0",
                    "v 10 0 0",
                    "v 10 10 0",
                    "v 0 10 0",
                    "f 1 2 3 4",
                ]
            )
        )

        self.assertEqual(len(mesh.triangles), 2)
        self.assertEqual(mesh.bounds().width, 10)

    def test_loads_obj_negative_indices_and_slash_faces(self) -> None:
        mesh = _load_obj_text(
            "\n".join(
                [
                    "v 0 0 0",
                    "v 3 0 0",
                    "v 0 4 0",
                    "vt 0 0",
                    "vn 0 0 1",
                    "f -3/1/1 -2/1/1 -1/1/1",
                ]
            )
        )

        self.assertEqual(len(mesh.triangles), 1)
        self.assertEqual(mesh.bounds().width, 3)
        self.assertEqual(mesh.bounds().depth, 4)

    def test_load_mesh_dispatches_obj_extension(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "part.obj"
            path.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", encoding="utf-8")

            self.assertEqual(len(load_mesh(path).triangles), 1)

    def test_load_mesh_dispatches_step_extension_through_native_tessellation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            step_path = Path(tmp) / "part.stp"
            step_path.write_text("ISO-10303-21;\nEND-ISO-10303-21;\n", encoding="ascii")

            with patch("resin_slicer.step.step_to_mesh", return_value=Mesh((((0, 0, 0), (1, 0, 0), (0, 1, 0)),))):
                self.assertEqual(len(load_mesh(step_path).triangles), 1)


def _load_obj_text(text: str):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "part.obj"
        path.write_text(text, encoding="utf-8")
        return load_obj(path)


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
