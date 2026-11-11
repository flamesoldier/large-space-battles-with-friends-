# Aegis fortress generators

One-off scripts that drew the four ready-made Aegis defences in the Defence Designer's
"Start from" menu (`src/shared/fortresses.js`). Each writes a design JSON (the designer's
Export format) at exactly 750,000 cr of blocks. Run from this folder:

    node gen.mjs  Aegis-Star-Citadel.json 7 5
    NA=6 W=780 RK=80 RM0=130 RM1=192 GAP=60 B_G=222 FL=38 OR_V=74 TIP=362 SKIN=4 node gen2.mjs Aegis-Star-Citadel-II.json
    GAP=48 RM0=140 RM1=200 node gen3.mjs Aegis-Star-Citadel-III.json
    GAP=48 RM0=140 RM1=200 NK_IN=3 NK_OUT=22 NECKH=4 node gen4.mjs Aegis-Star-Citadel-IV.json
    node pack.mjs        # -> ../../src/shared/fortresses.js

Block prices or weapon rules changing can change the output (guns with too narrow an arc
are dropped, the budget is trimmed to 750,000 exactly); `npm test` checks the packed ones
are still valid 750,000 cr defences.
