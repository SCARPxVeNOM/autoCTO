# Builds the landing arena's 3D assets in Blender and exports them as one GLB.
#   blender -b --factory-startup -P scripts/arena-assets.py -- frontend/src/assets/arena.glb [preview.png]
# Everything is made from code, so the file can be rebuilt: a coin (face, raised rim, reeded edge), a brain,
# and the field pieces the arena lights up (lock field, reticle, vote gauge, approval mark, padlock).
# Shapes are modelled in glTF's frame (Y up, the coin's face toward +Z); P() turns that into Blender's.
import math
import sys

import bmesh
import bpy
from mathutils import Vector, noise

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "arena.glb"
PREVIEW = argv[1] if len(argv) > 1 else None


def P(x, y, z):
    """glTF (x, y up, z toward the viewer) to Blender (x, y, z up)."""
    return (x, -z, y)


def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def mesh_object(name, verts, faces, coll, uvs=None, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([P(*v) for v in verts], [], faces)
    if uvs:
        layer = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li in poly.loop_indices:
                layer.data[li].uv = uvs[me.loops[li].vertex_index]
    for poly in me.polygons:
        poly.use_smooth = smooth
    me.validate()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def revolve(rows, segs, radius_at=None, flip=False):
    """A band swept round the Z axis through (r, z) rows. radius_at(r, theta) can carve the radius."""
    verts, faces = [], []
    for r, z in rows:
        for s in range(segs):
            a = 2 * math.pi * s / segs
            rr = radius_at(r, a) if radius_at else r
            verts.append((rr * math.cos(a), rr * math.sin(a), z))
    for i in range(len(rows) - 1):
        for s in range(segs):
            a, b = i * segs + s, i * segs + (s + 1) % segs
            c, d = b + segs, a + segs
            faces.append((a, d, c, b) if flip else (a, b, c, d))
    return verts, faces


def mirrored(rows):
    return [(r, -z) for r, z in reversed(rows)]


# ---------- the coin: radius 1, faces at z = +-0.06, a raised rim, a reeded edge ----------
FACE_R, FACE_Z = 0.80, 0.060
REEDS, REED_SEGS, REED_DEPTH = 120, 6, 0.011


def coin(coll):
    # The face: a disc of rings, its picture mapped across it. The back mirrors the picture so it reads right
    # from behind.
    segs, rings = 128, [0.2, 0.4, 0.6, 0.8]
    verts, faces, uvs = [], [], []
    for side in (1, -1):
        base = len(verts)
        verts.append((0, 0, side * FACE_Z))
        uvs.append((0.5, 0.5))
        for r in rings:
            for s in range(segs):
                a = 2 * math.pi * s / segs
                x, y = FACE_R * r / 0.8 * math.cos(a), FACE_R * r / 0.8 * math.sin(a)
                verts.append((x, y, side * FACE_Z))
                uvs.append((0.5 + side * x / (2 * FACE_R), 0.5 + y / (2 * FACE_R)))
        for s in range(segs):
            a, b = base + 1 + s, base + 1 + (s + 1) % segs
            faces.append((base, a, b) if side > 0 else (base, b, a))
        for i in range(len(rings) - 1):
            for s in range(segs):
                a = base + 1 + i * segs + s
                b = base + 1 + i * segs + (s + 1) % segs
                c, d = b + segs, a + segs
                faces.append((a, d, c, b) if side > 0 else (a, b, c, d))
    face = mesh_object("coin_face", verts, faces, coll, uvs)

    # The rim: an inner wall, a flat top and an outer bevel, as separate bands so each crease stays sharp.
    bands = [
        [(0.800, 0.060), (0.806, 0.078), (0.818, 0.090), (0.836, 0.096)],
        [(0.836, 0.096), (0.952, 0.096)],
        [(0.952, 0.096), (0.976, 0.091), (0.993, 0.080), (1.000, 0.066)],
    ]
    verts, faces = [], []
    for band in bands:
        for rows, flip in ((band, True), (mirrored(band), True)):
            v, f = revolve(rows, 240, flip=flip)
            off = len(verts)
            verts += v
            faces += [tuple(i + off for i in q) for q in f]
    rim = mesh_object("coin_rim", verts, faces, coll)

    # The edge: vertical reeds cut into the side.
    def reed(r, a):
        u = (a * REEDS / (2 * math.pi)) % 1
        return r - REED_DEPTH * (0.5 - 0.5 * math.cos(2 * math.pi * u)) ** 1.5

    v, f = revolve([(1.0, 0.066), (1.0, -0.066)], REEDS * REED_SEGS, reed, flip=True)
    edge = mesh_object("coin_edge", v, f, coll)

    root = bpy.data.objects.new("coin", None)
    coll.objects.link(root)
    for ob in (face, rim, edge):
        ob.parent = root
    return root


# ---------- the brain: two folded hemispheres, a cerebellum and a stem, about 1.6 long, front toward +X ----------
def groove_to(q, a, b):
    """Distance in XY from q to the segment a-b."""
    ab, aq = b - a, Vector((q.x, q.y)) - a
    t = max(0.0, min(1.0, aq.dot(ab) / ab.dot(ab)))
    return (aq - ab * t).length


def brain(coll, decimate=0.2):
    def lobe(name, shape, sub=6):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        for v in bm.verts:
            v.co = Vector(P(*shape(Vector((v.co.x, v.co.z, -v.co.y)))))
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for poly in me.polygons:
            poly.use_smooth = True
        ob = bpy.data.objects.new(name, me)
        coll.objects.link(ob)
        return ob

    def bump(x, y, cx, cy, sx, sy):
        return math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2))

    def hemisphere(side):
        def shape(p):
            q = Vector((p.x * 0.80, p.y * 0.56, p.z * 0.37))
            if q.z * side < 0:
                q.z *= 0.18  # the flat inner side, along the fissure between the halves
            # the profile: a dome a little higher toward the back, a rounder front, a flatter floor
            q.y += 0.05 * bump(q.x, q.y, -0.15, 0.5, 0.5, 0.3)
            if q.y < -0.16:
                q.y = -0.16 + (q.y + 0.16) * 0.6
            # room under the back for the cerebellum, and the temporal lobe hanging low at the front-side
            q.y += 0.15 * bump(q.x, q.y, -0.55, -0.32, 0.3, 0.2)
            q.y -= 0.10 * bump(q.x, q.y, 0.18, -0.24, 0.32, 0.14)
            lateral = max(0.0, q.z * side / 0.37)
            n = q.copy()
            q.z += side * (0.375 + 0.03 * bump(q.x, q.y, 0.15, -0.2, 0.35, 0.18) * lateral)
            c = Vector((0, 0.0, side * 0.375))
            out = (q - c)
            out = Vector((out.x / 0.80 ** 2, out.y / 0.56 ** 2, out.z / 0.37 ** 2)).normalized()
            # the two big fissures on the side: the lateral one above the temporal lobe, the central one over the top
            fissures = 0.075 * math.exp(-((groove_to(n, Vector((0.48, -0.12)), Vector((-0.22, 0.10))) / 0.03) ** 2)) * lateral
            fissures += 0.05 * math.exp(-((groove_to(n, Vector((0.12, 0.58)), Vector((0.24, 0.02))) / 0.025) ** 2)) * lateral ** 0.5
            # folds: narrow grooves where noise fields cross zero, rounded ridges between
            k = n * 4.4 + Vector((side * 7.3, 1.7, 0.4))
            n1 = noise.noise(k)
            n2 = noise.noise(n * 6.0 + Vector((3.1, side * 5.9, 2.2)))
            folds = 0.06 * math.exp(-((n1 / 0.12) ** 2)) + 0.025 * math.exp(-((n2 / 0.12) ** 2))
            return q + out * (0.01 * (1 - abs(n1)) - folds - fissures)

        return shape

    left = lobe("brain_left", hemisphere(-1))
    right = lobe("brain_right", hemisphere(1))

    def cerebellum(p):
        q = Vector((p.x * 0.28, p.y * 0.2, p.z * 0.40))
        q += Vector((-0.50, -0.36, 0))
        q.z *= 1 - 0.25 * math.exp(-((q.z / 0.06) ** 2))  # a dip between its two halves
        folia = 0.5 + 0.5 * math.sin((q.y + 0.08 * q.x) * 120 + 2.5 * noise.noise(q * 5))
        out = (q - Vector((-0.50, -0.36, 0))).normalized()
        return q - out * 0.014 * folia

    cb = lobe("brain_cerebellum", cerebellum, sub=4)

    def stem(p):
        h = (p.y + 1) / 2  # 0 at the bottom, 1 at the top
        r = 0.10 + 0.03 * h
        return Vector((p.x * r - 0.24 + 0.1 * h, -0.70 + 0.45 * h, p.z * r))

    st = lobe("brain_stem", stem, sub=3)

    for ob in (left, right, cb, st):
        ob.select_set(True)
    bpy.context.view_layer.objects.active = left
    bpy.ops.object.join()
    left.name = left.data.name = "brain"
    mod = left.modifiers.new("decimate", "DECIMATE")
    mod.ratio = decimate
    bpy.ops.object.modifier_apply(modifier=mod.name)
    # Relax the triangles the decimation leaves, without losing the folds.
    mod = left.modifiers.new("relax", "SMOOTH")
    mod.factor, mod.iterations = 0.5, 2
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    return left


# ---------- flat pieces of light, in the XY plane, facing +Z. u runs round the circle, v across it ----------
def arcs(pieces, segs_per_turn=256):
    """pieces: (r0, r1, a0, a1) annulus sectors, angles in turns from the top, clockwise."""
    verts, faces, uvs = [], [], []
    for r0, r1, a0, a1 in pieces:
        n = max(2, int(abs(a1 - a0) * segs_per_turn) + 1)
        base = len(verts)
        for i in range(n):
            u = a0 + (a1 - a0) * i / (n - 1)
            a = math.pi / 2 - 2 * math.pi * u
            for j, r in enumerate((r0, r1)):
                verts.append((r * math.cos(a), r * math.sin(a), 0))
                uvs.append((u % 1 if u < 1 else 1.0, j))
        for i in range(n - 1):
            a, b = base + 2 * i, base + 2 * i + 2
            faces.append((a, b, b + 1, a + 1))
    return verts, faces, uvs


def flat(name, pieces, coll):
    v, f, uv = arcs(pieces)
    return mesh_object(name, v, f, coll, uv, smooth=False)


def ticks(r0, r1, n, width, long_every=0, r1_long=None):
    out = []
    for i in range(n):
        c = i / n
        rr = r1_long if long_every and i % long_every == 0 else r1
        out.append((r0, rr, c - width / 2, c + width / 2))
    return out


def fields(coll):
    # The lock field: 18 plates with gaps, a fine inner line and a ring of ticks.
    plates = [(1.0, 1.055, i / 18 + 0.006, (i + 1) / 18 - 0.006) for i in range(18)]
    flat("lock_field", plates + [(0.955, 0.962, 0, 1)] + ticks(1.085, 1.11, 72, 0.0018, 6, 1.135), coll)
    # The reticle: four brackets, four pointers and a dashed inner line.
    brackets = [(1.0, 1.045, q / 4 + 0.125 - 0.07, q / 4 + 0.125 + 0.07) for q in range(4)]
    pointers = [(1.06, 1.16, q / 4 - 0.004, q / 4 + 0.004) for q in range(4)]
    dashes = [(0.90, 0.907, i / 48, i / 48 + 0.012) for i in range(48)]
    flat("reticle", brackets + pointers + dashes, coll)
    # The vote gauge: a track that a shader fills, with ticks every tenth.
    flat("gauge", [(1.0, 1.075, 0, 1)], coll)
    flat("gauge_ticks", ticks(1.09, 1.12, 40, 0.0022, 4, 1.15), coll)
    # Scan rings and a soft disc for pulses.
    flat("ring_thin", [(0.985, 1.0, 0, 1)], coll)
    approval(coll)
    padlock(coll)


def approval(coll):
    ring_v, ring_f, ring_uv = arcs([(0.9, 0.98, 0, 1)])
    # The tick: a thick check stroke, extruded so it has a little depth.
    pts = [(-0.42, 0.02), (-0.14, -0.27), (0.44, 0.33), (0.33, 0.44), (-0.14, -0.05), (-0.31, 0.13)]
    bm = bmesh.new()
    vs = [bm.verts.new(P(x, y, -0.03)) for x, y in pts]
    face = bm.faces.new(vs)
    ex = bmesh.ops.extrude_face_region(bm, geom=[face])
    bmesh.ops.translate(bm, vec=Vector(P(0, 0, 0.06)), verts=[e for e in ex["geom"] if isinstance(e, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("approval_tick")
    bm.to_mesh(me)
    bm.free()
    tick = bpy.data.objects.new("approval_tick", me)
    coll.objects.link(tick)
    ring = mesh_object("approval_ring", ring_v, ring_f, coll, ring_uv, smooth=False)
    root = bpy.data.objects.new("approval", None)
    coll.objects.link(root)
    tick.parent = ring.parent = root


def padlock(coll):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(P(0.56, 0.44, 0.2)), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(P(0, -0.12, 0)), verts=bm.verts)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.05, segments=4, affect="EDGES")
    me = bpy.data.meshes.new("padlock_body")
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    body = bpy.data.objects.new("padlock_body", me)
    coll.objects.link(body)
    # The shackle: half a torus on two short legs.
    bm = bmesh.new()
    R, r, segs, ring = 0.17, 0.042, 32, 12
    rows = []
    path = [(-R, 0.10 - 0.12 * (1 - t)) for t in (0, 1)] + [
        (-R * math.cos(math.pi * i / segs), 0.10 + R * math.sin(math.pi * i / segs)) for i in range(1, segs)
    ] + [(R, 0.10 - 0.12 * t) for t in (0, 1)]
    for k, (x, y) in enumerate(path):
        nx, ny = (x, y - 0.10) if 1 < k < len(path) - 2 else (1 if x > 0 else -1, 0)
        ln = math.hypot(nx, ny) or 1
        nx, ny = nx / ln, ny / ln
        row = []
        for j in range(ring):
            a = 2 * math.pi * j / ring
            row.append(bm.verts.new(P(x + nx * r * math.cos(a), y + ny * r * math.cos(a), r * math.sin(a))))
        rows.append(row)
    for a_row, b_row in zip(rows, rows[1:]):
        for j in range(ring):
            bm.faces.new((a_row[j], a_row[(j + 1) % ring], b_row[(j + 1) % ring], b_row[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("padlock_shackle")
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    shackle = bpy.data.objects.new("padlock_shackle", me)
    coll.objects.link(shackle)
    root = bpy.data.objects.new("padlock", None)
    coll.objects.link(root)
    body.parent = shackle.parent = root


# ---------- build, export, and optionally render a contact sheet ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
coins, brains, field = collection("Coin"), collection("Brain"), collection("Fields")
coin(coins)
brain(brains)
fields(field)

bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", export_materials="NONE", export_texcoords=True, export_normals=True,
    export_yup=True, export_apply=True, export_cameras=False, export_lights=False,
)
print("wrote", OUT)

if PREVIEW:
    # Lay the pieces out side by side and render them, to look at the shapes.
    scene = bpy.context.scene
    close = len(argv) > 2 and argv[2] == "brain"
    layout = {"coin": (-3.2, 0.4, 0), "brain": (0, 0.5, 0) if not close else (0, 0.35, 7.6), "lock_field": (3.0, 0.9, 0),
              "reticle": (3.0, -1.6, 0), "approval": (0, -1.8, 0), "padlock": (-1.4, -1.8, 0), "gauge": (-3.4, -2.0, 0),
              "gauge_ticks": (-3.4, -2.0, 0), "ring_thin": (3.0, -1.6, 0)}
    for name, at in layout.items():
        ob = bpy.data.objects[name]
        ob.location = Vector(P(*at))
    bpy.data.objects["coin"].rotation_euler = (0, 0, math.radians(28))
    bpy.data.objects["brain"].rotation_euler = (math.radians(-14), 0, math.radians(-20))
    mat = bpy.data.materials.new("clay")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.8
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.3
    for ob in scene.objects:
        if ob.type == "MESH":
            ob.data.materials.append(mat)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.location = P(0, 0.4, 11)
    cam.rotation_euler = (math.radians(90), 0, 0)
    cam.data.lens = 40
    scene.camera = cam
    for at, power in (((4, 6, 8), 1500), ((-6, 2, 4), 600), ((0, 4, -6), 900)):
        light = bpy.data.objects.new("l", bpy.data.lights.new("l", "AREA"))
        light.data.energy, light.data.size = power, 4
        light.location = P(*at)
        light.rotation_euler = (Vector(P(0, 0, 0)) - Vector(P(*at))).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(light)
    scene.world = bpy.data.worlds.new("w")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.02, 0.022, 0.026, 1)
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "CYCLES"
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print("rendered", PREVIEW)
