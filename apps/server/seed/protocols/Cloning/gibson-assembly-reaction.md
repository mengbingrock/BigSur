---
name: Gibson assembly reaction
description: Join fragments by 30 bp overlaps in a one-hour isothermal reaction at 50 C.
kind: protocol
category: Cloning
---
## Primer design

Order primers about 60 bp long: 30 bp matching the end of the adjacent fragment,
and 30 bp annealing to your target. The two fragments then share an identical
sequence at the join, which is what the assembly anneals.

Avoid strong secondary structure in the homology region. A hairpin there
noticeably reduces the chance of the two ends finding each other.

## Reaction

1. Work on ice.
2. Combine the fragments with the assembly master mix. Yields are best with the
   fragments at equimolar concentration.
3. Incubate 1 hour at 50 C, or follow the master mix manufacturer's timing.
4. Transform 2 ul of the reaction.

## Notes

- Success falls off sharply beyond about five fragments in one reaction.
- ET SSB protein can be added to improve accuracy and efficiency.
- For a short intervening sequence of roughly 60-150 bp, stitch oligos together
  rather than designing standard PCR primers.

*Adapted from the Addgene protocol collection: https://www.addgene.org/protocols/gibson-assembly/*
