---
name: Colony PCR screening
description: >-
  Screen transformants straight from the colony; 15 min initial lysis, 39
  cycles.
kind: protocol
category: PCR
---
## Reaction (per colony)

| Component | Volume |
| --- | --- |
| PCR supermix | 9 ul |
| Forward primer, 40 uM | 0.25 ul |
| Reverse primer, 40 uM | 0.25 ul |
| Colony picked into the mix | 0.5 ul |

Pick 4-8 colonies per construct for a routine assembly. Patch each onto a master
plate as you go, so a positive can be recovered.

## Cycling

1. 95 C for 15 min. The long first step lyses the cells and releases the template.
2. 39 cycles of:
   - 94 C for 30 s
   - 56 C for 30 s
   - 68 C for 1 min per kb of expected product
3. 68 C for 20 min
4. Hold at 4 C

Round the extension up rather than down: for a 3.6 kb construct use 4 min.
Generous extension times are the cheapest way to improve a screen.

## Notes

- Run the products on an agarose gel and read the length against the ladder.
- For amplicons beyond about 3 kb, a high-fidelity polymerase is worth the swap.
- With 96-well plates and tube strips this scales to a whole plate at once.

*Adapted from OpenWetWare (CC BY-SA): https://openwetware.org/wiki/Knight:Colony_PCR*
