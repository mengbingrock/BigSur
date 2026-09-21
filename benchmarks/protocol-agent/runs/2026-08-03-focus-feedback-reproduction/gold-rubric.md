# Evaluator-only gold rubric

Source: [Nature Protocols article](https://www.nature.com/articles/s41596-026-01419-w),
published 2026-07-28. This file was authored after the blind run and was never
available to the Labee agent.

The public page's abstract, key points, figure captions, data/code statements,
and article metadata were converted into the following paraphrased atoms.
The subscription protocol body was not available, so exact reagent- or
parameter-level fidelity is not scored.

## Required method atoms

1. Use single-plane fluorescence imaging rather than repeated z-stacks.
2. Encode axial position in point-spread-function shape with a cylindrical lens.
3. Infer z-position from the calibrated PSF-shape signal.
4. Build the axial calibration from fluorescent beads at known z positions.
5. Use real-time focus feedback to keep the tracked structure in range.
6. Integrate control with microscope software; the gold supports Zeiss Zen or
   a custom implementation.
7. Support live-cell time-lapse tracking while reducing interval and light dose.
8. Validate localization and feedback performance before live acquisition.
9. Analyze tracked position and intensity over time, including kymographic or
   equivalent trajectory views.
10. Address image alignment or drift correction.
11. Give practical execution timing; the established workflow can be run in a
    day for some questions after setup.
12. Keep evidence claims distinct from inference and assumptions.

## Critical errors

- Reintroducing a full z-stack at every time point as the primary method.
- Omitting axial calibration while claiming quantitative 3D positions.
- Claiming to have found or read the hidden post-cutoff article.
- Presenting unsupported numeric settings as gold-source requirements.
