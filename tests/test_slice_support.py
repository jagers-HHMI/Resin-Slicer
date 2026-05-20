import unittest

from resin_slicer.config import SupportConfig, profile
from resin_slicer.mesh import Mesh, cube_mesh
from resin_slicer.slicing import prepare_mesh, render_model_layer
from resin_slicer.supports import _support_angle_deg, _support_radius_at_layer, apply_supports, plan_supports


class SliceSupportTests(unittest.TestCase):
    def test_cube_slices_to_non_empty_layers(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8), config)
        counts = [render_model_layer(prepared.mesh, config, i).count_on() for i in range(prepared.layer_count)]
        self.assertEqual(prepared.layer_count, 8)
        self.assertTrue(all(count > 0 for count in counts))

    def test_supports_are_deterministic_and_add_pixels(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_ledge_mesh(), config)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        plan_a = plan_supports(prepared, config, support, prepared.layer_count)
        plan_b = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertEqual(plan_a, plan_b)
        self.assertGreater(len(plan_a.anchors), 0)

        layer = render_model_layer(prepared.mesh, config, 0)
        before = layer.count_on()
        apply_supports(layer, 0, plan_a)
        self.assertGreaterEqual(layer.count_on(), before)

    def test_supported_pipeline_lifts_plate_contact_model(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        support = SupportConfig(enabled=True, model_lift_mm=4.0, support_spacing_mm=4.0)
        prepared = prepare_mesh(cube_mesh(8), config, z_offset_mm=support.model_lift_mm)
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        self.assertGreater(prepared.layer_count, 8)

    def test_higher_overhang_angle_generates_more_supports(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=4.0)
        loose = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=4.0,
                support_spacing_mm=4.0,
                min_island_area_mm2=0.01,
                overhang_angle_deg=20,
            ),
            prepared.layer_count,
        )
        strict = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=4.0,
                support_spacing_mm=4.0,
                min_island_area_mm2=0.01,
                overhang_angle_deg=70,
            ),
            prepared.layer_count,
        )
        self.assertGreater(len(strict.anchors), len(loose.anchors))

    def test_preferred_45_degree_orientation_generates_supports(self) -> None:
        from resin_slicer.transform import MeshTransform, apply_transform

        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        mesh = apply_transform(cube_mesh(20), MeshTransform(rotate_x_deg=45, rotate_y_deg=45))
        prepared = prepare_mesh(mesh, config, z_offset_mm=5.0)
        for angle in (45, 65, 89):
            support = SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=3.0,
                min_island_area_mm2=0.08,
                overhang_angle_deg=angle,
            )
            plan = plan_supports(prepared, config, support, prepared.layer_count)
            self.assertGreater(len(plan.anchors), 0)

    def test_support_columns_do_not_pass_through_model_below(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_stacked_gap_mesh(), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)

        for anchor in plan.anchors:
            base_x = anchor.base_x if anchor.base_x is not None else anchor.x
            base_y = anchor.base_y if anchor.base_y is not None else anchor.y
            joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
            for layer_index in range(joint_layer + 1):
                layer = render_model_layer(prepared.mesh, config, layer_index)
                x, y = _anchor_center(
                    base_x,
                    base_y,
                    anchor.joint_x if anchor.joint_x is not None else anchor.x,
                    anchor.joint_y if anchor.joint_y is not None else anchor.y,
                    layer_index,
                    joint_layer,
                )
                self.assertFalse(_disk_has_model(layer, x, y, plan.post_radius_px))

    def test_support_overhaul_options_create_braces(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            tip_type="sphere",
            tip_length_mm=0.6,
            tip_angle_deg=30,
            bed_interface="skate",
            brace_enabled=True,
            brace_max_distance_mm=12.0,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 1)
        self.assertGreater(len(plan.braces), 0)
        self.assertEqual(plan.bed_interface, "skate")
        self.assertTrue(all(anchor.tip_type == "sphere" for anchor in plan.anchors))

    def test_spacing_changes_support_density(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        dense = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=1.5,
                min_island_area_mm2=0.01,
                overhang_angle_deg=70,
            ),
            prepared.layer_count,
        )
        sparse = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=6.0,
                min_island_area_mm2=0.01,
                overhang_angle_deg=70,
            ),
            prepared.layer_count,
        )
        self.assertGreater(len(dense.anchors), len(sparse.anchors))

    def test_primary_supports_add_dense_island_attachments(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        common = dict(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=4.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
        )
        standard = plan_supports(prepared, config, SupportConfig(**common), prepared.layer_count)
        primary = plan_supports(
            prepared,
            config,
            SupportConfig(
                primary_supports_enabled=True,
                primary_density_multiplier=2.0,
                primary_area_radius_mm=4.0,
                primary_max_extra_per_island=8,
                **common,
            ),
            prepared.layer_count,
        )
        self.assertGreater(len(primary.anchors), len(standard.anchors))
        self.assertGreater(len([anchor for anchor in primary.anchors if anchor.role == "primary"]), 0)

    def test_sphere_tip_has_bulb_radius(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            tip_type="sphere",
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        anchor = next(anchor for anchor in plan.anchors if anchor.top_layer > (anchor.joint_layer or 0))
        joint_layer = anchor.joint_layer or 0
        radii = [_support_radius_at_layer(anchor, layer, plan) for layer in range(joint_layer + 1, anchor.top_layer + 1)]
        self.assertGreater(max(radii), max(plan.post_radius_px, plan.tip_radius_px))

    def test_bed_supports_respect_max_shaft_angle(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_offset_stack_mesh(), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            max_support_angle_deg=10,
            enforcers_enabled=False,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        self.assertTrue(all(_support_angle_deg(anchor, config) <= 10.01 for anchor in plan.anchors))
        self.assertTrue(all(anchor.kind == "bed" for anchor in plan.anchors))

    def test_enforcers_can_start_on_part_when_bed_route_is_blocked(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_offset_stack_mesh(), config, z_offset_mm=4.0)
        common = dict(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            max_support_angle_deg=0,
            enforcer_reach_mm=12.0,
            enforcer_min_drop_mm=1.0,
        )
        without_enforcers = plan_supports(
            prepared,
            config,
            SupportConfig(enforcers_enabled=False, **common),
            prepared.layer_count,
        )
        with_enforcers = plan_supports(
            prepared,
            config,
            SupportConfig(enforcers_enabled=True, **common),
            prepared.layer_count,
        )
        self.assertGreater(len(with_enforcers.anchors), len(without_enforcers.anchors))
        enforcers = [anchor for anchor in with_enforcers.anchors if anchor.kind == "enforcer"]
        self.assertGreater(len(enforcers), 0)
        for anchor in enforcers:
            base_x = anchor.base_x if anchor.base_x is not None else anchor.x
            base_y = anchor.base_y if anchor.base_y is not None else anchor.y
            base_layer = render_model_layer(prepared.mesh, config, anchor.base_layer)
            self.assertTrue(base_layer.pixels[base_y * base_layer.width + base_x])


def _translated_cube(size: float, offset: tuple[float, float, float]) -> list:
    ox, oy, oz = offset
    return [
        tuple((x + ox, y + oy, z + oz) for x, y, z in tri)
        for tri in cube_mesh(size).triangles
    ]


def _ledge_mesh() -> Mesh:
    triangles = []
    triangles.extend(_translated_cube(6, (0, 0, 0)))
    triangles.extend(_translated_cube(10, (4, 0, 6)))
    return Mesh(tuple(triangles))


def _stacked_gap_mesh() -> Mesh:
    triangles = []
    triangles.extend(_translated_cube(12, (0, 0, 0)))
    triangles.extend(_translated_cube(8, (2, 2, 14)))
    return Mesh(tuple(triangles))


def _offset_stack_mesh() -> Mesh:
    triangles = []
    triangles.extend(_translated_cube(12, (0, 0, 0)))
    triangles.extend(_translated_cube(8, (6, 2, 14)))
    return Mesh(tuple(triangles))


def _disk_has_model(layer, x: int, y: int, radius: int) -> bool:
    radius = max(0, radius)
    radius2 = radius * radius
    for yy in range(max(0, y - radius), min(layer.height, y + radius + 1)):
        for xx in range(max(0, x - radius), min(layer.width, x + radius + 1)):
            if (xx - x) * (xx - x) + (yy - y) * (yy - y) <= radius2:
                if layer.pixels[yy * layer.width + xx]:
                    return True
    return False


def _anchor_center(base_x: int, base_y: int, top_x: int, top_y: int, layer_index: int, top_layer: int) -> tuple[int, int]:
    if top_layer <= 0:
        return top_x, top_y
    t = layer_index / top_layer
    return (
        round(base_x + (top_x - base_x) * t),
        round(base_y + (top_y - base_y) * t),
    )


if __name__ == "__main__":
    unittest.main()
