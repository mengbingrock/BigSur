The practical solution is single-plane astigmatic 3D localization plus piezo feedback. A weak cylindrical lens encodes axial position in the spot’s ellipticity, so every 200-ms cycle yields \(x,y,z\) without acquiring a z-stack. The piezo keeps the locus inside the calibrated axial range; its encoder record restores the motion removed by feedback.

## Evidence and assumptions

Retrieved Crossref metadata supports the general design:

- Cylindrical optics can encode a fluorescent particle’s 3D position in a single image ([Kao and Verkman, 1994](https://doi.org/10.1016/S0006-3495(94)80601-0)).
- Astigmatic z estimation can use an empirical bead calibration rather than an assumed analytical defocus curve, while estimating localization error ([Bayesian axial estimation, 2009](https://doi.org/10.1155/2009/896208)).
- Realistic 3D PSF fitting is applicable to wide-field microscopy ([Aguet et al., 2012](https://doi.org/10.1111/j.1365-2818.2012.03675.x)).
- lacO/LacI-GFP is an established locus-labeling method ([2017 protocol](https://doi.org/10.1101/pdb.prot091934)); FROS labeling has been used for high-temporal-resolution 3D chromosome imaging in budding yeast ([2021 study](https://doi.org/10.3389/fcell.2021.687132)).
- Long-term microscopy benefits from automated position/focus correction ([2004 tracking study](https://doi.org/10.1111/j.0022-2720.2004.01404.x)).
- Localization error and exposure-time blur must be included in trajectory analysis ([Savin and Doyle, 2005](https://doi.org/10.1529/biophysj.104.042457); [Michalet, 2010](https://doi.org/10.1103/physreve.82.041914)).

All exact focal lengths, exposures, controller gains, precision thresholds, sample preparation details, and timings below are engineering assumptions and must be accepted or adjusted from measured performance.

# Executable protocol

## 1. Modify and stabilize the microscope

1. Use the existing high-NA objective with the immersion medium and correction collar normally used for live yeast. Enclose the objective, stage, and sample sufficiently to hold the selected growth temperature.

2. Insert a weak cylindrical lens in a collimated portion of the emission relay, with its powered axis aligned to a camera axis.  
   **Assumption:** start with a 0.5–1 m focal-length cylindrical lens and adjust its position until the \(x\)- and \(y\)-focus planes are separated enough to give a unique calibration over at least ±0.8 µm. Do not use such strong astigmatism that the in-focus spot becomes photon-inefficient.

3. Use LED illumination if available, or hardware-gate the existing excitation source from the camera exposure signal. The piezo must never move during an exposure.

4. Use a fixed camera ROI large enough to contain the entire expected cell and drift range.  
   **Assumption:** 256×256 pixels is usually adequate at approximately 100× magnification; use 512×512 if the calibrated field is smaller or drift is substantial. Fit only a small software window around the spot.

5. Record on every frame:

   - Camera hardware timestamp and exposure duration.
   - Raw 16-bit image.
   - Piezo command and closed-loop encoder position.
   - Excitation state and nominal power.
   - Online spot parameters, uncertainty, and controller state.

6. If possible, provide weak transmitted illumination at a wavelength passed by the GFP emission path but inefficient at exciting GFP.  
   **Assumption:** a 535–545 nm condenser LED can supply occasional 1–3 ms cell-reference images without moving the fluorescence filter cube. Verify experimentally that it does not measurably bleach GFP or obscure the spot.

## 2. Prepare the sample

1. Immobilize exponentially growing cells in a sealed or perfused chamber containing the normal growth medium.  
   **Assumption:** concanavalin-A attachment and approximately 30 °C are suitable for standard *S. cerevisiae* strains; substitute the strain’s validated conditions.

2. Avoid compressing cells under a thick agar pad unless normal budding under that geometry has already been demonstrated.

3. Choose an isolated cell with one unsaturated locus, low diffuse GFP background, and sufficient clearance from neighboring fluorescent cells.

4. Bring the locus, located approximately 2–3 µm above the coverslip, to the midpoint of the astigmatic calibration range.

## 3. Perform session calibration

### Camera and lateral scale

1. Acquire at least 100 dark frames at every production exposure time. Construct per-pixel offset, variance, bad-pixel, and—if available—gain maps.

2. Measure effective pixel size with a stage micrometer or calibrated piezo displacement.

3. Avoid changing ROI, relay spacing, cylindrical-lens position, camera orientation, objective, correction collar, or immersion after calibration.

### Astigmatic z calibration

1. Prepare sub-resolution fluorescent beads whose emission approximates GFP. Place beads at approximately the same 2–3 µm optical depth in medium with similar refractive index. A coverslip-surface bead calibration alone is insufficient if its curve differs measurably from the live-cell depth.

2. At live-cell-like photon counts, scan an immobilized bead from −1.5 to +1.5 µm in 50-nm steps. Acquire 10 frames per step and repeat the scan three times in alternating directions.

3. Fit each image with a pixel-integrated elliptical Gaussian or measured-PSF likelihood, including position, amplitude, background, \(\sigma_x\), \(\sigma_y\), and orientation.

4. Calculate an axial observable such as

\[
q=\frac{\sigma_x^2-\sigma_y^2}{\sigma_x^2+\sigma_y^2}.
\]

Fit a monotonic spline \(z=f(q)\), or use a bead-derived PSF template library. Do not extrapolate beyond the unique calibrated interval.

5. Validate on withheld scans and multiple beads.  
   **Assumed acceptance criteria:** median error ≤40 nm laterally, ≤75–100 nm axially, negligible hysteresis, and a usable range of at least ±0.8 µm at production brightness.

6. Repeat at several field positions. If z bias changes by more than the chosen accuracy limit, use a local calibration or restrict cells to a central calibrated region.

### Piezo polarity and cross-talk

1. With an immobilized bead, command ±100- and ±200-nm z steps. Determine the sign converting piezo motion into optical defocus.

2. Fit lateral shifts caused by piezo motion, \(x_p(p)\) and \(y_p(p)\), for later subtraction.

3. Determine \(\beta\) in

\[
Z_{\mathrm{microscope}}(t)
 =z_{\mathrm{residual}}(t)+\beta[p(t)-p_0],
\]

choosing its sign and scale so that a stationary bead remains stationary when feedback moves the piezo.

4. Run a 30-minute, 5-Hz stationary-bead test with the production controller. Reject the setup if reconstruction shows drift, oscillation, or periodic errors comparable to the intended biological displacements.

### Optional cell-reference calibration

Immediately before production, acquire one low-dose transmitted-light stack of the selected cell over ±1 µm in 100-nm steps. Return to the initial piezo position and wait 2 seconds. Store these images as templates relating cell appearance to cell-plane defocus. This is a one-time, nonfluorescent calibration stack—not a repeated fluorescence stack.

## 4. Set illumination

1. Start with a 20–50 ms GFP exposure every 200 ms.  
   **Assumption:** 30 ms is a useful initial value, leaving most of each cycle dark for fitting, disk writing, and piezo settling.

2. Adjust irradiance—not exposure period—to obtain the lowest photon count that passes the calibrated localization-precision threshold.

3. Keep the brightest pixel below approximately 70% of full well and verify that background subtraction is stable.

4. Acquire a 60-second test. Proceed only if:

   - No saturated frames occur.
   - At least 99% of frames produce valid fits.
   - Estimated precision passes the calibration threshold.
   - The piezo is not oscillating.
   - Extrapolated intensity remains adequate for the requested duration.

## 5. Run live acquisition and feedback

Execute the following hardware-timed loop for 3,000–9,000 cycles:

```text
Every 200 ms:
    1. Freeze piezo command.
    2. Expose GFP for 20–50 ms.
    3. Read the fixed camera ROI and timestamp it.
    4. Correct offset/bad pixels for online fitting.
    5. Detect the locus near its predicted x-y position.
    6. Fit the astigmatic PSF and calculate x, y, z_residual and uncertainty.
    7. If fit quality passes:
           update the z controller.
       Else:
           hold the piezo; never chase an uncertain detection.
    8. Command the piezo only after exposure; require settling before the next exposure.
    9. Save raw frame, encoder value, fit diagnostics and controller state.
```

Use a PI controller:

\[
\Delta p=s\left(K_Pz_{\mathrm{residual}}
              +K_I\sum z_{\mathrm{residual}}\Delta t\right),
\]

where \(s\) is the measured polarity.

**Assumed initial tuning:** \(K_P=0.4\)–0.7, weak integral action, a 20–30 nm deadband, and a maximum command of 150–200 nm per frame. Tune on beads; reduce gain if the residual z alternates in sign or the encoder spectrum develops a peak near the loop frequency.

Every 1–2 seconds, fit a 1–3 ms transmitted-light reference image acquired during the dark interval. Template-match it to the initial cell stack to estimate the cell plane and cell centroid. Do not let this slower, noisier estimate drive the fast piezo loop.

Loss handling:

- One failed frame: hold the piezo and enlarge the search window.
- Two to five failures: use only the last valid position for prediction; keep holding z.
- More than 1 second without a valid localization: terminate the continuous track and label it broken. Do not silently bridge it or start a fluorescence z-stack.
- A single diagnostic recovery stack may be acquired after termination, but it is not part of the continuous trajectory.

## 6. Live checkpoints

At 60-second intervals, automatically evaluate:

- Valid-fit fraction ≥99%.
- No saturation.
- Residual z inside the central half of the calibrated interval for ≥95% of frames.
- Piezo encoder comfortably inside its travel range.
- Online localization uncertainty below the preregistered limit.
- No controller oscillation or sustained maximum-step commands.
- Spot intensity still sufficient for the remaining duration.

**Assumed abort limits:** stop if intensity falls below that required for 150-nm axial precision, if more than 1% of frames fail within a rolling minute, or if the residual reaches 80% of the calibrated range.

After 10–30 minutes, stop continuous excitation and acquire:

1. One transmitted-light image.
2. One terminal low-dose fluorescence stack, for example seven planes at 200-nm spacing, solely to verify the final single-frame z estimate.
3. A 30–60 minute low-dose transmitted-light follow-up to confirm continued budding or outgrowth.

## 7. Validate before collecting the biological dataset

1. **Static precision:** Image depth-matched immobilized beads for 30 minutes at 5 Hz and production brightness. Report RMS displacement, slow drift, fit-failure rate, and power spectra.

2. **Known displacement:** With feedback disabled, drive an immobilized bead through known steps and sinusoids spanning approximately 50–500 nm and 0.01–1 Hz. Compare reconstructed amplitude, sign, phase, and cross-axis motion with the piezo encoder.

3. **Closed-loop reconstruction:** Repeat with feedback enabled. Confirm that residual defocus plus encoder displacement recovers the programmed trajectory.

4. **Calibration transfer:** On separate cells, briefly compare single-frame astigmatic z with occasional conventional stacks. These validation cells are not used for long-duration biological analysis.

5. **Phototoxicity:** Compare imaged and stage-resident nonfluorescence controls under identical chamber conditions.  
   **Assumed acceptance criterion:** no material reduction in survival, outgrowth, or budding rate and no obvious cell-shape abnormality. Reduce irradiance before shortening the 200-ms interval.

## 8. Reconstruct and analyze trajectories

1. Refit all raw fluorescence frames offline using the measured sCMOS noise model and bead-derived PSF/template calibration. Online coordinates are for control, not final analysis.

2. Retain per-frame covariance or bootstrap uncertainty. Exclude saturated, nonunique, boundary, and out-of-calibration fits; do not interpolate them for displacement statistics.

3. Correct lateral piezo cross-talk:

\[
X=x_{\mathrm{fit}}-x_p(p),\qquad
Y=y_{\mathrm{fit}}-y_p(p).
\]

4. Produce two axial coordinates:

\[
Z_{\mathrm{microscope}}
 =z_{\mathrm{residual}}+\beta(p-p_0),
\]

and, where the transmitted-light cell reference is reliable,

\[
Z_{\mathrm{cell}}
 =z_{\mathrm{residual}}-z_{\mathrm{cell\,plane}}.
\]

The second quantity cancels stage motion directly. Correct \(X,Y\) for cell-centroid drift in the same way. Because there is no nuclear-envelope marker, do not interpret cell-center distance as nuclear radial position.

5. Preserve unsmoothed coordinates as the primary data. Any Kalman filter used by the controller must not replace raw-frame localization offline.

6. Calculate 3D displacements, coordinate covariance, displacement distributions, directional persistence, and time-averaged MSD. For each lag, subtract the summed endpoint localization variances from the observed squared displacement.

7. Account for finite exposure. For a Brownian comparison model and nonoverlapping exposures, use an effective lag approximately \(\Delta t-T_{\mathrm{exp}}/3\); for confined or anomalous models, forward-simulate exposure averaging instead of applying that Brownian correction blindly.

8. Fit only lags up to roughly one-quarter of each track and report both raw and error-aware results. Bootstrap contiguous time blocks and, for population conclusions, resample whole cells rather than treating frames as independent replicates.

9. Archive raw images, calibrations, controller logs, analysis code version, rejected-frame masks, and all assumptions needed to reproduce the trajectory.

## Practical timing

| Activity | Assumed duration |
|---|---:|
| Install and align cylindrical lens, once | 2–4 h |
| Camera, depth, and piezo calibration per session | 45–90 min |
| Prepare and equilibrate cells | 30–60 min |
| Select cell and acquire reference templates | 2–5 min |
| Test exposure and feedback | 1–2 min |
| Continuous acquisition | 10–30 min |
| Terminal QC and viability follow-up | 35–65 min |
| Automated reconstruction per track | 5–15 min |

The decisive go/no-go checkpoint is the 30-minute depth-matched bead run: production imaging should begin only after it demonstrates stable 5-Hz feedback, unique astigmatic z recovery, and reconstruction errors below the biological displacement scale.