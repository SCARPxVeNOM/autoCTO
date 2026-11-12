# Renders the landing headline and the wordmark as 3D lettering: one WebP per layout and theme.
# Each glyph is read straight from the site's font file and put where the browser puts it, so the
# shapes, kerning, letter spacing and line breaks are the page's own (see lettering.json).
#   blender -b -P scripts/lettering.py -- <fonts dir> scripts/lettering.json frontend/src/assets [art ...]
#
# The fonts dir holds the Google Fonts files InstrumentSerif-Italic.ttf and PixelifySans-SemiBold.ttf,
# and Bricolage Grotesque cut at the optical size the page draws it at (84px), from the variable font
# in github.com/google/fonts (fontTools 4.68; rename the output to BricolageGrotesque-Bold-opsz84.ttf):
#   fonttools varLib.instancer BricolageGrotesque[opsz,wdth,wght].ttf opsz=84 wght=700 wdth=drop
#
# lettering.json holds, per piece of art: the CSS box it replaces (px at font size `em`), the render
# scale, and each glyph as [char, font, size px, colour, pen x, baseline y] measured in Chrome with
# Range.getClientRects() per character; baselines from a zero-size inline-block (vertical-align: baseline).
import json, math, struct, sys
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector

# depth and bevel in em; the bevel is offset inward, so the outline stays the font's own
DEPTH, BEVEL = 0.04, {"display": 0.012, "serif": 0.006, "pixel": 0.018}
SHEEN = 0.1  # how much darker a letter's foot is than its top, in linear light
LIGHT = Vector((-0.35, 0.6, 1)).normalized()  # toward the key light: top left, in front
RIM = 0.45  # a bevel facing the key is this much lighter, one facing away this much darker
GLOSS = 1.6  # the strip of sky the bevels reflect overhead
SHADOW = 0.22  # opacity of the shadow where the key is fully blocked
GAP = 0.08  # em between the letters' back and the surface they shadow
MARGIN = 0.16  # em of clear space around the ink, for the shadow


class Font:
    """Just enough of a TrueType file to get glyph outlines: cmap (format 4), loca and glyf."""

    def __init__(self, path):
        d = self.d = Path(path).read_bytes()
        n = self.u16(4)
        self.t = {d[12 + 16 * i:16 + 16 * i].decode("latin1"): self.u32(20 + 16 * i) for i in range(n)}
        self.upm = self.u16(self.t["head"] + 18)
        self.long_loca = self.i16(self.t["head"] + 50)
        self.cmap = self.read_cmap()

    def u16(self, o): return struct.unpack_from(">H", self.d, o)[0]
    def i16(self, o): return struct.unpack_from(">h", self.d, o)[0]
    def u32(self, o): return struct.unpack_from(">I", self.d, o)[0]

    def read_cmap(self):
        c, out = self.t["cmap"], {}
        for i in range(self.u16(c + 2)):
            pid, _, off = struct.unpack_from(">HHI", self.d, c + 4 + 8 * i)
            o = c + off
            if self.u16(o) != 4 or pid not in (0, 3):
                continue
            n = self.u16(o + 6) // 2
            ends, starts = o + 14, o + 16 + 2 * n
            deltas, ranges = starts + 2 * n, starts + 4 * n
            for k in range(n):
                s, e, dl, ro = self.u16(starts + 2 * k), self.u16(ends + 2 * k), self.i16(deltas + 2 * k), self.u16(ranges + 2 * k)
                for ch in range(s, min(e, 0x2FF) + 1):
                    g = 1 if ro == 0 else self.u16(ranges + 2 * k + ro + 2 * (ch - s))
                    out[chr(ch)] = ((ch if ro == 0 else g) + dl) & 0xFFFF if g else 0
        return out

    def glyf(self, g):
        l = self.t["loca"]
        a, b = (self.u32(l + 4 * g), self.u32(l + 4 * g + 4)) if self.long_loca else (2 * self.u16(l + 2 * g), 2 * self.u16(l + 2 * g + 2))
        return self.t["glyf"] + a, b - a

    def contours(self, g, m=(1, 0, 0, 1, 0, 0)):
        """The glyph's contours as lists of (x, y, on_curve), in font units, with composites resolved."""
        o, size = self.glyf(g)
        if not size:
            return []
        n = self.i16(o)
        if n < 0:  # composite
            out, p = [], o + 10
            while True:
                flags, sub = self.u16(p), self.u16(p + 2)
                p += 4
                if flags & 1:
                    dx, dy = struct.unpack_from(">hh", self.d, p); p += 4
                else:
                    dx, dy = struct.unpack_from(">bb", self.d, p); p += 2
                a, b, c, d = 1, 0, 0, 1
                if flags & 8:
                    a = d = self.i16(p) / 16384; p += 2
                elif flags & 0x40:
                    a, d = self.i16(p) / 16384, self.i16(p + 2) / 16384; p += 4
                elif flags & 0x80:
                    a, b, c, d = (self.i16(p + 2 * k) / 16384 for k in range(4)); p += 8
                # child transform, then this one (offsets are x/y values; point matching isn't used here)
                ma, mb, mc, md, me, mf = m
                child = (a * ma + b * mc, a * mb + b * md, c * ma + d * mc, c * mb + d * md, dx * ma + dy * mc + me, dx * mb + dy * md + mf)
                out += self.contours(sub, child)
                if not flags & 0x20:
                    return out
        ends = [self.u16(o + 10 + 2 * k) for k in range(n)]
        npts = ends[-1] + 1 if ends else 0
        p = o + 10 + 2 * n
        p += 2 + self.u16(p)
        flags = []
        while len(flags) < npts:
            f = self.d[p]; p += 1
            flags.append(f)
            if f & 8:
                flags += [f] * self.d[p]; p += 1
        coords = []
        for short, same in ((2, 16), (4, 32)):
            v, vals = 0, []
            for f in flags:
                if f & short:
                    dv = self.d[p]; p += 1
                    v += dv if f & same else -dv
                elif not f & same:
                    v += self.i16(p); p += 2
                vals.append(v)
            coords.append(vals)
        ma, mb, mc, md, me, mf = m
        pts = [(x * ma + y * mc + me, x * mb + y * md + mf, bool(f & 1)) for x, y, f in zip(*coords, flags)]
        return [pts[s:e + 1] for s, e in zip([0] + [e + 1 for e in ends], ends)]


def flatten(contour, steps=16):
    """A quadratic TrueType contour as a closed polyline, `steps` points per curve."""
    pts = []
    for i, (x, y, on) in enumerate(contour):  # put the implied on-curve points back between two off-curve ones
        px, py, pon = contour[i - 1]
        if not on and not pon:
            pts.append(((x + px) / 2, (y + py) / 2, True))
        pts.append((x, y, on))
    while not pts[0][2]:
        pts.append(pts.pop(0))
    out, n = [], len(pts)
    for i, (x, y, on) in enumerate(pts):
        if not on:
            continue
        out.append((x, y))
        c = pts[(i + 1) % n]
        if not c[2]:
            e = pts[(i + 2) % n]
            out += [((1 - t) ** 2 * x + 2 * t * (1 - t) * c[0] + t * t * e[0], (1 - t) ** 2 * y + 2 * t * (1 - t) * c[1] + t * t * e[1])
                    for t in (k / steps for k in range(1, steps))]
    return out


def crossing(poly):
    """The first place a closed polyline crosses itself: (i, j, point) for segments i and j > i."""
    p = np.array(poly)
    q = np.roll(p, -1, axis=0)
    d = q - p
    n = len(p)
    for i in range(n - 2):
        js = np.arange(i + 2, n if i else n - 1)
        r, s = d[i], d[js]
        den = r[0] * s[:, 1] - r[1] * s[:, 0]
        w = p[js] - p[i]
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (w[:, 0] * s[:, 1] - w[:, 1] * s[:, 0]) / den
            u = (w[:, 0] * r[1] - w[:, 1] * r[0]) / den
        hit = np.nonzero((den != 0) & (t > 0) & (t < 1) & (u > 0) & (u < 1))[0]
        if len(hit):
            j = js[hit[0]]
            return i, j, tuple(p[i] + t[hit[0]] * r)
    return None


def simple(poly):
    """A self-crossing loop cut at its crossings into simple loops. Filled by the nonzero rule, as
    fonts are, the pieces add up to the same shape; one even-odd fill would punch holes instead."""
    x = crossing(poly)
    if not x:
        return [poly]
    i, j, pt = x
    return simple([pt] + poly[i + 1:j + 1]) + simple(poly[j + 1:] + poly[:i + 1] + [pt])


def area(c):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(c, c[1:] + c[:1])) / 2


def inside(p, c):
    x, y, n = p[0], p[1], False
    for (x0, y0), (x1, y1) in zip(c, c[1:] + c[:1]):
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            n = not n
    return n


def islands(contours):
    """The glyph as islands: each outer loop with the holes it holds. Variable-font masters keep their
    overlaps (the bar of an e crosses its bowl); islands whose fronts are coplanar add up to the union."""
    loops = [l for c in contours for l in simple(flatten(c)) if abs(area(l)) > 1]
    if not loops:
        return []
    sign = math.copysign(1, area(max(loops, key=lambda l: abs(area(l)))))
    groups = [[l] for l in loops if area(l) * sign > 0]
    for h in (l for l in loops if area(l) * sign < 0):
        home = [g for g in groups if inside(h[len(h) // 2], g[0])]
        if home:
            min(home, key=lambda g: abs(area(g[0]))).append(h)
        else:  # a lobe wound the other way is still ink under the nonzero rule
            groups.append([h[::-1]])
    return groups


def srgb_to_linear(hex_):
    c = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c] + [1]


def material(name, rgba):
    """Front faces glow in the exact CSS colour, a touch darker toward the foot. The bevel takes the
    same colour, lighter where it turns to the key and darker where it turns away, plus a gloss."""
    m = bpy.data.materials.new(name)
    if m.node_tree is None:  # Blender 4; 5 always has one
        m.use_nodes = True
    nt = m.node_tree
    N = nt.nodes
    for n in list(N):
        N.remove(n)
    link = nt.links.new

    def node(kind, *inputs, **props):
        n = N.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        for i, v in enumerate(inputs):
            if v is not None:
                (link(v, n.inputs[i]) if hasattr(v, "links") else setattr(n.inputs[i], "default_value", v))
        return n

    geo = N.new("ShaderNodeNewGeometry")
    normal = geo.outputs["True Normal"]
    nz = node("ShaderNodeSeparateXYZ", normal).outputs["Z"]
    front = node("ShaderNodeMapRange", nz, 0.985, 0.999, 0, 1).outputs[0]
    # sheen: 0 at the baseline, 1 at cap height (per-object "base" and "cap", in world y)
    y = node("ShaderNodeSeparateXYZ", geo.outputs["Position"]).outputs["Y"]
    base = node("ShaderNodeAttribute", attribute_type="OBJECT", attribute_name="base").outputs["Fac"]
    cap = node("ShaderNodeAttribute", attribute_type="OBJECT", attribute_name="cap").outputs["Fac"]
    t = node("ShaderNodeMath", node("ShaderNodeMath", y, base, operation="SUBTRACT").outputs[0], cap, operation="DIVIDE", use_clamp=True).outputs[0]
    sheen = node("ShaderNodeMapRange", t, 0, 1, 1 - SHEEN, 1).outputs[0]
    # rim: by how far the bevel turns toward the key, in the picture plane (0 for a face toward us)
    turn = node("ShaderNodeVectorMath", normal, Vector((LIGHT.x, LIGHT.y, 0)).normalized(), operation="DOT_PRODUCT").outputs["Value"]
    rim = node("ShaderNodeMapRange", turn, -1, 1, 1 - RIM, 1 + RIM).outputs[0]
    flat = node("ShaderNodeMix", data_type="FLOAT")  # rim on the bevel, none on the front
    link(front, flat.inputs["Factor"]); link(rim, flat.inputs["A"]); flat.inputs["B"].default_value = 1
    lit = node("ShaderNodeMath", sheen, flat.outputs[0], operation="MULTIPLY").outputs[0]
    col = node("ShaderNodeMix", data_type="RGBA", blend_type="MULTIPLY")
    col.inputs["Factor"].default_value, col.inputs["A"].default_value = 1, rgba
    link(node("ShaderNodeCombineXYZ", lit, lit, lit).outputs[0], col.inputs["B"])
    emit = node("ShaderNodeEmission", col.outputs["Result"])
    gloss = N.new("ShaderNodeBsdfPrincipled")
    gloss.inputs["Base Color"].default_value, gloss.inputs["Roughness"].default_value = (0, 0, 0, 1), 0.3
    bevel = node("ShaderNodeAddShader", emit.outputs[0], gloss.outputs[0])
    mix = node("ShaderNodeMixShader", front, bevel.outputs[0], emit.outputs[0])
    link(mix.outputs[0], node("ShaderNodeOutputMaterial").inputs["Surface"])
    return m


def stage(scene, frame, em, back):
    """Orthographic camera square on to the frame; a strip of sky overhead that only reflections see;
    a big soft key light that casts the shadow; and a shadow catcher behind the letters, with a fill
    light of its own so the shadow is only SHADOW deep."""
    fx0, fy0, fw, fh = frame
    centre = Vector((fx0 + fw / 2, -(fy0 + fh / 2), 0))
    cam = bpy.data.cameras.new("cam")
    cam.type, cam.sensor_fit, cam.ortho_scale = "ORTHO", "HORIZONTAL", fw
    cam.clip_start, cam.clip_end = 1, 100 * em
    co = bpy.data.objects.new("cam", cam)
    co.location = centre + Vector((0, 0, 50 * em))
    scene.collection.objects.link(co)
    scene.camera = co
    w = bpy.data.worlds.new("sky")
    scene.world = w
    if w.node_tree is None:
        w.use_nodes = True
    N, link = w.node_tree.nodes, w.node_tree.links.new
    up = N.new("ShaderNodeSeparateXYZ"); link(N.new("ShaderNodeTexCoord").outputs["Generated"], up.inputs[0])
    strip = N.new("ShaderNodeMapRange"); strip.interpolation_type = "SMOOTHSTEP"
    link(up.outputs["Y"], strip.inputs["Value"])
    strip.inputs["From Min"].default_value, strip.inputs["From Max"].default_value, strip.inputs["To Max"].default_value = 0.3, 0.9, GLOSS
    only = N.new("ShaderNodeMath"); only.operation = "MULTIPLY"
    link(strip.outputs[0], only.inputs[0]); link(N.new("ShaderNodeLightPath").outputs["Is Glossy Ray"], only.inputs[1])
    link(only.outputs[0], N["Background"].inputs["Strength"])
    catcher = bpy.data.collections.new("catcher")
    me = bpy.data.meshes.new("catcher")
    x0, x1, y0, y1 = fx0 - 4 * em, fx0 + fw + 4 * em, -fy0 + 4 * em, -fy0 - fh - 4 * em
    me.from_pydata([(x0, y0, back), (x1, y0, back), (x1, y1, back), (x0, y1, back)], [], [(0, 1, 2, 3)])
    po = bpy.data.objects.new("catcher", me)
    po.is_shadow_catcher, po.visible_diffuse, po.visible_glossy = True, False, False
    scene.collection.objects.link(po)
    catcher.objects.link(po)
    # power for a given irradiance on the catcher: a disk of radius r at distance d, at an angle
    d = 12 * em
    for name, aim, r, irr, shadow in (("key", LIGHT, d / 2, 1, True), ("fill", Vector((0, 0, 1)), d, 1 / SHADOW - 1, False)):
        light = bpy.data.lights.new(name, "AREA")
        light.shape, light.size, light.use_shadow = "DISK", 2 * r, shadow
        light.energy = irr * math.pi * (r * r + d * d) / aim.z
        lo = bpy.data.objects.new(name, light)
        lo.location = centre + aim * d
        lo.rotation_euler = aim.to_track_quat("Z", "Y").to_euler()
        if not shadow:
            lo.light_linking.receiver_collection = catcher
        scene.collection.objects.link(lo)


def build(art, fonts, mats):
    """One curve object per glyph, at its measured pen position and baseline (CSS px, y flipped)."""
    shapes, em = {}, art["em"]
    for ch, font, size, colour, x, base in art["glyphs"]:
        f = fonts[font]
        key = (font, ch, size)
        if key not in shapes:
            k, b = size / f.upm, BEVEL[font] * size
            shapes[key] = []
            for i, island in enumerate(islands(f.contours(f.cmap[ch]))):
                cu = bpy.data.curves.new(f"{font}-{ch}-{size}-{i}", "CURVE")
                cu.dimensions, cu.fill_mode = "2D", "BOTH"
                for loop in island:
                    sp = cu.splines.new("POLY")
                    sp.points.add(len(loop) - 1)
                    sp.use_cyclic_u = True
                    sp.points.foreach_set("co", [v for px, py in loop for v in (px * k, py * k, 0, 1)])
                cu.extrude, cu.bevel_depth, cu.bevel_resolution, cu.offset = DEPTH * em / 2 - b, b, 3, -b
                cu.materials.append(mats[colour])
                shapes[key].append(cu)
        for cu in shapes[key]:
            ob = bpy.data.objects.new(f"{ch}@{x}", cu)
            ob.location = (x, -base, 0)
            ob["base"], ob["cap"] = -base, 0.7 * size
            bpy.context.scene.collection.objects.link(ob)


def ink(fonts, art):
    """The glyphs' outline bounds in CSS px (x right, y down)."""
    xs, ys = [], []
    for ch, font, size, _, x, base in art["glyphs"]:
        f, k = fonts[font], size / fonts[font].upm
        for c in f.contours(f.cmap[ch]):
            for px, py, _ in c:
                xs.append(x + px * k); ys.append(base - py * k)
    return min(xs), min(ys), max(xs), max(ys)


def gpu():
    """Turn on whatever GPU Cycles can use here; False if there is none."""
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        devices = [d for d in prefs.devices if d.type == kind]
        for d in devices:
            d.use = True
        if devices:
            return True
    return False


def render(name, art, fonts, themes, out_dir):
    s, em = art["scale"], art["em"]
    bw, bh = art["box"]
    x0, y0, x1, y1 = ink(fonts, art)
    pad = MARGIN * em
    # the frame: the CSS box and the ink plus a margin, snapped to whole output pixels from the box's corner
    fx0 = math.floor(min(0, x0 - pad) * s) / s
    fy0 = math.floor(min(0, y0 - pad) * s) / s
    W, H = math.ceil((max(bw, x1 + pad) - fx0) * s), math.ceil((max(bh, y1 + pad) - fy0) * s)
    fw, fh = W / s, H / s
    print(f"{name}: {W}x{H}; img left {fx0 / bw:.4%} top {fy0 / bh:.4%} width {fw / bw:.4%} height {fh / bh:.4%}")
    for theme, colours in themes.items():
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        mats = {k: material(f"{theme}-{k}", srgb_to_linear(v)) for k, v in colours.items()}
        build(art, fonts, mats)
        stage(scene, (fx0, fy0, fw, fh), em, -(DEPTH / 2 + GAP) * em)
        r = scene.render
        r.engine, r.film_transparent = "CYCLES", True
        scene.cycles.device = "GPU" if gpu() else "CPU"
        r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
        scene.cycles.samples, scene.cycles.use_denoising = 1024, False
        scene.cycles.pixel_filter_type, scene.cycles.filter_width = "BOX", 1.0
        scene.view_settings.view_transform, scene.view_settings.look = "Standard", "None"
        im = r.image_settings
        im.file_format, im.color_mode, im.quality = "WEBP", "RGBA", 90
        r.filepath = str(Path(out_dir) / f"{name}-{theme}.webp")
        bpy.ops.render.render(write_still=True)


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    fonts_dir, layout, out_dir, only = args[0], json.loads(Path(args[1]).read_text()), args[2], args[3:]
    fonts = {k: Font(Path(fonts_dir) / v) for k, v in layout["fonts"].items()}
    for name, art in layout["art"].items():
        if not only or name in only:
            render(name, art, fonts, layout["themes"], out_dir)


if __name__ == "__main__":
    main()
