## Evidence base and its limits

I ran 7 searches across the protocol corpora. **Only metadata (titles/DOIs) was retrievable** under the harness rules — I did not open any full text. So the citations below establish that a method class is documented and standard; every *number* in this protocol is my engineering inference unless explicitly attributed.

| # | Retrieved record | What it anchors |
|---|---|---|
| E1 | *3D positioning of tagged DNA loci by widefield and super-resolution fluorescence imaging of fixed yeast nuclei* — `doi:10.1016/j.xpro.2021.100525` | Closest published analogue: tagged DNA loci, yeast nuclei, widefield, 3D positioning. **Fixed cells** — the live/long-duration part is the gap this protocol fills. |
| E2 | *Quantifying transport dynamics with three-dimensional single-particle tracking in adherent cells* — `doi:10.1016/j.xpro.2022.101790` | 3D SPT + MSD/transport analysis as a documented protocol workflow. |
| E3 | *A Protocol for Real-time 3D Single Particle Tracking* — `doi:10.3791/56711` | Real-time (feedback) 3D SPT is an established, protocol-documented approach. |
| E4 | *Build and operation of a custom 3D, multicolor, single-molecule localization microscope* — `doi:10.1038/s41596-024-00989-x` | Build/alignment/calibration of 3D-capable localization optics on a home-built stand. |
| E5 | *Measuring and interpreting point spread functions... ensure quality control* — `doi:10.1038/nprot.2011.407` | Bead-based PSF QC as the standard pre-calibration gate. |
| E6 | *Construction and use of a microfluidic dissection platform for long-term imaging of cellular processes in budding yeast* — `doi:10.1038/nprot.2013.060` | Long-duration yeast immobilization/perfusion. |
| E7 | *Protocol for 4D live fluorescence microscopy to image rapid cellular responses in yeast* — `doi:10.1016/j.xpro.2025.104026` | Fast 4D yeast imaging exists as a protocol — and is exactly the z-stack approach the user is rejecting. |
| E8 | *Sample Drift Correction Following 4D Confocal Time-lapse Imaging* — `doi:10.3791/51086` | Post-hoc drift correction as a documented step. |
| E9 | *Optimized sample preparation for single-molecule localization-based superresolution microscopy in yeast* — `doi:10.1038/nprot.2015.060` | Yeast-specific sample prep for localization microscopy. |
| E10 | *Single-particle tracking photoactivated localization microscopy of membrane proteins in living plant tissues* — `doi:10.1038/s41596-020-00471-4` | SPT acquisition→MSD analysis pipeline structure. |
| E11 | *Protocol for quantifying phase-separated condensates in living cells using HILO microscopy imaging* — `doi:10.1016/j.xpro.2025.104151` | HILO as a documented live-cell background-reduction mode (optional Tier-2 mod here). |
| E12 | *3D Orbital Tracking in a Modified Two-photon Microscope* — `doi:10.3791/51794` | The excluded-hardware alternative; cited only to justify why it is not used. |

**No retrieved record covers the specific combination requested** (live yeast + single-color locus + 5 Hz + 10–30 min + widefield + passive 3D encoding). The protocol below is a synthesis; Section 12 lists every assumption.

---

# Protocol: Continuous 3D tracking of a single GFP-LacI locus in live budding yeast

## 1. Design rationale (read before building)

**The core decision.** You must get z from *one* frame, because a z-stack per timepoint costs both time and dose. There are three ways to do this on a conventional widefield stand with only passive additions:

| Option | Mechanism | Photon efficiency | Verdict |
|---|---|---|---|
| **Astigmatism** (cylindrical lens in detection path) | PSF ellipticity encodes z | **All photons in one spot** | **Chosen.** |
| Biplane (50/50 splitter, two focal planes on one sCMOS) | Relative defocus encodes z | Halves photons per image | Rejected — bleaching-limited experiment |
| Double-helix / tetrapod phase mask | Lobe angle encodes z | Spreads photons; needs a 4f relay + SLM/mask | Rejected — larger PSF footprint, more background, more build |

Astigmatism wins here specifically **because this experiment is photon-budget-limited, not precision-limited** (Section 4). An orbital tracker (E12) would be photon-optimal but requires exactly the galvo/FPGA hardware you excluded.

**The second decision — what the piezo is for.** The piezo is *not* the z sensor and *not* a fast tracker. Astigmatism has a usable range of only ~±0.6–0.8 µm; a yeast locus wanders over ~1 µm and the stage drifts. So the piezo runs as a **slow, dead-banded re-centering servo** (updated at ~1 Hz, moving only in the inter-frame dead time), keeping the locus inside the astigmatic window.

> **This is the single most important implementation detail:** the reported axial coordinate is
> `z_true(t) = z_astig(t) + z_piezo_readback(t)`
> The piezo's closed-loop sensor readback must be logged **per frame, with the camera timestamp**. If you log only the *commanded* position, or log at the wrong time, you will inject servo dynamics straight into your MSD curve and misread it as anomalous diffusion.

---

## 2. Microscope modifications

### Tier 1 — required

**M1. Cylindrical lens (the 3D encoder).**
- Weak plano-convex cylindrical lens, **f = 750–1000 mm**, ⌀25 mm, AR-coated for 500–550 nm.
- Mount in a **rotation mount on a flip/kinematic mount** in the converging beam between the tube lens and the camera, roughly **50–120 mm ahead of the sensor**.
- Rotate so the astigmatic axes align to camera rows/columns (simplifies the fit; verify by imaging a bead below and above focus).
- The flip mount matters: you need to remove it to run the 2D control experiment (Section 8, V5) and to take clean reference z-stacks.
- *Inference:* f=1000 mm gives ~±0.6 µm range with better lateral precision; f=750 mm gives ~±0.9 µm with worse. **Start at 1000 mm.** Exact range must be measured (Section 6, C2), not assumed.

**M2. Camera ROI + timing.**
- Crop the sCMOS to a **128×128 or 256×256 ROI** centered on the target cell. This is for latency and data volume, not framerate.
- Run the camera in an **externally-triggered or software-triggered single-frame mode**, not free-running, so that piezo moves are guaranteed to fall in the dead time.
- Target **65–110 nm/px at the sample** (e.g. 100×/1.4 with a 6.5 µm sCMOS pixel → 65 nm). Astigmatic PSFs are elongated; do not exceed ~120 nm/px.

**M3. Illumination shuttering.**
- Hardware-gate the 488 nm source (LED or laser) to the exposure window only. At 30 ms exposure / 200 ms period you get a **15% duty cycle → ~6.7× dose reduction** versus continuous illumination. This is free lifetime and the cheapest thing on this list.

**M4. Fiducial channel for drift.**
- Sparse **200 nm far-red/crimson beads** on the coverslip surface (and/or embedded in the pad).
- Add a **red/far-red LED + filter cube position**, imaged at **0.5 Hz interleaved** (1 bead frame per 10 GFP frames). Cost to the GFP budget: zero.
- If your stand has a hardware IR focus-lock (Perfect Focus / Definite Focus class), **use it as well** — but keep the beads, because focus-lock holds the *coverslip*, not the *locus*, and lateral drift is uncorrected.

**M5. Thermal and mechanical stabilization.**
- Full enclosure, set point 30 °C, **equilibrated ≥2 h** with objective, stage, and sample in place.
- Objective heater collar matched to enclosure setpoint.
- Air table floated; kill nearby fans/compressors during acquisition.
- *Inference:* uncontrolled thermal drift is typically 0.5–3 µm/h axially — enough to walk the locus out of the astigmatic range in minutes. Equilibration is not optional.

### Tier 2 — recommended if achievable

**M6. HILO / oblique illumination.** At 2–3 µm depth, HILO is squarely in range (E11) and substantially cuts out-of-focus background from unbound nuclear LacI-GFP — the dominant SNR limiter in LacO systems. Implementation: a mirror on a micrometer translator at a plane conjugate to the objective back focal plane. This is an illumination-path modification, slightly beyond "passive," but requires no scanning hardware.

**M7. Objective choice.** If a **silicone-oil (n≈1.406) or water-immersion** high-NA objective is available, prefer it over oil (n=1.518). At 2–3 µm into yeast cytoplasm (n≈1.36–1.38), oil immersion produces depth-dependent spherical aberration that **distorts the astigmatic calibration curve and rescales your z axis**. If you must use oil, tune the correction collar (if present) and perform the depth-matched calibration in Section 6 (C3) — do not skip it.

---

## 3. Strain and sample preparation

### 3.1 Strain
- LacO array (**128–256 repeats**) integrated at the locus of interest; **LacI-GFP-NLS** expressed from a **weak/moderate promoter**.
- **Optimize expression downward, aggressively.** The figure of merit is spot-to-nucleoplasm contrast, not spot brightness. Screen 3–5 promoter strengths and pick the dimmest that still gives a spot you can fit in a 30 ms exposure.
- *Upgrade option (label as a deviation):* swapping eGFP for **mNeonGreen** or **mGreenLantern** buys meaningful photostability and brightness. This is what makes 30 min tracks routine rather than marginal (Section 4). A HaloTag-JFX549 array is better still but is a bigger strain-engineering commitment.
- **Caveat:** LacO/LacI arrays are known to perturb local chromatin and can stall replication forks. Include a no-array or array-without-LacI control for any biological conclusion. [Assumption: general field knowledge; not verified against a retrieved record.]

### 3.2 Mounting — two options

**Option A — agarose pad (default for 10–30 min).**
1. 2% low-melt agarose in filtered synthetic complete medium (SC + 2% glucose), melted and held at 65 °C.
2. Cast a pad ~1 mm thick between two slides with spacers; let set 20 min.
3. Coverslip (#1.5H, 170 ± 5 µm, **plasma-cleaned or KOH-cleaned**) coated with **0.5–1 mg/mL Concanavalin A**, air-dried. ConA adhesion suppresses cell rocking, which otherwise dominates your apparent locus motion.
4. Apply 2 µL of mid-log culture (OD600 0.3–0.5) to the coverslip, let adhere 5 min, wick excess, invert pad onto cells.
5. **Seal all edges with VALAP** (1:1:1 vaseline/lanolin/paraffin). Unsealed pads dry, shrink, and drift.
- Rationale: for ≤30 min, a sealed pad is *more mechanically stable* than a perfused device and is the right default.

**Option B — microfluidic chamber (if perturbation/media exchange is needed).** Follow a yeast-specific long-term imaging device (E6). Accept somewhat worse drift and pre-characterize it.

### 3.3 Fiducials
Spot 200 nm crimson beads onto the ConA coverslip **before** adding cells, at a density giving **3–8 beads per 40×40 µm field**. Too many beads = background; too few = no drift correction.

---

## 4. Photon budget — do this arithmetic before you build anything

This determines whether the experiment is feasible, and it is the number most people skip.

**Demand.** 5 Hz × 10 min = **3,000 frames**. 5 Hz × 30 min = **9,000 frames**.

**Supply.** [All figures below are engineering estimates, not retrieved values.]
- ~200 mature, fluorescent LacI-GFP on the array (of 256 sites — assume incomplete occupancy and incomplete maturation).
- eGFP detected-photon budget before bleaching: ~1–3 × 10⁴ per molecule on a well-aligned high-NA widefield path.
- Total reservoir: **~2–6 × 10⁶ detected photons**.

| Track length | Frames | Photons/frame available | Est. σ_xy | Est. σ_z | Verdict |
|---|---|---|---|---|---|
| 10 min | 3,000 | ~1,000–2,000 | 20–30 nm | 50–80 nm | **Routine** |
| 20 min | 6,000 | ~500–1,000 | 30–45 nm | 75–120 nm | Workable, degrades late |
| 30 min | 9,000 | ~300–650 | 40–60 nm | 100–160 nm | **At the edge with eGFP** |

**Interpretation.** Your precision floor is not set by the optics — it is set by bleaching. A yeast chromatin locus moves roughly 100–150 nm per 200 ms step [inference from typical published D≈10⁻³–10⁻² µm²/s, α≈0.5]. So at 30 min, σ_z becomes **comparable to the step size**, and the static-localization-error term dominates your z-MSD.

**Consequences for the protocol:**
1. **10 min is the default track length.** 30 min is a stretch goal requiring mNeonGreen/mGreenLantern (M-3.1) or accepting z-precision ~150 nm.
2. **Static error correction is mandatory, not optional** (Section 9). You must measure σ_xy and σ_z on immobilized samples *at matched photon counts* and subtract 2σ² from each axis's MSD.
3. Because σ_z ≈ 2–3 × σ_xy, **never pool axes into a single 3D MSD without per-axis offset correction.** A naive 3D MSD will be dominated by the z error term and will look artifactually superdiffusive at short lag and artifactually confined at long lag.

---

## 5. Acquisition parameters (starting point)

| Parameter | Value | Note |
|---|---|---|
| Excitation | 488 nm | LED or laser |
| Irradiance at sample | **1–5 W/cm²** | Start at 1; raise only to reach photon target |
| Exposure | **30 ms** (range 20–50) | Motion blur at 30 ms ≈ 50 nm — acceptable |
| Frame period | **200 ms** | 15% duty cycle |
| ROI | 128×128 px | ~8×8 µm at 65 nm/px |
| Emission filter | 525/50 or 520/35 | Narrow to reject autofluorescence |
| Camera mode | Triggered single-frame, low-noise | Log per-frame timestamps |
| Piezo servo update | Every 5th frame (1 Hz) | Move only in dead time |
| Bead/fiducial frame | Every 10th frame (0.5 Hz) | Far-red channel |
| Track length | 10 min default / 30 min stretch | |

**Latency budget per 200 ms cycle:** 30 ms exposure + ~5 ms readout (small ROI) + ~10 ms fit + ~5 ms decision + ~20 ms piezo settle ≈ **70 ms used, 130 ms slack.** Python with NumPy/SciPy is comfortably fast enough here; this is exactly why 5 Hz is the right target and why no FPGA is needed.

---

## 6. Calibration (do all of it; do it in this order)

**C1 — Optical QC (gate).** Before the cylindrical lens goes in. Image 100 nm beads on a clean coverslip; acquire a z-stack (25 nm steps, ±1.5 µm). Confirm the PSF is symmetric above/below focus and free of coma (E5). Tune the correction collar. **Do not proceed on a bad PSF** — astigmatic calibration on an aberrated PSF produces a smooth, convincing, wrong z curve.

**C2 — Astigmatic calibration, at the coverslip.** Install the cylindrical lens. Beads on glass in imaging medium. Piezo scan **−1.5 to +1.5 µm in 25 nm steps**, 20 frames/step, ≥10 beads.
- Fit each frame with an elliptical Gaussian → σx(z), σy(z).
- Build the calibration: fit the standard defocus form σ(z) = σ₀√(1 + ((z−c)/d)² + A((z−c)/d)³ + B((z−c)/d)⁴) to each axis.
- **Extract and record: usable z range** (where dσ/dz is monotonic and steep on both axes) and **σ_z vs photon count**.
- Store the calibration as a lookup + spline, not just parameters.

**C3 — Depth-matched calibration (the step people skip).** Repeat C2 with beads **embedded 2–4 µm deep in 2% agarose in SC medium** (n ≈ 1.34–1.36, close to yeast cytoplasm).
- Compare to C2. With an oil objective you will see the curve **broaden, shift, and rescale**.
- Extract the **axial scaling factor** k = Δz_true / Δz_nominal_piezo. [Inference: expect k ≈ 0.75–0.90 for oil-into-aqueous; ~0.95–1.0 for silicone/water.]
- **Use the C3 curve for all analysis**, not C2. Using C2 will scale your entire z axis — and therefore your diffusion coefficient — by a constant ~15–25% error that no downstream statistic will reveal.

**C4 — Field dependence.** Astigmatism and focal plane vary across the FOV. Repeat C2 at 9 positions across the field. **Restrict acquisition to the central region where z bias < 30 nm**, or build a position-dependent correction map. With a large sCMOS this is a real effect.

**C5 — Piezo characterization.** With a bead in the astigmatic range: command ±50, ±100, ±200 nm steps.
- Measure **settle time to within 10 nm** (expect 10–30 ms for closed-loop; must be < your dead time).
- Measure **hysteresis** and confirm closed-loop readback matches astigmatic z.
- Measure **readback latency** relative to camera timestamp. Correct for it in the log.

**C6 — sCMOS noise map.** Per-pixel offset, gain, and read-noise variance maps (dark frames + uniform-illumination series). Required for MLE fitting and for converting ADU → photons. Without this your photon counts — and hence your precision estimates and error corrections — are guesses.

**C7 — Precision floor.** Immobilized beads attenuated to match the *expected in-cell photon count* (~500, 1000, 2000 photons). Measure σ_x, σ_y, σ_z at each. **This table is the input to Section 9's error correction.**

---

## 7. Live acquisition and control workflow

### 7.1 Software architecture (Python)

Use `pymmcore-plus` (Micro-Manager device layer from Python) or the vendor SDK directly. Three threads:

```
[Camera thread]  → ring buffer (frame, hw_timestamp)
[Analysis thread]→ crop → fit → z → append to track → every 5th frame: servo update
[Writer thread]  → stream frames to disk (Zarr/OME-TIFF) + append log row
```

**Never do disk I/O in the analysis thread.** Write raw frames always — you will want to refit offline with a better model.

**Per-frame log row (write all of it):**
`frame_idx, camera_hw_timestamp, x_px, y_px, sigma_x, sigma_y, amplitude, background, photons, fit_residual, z_astig, piezo_readback, piezo_command, servo_active_flag, in_range_flag`

### 7.2 Real-time localization
1. Crop a **21×21 px** window around the predicted position (previous position + constant-velocity or simply previous position).
2. Subtract the sCMOS offset map; convert to photons via the gain map.
3. Fit an **elliptical 2D Gaussian, θ fixed** to the calibrated astigmatic axes. Weighted least-squares is sufficient for real time; refit offline with sCMOS-MLE or a spline PSF model.
4. Look up z from the C3 calibration via σx, σy. Use a **2D lookup on the (σx, σy) plane** (nearest point on the calibration trajectory) rather than the σx−σy difference alone — it is more robust to background.
5. Reject the frame if photons < threshold, or fit residual > threshold, or (σx, σy) lies far from the calibration trajectory (this last is your out-of-range detector).

### 7.3 The z servo (deliberately slow)

```python
# Called every 5th frame (~1 Hz). ONLY between exposures.
def servo_update(z_astig_recent, piezo_pos):
    z_err = median(z_astig_recent)          # median of last 5 frames: reject outliers
    if abs(z_err) < DEADBAND:               # DEADBAND = 100 nm
        return piezo_pos                    # do nothing — most of the time
    step = clip(KI * z_err, -MAX_STEP, MAX_STEP)   # KI = 0.15, MAX_STEP = 80 nm
    return piezo_pos + step
```

**Design notes, each of which matters:**
- **Integral-only, low gain.** No proportional or derivative term. You are correcting drift and slow wander, not chasing diffusion. A fast servo will track the locus's own Brownian motion and *erase the signal you are measuring*.
- **Deadband ±100 nm.** The servo should be idle most of the time. Log `servo_active_flag` so you can test for correlation between servo activity and apparent motion (Section 8, V3).
- **Moves only in the dead time**, with the C5-measured settle time elapsed before the next exposure begins.
- **Setpoint z = 0**, the astigmatic midpoint, where σ_z is best and the calibration is most linear.

### 7.4 Lateral: do *not* servo
Let the locus move laterally within the ROI. Only re-center the ROI (a software crop, no stage motion) if it approaches within 5 px of an edge. **Never move the XY stage during a track** — stage motion is far less repeatable than the piezo and will destroy the track.

### 7.5 Failure handling
- **Out of astigmatic range** (in_range_flag false for >3 consecutive frames): execute a **single** ±400 nm piezo search, 3 positions, 1 frame each. If not reacquired in 2 s, **terminate the track** and mark it. Do not scan repeatedly — that is a z-stack by another name, and it is what you were trying to avoid.
- **Photon count drops below 40% of frame-1 value:** flag `bleaching_limited` from that point. Analyze pre- and post-threshold segments separately.
- **Two spots appear** (locus replicated / sister separation): terminate. Single-spot assumption is broken.

---

## 8. Validation

Run every one of these before you trust a single biological number.

| ID | Control | What you measure | Pass criterion |
|---|---|---|---|
| **V1** | **Immobilized-locus control.** PFA-fixed yeast (4%, 15 min) of the same strain, same illumination, same 3,000-frame run. | Apparent MSD_x, MSD_y, MSD_z vs lag | Flat MSD. Its value = **2σ²_static** per axis. **This is your error-correction constant.** |
| **V2** | **Drift residual.** Fiducial beads through the full run. | Post-correction bead position RMS | < 25 nm lateral, < 50 nm axial over 10 min |
| **V3** | **Servo artifact test.** Fixed sample (V1) with servo ON vs OFF. | MSD_z(ON) vs MSD_z(OFF); correlation of `servo_active_flag` with Δz | Curves indistinguishable; no significant correlation. **If they differ, lower KI and widen DEADBAND.** |
| **V4** | **Isotropy check.** Live tracks. | MSD_x vs MSD_y vs MSD_z after error correction | MSD_x ≈ MSD_y (sanity). MSD_z should approach them for isotropic chromatin motion. **A systematic z/xy ratio ≠ 1 means your C3 axial scaling k is wrong — go back and refit.** This is the most sensitive single check on the whole 3D calibration. |
| **V5** | **2D cross-check.** Same strain, cylindrical lens flipped out, standard 2D tracking. | MSD_x, MSD_y from 2D vs from astigmatic data | Agreement within 15%. Confirms the cylindrical lens is not degrading lateral accuracy. |
| **V6** | **Absolute z cross-check.** One 200 nm-step z-stack at t=0 and t=end (only two stacks in the whole experiment). | Locus z from stack vs from astigmatic track | Agreement within 100 nm |
| **V7** | **Phototoxicity — biological.** Track cells to completion, then continue brightfield observation for 2 h. | Bud emergence, division, cell-cycle progression | ≥80% of tracked cells divide on a normal schedule vs unilluminated neighbors |
| **V8** | **Phototoxicity — dynamical.** Compare MSD from minutes 0–3 vs 7–10 of the same tracks. Also run a 4× lower-dose cohort. | D, α over time and vs dose | No significant decrease. **A falling D over time is the classic signature of light-induced chromatin stiffening and will otherwise be published as biology.** |
| **V9** | **Timing integrity.** | Camera hardware timestamp intervals | SD of frame interval < 2 ms; no dropped frames |

---

## 9. Downstream analysis

### 9.1 Refit offline
Re-localize all frames from the raw stack with a **cubic-spline experimental-PSF model** or **sCMOS-MLE elliptical Gaussian**, using the C3 depth-matched calibration and the C6 noise maps. Real-time fits are for the servo; offline fits are for the data.

### 9.2 Assemble coordinates
```
z_true(t) = k · [ z_astig(t) + z_piezo_readback(t) ]     # k from C3
x_true(t) = x_fit(t) - x_drift(t)                        # bead-derived
y_true(t) = y_fit(t) - y_drift(t)
```
Interpolate the 0.5 Hz drift trace to 5 Hz with a smoothing spline (do not use raw interpolation — you will inject bead localization noise into every locus coordinate).

### 9.3 Reference frame — a real limitation
With one color you **cannot** subtract nuclear-centroid motion directly. Mitigations, in order of preference:
1. Interleave a **brightfield/DIC snapshot every 2 s** (negligible dose) and derive the cell-body centroid and orientation; subtract. Removes cell translation and rotation, not nuclear motion within the cell.
2. Accept the confound and **state it explicitly** in reporting.
3. *Deviation from the one-color spec:* add a dim second marker (e.g. Nup49-mCherry) imaged at 0.5 Hz. This is the correct fix if the science depends on nucleus-relative motion, and it costs almost nothing in GFP budget.

### 9.4 MSD with correct error handling
Compute the **time-averaged MSD per track, per axis**, then ensemble-average. Fit:

```
MSD_i(τ) = 2·Γ_i·τ^α  +  2σ²_i  −  (4/3)·Γ_i·t_exp·R
              ↑            ↑              ↑
        anomalous     static error    motion-blur (R=1/6 for
        transport      (from V1)      continuous exposure)
```

- **σ²_i comes from V1, per axis, matched to photon count.** Do not fit it as a free parameter — it is strongly degenerate with α at short lag and will bias your exponent.
- Fit only lags **τ = 0.2 s to T/10** (i.e. 1 to ~300 frames for a 10 min track). Beyond T/10, time-averaged MSD statistics become unreliable.
- Report **α** (anomalous exponent), **Γ** (generalized diffusion coefficient), and where a plateau exists, **confinement radius** from MSD_plateau = (6/5)·R_c² in 3D.

### 9.5 Complementary statistics (do not rely on MSD alone)
- **Step-size distributions** per axis, per lag — reveals non-Gaussian/heterogeneous motion that MSD averages away.
- **Velocity autocorrelation function** — the negative dip at lag 1 is diagnostic of viscoelastic/fBm-like subdiffusion and is far less sensitive to localization error than α from MSD.
- **Radius of gyration** per track, and its convergence over track length.
- **Per-track α distribution** — do not just report the ensemble fit; heterogeneity between loci/cells is usually the interesting result.

### 9.6 Statistics
- **≥25–30 tracks from ≥3 independent biological replicates** on different days.
- Bootstrap CIs over *tracks*, not over *steps* (steps within a track are correlated; treating them as independent inflates significance dramatically).
- Report the localization-precision table (V1) alongside every MSD figure.

### 9.7 Tooling
`trackpy` or TrackMate for detection/linking; a custom astigmatic fitter (SMAP, ThunderSTORM's astigmatic module, or your own spline-PSF MLE); `msdanalyzer`-equivalent or custom for MSD. Pipeline structure follows documented SPT protocols (E2, E10).

---

## 10. Checkpoints (go / no-go)

| CP | Stage | Criterion | If failed |
|---|---|---|---|
| **CP1** | After C1 | Symmetric bead PSF, no coma; Strehl-proxy acceptable | Re-tune collar, re-check coverslip thickness, re-align. **Hard stop.** |
| **CP2** | After C2/C3 | Monotonic σx, σy over ≥1.2 µm; σ_z < 60 nm at 2,000 photons | Change cylindrical lens f; check lens rotation/position |
| **CP3** | After C3 | Axial scaling k determined; depth curve differs from surface curve by a characterized amount | If k is unstable across beads, switch to silicone/water objective |
| **CP4** | After C5 | Piezo settles <10 nm within the dead time; no hysteresis in closed loop | Reduce MAX_STEP; lengthen dead time (exposure 20 ms) |
| **CP5** | After sample prep | Spot/nucleoplasm contrast ≥ 3:1 at 30 ms | Lower LacI-GFP expression; add HILO (M6) |
| **CP6** | First live run | ≥1,500 detected photons in frame 1; ≥90% frames in-range over 10 min | Raise power slightly; check servo tuning; check drift |
| **CP7** | After V1–V3 | Flat fixed-cell MSD; servo ON≡OFF; drift residual within spec | Retune servo (lower KI, wider deadband). **Hard stop for biology.** |
| **CP8** | After V4 | MSD_z/MSD_xy ratio ≈ 1 after correction | Axial calibration wrong — return to C3 |
| **CP9** | After V7/V8 | Cells divide normally; no D decline over track | Cut dose 2–4×, shorten to 10 min, or switch fluorophore |
| **CP10** | After analysis | ≥25 tracks, ≥3 replicates, per-track α distribution reported | Collect more |

---

## 11. Practical timing

| Phase | Activity | Time |
|---|---|---|
| **Build** | Source cylindrical lens, mounts, beads, filters | 1–2 weeks lead |
| Day 1 | Install cylindrical lens; C1 PSF QC | 4 h |
| Day 2 | C2 surface astigmatic calibration + fitting code | 6 h |
| Day 3 | **C3 depth-matched calibration** (make gel phantoms, scan, refit) | 6 h |
| Day 4 | C4 field map, C5 piezo characterization, C6 sCMOS maps | 6 h |
| Day 5–7 | Write + debug the Python control loop; C7 precision floor | 2–3 days |
| Day 8 | Strain check; expression-level optimization; sample prep practice | 6 h |
| Day 9 | V1–V3 (fixed-cell, drift, servo artifact) | 6 h |
| Day 10 | V5, V6, V9 (2D cross-check, absolute z, timing) | 4 h |
| **Per imaging day** | 2 h equilibration + prep | 2 h |
| | Find cell, set ROI, initialize (per cell) | 3–5 min |
| | Acquire one 10 min track | 10 min |
| | **Realistic yield** | **6–10 tracks/day** |
| **Campaign** | 30 tracks, 3 biological replicates | 3 separate days |
| V7/V8 | Phototoxicity controls | 1 day |
| Analysis | Offline refit + MSD pipeline | 3–5 days |
| **Total to first defensible dataset** | | **~4–6 weeks** |

*Data volume:* 256×256×16-bit × 3,000 frames ≈ 400 MB/track; ~4 GB/day. Trivial — keep every raw frame.

---

## 12. Assumptions and unsupported details — explicit list

**Not supported by any retrieved record; from general optical/biological engineering:**
1. Cylindrical lens f = 750–1000 mm and its ±0.6–0.9 µm z range. **Must be measured (C2).**
2. All photon-budget figures in Section 4 (GFP photon reservoir, array occupancy, resulting σ_xy/σ_z). Order-of-magnitude only.
3. Servo constants: KI = 0.15, DEADBAND = 100 nm, MAX_STEP = 80 nm, 1 Hz update. Starting points requiring V3 tuning.
4. Oil-immersion axial scaling k ≈ 0.75–0.90 at 2–3 µm depth. **Must be measured (C3).**
5. Piezo settle time 10–30 nm/ms class. **Must be measured (C5).**
6. Yeast chromatin D ≈ 10⁻³–10⁻² µm²/s, α ≈ 0.5, R_c ≈ 300–500 nm — used only to argue feasibility, not as a result.
7. Drift specs (25 nm lateral / 50 nm axial per 10 min) — targets, not measured values for your stand.
8. LacO/LacI arrays perturbing local chromatin and replication.
9. All timing estimates in Section 11.

**Supported as method class, not as parameters:** astigmatic/3D SPT with MSD analysis (E2, E4); real-time feedback 3D SPT (E3); bead PSF QC (E5); 3D positioning of tagged loci in yeast nuclei by widefield (E1, fixed cells); yeast SMLM sample prep (E9); long-term yeast imaging (E6); post-hoc drift correction (E8); HILO for live-cell background reduction (E11).

**Known gap:** I found no protocol-corpus record combining live yeast + single-color locus + single-frame 3D encoding + 10–30 min continuous tracking. The closest published work (E1) is on **fixed** nuclei. Treat this protocol as a well-reasoned synthesis that has not been validated as a whole in the retrieved literature — which is precisely why Section 8's validation battery, especially **V1, V3, and V4**, is not optional.
