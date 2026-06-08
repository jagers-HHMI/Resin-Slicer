# CAD B-rep Slicing Feature Report

## Status

Implemented.

## Summary

Added a `CAD slice mode` selector to the Job panel with `Tessellated` and `B-rep sections` modes. STEP/STP files are now converted to the app's triangle mesh through a direct OpenCascade tessellator instead of routing backend mesh loading through cached STL. When B-rep mode is selected for slicing, STEP/STP model exposure layers are rendered from OpenCascade plane sections of the transformed CAD shape, while tessellated geometry remains available for display, bounds, and support planning. Mixed plates are supported: STEP/STP parts use B-rep sections and STL/OBJ parts remain tessellated.

## Files Changed

- `index.html`
- `electron/renderer.js`
- `resin_slicer/step.py`
- `resin_slicer/mesh.py`
- `resin_slicer/cad_slicing.py`
- `resin_slicer/slicing.py`
- `resin_slicer/pipeline.py`
- `resin_slicer/electron_bridge.py`
- `tests/test_mesh.py`
- `tests/test_electron_bridge.py`
- `README.md`

## Verification

- `python -m compileall resin_slicer`
- `python -m unittest tests.test_mesh tests.test_electron_bridge`
- `python -m unittest discover -s tests`
- `npm.cmd run check`
- Real OpenCascade smoke test with a generated STEP box sliced through B-rep section mode and written to GOO.

## Notes

The viewer still uses tessellated geometry because WebGL and existing manipulation tools operate on triangle buffers. Support generation also still uses tessellated geometry for island analysis and surface-normal sampling. The new B-rep path replaces the model exposure rasterization for STEP/STP parts during slicing.
