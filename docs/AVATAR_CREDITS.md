# Avatar credits

`frontend/public/models/avatar.glb` is a derivative of **"Low-poly flat-shaded hood character rigged and animated"**
by **kednar** (OpenGameArt submission 76261), released under **Creative Commons Attribution 3.0**
(https://creativecommons.org/licenses/by/3.0/). The files shipped with it are named
`TWWB_character_hood_PabloLopezSoriano_CCBYSA`, which also credits Pablo Lopez Soriano and says "CC-BY-SA".
The license page in the download says CC-BY 3.0 only, so the two disagree. Until that is settled, treat the stricter
reading (BY-SA: credit both people and release changes to the model under the same license) as the safe one.

Changes made for POSTURA: baked the mirror modifier; replaced the 84-bone control rig and its 15 animation clips with a
40-bone deform skeleton using POSTURA's bone names (original skin weights kept); split the hood into its own mesh;
rescaled to 1.75 m with the origin at the feet; rebuilt the materials as single Principled shaders (same colours).
Source for the result: `assets/avatar/avatar_hood_postura.blend`. Unmodified original: `assets/avatar/TWWB_character_hood_PabloLopezSoriano_CCBYSA.blend`.

The previous placeholder humanoid (`avatar_humanoid.glb`, removed) can be regenerated from `assets/avatar/avatar_postura.blend`.
