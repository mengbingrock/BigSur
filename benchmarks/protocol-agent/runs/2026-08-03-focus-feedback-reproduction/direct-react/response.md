## What the searches actually returned (evidence base, all pre‑July‑2026)

The protocol‑search tool returned **titles/DOIs and occasional abstract fragments only** — I did not fetch full texts (harness restriction). So the citations below establish that a method class exists and is documented in the protocol literature; they are **not** the source of any specific number I give. Every number is flagged as engineering inference or assumption.

| Anchor | ID | What it supports |
|---|---|---|
| *A Protocol for Real-time 3D Single Particle Tracking* (JoVE) | `doi:10.3791/56711` | Real‑time feedback 3D SPT is an established, protocolised method |
| *Quantifying transport dynamics with 3D single-particle tracking in adherent cells* (STAR Protoc.) | `doi:10.1016/j.xpro.2022.101790` | 3D SPT + MSD/transport analysis workflow in cells |
| *Single-particle tracking PALM in living plant tissues* (Nat. Protoc.) | `doi:10.1038/s41596-020-00471-4` | SPT acquisition→localization→MSD pipeline in thick live tissue |
| *Optimized sample preparation for single-molecule localization microscopy in yeast* (Nat. Protoc.) | `doi:10.1038/nprot.2015.060` | Yeast‑specific SMLM mounting/autofluorescence handling |
| *Microfluidic dissection platform for long-term imaging of budding yeast* (Nat. Protoc.) | `doi:10.1038/nprot.2013.060` | Hour‑scale immobilised yeast imaging chambers |
| *Sample Drift Correction Following 4D Time-lapse Imaging* (JoVE) | `doi:10.3791/51086` | Post‑hoc drift correction is a required, protocolised step |
| *Turning SMLM into a quantitative bioanalytical tool* (Nat. Protoc.) | `doi:10.1038/nprot.2016.166` | Photon/CRLB‑based precision accounting |
| *Tracking single fused synaptic vesicle proteins…* (STAR Protoc.) | `doi:10.1016/j.xpro.2021.101107` | Fast single‑spot tracking + linking conventions |

**No result described an astigmatic + piezo‑feedback tracker for a yeast chromatin locus.** That combination is my design synthesis, built from the pieces above.

---

# Protocol: Feedback‑stabilised astigmatic 3D tracking of a single GFP‑LacI locus in *S. cerevisiae*

**Principle.** Replace the z‑stack with a *single* image plane that encodes z. A weak cylindrical lens in the emission path makes the PSF elliptical in a z‑dependent way (astigmatism), giving z from one frame. Because astigmatism only works over ~±600 nm, a closed‑loop piezo runs a slow **PI focus‑lock on the locus itself**, so the locus is continuously held near the astigmatic sweet spot. Absolute z = (recorded piezo position) + (astigmatic residual). One frame per 200 ms, one exposure per frame, illumination gated off between frames.

**Assumed strain (state it in your methods):** ~256×*lacO* array integrated at the locus of interest + NLS‑GFP‑LacI expressed from a moderate promoter; single bright diffraction‑limited spot per nucleus. *Assumption — not from retrieval.*

---

## 1. Microscope modifications (all passive, ≤ $3k)

**M1 — Astigmatism module.** Insert a **cylindrical lens, f = +500 mm** (achromatic, λ/10, AR‑coated 400–700 nm) in the infinity/emission path **~40–60 mm in front of the camera sensor**, in a rotatable lens mount on a single‑axis translator.
- Engineering inference: f = +500 mm at ~50 mm from the sensor yields ~±600–800 nm usable astigmatic range at 100× — matched to the ±400 nm you actually need under focus‑lock. **Do not use a shorter focal length** (e.g. f = 150 mm); it widens range but destroys lateral precision.
- Rotate so the two astigmatic foci align with camera rows/columns (±2°).
- Keep it on a **kinematic slide‑in mount** so you can remove it for conventional imaging and for calibration cross‑checks.

**M2 — Emission cleanliness.** Single‑band GFP filter set (ex 470/24, dichroic 495 LP, em 515/30). Nothing else in the path — every extra surface costs photons you cannot spare over 9,000 frames.

**M3 — TTL‑gated excitation.** LED engine (e.g. 470 nm) driven in **external TTL mode from the camera's "fire"/exposure‑out line**, so light is on only during the exposure. With a 40 ms exposure in a 200 ms cycle this is a **5× dose reduction** versus continuous illumination — this single change is the main phototoxicity fix. *(Inference.)*

**M4 — Fiducials.** 100 nm far‑red TetraSpeck beads sparsely adsorbed to the coverslip (see §3). Beads are read in the **same GFP channel** at low level (TetraSpecks are bright in every band) — no second channel needed, no extra dose.

**M5 — Mechanical/thermal.** Objective heater + stage‑top incubator at 30 °C, **equilibrated ≥ 2 h before first acquisition**. Passive: enclose the stage in foam‑core, run the piezo controller and camera fans outside the enclosure. Uncontrolled thermal drift of 20–50 nm/min will otherwise dominate your z signal. *(Inference.)*

**M6 — Optional fallback (only if astigmatic SNR fails QC in §6).** A passive 50:50 image splitter (OptoSplit‑class) with a ~4 mm glass path difference in one arm gives **biplane** (two planes ~0.55 µm apart) 3D encoding at the cost of 2× photon splitting. Astigmatism is the better first choice here because it preserves all photons in one spot.

**Explicitly not used:** two‑photon, galvo orbital tracking, FPGA, resonant scanning — per your constraints.

---

## 2. Software stack

Python only:
- `pycromanager` → Micro‑Manager 2.x for camera, piezo, LED (or the camera vendor's Python SDK directly for lowest latency).
- Camera in **external‑trigger / light‑sheet‑off, rolling‑shutter, ROI 64×64 px** mode.
- Hardware‑timed 5 Hz trigger from a low‑cost USB DAQ (NI USB‑6001 class) — **not** software timing. Software `time.sleep()` loops will give you 200 ± 15 ms jitter, which corrupts short‑lag MSD.
- Two threads: (a) grab+fit+control, (b) disk writer (HDF5, chunked).
- Post‑hoc: `trackpy` for linking, `numpy/scipy` for MSD, custom MLE fitter.

---

## 3. Sample preparation

1. Grow cells in **low‑fluorescence synthetic complete medium** (SC lacking riboflavin and folic acid) at 30 °C to OD₆₀₀ 0.2–0.4. Low‑fluorescence medium is non‑negotiable — flavin background sets your localization precision floor.
2. Coverslip: **#1.5H (170 ± 5 µm), high‑precision**, cleaned by 20 min 1 M KOH sonication then rinsed. Thickness spread is a direct spherical‑aberration/z‑calibration error.
3. Adsorb beads: 1:5,000 TetraSpeck in water, 5 min, rinse 3×. Target **2–5 beads per 40 × 40 µm field**.
4. Coat with **1 mg/mL concanavalin A**, 10 min, air dry, rinse.
5. Apply cells, let settle 10 min, wash off unattached cells, then either (a) overlay a **2% low‑melt agarose pad in SC**, or (b) use a perfusion/microfluidic chamber for >20 min runs (cf. `doi:10.1038/nprot.2013.060`). Agarose pads dry and drift after ~30–40 min — use perfusion if you want the full 30 min routinely.
6. **Immersion oil:** run an oil RI series (1.514 / 1.518 / 1.522) at 30 °C and pick the one that minimises PSF asymmetry **at 2.5 µm depth**, not at the coverslip. *(Inference — this is the single biggest determinant of astigmatic z accuracy at your depth.)*

**Control samples to prepare the same day:**
- **Fixed cells** (4% formaldehyde, 15 min) — localization‑precision floor.
- **ATP‑depleted cells** (10 mM sodium azide + 10 mM 2‑deoxyglucose, 15 min) — biological immobility control.
- **Bead‑in‑agarose slide** — calibration and piezo linearity.

---

## 4. Calibration (do all of this before any biology; ~4 h, repeat weekly)

**C1 — sCMOS pixel maps.** 200 dark frames + a flat‑field intensity series → per‑pixel **offset, gain (e⁻/ADU), and read‑noise variance maps**. Required for MLE fitting and for honest CRLB error bars (cf. `doi:10.1038/nprot.2016.166`).

**C2 — Pixel size.** Stage micrometer or a bead grid + affine fit. At 100× with 6.5 µm sCMOS pixels expect **65 nm/px** — good sampling for astigmatic fitting; do **not** bin.

**C3 — Astigmatic z calibration at depth (critical).**
- Beads embedded in 1% agarose in SC; select beads **2–3 µm above the coverslip**, matching your locus depth.
- Piezo scan **−1.0 to +1.0 µm in 25 nm steps**, 10 frames/step, same exposure and LED power as the experiment.
- Fit each frame with an elliptical Gaussian → w_x(z), w_y(z). Fit both to the defocus model w(z) = w₀√(1 + ((z−c)/d)² + A((z−c)/d)³ + B((z−c)/d)⁴).
- Build the calibration as a **monotonic spline of z vs. the shape metric** (w_x − w_y)/(w_x + w_y), which is intensity‑independent and therefore bleaching‑robust. *(Inference — better than raw w_x, w_y under photobleaching.)*
- Also fit and store the **z‑dependent lateral wobble** Δx(z), Δy(z) (astigmatic optics shift the apparent centroid by tens of nm across z). Subtract it in analysis or you will manufacture spurious xy–z coupling.
- **Repeat at 0, 1.5, 3.0, 4.5 µm depth** to get the depth‑dependent z‑scaling factor. Index‑mismatch focal shift means one piezo nanometre ≠ one sample nanometre; expect a scaling factor near ~0.8 for oil→aqueous. *(Inference — measure it, don't assume the value.)*

**C4 — Piezo characterisation.**
- Staircase (±100, ±200, ±400 nm) up then down on an immobilised bead → **hysteresis must be < 10 nm** in closed loop.
- Step response: measure time to settle within 10 nm of target for a 100 nm step. **Record t_settle**; it must be < 25 ms. This sets your control loop's dead time.

**C5 — Precision floor & photon budget.**
- On a **fixed cell** locus at your final exposure/power: 3,000 frames, compute σ_x, σ_y, σ_z (std of positions) and photons/frame.
- **Target (inference):** 1,500–3,000 detected photons/frame, background 20–60 photons/px → σ_x,y ≈ 10–15 nm, σ_z ≈ 25–45 nm.
- If σ_z > 60 nm: raise exposure to 60–80 ms *before* raising LED power (exposure costs blur, power costs viability; at these dynamics blur is the cheaper cost).

---

## 5. Live acquisition and control workflow

### 5.1 The 200 ms cycle (engineering inference throughout)

| Phase | Budget |
|---|---|
| LED on + exposure (64×64 ROI) | 40 ms |
| Readout + transfer | ~5 ms |
| Crop, MLE fit, z lookup | ~5 ms |
| PI update + piezo move + settle | ~25 ms |
| Idle, **illumination off** | ~125 ms |
| **Total** | **200 ms, ~20% light duty cycle** |

Camera is externally triggered at exactly 5.000 Hz; the fit/control runs inside the idle window. If a fit overruns, **skip the control update, never skip the frame** — a dropped frame breaks the uniform time base that MSD analysis depends on.

### 5.2 Startup sequence

1. Find a G1 or small‑budded cell with one bright, well‑isolated spot 2–3 µm above the coverslip, with ≥1 fiducial bead in the same 64×64 ROI if possible (else use a second small "bead ROI" read every 10th frame).
2. Take **one** 21‑plane × 100 nm reference stack (this is the *only* stack you take) to get starting z and confirm the spot is single.
3. Move piezo so the locus sits at the **astigmatic zero‑crossing** (w_x = w_y), i.e. the centre of the calibration well.
4. Snap a low‑dose brightfield/DIC frame (cell outline, bud neck) — repeat every 30 s. Brightfield dose is negligible relative to 470 nm.
5. Arm the trigger.

### 5.3 The controller

Per frame k:
```
crop 64×64 ROI centred on last (x,y)
fit elliptical Gaussian, MLE with per-pixel sCMOS variance map
 -> x, y, wx, wy, N_photons, background
s = (wx - wy)/(wx + wy)
z_rel = spline_lookup(s)                 # astigmatic residual, sample frame
z_abs = piezo_pos_k * depth_scale + z_rel
e = z_rel - 0                            # setpoint = astigmatic zero
if |e| > deadband(40 nm):
    u += Kp*e + Ki*integral(e)           # Kp≈0.3, Ki≈0.05, slew-limited to 150 nm/frame
    piezo.move(u)
recentre ROI if |x,y - ROI centre| > 8 px
log: t_trigger, x, y, wx, wy, N, bkg, piezo_setpoint, piezo_readback, z_abs
```

**Deliberately sluggish gains.** With Kp ≈ 0.3 the loop has a ~1 s time constant. It follows thermal drift and slow nuclear repositioning but **does not chase the locus's own sub‑second motion** — which is exactly what you want, because a fast focus‑lock would subtract the biology you are measuring. The fast component of z motion stays in the astigmatic residual `z_rel`; the piezo only carries the slow component. *(This is the key design decision; it is engineering inference, not retrieved.)*

**Escape conditions — auto‑terminate the track and log the reason:**
- N_photons < 40% of frame‑1 value (bleached out)
- |z_rel| > 500 nm for 5 consecutive frames (lost the astigmatic range)
- a second spot appears within 6 px (replication → sister loci; this ends a valid single‑locus track)
- fit residual χ²_red > 3

### 5.4 xy

Do **not** actuate the xy stage. Yeast nuclear loci explore < ~1 µm laterally; software ROI recentring is sufficient and avoids injecting stage‑settling vibration into your position record.

---

## 6. Validation (do not analyse biology until all five pass)

**V1 — Static precision.** Fixed‑cell locus, full 9,000‑frame run under identical settings. TAMSD must be **flat** at 2σ² in each axis with no trend > 5 nm² per 100 s. Any rising baseline = uncorrected drift.

**V2 — Closed‑loop z ground truth (the essential test).** With a **fixed** cell or bead, command the piezo through a known 0.02 Hz, ±300 nm sinusoid *underneath* an active tracker. Reconstruct z_abs = piezo + z_rel. **z_abs must be flat**, and independently, with the loop disabled, the recovered z_rel must reproduce the imposed sinusoid with **slope 1.00 ± 0.05 and residual < 40 nm RMS**. This validates that piezo and astigmatic components sum correctly — the single most likely failure mode of this design.

**V3 — Biological immobility.** Azide/2‑DG–depleted cells should show strongly suppressed MSD versus untreated. *(The expected magnitude of suppression is an assumption; use it as a relative, within‑experiment control.)*

**V4 — Periodic stack cross‑check.** Every 5 min, insert one **7‑plane × 200 nm** mini‑stack (adds ~2% to total dose). The stack centroid z must agree with the tracked z_abs within **±80 nm**. This is your drift‑independent absolute‑z audit.

**V5 — Phototoxicity.** Illuminated cells must (i) complete the current division and bud again within 2 h at a rate ≥ 80% of unilluminated neighbours in the same field, and (ii) show no vacuole fragmentation or cytoplasmic GFP redistribution. If they fail, halve LED power and re‑check §C5 precision. *(Thresholds are inference.)*

**V6 — Isotropy sanity check.** MSD_x, MSD_y should be statistically indistinguishable; MSD_z will be noisier (σ_z > σ_xy) but its **exponent α should match** the lateral one. A z exponent that diverges from x/y indicates a calibration or control artefact, not biology.

---

## 7. Downstream analysis

1. **Reconstruct** z_abs = piezo_readback × depth_scale + spline(s); subtract the Δx(z), Δy(z) wobble from C3.
2. **Drift correction.** Fit the fiducial‑bead trajectories with a smoothing spline (30 s knots) in x, y, z; subtract from the locus track. Report residual bead RMS after correction as your systematic floor (cf. `doi:10.3791/51086`).
3. **Reference frame.** Trick available to you despite the single colour: the **unbound nuclear NLS‑GFP‑LacI pool** dims the nucleus visibly in the same channel. Fit a 2D disc/ellipse to this background in each frame to get a nuclear centre, and report both lab‑frame and nucleus‑frame trajectories. If the background is too dim, use the brightfield cell outline + bud neck instead and **state explicitly that nuclear translation and rotation are not removed** — this is a real limitation of a one‑colour experiment, not something to paper over. *(Inference.)*
4. **Per‑point uncertainty.** Compute σ(t) per frame from photons/background via the sCMOS CRLB. Bleaching means late‑track points are less precise; propagate this, do not use a single σ.
5. **MSD.** Time‑averaged MSD per track, then ensemble‑average. Fit
   MSD(τ) = Γτ^α + 2σ² − (4/3)·Γ·R·(t_E)^α‑type blur term,
   with the localization offset **2σ² fitted, not fixed**, and the motion‑blur coefficient R = 1/6 for continuous exposure. Fit only τ ∈ [0.4 s, 0.2 × T_track] — the tail of a TAMSD is statistically worthless.
6. **Beyond MSD** (these are what distinguish a real result from a drift artefact):
   - **Velocity autocorrelation** at lag 1: genuine subdiffusive/viscoelastic motion gives a characteristic negative correlation; drift gives a positive one.
   - Confinement radius R_c from the MSD plateau.
   - 3D step‑size / jump‑distance distributions, tested against one‑ vs two‑state models.
7. **Report** α, Γ, R_c, σ_x/σ_y/σ_z, photons/frame, duty cycle, track length distribution, and the number of tracks terminated by each escape condition in §5.3. That last table is the honest denominator of the experiment.

---

## 8. Checkpoints (go / no‑go)

| # | Checkpoint | Pass criterion | If it fails |
|---|---|---|---|
| CP1 | Astigmatic calibration at 2–3 µm depth | (w_x−w_y)/(w_x+w_y) monotonic over ≥ ±500 nm | Rotate/translate cylindrical lens; re‑select immersion oil RI |
| CP2 | Piezo hysteresis & settle | <10 nm, <25 ms | Reduce step size, slow the loop, extend cycle to 250 ms |
| CP3 | Photon budget | ≥1,500 photons/frame at ≤20% duty cycle | Raise exposure to 80 ms first, power second |
| CP4 | Static precision (V1) | flat MSD; σ_z ≤ 50 nm | Re‑do C1 pixel maps; check thermal enclosure |
| CP5 | Closed‑loop z ground truth (V2) | slope 1.00±0.05, <40 nm RMS | **Stop.** Sign error or depth‑scale error in z_abs reconstruction |
| CP6 | Track yield | ≥50% of started tracks reach 10 min | Reduce dose; switch agarose pad → perfusion |
| CP7 | Viability (V5) | ≥80% of control budding rate | Halve power; consider 80 ms exposure at lower power |
| CP8 | Stack cross‑check (V4) | ±80 nm agreement | Re‑run C3 depth series |

---

## 9. Practical timing

**One‑time setup:** cylindrical‑lens install + alignment, 1 day. Python control loop + hardware triggering, 3–5 days (budget most of this for trigger timing, not for the fitter).

**Per experiment day:**
| | |
|---|---|
| Turn on incubation, equilibrate | 2 h (start before you arrive) |
| C1 pixel maps (weekly, not daily) | 20 min |
| C3 astigmatic calibration at depth | 45 min |
| C4 piezo check | 20 min |
| C5/V1 precision on fixed cells | 30 min |
| V2 ground‑truth sinusoid | 20 min |
| Sample mounting + settling | 30 min |
| **Per cell:** find + reference stack + track | 3 min + 10–30 min |
| Realistic yield | **8–12 cells / 8 h day** |
| Azide control block | 30 min |

**Analysis:** ~2 h for a first full pass on a day's data once the pipeline is written; MSD fitting itself is seconds.

---

## 10. Assumptions, explicitly labelled

1. Strain design (256×*lacO* + NLS‑GFP‑LacI, single spot, moderate expression) — **assumed**, not retrieved.
2. All optical numbers (f = +500 mm, ±600–800 nm range, 65 nm/px, 40 ms exposure, 20% duty cycle, photon targets, σ_xy ≈ 10–15 nm, σ_z ≈ 25–45 nm) — **engineering inference** from standard astigmatic‑3D‑localization scaling, not from any retrieved document.
3. PI gains (Kp 0.3, Ki 0.05) and the deliberately slow‑loop design — **inference**; tune empirically against V2.
4. Depth scaling factor ~0.8 for oil→aqueous — **must be measured** in C3; the value quoted is illustrative only.
5. Expected subdiffusive exponent for yeast chromatin (~0.4–0.5) — **recall, not retrieved**; treat your measured α as the result, not a check.
6. Viability thresholds (80% budding rate) and QC tolerances (±80 nm, χ²_red < 3) — **inference**, set them from your own control distributions.
7. The nuclear‑background‑as‑reference‑frame trick — **inference**; verify the unbound GFP‑LacI pool is actually detectable in your strain before relying on it.
8. Retrieved sources were used at **metadata level only** (titles/abstract fragments); none was read in full, so none is cited as the source of a parameter.
