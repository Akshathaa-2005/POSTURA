# Exercise thresholds: what each number is based on

Scope: the five strength exercises in [`exercises/exercises.json`](../exercises/exercises.json) (bicep curl, shoulder press,
front raise, lateral raise, overhead tricep extension).

Angle conventions used by the engine (see `frontend/src/utils/poseValidation.ts`):
- `elbow` = shoulder–elbow–wrist. 180° = straight arm, about 90° = elbow at right angle.
- `shoulder` = hip–shoulder–elbow. About 0° = arm hanging at side, 90° = arm horizontal (shoulder height), 180° = arm straight overhead.

Anatomical flexion (the usual clinical convention) is 180° minus the elbow angle, so an elbow angle of 50° is 130° of flexion.

**Status key**
- **Supported**: a source gives a value that matches the threshold.
- **Partly supported**: a source supports the idea or a nearby value, but not this exact number.
- **Estimate**: no source found. Treat as a coaching estimate until tested with recorded reps.

Sources were found with web search and read as summaries and secondary pages. The full papers have not been checked.

## Bicep curl

| Rule | Value | Status | Basis |
|---|---|---|---|
| Rep start (elbow) | 150° | Partly supported | Normal elbow flexion starts at 0° (straight), so 150° is about 30° of flexion. Used as the rest position. |
| Rep peak (elbow) | 60° | Partly supported | Equals about 120° of flexion. A 2012 preacher-curl study used 0–130° as full range (about 50° elbow angle). The peak is slightly short of that full range. |
| `partial_curl` warn 50° / bad 75° | | Supported | Warn at 50° matches the 130° full-range end of the 2012 study. Bad at 75° is short of the peak, so the rep is not counted. |
| `elbow_drift` (shoulder warn 25° / bad 40°) | | Estimate | No source found for how far the upper arm may move. |
| `swinging` (torso lean 10° / 18°) | | Estimate | No source found. |

Sources:
- Pinto et al., 2012, preacher curl, 0–130° vs 50–100° (cited in the summary at [examine.com](https://examine.com/summaries/study/9goqN9/); full text not checked). Full-range training gave greater strength, and both groups gained muscle.
- A 2023 randomized trial summarized by Examine: training the lengthened half of a curl (0–68° flexion) was more effective than the shortened half (68–135°). Relevant to where the rep should be counted. Summary at [examine.com](https://examine.com/summaries/study/9goqN9/).
- [IDEA Fit: range of motion, full or partial](https://www.ideafit.com/range-of-motion-full-or-partial), a secondary summary.

## Shoulder press

| Rule | Value | Status | Basis |
|---|---|---|---|
| Rep start (elbow) | 100° | Estimate | No source found for the bottom position. Test case: a bottom at 110° never counts (see the rep simulation). |
| Rep peak (elbow) | 160° | Partly supported | Full elbow extension is 180°; 160° allows a slight bend at the top. |
| `no_lockout` warn 166° / bad 150° | | Partly supported | Follows from the peak. The exact values are estimates. |
| `pressing_forward` (shoulder warn 155° / bad 140°) | | Estimate | No source found. |
| `leaning_back` (torso lean 10° / 18°) | | Estimate | No source found. |

Sources:
- Seated barbell and dumbbell press comparison, a student-style web page: elbow range about 130° with a barbell, 135° with dumbbells. Small sample, and the angle convention differs from ours. Treat as indicative only. Not linked here because the page's quality is low.
- [Gundersen et al., 2025, grip width in the shoulder press](https://www.klokavskade.no/globalassets/publications/gundersen_2025_the-impact-of-grip-width-on-kinetics-and-kinematics-in-the-shoulder-press-among-resistance.pdf). Narrow and wide grips change elbow and shoulder range; no fixed angles given in the summary.
- [Link-chain model of bench and overhead press, PMC12372072](https://pmc.ncbi.nlm.nih.gov/articles/PMC12372072). Elbow extensors dominate near full extension. Supports the top-of-press checks, but no bottom angle is given.

## Front raise

| Rule | Value | Status | Basis |
|---|---|---|---|
| Rep start (shoulder) | 30° | Estimate | Arm at side is about 0–10°. The start is a rest position, not a measured value. |
| Rep peak (shoulder) | 80° | Partly supported | Target is shoulder height (90°). Counting at 80° allows a small margin. |
| `raise_low` warn 85° / bad 70° | | Partly supported | Follows from the peak. Shoulder height is 90° in our angle convention. |
| `bent_arms` (elbow warn 145° / bad 120°) | | Estimate | No source found. |
| Upper limit (not present) | | Gap | No check for raising the arm above shoulder height. Suggested addition, not yet made. |

Sources:
- Hecker et al., 2021, *J Shoulder Elbow Surg*. The deltoid's share of flexion strength rises with angle, from about 11% at 0° to about 70% at 120°. Does not isolate 90° (summary read, full text not checked).
- Surface EMG study, 1988, maximal static flexion at 45°, 65° and 90° in 23 women. Deltoid activity differs between these angles. Static, not a dynamic raise.
- A front-raise study with reported "18% tension difference at 45° vs 90°" appeared on low-quality pages. Could not verify it, so it is not used.

## Lateral raise

| Rule | Value | Status | Basis |
|---|---|---|---|
| Rep start (shoulder) | 30° | Estimate | Same as front raise. |
| Rep peak (shoulder) | 80° | Partly supported | Shoulder height (90°). |
| `raise_low` warn 85° / bad 70° | | Partly supported | Same as front raise. |
| `raise_high` warn 105° / bad 120° | | Estimate | No source found for an upper limit. Arms above shoulder height are a common coaching point. |
| `bent_arms` (elbow warn 145° / bad 120°) | | Estimate | No source found. |
| Shrug cue ("don't shrug") | | Gap | The cue has no matching measurement. |

Sources:
- Reed et al. (Australian Catholic University repository), EMG in abduction. Activation is similar in the scapular plane and within 30° of it, except for middle deltoid and upper trapezius. Supports using scapular-plane abduction as a stand-in for the lateral raise. [ACU research bank](https://acuresearchbank.acu.edu.au/item/858vz/does-changing-the-plane-of-abduction-influence-shoulder-muscle-recruitment-patterns-in-healthy-individuals)
- de Oliveira et al., EMG of the deltoid portions across 0–180° of abduction, scapular vs frontal plane. [Konstanz journal](https://ojs.ub.uni-konstanz.de/cpa/article/view/2172)

## Overhead tricep extension

| Rule | Value | Status | Basis |
|---|---|---|---|
| Setup (shoulder > 120°) | | Partly supported | Upper arm overhead. Overhead is 180°; 120° allows some tolerance. |
| Rep start (elbow) | 90° | Estimate | Sources say "deep elbow flexion" without a number. Test case: a bottom at 100° never counts (see the rep simulation). |
| Rep peak (elbow) | 155° | Partly supported | Near full extension (180°). |
| `no_lockout` warn 162° / bad 145° | | Partly supported | Follows from full extension. |
| `elbows_forward` (shoulder warn 150° / bad 135°) | | Estimate | No source found. |

Sources:
- [PMC6136322](https://pmc.ncbi.nlm.nih.gov/articles/PMC6136322), elbow kinematics and triceps muscle length, using an OpenSim model. Starts from full flexion. Does not give overhead ROM.
- 2022 study, overhead vs neutral arm position: greater triceps growth with overhead extensions. [BarBend summary](https://barbend.com/overhead-triceps-extensions-vs-pushdowns-muscle-growth-study). Supports the exercise choice, not the angles.
- Fitness sites recommend deep flexion to full extension. No measured values.

## Overall

- **Supported or partly supported:** the peak thresholds for the curl and the press lockout, the curl's partial-rep warn, and the shoulder-height target for the raises. Shoulder height is 90° of shoulder angle, which is a definition, not a study result.
- **Estimates:** every start threshold, the tricep and press bottom positions, the warn/bad values for lean, sway and elbow bend, and the lateral raise upper limit.
- **Gaps:** the front raise has no upper-limit check, and the lateral raise shrug cue has no measurement.

Next step: test these thresholds against recorded reps (the `?record=1` workflow in the README) before changing any values.
