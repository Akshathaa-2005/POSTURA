# Blender → POSTURA avatar (`frontend/public/models/avatar.glb`)

`AvatarCoach3D` loads `/models/avatar.glb`. If the file is missing or lacks required bones, the viewer
shows the built-in placeholder body and an "unavailable" badge instead of breaking.

## 1. Prepare the model in Blender

1. **Scale and orientation**: 1 Blender unit = 1 m, character about 1.6–1.9 m tall, standing on Z = 0,
   facing **-Y** (Blender front view). The exporter converts this to +Y-up, facing +Z in three.js.
   Select everything → `Ctrl+A` → **All Transforms** so object scale is 1 and rotation is 0.
2. **Armature bones must use these exact names** (a `mixamorig:` prefix is also accepted):

   `Hips`, `Spine`, `Spine1`, `Neck`, `Head`,
   `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `RightUpLeg`, `RightLeg`, `RightFoot`,
   `LeftArm`, `LeftForeArm`, `RightArm`, `RightForeArm`

   Optional but recommended: `LeftHand` / `RightHand` (used to aim the forearm). Extra bones
   (`Spine2`, shoulders, fingers, toes) are fine; they just follow their parent.
   Avoid `.` in names (`Hips.L`): three.js strips dots when loading.
3. **Rest pose**: T-pose or A-pose both work; the loader swings limbs down to match the rig.
   Do not leave the armature posed. Use *Pose → Clear Transform → All*.
4. **Weights**: max 4 influences per vertex (*Weight Paint → Weights → Limit Total → 4*, then *Normalize All*).
5. **Budget**: 15k–50k triangles, textures 1024² (2048² max), ~2–8 MB total. Delete hidden
   geometry, apply modifiers, and keep 1–3 materials.

## 2. Export (File → Export → glTF 2.0)

| Panel | Setting |
|---|---|
| Format | **glTF Binary (.glb)** |
| Include | Selected Objects (select the mesh(es) **and** the armature); Limit to Visible |
| Transform | **+Y Up** ✔ |
| Data → Mesh | Apply Modifiers ✔, UVs ✔, Normals ✔, Tangents ✘, Vertex Color ✘ (unless used) |
| Data → Mesh → Compression | Off (see "file size" below for meshopt) |
| Data → Material | Export; Images: **Automatic** (JPEG for color, PNG where alpha is needed) |
| Data → Armature | Export Deform Bones Only ✔ |
| Data → Skinning | ✔ Include skinning (+ Include All Bone Influences ✘) |
| Animation | Off, or keep it: clips are exported but **not played**; POSTURA drives the skeleton itself |

Textures are embedded in the `.glb`, so there are no side files. Save as
`frontend/public/models/avatar.glb`.

## 3. Common issues

- **Model is huge / tiny**: unapplied scale in Blender, or the model is in cm. Apply transforms (step 1).
  The viewer also rescales the model so its hips height matches the rig.
- **Faces away from camera**: it faced +Y in Blender. Rotate 180° around Z, apply, re-export.
- **Console: "missing rig bones"**: bone names differ (check case and the list above). The placeholder is shown.
- **Arms/legs twisted or pointing sideways**: the optional `LeftHand`/`RightHand` bones are missing, or the
  bone's tail doesn't point along the limb. Fix the bone roll/orientation in edit mode.
- **Textures missing / black**: images were not packed (*File → External Data → Pack Resources*) or the
  material uses a Blender-only node (procedural noise, etc.). Bake to an image and use a Principled BSDF.
  Pure metals (Metallic = 1) look dark without environment light; the viewer adds one, but keep Metallic low for skin and cloth.
- **Mesh vanishes when moving**: only if frustum culling is re-enabled; the loader disables it for skinned meshes.
- **File size**: downscale textures first (largest win), then optionally compress:
  `npx gltf-transform optimize avatar.glb avatar.glb --compress meshopt --texture-compress webp`.
  The viewer already registers the meshopt decoder. Draco would need decoder files hosted under `public/`, so prefer meshopt.
- **Loading % stays blank**: the server sent no `Content-Length` (e.g. gzip). The spinner still shows.
