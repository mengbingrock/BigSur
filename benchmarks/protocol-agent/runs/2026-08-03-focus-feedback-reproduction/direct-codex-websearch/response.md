## Recommended architecture

Use single-plane astigmatic 3D localization with locus-following axial feedback:

- Insert a weak cylindrical lens in the GFP emission path so each camera frame encodes \(z\) in the spot’s ellipticity.
- Fit the locus after every frame and move the closed-loop \(z\)-piezo during the dark interval to keep it near the center of the calibrated axial range.
- Reconstruct the unforced trajectory from the piezo encoder position plus the locus’s residual position relative to focus.
- Do not scan \(z\) during production acquisition.

This is the least invasive modification compatible with 5 Hz acquisition. Astigmatism and biplane imaging both provide single-frame axial information, and image-derived \(z\) estimates have previously been coupled to piezo feedback ([real-time 3D tracking review](https://pmc.ncbi.nlm.nih.gov/articles/PMC6695621/)). A pre-cutoff study also demonstrated 3D LacI-GFP chromatin tracking in budding yeast with an engineered PSF, although its 6-µm Tetrapod PSF spreads photons over many pixels and is unnecessarily elaborate here ([yeast Tetrapod study](https://pmc.ncbi.nlm.nih.gov/articles/PMC5745116/)).

All uncited numerical values below are engineering starting assumptions to be verified during calibration, not universal biological limits.

### 1. Microscope and sample setup

1. Use a high-NA objective appropriate for a #1.5H coverslip. If it is oil immersion, set any correction collar using a sample mounted identically to the experiment; the 2–3 µm imaging depth makes depth-dependent spherical aberration relevant.

2. Maintain the cells at their normal experimental temperature in a sealed chamber.  
   **Assumption:** 30 °C is appropriate for the strain and biological question.

3. Immobilize cells on a concanavalin-A-coated coverslip or in a thin, low-autofluorescence agarose pad made with the experimental medium. Confirm separately that immobilization does not change locus dynamics or growth.

4. Use 488-nm wide-field epi-illumination with:

   - A field stop restricting illumination to the camera ROI.
   - Electronic intensity control.
   - Camera-exposure TTL driving the light source directly, so excitation is on only while the sensor is integrating. Illumination outside camera exposure can be a substantial source of unnecessary dose ([illumination-overhead study](https://journals.biologists.com/jcs/article/133/4/jcs242834/224018/Optimizing-live-cell-fluorescence-imaging)).

   TIRF is unsuitable because the locus is 2–3 µm above the coverslip.

5. Place a removable weak cylindrical lens in a relayed emission path, preferably at or near a pupil-conjugate plane. Align its axes with the camera rows and columns. Adjust its power or position until the two astigmatic focal planes are separated enough to give a monotonic \(z\) response over approximately ±0.5–0.8 µm, while keeping the PSF compact.

6. Set the effective sample pixel size near 70–120 nm/pixel. Use a fixed 192×192 or 256×256 ROI containing the whole cell and enough margin for lateral drift. At 16-bit depth, 9,000 frames from a 256² ROI occupy about 1.2 GB.

7. Preferably add a very sparse population of immobilized green fluorescent beads to the pad at approximately the locus depth. Select one or more isolated beads outside the cell in the same ROI. They require no second color or additional exposure and permit common-mode \(x,y,z\) drift subtraction. Marker-based 3D drift correction on an ordinary fluorescence microscope is established in principle ([marker-assisted drift correction](https://pmc.ncbi.nlm.nih.gov/articles/PMC5444076/)).

   If suitable fiducials cannot be prepared, the result is a microscope-frame trajectory. A single fluorescent locus cannot by itself distinguish chromatin motion from whole-cell translation, nuclear translation, or sample drift.

### 2. Calibration

Perform the complete calibration after any optical realignment and a shorter verification each imaging day.

1. **Camera calibration — 30–60 minutes initially**

   - Record 5,000–10,000 dark frames at the production exposure and readout settings.
   - Estimate per-pixel offset and variance; obtain conversion gain from a photon-transfer measurement or manufacturer-supported calibration.
   - Record a flat field and mask hot or unstable pixels.
   - Use the pixel-dependent maps in both online and offline fitting. sCMOS pixel nonuniformity can bias localization, and pixel-specific offsets should be removed ([2017 sCMOS analysis](https://eprints.whiterose.ac.uk/id/eprint/117473/)).

2. **Pixel scale and axes — 10 minutes**

   - Translate a bead sample through known \(x\) and \(y\) stage distances.
   - Determine nm/pixel, camera-axis rotation, and any \(x,y\) shift coupled to objective-piezo motion.

3. **Depth-matched PSF calibration — 45–60 minutes**

   - Prepare subdiffraction green beads embedded in gel at 2–3 µm above a coverslip, using the same coverslip, medium, objective, temperature, and cylindrical-lens position as the experiment.
   - Step the closed-loop piezo through at least \(-0.8\) to \(+0.8\) µm in 20–50 nm increments, collecting 20–50 frames per position.
   - Fit each bead with an elliptical Gaussian or empirical PSF to obtain \(w_x(z)\), \(w_y(z)\), photon count, background, and fit residuals.
   - Construct an empirical interpolation from
     \[
     q={w_x^2-w_y^2\over w_x^2+w_y^2}
     \]
     or from the pair \((w_x,w_y)\) to \(z\). Do not extrapolate outside the calibrated support. Astigmatic calibration conventionally uses beads at predefined \(z\) planes; reported 40–80 nm axial precision under nearly ideal conditions is evidence of feasibility, not a guarantee in yeast ([astigmatic calibration study](https://www.biorxiv.org/content/10.1101/304816v1.full)).
   - Repeat on at least 10 beads across the intended ROI and make a field-dependent correction if necessary. Depth-calibration studies use 20–50 nm steps and demonstrate why a coverslip-only calibration is insufficient several micrometres into a specimen ([depth-dependent PSF calibration](https://pmc.ncbi.nlm.nih.gov/articles/PMC6583355/)).
   - Verify the bead-derived mapping on fixed GFP-LacI yeast loci. Use a separate fixed-locus lookup table if their spectrum or spot shape creates a reproducible bias.

4. **Piezo dynamics — 20 minutes**

   - Apply 50, 100, and 200 nm steps while imaging a fixed bead.
   - Measure sign, settling time, overshoot, encoder latency, and the transformation from encoder units to optical \(z\).
   - Establish the latest safe command time that still lets the piezo settle before the next exposure.

5. **Static and driven validation — 60 minutes**

   - Record a fixed bead for 30 minutes using the production timing and feedback loop.
   - Then drive a known slow sine or stepped trajectory of ±0.2–0.4 µm and compare the reconstructed position with the imposed motion.
   - Repeat after reducing bead photons computationally or optically to match the GFP locus; a bright bead alone overestimates performance.

### 3. Illumination and biological calibration

At 5 Hz there are 3,000 frames in 10 minutes and 9,000 in 30 minutes.

1. Begin with a 40–60 ms exposure every 200 ms; explore 20–80 ms only if necessary. Short exposure relative to the interval reduces dose and motion blur.

2. Measure irradiance \(I\) at the specimen. Report the cumulative nominal dose:
   \[
   D=I\,t_{\rm exp}\,N .
   \]
   For 40 ms exposures, total illuminated time is 120 seconds over 10 minutes and 360 seconds over 30 minutes.

3. On replicate cells, test an intensity ladder such as 0.25×, 0.5×, and 1× while holding exposure fixed. Select the lowest intensity that meets localization requirements through the end of the movie.

4. Compare:

   - Imaged GFP-LacI cells.
   - Mounted but unilluminated GFP-LacI cells.
   - If available, identically illuminated cells lacking GFP.

   Monitor bleaching, morphology, budding, and post-imaging ability to resume growth or complete a cell cycle. There is no universal safe fluorescence dose, so phototoxicity requires a biological control appropriate to the experiment ([phototoxicity assessment guidance](https://www.nature.com/articles/nmeth.4344)).

**Suggested acceptance assumptions:** at least 50% of initial locus photons remain; the imaged group differs by less than 10% from dark controls in the selected growth/viability endpoint; median localization uncertainty is below 50 nm laterally and 100 nm axially. Replace these thresholds if the biological question requires different precision.

### 4. Live acquisition and control

Use the camera as the timing master. Separate Python acquisition, localization/control, and disk-writing into independent threads or processes with preallocated buffers.

For each 200-ms cycle:

1. Confirm the piezo has settled.
2. Open the 488-nm illumination through TTL and expose for 40–60 ms.
3. Attach the exposure-midpoint hardware timestamp and current piezo encoder value to the frame.
4. Transfer the ROI and correct camera offset, gain, and bad pixels.
5. Fit a 13×13 to 21×21 pixel locus patch with an elliptical Gaussian plus constant or sloping background. Estimate \(x,y,w_x,w_y\), photons, background, fit covariance, and residual.
6. Convert \((w_x,w_y)\) to residual \(z_{\rm rel}\) using the depth-matched lookup table.
7. Accept the estimate only if:

   - No relevant pixels are saturated.
   - The fit converged and the spot is not near the ROI boundary.
   - Its ellipticity lies inside calibration support.
   - Photon count, uncertainty, and residual pass thresholds determined from calibration.
   - The displacement is compatible with the pilot motion distribution.

8. Update the piezo only for a valid localization:
   \[
   u_{k+1}=u_k+s\,K\,\bar z_{\rm rel},
   \]
   where \(s\) is the experimentally calibrated sign, \(\bar z_{\rm rel}\) is a lightly filtered estimate, and the command is rate- and range-limited.

   **Starting assumptions:** \(K=0.4\)–0.7, a 30–50 nm deadband, and a maximum correction of 100–200 nm per frame. Tune these from the driven-bead experiment; avoid gains that produce alternating \(z\) errors.

9. Move the piezo only after exposure and let it settle during the remaining dark time.

A workable budget is approximately 60 ms exposure, 40 ms transfer and fitting, 30 ms command/motion, and 70 ms settling margin. At 5 Hz, ordinary Python and a CPU fit should suffice; no FPGA is needed.

Do not move the piezo after an invalid frame. Hold position and search the full fixed ROI using the predicted locus location. One or two missed frames remain explicitly missing. After three consecutive misses, stop the continuous record; an optional one-time low-dose rescue sweep may reacquire the locus, but the resulting data must be labeled as a new segment rather than silently joined.

Every minute, automatically check photon count, background, fit uncertainty, saturation, valid-frame fraction, piezo position, calibration-edge occupancy, dropped frames, and disk backlog. Abort rather than increasing excitation mid-recording if the track becomes photon-starved.

Store raw frames plus:

- Hardware timestamps and exposure duration.
- Illumination setting and measured irradiance.
- Piezo command and settled encoder position.
- Fit parameters, covariance, and quality flags.
- Calibration identifiers and software version.
- All dropped or rejected-frame indicators.

### 5. Coordinate reconstruction and drift correction

For every exposure, reconstruct the axial laboratory coordinate using the encoder position at that exposure—not the subsequent command:

\[
z_{\rm locus}^{\rm lab}(t_k)
  =Z_{\rm focus}\!\left[u_{\rm enc}(t_k)\right]+z_{\rm rel}(t_k),
\]

with signs, scaling, and refractive-index corrections taken from calibration. Correct \(x,y\) for any piezo-dependent lateral shear.

If same-depth fiducials are present, reconstruct each identically and subtract their robust common displacement:

\[
\mathbf r_{\rm locus}^{\rm sample}(t)=
\mathbf r_{\rm locus}^{\rm lab}(t)
-\operatorname{median}_j[
\mathbf r_{{\rm fid},j}^{\rm lab}(t)
-\mathbf r_{{\rm fid},j}^{\rm lab}(0)].
\]

This removes instrument/sample drift but assumes the yeast remains fixed relative to the fiducial-containing pad. It still does not produce a nucleus-centered trajectory unless the nucleus or cell orientation is independently measured.

### 6. Final validation and analysis

1. Require, as starting acceptance criteria:

   - At least 99% valid frames.
   - No gap longer than two frames.
   - No sustained operation outside the central 80% of the calibrated \(z\) range.
   - Fixed-bead drift and driven-motion error below the experiment’s required resolution.
   - No oscillation in piezo command or correlation between localization residual and previous command.
   - Phototoxicity and bleaching controls pass.

2. Preserve invalid localizations as missing values. Do not interpolate them for displacement, diffusion, or state analysis.

3. Use exposure-midpoint timestamps. Report that 5-Hz sampling has a 2.5-Hz Nyquist limit and that each 40–60 ms exposure averages motion within that interval.

4. Estimate per-frame localization covariance from the likelihood fit, but calibrate it against fixed, photon-matched targets. Correct displacement statistics for heteroscedastic localization error and motion blur.

5. Analyze:

   - \(x,y,z\) trajectories and radial displacement.
   - Displacement distributions by lag.
   - Time-averaged MSD over lags no longer than roughly one-tenth of the track.
   - Confinement or anomalous-motion models using a state-space likelihood that includes localization covariance.
   - Changes in motion state only when they exceed fixed-bead noise and are reproducible across cells.

6. Treat cells—not frames—as biological replicates. Report valid-frame fraction, photon trajectory, axial calibration range, localization precision, dose, bleaching, and health-control results with every condition.

### Practical timing

- Optical installation and cylindrical-lens alignment: 0.5–1 day.
- Initial camera, PSF, and controller calibration: 2–4 hours.
- Photodose/viability qualification: one experimental day plus growth follow-up.
- Daily calibration check: 30–45 minutes.
- Sample mounting and equilibration: 15–30 minutes.
- Locus selection and 2-minute pilot: 5–10 minutes.
- Production acquisition: 10–30 minutes.
- Immediate QC and endpoint transmitted-light image: about 5 minutes.

The decisive go/no-go checkpoint is the photon-matched 30-minute fixed-target test followed by the live 2-minute pilot. If either fails the precision, continuity, controller-stability, or phototoxicity criteria, retune astigmatism, exposure, illumination, or immobilization before collecting production tracks.