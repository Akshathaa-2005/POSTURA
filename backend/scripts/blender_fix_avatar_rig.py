"""Fixes the POSTURA avatar rig in Blender and exports a clean GLB.

    blender -b assets/avatar/avatar_hood_postura.blend \
        --python backend/scripts/blender_fix_avatar_rig.py -- frontend/public/models/avatar_fixed.glb

What it does (every step is also reported on stdout):
  1. Hands: poses each hand and finger chain straight (hand in line with the forearm, every finger segment in line
     with the one before it), bakes that into the mesh and makes it the armature's rest pose. Palm splay and the
     thumb's root orientation are kept. The viewer never drives hand bones, so the bind pose is the pose.
  2. Weights: smooths hard weight cuts (neighbouring vertices with almost no shared bones) on the body and clothes,
     then limits to 4 influences and normalises. Rest-pose geometry is unchanged. The hood is left alone.
  3. Markers: turns off bone axes and custom bone shapes in the file, and exports only the three meshes and the
     armature, so no helper objects (the importer's "Icosphere" bone shape, lamps, cameras) reach the GLB.
  4. Exports GLB with the settings from docs/blender-export.md.
"""

import sys
from collections import defaultdict

import bmesh
import bpy
from mathutils import Matrix

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else None
SMOOTH_MESHES = ("Avatar_Body", "Avatar_Clothes")  # the hood is a set of intentionally segmented, undriven bones
HARD_EDGE_L1 = 1.2  # weight-vector distance (0 = same, 2 = disjoint) above which an edge counts as a hard cut
SMOOTH_ITERATIONS, SMOOTH_FACTOR, MAX_INFLUENCES = 2, 0.5, 4

arm = bpy.data.objects["Avatar_Rig"]
arm.data.pose_position = "POSE"


def log(msg: str) -> None:
    print(f"[fix_rig] {msg}")


# ---- 1. hands ---------------------------------------------------------------------------------------------------


def _dir(pb):
    return (pb.tail - pb.head).normalized()


def _skip(pb) -> bool:
    return "Palm" in pb.name or pb.name.endswith("Thumb1")  # keep palm splay and the thumb's opposition


def straighten_hand(side: str) -> list[str]:
    hand = arm.pose.bones[f"{side}Hand"]
    chain = [hand]
    queue = list(hand.children)
    while queue:
        chain.append(queue[0])
        queue = queue[1:] + list(queue[0].children)
    done = []
    for pb in chain:
        if pb.parent is None or _skip(pb):
            continue
        delta = _dir(pb).rotation_difference(_dir(pb.parent))
        pivot = pb.head.copy()
        pb.matrix = Matrix.Translation(pivot) @ delta.to_matrix().to_4x4() @ Matrix.Translation(-pivot) @ pb.matrix
        bpy.context.view_layer.update()
        done.append(f"{pb.name} {delta.angle * 57.2958:.0f}deg")
    return done


def bake_pose_into_rest() -> None:
    """Applies the armature modifier on the (single-user, shape-key-free) meshes, then makes the pose the rest pose."""
    posed = [pb.name for pb in arm.pose.bones if pb.matrix_basis != Matrix.Identity(4)]
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]
    for m in meshes:
        weighted = {vg.name for vg in m.vertex_groups}
        if not weighted & set(posed):
            continue  # nothing this mesh is bound to moved, so its shape can't change
        assert m.data.users == 1 and not m.data.shape_keys, f"{m.name}: bake needs single-user data, no shape keys"
        bpy.context.view_layer.objects.active = m
        mod = next(x for x in m.modifiers if x.type == "ARMATURE")
        bpy.ops.object.modifier_apply(modifier=mod.name)
        new = m.modifiers.new("Armature", "ARMATURE")
        new.object = arm
        log(f"baked pose into {m.name}")
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")


# ---- 2. weights -------------------------------------------------------------------------------------------------


def _weights(mesh, v) -> dict[str, float]:
    names = {vg.index: vg.name for vg in mesh.vertex_groups}
    return {names[g.group]: g.weight for g in v.groups if g.weight > 1e-4}


def _l1(a: dict, b: dict) -> float:
    return sum(abs(a.get(k, 0) - b.get(k, 0)) for k in set(a) | set(b))


def smooth_hard_cuts(mesh) -> int:
    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    bm.verts.ensure_lookup_table()
    w = [_weights(mesh, v) for v in mesh.data.vertices]
    nbrs = defaultdict(set)
    seam = set()
    for e in bm.edges:
        i, j = (v.index for v in e.verts)
        nbrs[i].add(j)
        nbrs[j].add(i)
        if _l1(w[i], w[j]) > HARD_EDGE_L1:
            seam |= {i, j}
    targets = set(seam)
    for i in seam:  # one ring around each cut, so the blend has somewhere to go
        targets |= nbrs[i]
    for _ in range(SMOOTH_ITERATIONS):
        nxt = {}
        for i in targets:
            ring = [w[j] for j in nbrs[i]]
            mean = defaultdict(float)
            for r in ring:
                for k, x in r.items():
                    mean[k] += x / len(ring)
            blend = {k: (1 - SMOOTH_FACTOR) * w[i].get(k, 0) + SMOOTH_FACTOR * mean.get(k, 0) for k in set(w[i]) | set(mean)}
            top = sorted(blend.items(), key=lambda kv: -kv[1])[:MAX_INFLUENCES]
            total = sum(x for _, x in top) or 1.0
            nxt[i] = {k: x / total for k, x in top if x / total > 1e-3}
        for i, nw in nxt.items():
            w[i] = nw
    groups = {vg.name: vg for vg in mesh.vertex_groups}
    for i in targets:
        for name, vg in groups.items():
            if name in w[i]:
                vg.add([i], w[i][name], "REPLACE")
            else:
                try:
                    vg.remove([i])
                except RuntimeError:
                    pass
    bm.free()
    return len(seam)


# ---- 3 + 4. markers and export ----------------------------------------------------------------------------------


def hide_markers() -> None:
    arm.data.show_axes = False
    arm.data.show_names = False
    for pb in arm.pose.bones:
        pb.custom_shape = None


def export(path: str) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    keep = [arm] + [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Avatar_")]
    for o in keep:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_skins=True,
        export_def_bones=True,
        export_all_influences=False,
        export_animations=False,
        export_image_format="AUTO",
    )


for side in ("Left", "Right"):
    log(f"{side} hand straightened: " + ", ".join(straighten_hand(side)))
bake_pose_into_rest()
for name in SMOOTH_MESHES:
    log(f"{name}: smoothed around {smooth_hard_cuts(bpy.data.objects[name])} hard-cut vertices")
hide_markers()
if OUT:
    export(OUT)
    log(f"wrote {OUT}")
