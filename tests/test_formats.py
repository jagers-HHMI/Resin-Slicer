import tempfile
import unittest
from pathlib import Path

from resin_slicer.config import SupportConfig, profile
from resin_slicer.mesh import cube_mesh
from resin_slicer.pipeline import SliceJob, slice_to_file
from resin_slicer.transform import MeshTransform


class FormatSmokeTests(unittest.TestCase):
    def test_writes_goo_and_ctb(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=2.0)
        job = SliceJob(cube_mesh(6), config, SupportConfig(enabled=True))
        with tempfile.TemporaryDirectory() as tmp:
            goo_path = Path(tmp) / "cube.goo"
            ctb_path = Path(tmp) / "cube.ctb"
            goo_result = slice_to_file(job, goo_path, "goo")
            ctb_result = slice_to_file(job, ctb_path, "ctb")

            self.assertTrue(goo_path.read_bytes().startswith(b"V3.0"))
            self.assertEqual(ctb_path.read_bytes()[:4], (0x12FD0107).to_bytes(4, "little"))
            self.assertEqual(goo_result.layer_count, 6)
            self.assertEqual(ctb_result.layer_count, 6)
            self.assertGreater(goo_result.support_count, 0)
            self.assertGreater(ctb_result.support_count, 0)
            self.assertGreater(goo_path.stat().st_size, 1000)
            self.assertGreater(ctb_path.stat().st_size, 1000)

    def test_writes_with_rotation(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=2.0)
        job = SliceJob(cube_mesh(6), config, SupportConfig(enabled=False), MeshTransform(rotate_z_deg=30))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "cube.goo"
            result = slice_to_file(job, path, "goo")
            self.assertTrue(path.exists())
            self.assertGreater(result.layer_count, 0)

    def test_writes_with_parallel_layer_rendering(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=2.0)
        job = SliceJob(cube_mesh(6), config, SupportConfig(enabled=True))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "parallel.goo"
            result = slice_to_file(job, path, "goo", layer_workers=2)

            self.assertTrue(path.exists())
            self.assertEqual(result.layer_count, 6)
            self.assertGreater(result.support_count, 0)


if __name__ == "__main__":
    unittest.main()
