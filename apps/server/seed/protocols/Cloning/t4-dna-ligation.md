---
name: T4 DNA ligation
description: >-
  Ligate an insert into a linearised vector with T4 DNA ligase; 10 ul reaction,
  30 min at 22.5 C.
kind: protocol
category: Cloning
---
## Reaction (10 ul)

| Component | Amount |
| --- | --- |
| 10X T4 ligase buffer | 1.0 ul |
| Linearised vector | ~10 ng |
| Insert | 6:1 molar ratio to vector |
| Water | to 9.5 ul |
| T4 DNA ligase | 0.5 ul |

Insert mass (ng) = 6 x (insert length in bp / vector length in bp) x vector mass (ng).
Ratios from 1:1 to 10:1 are worth testing when a ligation is stubborn.

## Procedure

1. Vortex the buffer and the ligase before pipetting. The buffer carries ATP, and
   repeated freeze-thaw degrades it, which quietly costs you efficiency.
2. Assemble everything except the ligase.
3. Add 0.5 ul ligase by touching the tip to the surface of the liquid. It is
   supplied in glycerol and will otherwise stay in the tip.
4. Mix by pipetting or slow resuspension, never by vortexing: T4 ligase is
   sensitive to shear.
5. Incubate 30 min at 22.5 C.
6. Heat-inactivate 10 min at 65 C.
7. If you are going to electroporate, dialyse for 20 min first.

## Notes

- Dephosphorylating the vector cuts self-ligation background.
- Completed reactions keep at -20 C.

*Adapted from OpenWetWare (CC BY-SA): https://openwetware.org/wiki/DNA_ligation*
