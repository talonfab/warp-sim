# How the warp simulation works — and how to read its output

This document explains the physical model behind the simulator, why each
piece of it corresponds to something real about FFF printing, how the
numbers were calibrated, and — most importantly — what the risk rating does
and does not tell you.

The short version: the simulator estimates, for each printed object, how
hard its locked-in thermal shrink pulls the worst bottom corners off the
plate, compared with how hard the first layer holds on. That ratio is the
score. It is a physics-informed heuristic, not a finite-element analysis —
built to get the *first-order* mechanics right, and calibrated against
prints with known outcomes.

## 1. Why FFF parts warp at all

Every road of filament is extruded hot, then cools to room temperature and
shrinks. If the whole part shrank at the same time, it would just end up
fractionally smaller. It doesn't, because layers are deposited at different
times into different local temperatures:

1. Material near the heated bed stays warm for the whole print.
2. Material higher up cools to the chamber/room temperature within minutes.
3. When a layer cools below the temperature at which its polymer stops
   flowing — the **lock-in temperature** (≈ glass transition Tg for
   amorphous polymers like PLA/PETG/ABS/ASA/PC, ≈ crystallisation
   temperature for semi-crystalline ones like nylons) — any further shrink
   is stored as elastic stress instead of relaxing away.

The result is a stack in which upper, colder layers have shrunk more than
the warm base. That differential contracts the top relative to the bottom
and bends the part upward at its extremities — exactly like a bimetal
strip. The bending moment is resisted by one thing only: the first layer's
adhesion to the plate. When peel stress at a corner exceeds adhesion, the
corner lifts, the lever gets longer, and the lift propagates — the familiar
curled corner.

That contest — **locked-in differential shrink versus first-layer
adhesion** — is what the simulator computes.

## 2. The model, step by step

The pipeline runs independently for **every object on the build plate**
(objects are separate bodies; each shrinks toward its own centroid — two
small parts far apart are *not* one big risky part).

### 2.1 Voxelisation

Each object is voxelised by column parity into at most ~96×96 cells in XY
and 160 layers in Z. That yields per-layer cross-sections, the bottom-layer
footprint, and each bottom cell's distance from the footprint centroid.

### 2.2 Thermal field

While printing, material at height *z* is assumed to equilibrate to

```
T_env(z) = T_chamber + (T_bed − T_chamber) · e^(−z / 7 mm)
```

The 7 mm decay captures what matters in practice: the bed dominates the
first few millimetres and is nearly irrelevant a couple of centimetres up,
where only the chamber temperature helps. This is why thin flat parts on a
hot bed are safe and *tall* parts in cold air are not — the model's most
load-bearing qualitative behaviour.

### 2.3 Stress lock-in, with a relaxation band

A layer held at temperature `T_hold` locks in this fraction of the
material's total shrink strain:

```
φ = clamp( ((T_lock − 20 °C) − T_hold) / (T_lock − 25 °C), 0, 1 )
```

Two deliberate features:

- **The 20 °C relaxation band.** Polymer held only slightly below its
  lock-in temperature still creeps: over the minutes-to-hours of a print,
  stress at Tg−10 °C largely relaxes away. Strain only *survives* once the
  material sits a whole band below lock-in. This single term is what
  separates the materials that warp from the ones that don't:
  - PLA (lock ≈ 60 °C) on a 60 °C bed: the base *is* the band — nothing
    locks in near the plate. PLA prints flat.
  - PETG (≈ 78 °C) on a 70 °C bed: same story.
  - ABS (≈ 102 °C) on a 100 °C bed in 25 °C air: the bed protects only the
    first couple of millimetres; everything above locks in hard.
  - PAHT-CF (≈ 160 °C): even a 100 °C bed is 60 °C below lock-in. Nylons
    keep most of their shrink as stress, chamber or not — which is why they
    need glue, brims, and care regardless.
- **Even stone-cold material locks less than 100 %** — the strain picked up
  while crossing the band has already relaxed and never loads the part.

A layer that stays warm contributes only a small residual (5 % of its
shrink) for the through-thickness gradients of the final cooldown.

### 2.4 What drives the base: strain near the plate

Corner peel is driven by strain in the lower region of the part, so layer
strains are averaged with an exponential weight `e^(−z/h_ref)` where
`h_ref = max(0.4 · height, 3 mm)`. Material a long way up bends the walls,
not the base — but it still matters more on tall parts, captured by a
height factor `min(2, √(height/10 mm) + 0.5)`.

### 2.5 Corner peel versus adhesion

For every occupied bottom cell at distance *r* from the footprint centroid:

```
r_eff  = 90 mm · (1 − e^(−r / 90 mm))          # saturating lever
peel   ∝ stiffness · (ε_base / 0.003) · (r_eff / 60 mm)^1.5 · heightFactor
ratio  = peel / (bedAdhesion · brimBonus)      # brimBonus = 1.6 with a brim
```

- **Stiffness matters as much as shrink.** Peel force is modulus × strain.
  TPU shrinks a lot but is ~30× softer than PLA — the bead stretches
  instead of prying the corner up, so TPU prints flat. Carbon-filled grades
  gain stiffness but lose ~2–3× more shrink, so they warp *less* — and a
  20 % CF grade less than a 10 % one.
- **The lever grows super-linearly, then saturates.** Distant corners are
  worse (`r^1.5`, the bimetal-strip lever), but past ~90 mm the base plate
  *bends* rather than prying harder — which is why a 250 mm sheet is not
  radically worse than a 120 mm one, matching experience.
- **Adhesion is per material and per plate surface.** Material values (PLA
  = 1.0; PETG grips harder; ABS and nylons hold less, assuming glue for
  nylons) are calibrated on textured PEI. Other surfaces scale them: smooth
  PEI grips 10–20 % harder (PETG most of all — it nearly welds), while
  PLA-oriented cool and high-tack plates hold hot-bed polymers at roughly
  half strength (and grip PLA hardest of all). A brim multiplies holding
  force by 1.6.

### 2.6 The score

The per-cell ratios are reduced to their 95th percentile *p* (the worst
corners decide the outcome, not the average), then squashed to 0–100:

```
score = 100 · p / (1 + p)
```

So **score 50 means peel ≈ adhesion at the worst corners** — the genuine
borderline. The plate's overall rating is its **worst object**.

## 3. Why you can trust it (and how it was calibrated)

The model contains the mechanisms that dominate warping in practice, each
of which reproduces a well-known workshop fact:

| Model mechanism | Real-world fact it reproduces |
|---|---|
| Bed influence decays over ~7 mm | Thin parts on hot beds are safe; tall parts warp from the waist up |
| Lock-in ≈ Tg / crystallisation temp | ABS/PC/nylon are the warpers; PLA/PETG mostly aren't |
| 20 °C relaxation band | PLA at bed 60 / PETG at bed 70 print dead flat |
| Chamber raises T_env at height | Enclosures fix ABS; actively heated chambers fix more |
| Peel ∝ stiffness × strain | TPU never warps; CF grades warp less than base polymer |
| Saturating r^1.5 lever | Far corners lift first; huge sheets aren't catastrophically worse |
| Adhesion × 1.6 with brim | Brims genuinely rescue borderline prints |
| Per-object simulation | Ten small parts on one plate ≠ one huge part |

The constants (band width, lever scale, reference strain, bucket edges)
were then fitted against an **anchor table** of prints with known outcomes
— PLA/PETG sheets that print flat on open printers, ABS boxes that fail on
open printers and succeed in chambers, nylon plates that stay tense even
chambered, TPU that never lifts. The anchors live in
[`tests/anchors.test.ts`](../tests/anchors.test.ts) and run in CI, so the
calibration cannot silently drift. Relative orderings (ABS ≫ PLA, CF <
base polymer, open ≫ chambered, brim < no brim) are separately pinned by
tests.

Where the numbers come from: lock-in temperatures and shrink strains follow
manufacturer datasheet values and polymer literature;
stiffnesses are real relative moduli (PLA ≈ 3.5 GPa = 1.0, PETG/ABS/ASA ≈
0.6–0.65, CF grades 1.1–1.5); adhesion values are relative practical
rankings on PEI-type plates.

## 4. How to interpret the risk rating

| Score | Bucket | What it means | What to do |
|---|---|---|---|
| 0–19 | **low** | Peel is well below adhesion everywhere. | Print it. Normal plate prep is enough. |
| 20–44 | **moderate** | Worst corners are loaded but hold with margin. | Clean plate, watch the first layer, consider a brim on the far corners. |
| 45–69 | **high** | Worst corners are near or at the limit — outcome depends on the details the model can't see (plate cleanliness, first-layer squish, drafts). | Take active measures: brim or mouse-ears, maximum bed temp, enclosure/chamber, glue for nylons, reorient or split the part. |
| 70–100 | **severe** | Peel clearly exceeds adhesion at the corners. | Expect failure as configured. Change something structural: different material (CF grade), different geometry/orientation, heated chamber. |

Reading guidance:

- **Comparisons are stronger than absolutes.** The most reliable output is
  the *ranking*: "PETG scores 12 where ABS scores 48 on this part" is
  trustworthy; whether a 48 fails on *your* plate on Tuesday depends on
  factors below the model's resolution. Treat the absolute bucket as
  accurate to about ±1 bucket.
- **Score 50 is the physical borderline** (peel = adhesion), not "50 % of
  the way to bad". The squash is non-linear: 30→40 is a bigger physical
  step than 10→20.
- **The heatmap shows *where* lift starts.** Dark regions are the bottom
  corners whose peel ratio is highest, with the risk decaying up the walls
  over the bending length. Use it to place mouse-ears or a painted-on brim
  exactly where they're needed, or to see which reorientation shortens the
  worst lever.
- **The plate rating is its worst object.** Click through filaments in the
  table; the per-object heatmap tells you *which* object is the problem.
- **Conditions are per filament.** Scores are computed at each filament's
  resolved bed/chamber/brim (sliced settings → printer inference →
  recommendation, overridable per filament) — so the table compares
  materials *as you would actually print them*, not at one shared setting.

## 5. What the model does not capture

Honesty section — a "low" can still fail and a "severe" can still be
rescued, because the model deliberately ignores:

- **First-layer quality.** Z-offset, squish, dust, fingerprint oils — the
  single biggest cause of real-world corner lift. The model assumes a
  clean, correctly calibrated first layer on the recommended surface.
- **Adhesives.** Values assume the standard surface (and glue for nylons,
  which is why PA adhesion isn't rated even lower). Liquid glue / 3D-lac
  can add margin the model doesn't know about.
- **Layer delamination / Z-warp.** Tall ABS parts in cold air often crack
  between layers instead of (or as well as) lifting corners. That failure
  mode shares the same cause (locked-in strain) but isn't scored.
- **Transient effects.** Deposition order, part-cooling fan, drafts from
  an open door, the first hour vs the tenth. The thermal field is a
  steady-state approximation.
- **Infill.** Parts are treated as solid cross-sections — conservative for
  sparse infill, which shrinks the base slightly less.
- **Overhang/edge curl** from insufficient cooling — a different mechanism
  (local, thermal, top-surface) than plate warp.

## 6. Worked example

A 150×100×8 mm PAHT-CF electronics tray in an actively heated chamber
(bed 100 °C, chamber 60 °C, no brim) scores ~51 — high. The heatmap darkens at the four tray
corners. Reading: nylon locks in stress even chambered (160 °C lock-in is
far above any bed), and 90 mm corner levers load it to roughly the adhesion
limit. Response, in order of cheapness: glue + 8 mm brim (adhesion ×1.6
drops it to moderate), mouse-ears at the corners, or switch the tray to
ASA-CF 20 % — same chamber, scores low-moderate, because its lock-in is
60 °C lower and its shrink a third of nylon's.
