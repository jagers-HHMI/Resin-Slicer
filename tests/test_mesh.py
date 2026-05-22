import tempfile
import unittest
from pathlib import Path

from resin_slicer.mesh import load_mesh, load_obj


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


def _load_obj_text(text: str):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "part.obj"
        path.write_text(text, encoding="utf-8")
        return load_obj(path)


if __name__ == "__main__":
    unittest.main()
