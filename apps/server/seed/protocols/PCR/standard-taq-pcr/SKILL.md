---
name: Standard Taq PCR
description: 50 ul Taq reaction with a 25-30 cycle program; annealing 5 C below primer Tm.
kind: protocol
category: PCR
---
## Reaction (50 ul)

| Component | Volume |
| --- | --- |
| Template DNA (10-500 ng) | 2 ul |
| 10X Taq buffer with MgCl2 | 5 ul |
| dNTP mix, 10 mM each | 1 ul |
| Forward primer, 10 uM | 2.5 ul |
| Reverse primer, 10 uM | 2.5 ul |
| Taq polymerase, 5 U/ul | 0.2 ul |
| Sterile water | 36.8 ul |

Keep everything on ice while setting up.

## Cycling

1. 94 C for 2 min
2. 25-30 cycles of:
   - 94 C for 30 s
   - 55 C for 30 s, or 5 C below the primer Tm
   - 72 C for 1-2 min
3. 72 C for 5 min
4. Hold at 4 C

## Primers

Design the pair with similar melting temperatures. To reconstitute a lyophilised
primer, add water in ul equal to ten times the nanomoles supplied, which gives
100 uM; dilute 1:10 for a 10 uM working stock.

## Troubleshooting

- GC-rich template: lengthen the denaturation step.
- Weak or absent product: try 1 ul of 25 mM MgCl2, or 1 ul DMSO, per reaction.
- Always confirm the product on a gel before using it.

*Adapted from the Addgene protocol collection: https://www.addgene.org/protocols/pcr/*
