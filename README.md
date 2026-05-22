# Resin Slicer

Resin Slicer is a Windows-focused MSLA resin slicer with an Electron 3D viewer, deterministic Python slicing backend, automatic island support generation, and native `.goo` / `.ctb` export.

The project favors stability and explicit settings over silent guessing. Always confirm the machine profile, resin profile, and output format against the printer you intend to use before printing.

## Shared Portable Build

For someone who just wants to run the app:

1. Extract `ResinSlicer-Windows-Portable.zip`.
2. Run `Run ResinSlicer.bat`, or open `ResinSlicer\ResinSlicer.exe`.
3. Keep the `ResinSlicer` folder together. Do not move only the `.exe` out of the folder.

The packaged build includes Electron and a minimal Python runtime, so users should not need Node.js, npm, or a separate Python install.

To create the shareable package from source:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\package_release.ps1
```

Outputs:

- `dist\ResinSlicer-Windows-Portable\`
- `dist\ResinSlicer-Windows-Portable.zip`

## GUI Workflow

1. Open one or more STL/OBJ files, or drag mesh files into the 3D view.
2. Choose `GOO` or `CTB`.
3. Adjust placement/orientation in the 3D viewer and `Placement` section. Multiple loaded meshes are arranged automatically on the build plate.
4. Generate a support preview.
5. Slice to the selected output path.

Layer rendering uses multiple worker threads by default, capped at four workers or the number of layers in the job.

The main buttons stay visible by default. Deeper settings live in collapsible sections:

- `Placement`: rotation, translation, scale, centering.
- `Printer`: machine name, resolution, build volume, layer height.
- `Resin`: exposure, bottom layers, lift/retract distances and speeds, wait time, PWM, density.
- `Support Basics`: lift, overhang threshold, spacing, primary extra supports, post/tip basics.
- `Tip And Bed`: tip shape, tip length/angle, feet/raft/skate options.
- `Support Access`: collision clearance, base reach, shaft angle, enforcers.
- `Bracing`: cross-support structure.

## Profiles

The GUI can import and export:

- Machine profiles
- Resin profiles
- Support settings

Machine profiles can also be imported directly from the UVTools GitHub printer list. Use `Printer` -> `UVTools GitHub`, search for the printer, then import it into the current machine settings.

Exports are JSON files using this slicer's schema. Resin import also includes best-effort Chitubox-style field mapping for common names such as `normalExposureTime`, `bottomExposureTime`, `bottomLayerCount`, `liftingDistance`, `liftingSpeed`, `retractSpeed`, and `lightOffDelay`.

Chitubox profile formats are not fully standardized, so imported values should be reviewed after import.

## Supports

Support generation is island driven:

- Unsupported regions are detected layer-by-layer from overhang/island analysis.
- `Overhang deg` controls how aggressively regions are treated as unsupported.
- `Spacing mm` controls normal support density.
- `Primary extras` adds denser support candidates around each detected island's primary attachment area.
- `Enforcers` allow part-to-part supports for regions that cannot get a safe bed support.
- `Path clearance`, `Base reach`, and `Max shaft angle` control route safety.

The support preview shows posts, tips, bases, enforcers, and braces before slicing.

## File Format Notes

- `.goo`: native Elegoo GOO V3.0 writer with per-layer print settings and RLE compression.
- `.ctb`: native Chitu CTB v5 writer with CTB RLE, layer XOR coding, encrypted settings/signature sections, and preview/resin metadata records.

These are proprietary printer formats. The writer is intended to produce printer-compatible files, but machine firmware can be strict about resolution, build volume, metadata, and CTB/GOO dialects. Test with non-critical files first.

## Command Line

Basic slicing:

```powershell
python -m resin_slicer.cli model.stl --format goo --output model.goo --profile generic-2k
python -m resin_slicer.cli model.stl --format ctb --output model.ctb --profile generic-2k
python -m resin_slicer.cli model.stl --format goo --output model.goo --profile elegoo-jupiter-2-16k
python -m resin_slicer.cli model.obj --format goo --output model.goo --profile generic-2k
```

Orientation and printer overrides:

```powershell
python -m resin_slicer.cli model.stl --rotate-x 30 --rotate-z 45 --scale 0.95 --format goo --output model.goo
python -m resin_slicer.cli model.stl --resolution 3840x2400 --volume 130x82x160 --layer-height 0.05 --format goo --output model.goo
```

Support and resin settings:

```powershell
python -m resin_slicer.cli model.stl --model-lift 5 --overhang-angle 45 --support-spacing 3 --primary-supports --format goo --output model.goo
python -m resin_slicer.cli model.stl --exposure 2.5 --bottom-exposure 35 --lift-distance 5 --lift-speed 65 --retract-speed 150 --format ctb --output model.ctb
```

Disable supports:

```powershell
python -m resin_slicer.cli model.stl --no-supports --format ctb --output model.ctb
```

Control slicing worker threads:

```powershell
python -m resin_slicer.cli model.stl --format goo --output model.goo --workers 8
$env:RESIN_SLICER_LAYER_WORKERS = "8"
```

## Development

Run tests:

```powershell
python -m unittest discover -s tests
```

Run the Electron app from source with Vite hot renderer updates:

```powershell
npm install
npm run dev
```

The double-click `Launch Resin Slicer.vbs` launcher also starts this development flow. It launches the Vite dev server on `http://127.0.0.1:5178` and then starts Electron with `VITE_DEV_SERVER_URL` pointed at that server.

Renderer/UI changes hot-update through Vite without closing the Electron window. Electron main-process and preload changes still require restarting the app.

Build and run the production-style renderer files:

```powershell
npm run build
npm start
```

In production mode Electron loads `dist/index.html`; keep `npm run build` in the packaging flow before launching `npm start`.

Build the portable app folder without the release zip:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build_electron_portable.ps1
.\dist\ResinSlicer\ResinSlicer.exe
```

Build the optional root launcher:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build_launcher.ps1
.\ResinSlicer.exe
```

## Safety Checklist

Before printing:

- Match resolution and build volume to the exact printer.
- Confirm resin exposure, bottom exposure, lift speeds, and retract speeds.
- Preview supports after every orientation/settings change.
- Inspect islands and primary attachment regions.
- Start with a small, non-critical model when testing a new printer/profile combination.
