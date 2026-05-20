import unittest

from resin_slicer.mesh import cube_mesh
from resin_slicer.transform import MeshTransform, apply_transform


class TransformTests(unittest.TestCase):
    def test_rotate_cube_changes_bounds(self) -> None:
        mesh = cube_mesh(10)
        rotated = apply_transform(mesh, MeshTransform(rotate_x_deg=45))
        bounds = rotated.bounds()
        self.assertGreater(bounds.height, 10)
        self.assertAlmostEqual(bounds.width, 10)

    def test_scale_cube(self) -> None:
        scaled = apply_transform(cube_mesh(10), MeshTransform(scale=0.5))
        self.assertAlmostEqual(scaled.bounds().width, 5)


if __name__ == "__main__":
    unittest.main()
