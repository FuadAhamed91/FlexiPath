"""
FlexiPath — procedural asset generator (Blender 4.x / 5.x, pure bpy + bmesh).

Creates, materials and exports the six glTF-binary assets used by the digital twin:

    flexipath_drone.glb     X-frame quadcopter · carbon hull · glowing cyan canopy + prop guards · AntennaAnchor
    legacy_drone.glb        identical airframe tinted crimson / burgundy
    wired_node.glb          pedestal charging / docking dock with emissive slate terminal ring
    wifi_node.glb           utility pole + dual-antenna Wi-Fi 6 access box (neon cyan)
    5g_tower.glb            hexagonal lattice tower + three angled panel antennas (emerald)
    leo_satellite.glb       CubeSat · gold-foil core · twin PV wings · downward transponder dish (amber)

Usage
    blender -b -P blender/generate_all_models.py                            # → public/models/
    blender -b -P blender/generate_all_models.py -- --out D:/some/dir       # custom output
    blender -b -P blender/generate_all_models.py -- --showcase             # also lay them out in a scene
    # Blender MCP / Text Editor inside a running session:
    #   import runpy; runpy.run_path(r".../blender/generate_all_models.py", run_name="__main__")

Safety: every asset is built in its own temporary scene and all of its datablocks are removed
after export, so running this inside an open Blender session never touches the user's scenes.

Conventions (Blender Z-up → glTF Y-up is handled by the exporter)
    drones face +X · rotors are empties named Rotor_FL/FR/RL/RR (spin about the vertical axis)
    antenna tip empty: AntennaAnchor · node beam attach point empty: BeamAnchor
    emissive parts use Principled "Emission Color/Strength" → glTF emissive + KHR_materials_emissive_strength
"""

import json
import math
import os
import sys
import time

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

GENERATOR_VERSION = "1.1.0"
TAU = math.tau


# ─────────────────────────────────────────────────────────────────────────────
# Paths & options
# ─────────────────────────────────────────────────────────────────────────────
def _script_args():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def resolve_out_dir():
    args = _script_args()
    if "--out" in args and args.index("--out") + 1 < len(args):
        return os.path.abspath(args[args.index("--out") + 1])
    env = os.environ.get("FLEXIPATH_MODELS_DIR")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
    return os.path.abspath(os.path.join(here, "..", "public", "models"))


def want_showcase():
    return "--showcase" in _script_args() or os.environ.get("FLEXIPATH_SHOWCASE") == "1"


# ─────────────────────────────────────────────────────────────────────────────
# Colour helpers (hex sRGB → scene-linear)
# ─────────────────────────────────────────────────────────────────────────────
def lin(hex_color):
    h = hex_color.lstrip("#")
    out = []
    for i in range(0, 6, 2):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def _socket(node, *names):
    for s in node.inputs:
        if s.identifier in names or s.name in names:
            return s
    return None


# ─────────────────────────────────────────────────────────────────────────────
# bmesh primitives (context-free: no bpy.ops needed for modelling)
# ─────────────────────────────────────────────────────────────────────────────
def _xf(center=(0, 0, 0), rot=None, scale=None):
    m = Matrix.Translation(Vector(center))
    if rot is not None:
        m = m @ (rot if isinstance(rot, Matrix) else Euler(rot).to_matrix().to_4x4())
    if scale is not None:
        m = m @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
    return m


def bm_box(bm, size, center=(0, 0, 0), rot=None):
    bmesh.ops.create_cube(bm, size=1.0, matrix=_xf(center, rot, size))


def bm_cyl(bm, r1, r2, depth, center=(0, 0, 0), rot=None, segments=24, caps=True):
    """Cone/cylinder along local Z; r1 at −depth/2, r2 at +depth/2."""
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segments, radius1=r1, radius2=r2,
                          depth=depth, matrix=_xf(center, rot))


def bm_sphere(bm, radius, center=(0, 0, 0), u=16, v=10):
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius, matrix=_xf(center))


def bm_torus(bm, major_r, minor_r, center=(0, 0, 0), rot=None, major=40, minor=10):
    """Torus in the local XY plane (axis = local Z)."""
    m = _xf(center, rot)
    ring = []
    for i in range(major):
        a = TAU * i / major
        row = []
        for j in range(minor):
            b = TAU * j / minor
            p = Vector(((major_r + minor_r * math.cos(b)) * math.cos(a),
                        (major_r + minor_r * math.cos(b)) * math.sin(a),
                        minor_r * math.sin(b)))
            row.append(bm.verts.new(m @ p))
        ring.append(row)
    for i in range(major):
        for j in range(minor):
            a = ring[i][j]
            b = ring[(i + 1) % major][j]
            c = ring[(i + 1) % major][(j + 1) % minor]
            d = ring[i][(j + 1) % minor]
            bm.faces.new((a, b, c, d))


def bm_slab(bm, outline_xy, z0, z1):
    """Extrude a closed top-view outline (X forward, Y left) from z0 up to z1."""
    bottom = [bm.verts.new((x, y, z0)) for x, y in outline_xy]
    top = [bm.verts.new((x, y, z1)) for x, y in outline_xy]
    n = len(outline_xy)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    bm.faces.new(list(reversed(bottom)))
    bm.faces.new(top)


def bm_strut(bm, p0, p1, radius, segments=6):
    p0 = Vector(p0)
    p1 = Vector(p1)
    d = p1 - p0
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    bmesh.ops.create_cone(bm, cap_ends=False, cap_tris=False, segments=segments, radius1=radius, radius2=radius,
                          depth=d.length, matrix=Matrix.Translation((p0 + p1) / 2) @ rot)


def bm_lathe(bm, profile_rz, center=(0, 0, 0), segments=40):
    """Revolve (r, z) profile points around local Z."""
    c = Vector(center)
    rings = []
    for r, z in profile_rz:
        rings.append([bm.verts.new(c + Vector((r * math.cos(TAU * k / segments), r * math.sin(TAU * k / segments), z)))
                      for k in range(segments)])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(segments):
            k2 = (k + 1) % segments
            bm.faces.new((a[k], a[k2], b[k2], b[k]))


def bm_tube(bm, points, radius, sides=8):
    """Sweep a circle along a polyline (parallel-transport frames)."""
    pts = [Vector(p) for p in points]
    rings = []
    normal = None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        if normal is None:
            ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            normal = t.cross(ref).normalized()
        else:
            normal = (normal - t * normal.dot(t)).normalized()
        binormal = t.cross(normal).normalized()
        rings.append([bm.verts.new(p + (normal * math.cos(TAU * k / sides) + binormal * math.sin(TAU * k / sides)) * radius)
                      for k in range(sides)])
    for a, b in zip(rings[:-1], rings[1:]):
        for k in range(sides):
            k2 = (k + 1) % sides
            bm.faces.new((a[k], a[k2], b[k2], b[k]))


def catmull(points, samples=10):
    pts = [Vector(p) for p in points]
    out = []
    for i in range(len(pts) - 1):
        p0 = pts[max(i - 1, 0)]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[min(i + 2, len(pts) - 1)]
        for s in range(samples):
            t = s / samples
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1])
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Asset builder: temporary scene + datablock bookkeeping + export
# ─────────────────────────────────────────────────────────────────────────────
class AssetBuilder:
    def __init__(self, tag):
        self.tag = tag
        self.scene = bpy.data.scenes.new("FP_BUILD_" + tag)
        self.collection = self.scene.collection
        self.objects = []
        self.meshes = []
        self.materials = {}
        self.root = self.empty("FlexiPath_" + tag, (0, 0, 0), parent=None, display="PLAIN_AXES")

    # Materials ---------------------------------------------------------------
    def mat(self, key, base="#101010", metallic=0.0, roughness=0.5, emission=None, strength=0.0):
        if key in self.materials:
            return self.materials[key]
        m = bpy.data.materials.new("FP_" + key)
        if bpy.app.version < (5, 0, 0):
            m.use_nodes = True  # always on (and deprecated) from Blender 5.0
        nodes = m.node_tree.nodes
        bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            bsdf = nodes.new("ShaderNodeBsdfPrincipled")
            out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None) or nodes.new("ShaderNodeOutputMaterial")
            m.node_tree.links.new(bsdf.outputs[0], out.inputs[0])
        base_lin = lin(base) if isinstance(base, str) else base
        _socket(bsdf, "Base Color").default_value = (*base_lin, 1.0)
        _socket(bsdf, "Metallic").default_value = metallic
        _socket(bsdf, "Roughness").default_value = roughness
        if emission is not None:
            e = lin(emission) if isinstance(emission, str) else emission
            sock = _socket(bsdf, "Emission Color", "Emission")
            if sock is not None:
                sock.default_value = (*e, 1.0)
            st = _socket(bsdf, "Emission Strength")
            if st is not None:
                st.default_value = strength
        m.diffuse_color = (*base_lin, 1.0)
        m.metallic = metallic
        m.roughness = roughness
        self.materials[key] = m
        return m

    # Objects -----------------------------------------------------------------
    def empty(self, name, location, parent="root", display="SPHERE", size=0.1):
        o = bpy.data.objects.new(name, None)
        o.empty_display_type = display
        o.empty_display_size = size
        o.location = location
        self.collection.objects.link(o)
        if parent == "root":
            o.parent = self.root
        elif parent is not None:
            o.parent = parent
        self.objects.append(o)
        return o

    def part(self, name, build, material, parent="root", location=(0, 0, 0), smooth=False, bevel=None):
        """`build(bm)` fills a fresh bmesh; the result becomes one mesh object."""
        bm = bmesh.new()
        build(bm)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        if bevel:
            try:
                bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=2, profile=0.5, affect="EDGES",
                                clamp_overlap=True)
            except TypeError:
                pass
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for f in bm.faces:
            f.smooth = smooth
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(material)
        o = bpy.data.objects.new(name, me)
        o.location = location
        self.collection.objects.link(o)
        o.parent = self.root if parent == "root" else parent
        self.objects.append(o)
        self.meshes.append(me)
        return o

    # Export / cleanup --------------------------------------------------------
    def export(self, filepath):
        vl = self.scene.view_layers[0]
        for o in self.scene.objects:
            o.select_set(o in self.objects, view_layer=vl)
        kwargs = dict(
            filepath=filepath,
            export_format="GLB",
            use_selection=True,
            use_active_scene=True,
            export_apply=True,
            export_yup=True,
            export_extras=True,
            export_cameras=False,
            export_lights=False,
            export_animations=False,
            will_save_settings=False,
            check_existing=False,
        )
        props = bpy.ops.export_scene.gltf.get_rna_type().properties
        kwargs = {k: v for k, v in kwargs.items() if k in props or k == "filepath"}
        with bpy.context.temp_override(scene=self.scene, view_layer=vl):
            try:
                bpy.ops.export_scene.gltf(**kwargs)
            except TypeError as err:  # dynamic enum changed identifier → pick the binary variant
                ids = [s.strip("'\" ") for s in str(err).split("(")[-1].rstrip(")").split(",")]
                fmt = next((i for i in ids if "GLB" in i.upper()), None)
                if not fmt:
                    raise
                kwargs["export_format"] = fmt
                bpy.ops.export_scene.gltf(**kwargs)

    def cleanup(self):
        for o in reversed(self.objects):
            if o.name in bpy.data.objects:
                bpy.data.objects.remove(o, do_unlink=True)
        for me in self.meshes:
            if me.name in bpy.data.meshes and me.users == 0:
                bpy.data.meshes.remove(me)
        for m in self.materials.values():
            if m.name in bpy.data.materials and m.users == 0:
                bpy.data.materials.remove(m)
        if self.scene.name in bpy.data.scenes:
            bpy.data.scenes.remove(self.scene, do_unlink=True)


# ─────────────────────────────────────────────────────────────────────────────
# 1 & 2 — drones
# ─────────────────────────────────────────────────────────────────────────────
DRONE_PALETTES = {
    "flexipath": dict(body="#0b0f16", trim="#1f2937", accent="#00F0FF", canopy="#00F0FF", canopy_strength=1.1),
    "legacy": dict(body="#3b0a16", trim="#4c0519", accent="#E11D48", canopy="#FB7185", canopy_strength=0.9),
}

# Top-view outlines (X forward, Y left), extruded upwards. Keep in step with buildDrone() in VehicleManager.js.
HULL_OUTLINE = [(0.62, 0.0), (0.40, 0.34), (-0.42, 0.36), (-0.62, 0.18), (-0.62, -0.18), (-0.42, -0.36), (0.40, -0.34)]
CANOPY_OUTLINE = [(0.44, 0.0), (0.27, 0.20), (-0.30, 0.20), (-0.40, 0.0), (-0.30, -0.20), (0.27, -0.20)]
ARM_REACH = 1.12  # motor centre offset along X and Y (X-frame quad)
ROTOR_Z = 0.82  # rotor plane above the skids (skids rest on z = 0)
GUARD_R = 0.70  # prop-guard ring radius (blade tips stay inside it)
BLADE_LEN = 1.24
MOTORS = (("FL", 1, 1), ("FR", 1, -1), ("RL", -1, 1), ("RR", -1, -1))


def build_drone(kind):
    p = DRONE_PALETTES[kind]
    b = AssetBuilder(kind + "_drone")
    carbon = b.mat("Hull_" + kind, p["body"], metallic=0.75, roughness=0.32)
    trim = b.mat("Trim_" + kind, p["trim"], metallic=0.6, roughness=0.45)
    glass = b.mat("CanopyGlow_" + kind, "#02060d", metallic=0.3, roughness=0.15, emission=p["canopy"], strength=p["canopy_strength"])
    accent = b.mat("Accent_" + kind, "#05080f", roughness=0.4, emission=p["accent"], strength=2.6)
    head = b.mat("Headlight_" + kind, "#05080f", emission="#E0FDFF", strength=4.0)
    tail = b.mat("TailLight_" + kind, "#05080f", emission="#FF2848", strength=2.4)
    blade = b.mat("Blade", "#05070b", metallic=0.2, roughness=0.6)

    b.part("Hull", lambda bm: bm_slab(bm, HULL_OUTLINE, 0.41, 0.71), carbon, bevel=0.03)
    b.part("Canopy", lambda bm: bm_slab(bm, CANOPY_OUTLINE, 0.71, 0.81), glass, bevel=0.02)

    def strips(bm):
        for side in (-1, 1):
            bm_box(bm, (0.8, 0.04, 0.05), (0.0, side * 0.355, 0.5))
    b.part("LightStrips", strips, accent)
    b.part("Headlight", lambda bm: bm_box(bm, (0.04, 0.3, 0.06), (0.63, 0, 0.56)), head)
    b.part("TailLight", lambda bm: bm_box(bm, (0.04, 0.3, 0.06), (-0.63, 0, 0.56)), tail)

    def arms(bm):
        for _name, sx, sy in MOTORS:
            mx, my = sx * ARM_REACH, sy * ARM_REACH
            bm_strut(bm, (sx * 0.34, sy * 0.26, 0.6), (mx, my, 0.64), 0.065, 8)
            bm_cyl(bm, 0.13, 0.13, 0.2, (mx, my, 0.66), segments=16)  # motor can
            for k in (0, 1, 2):  # prop-guard struts, pointing away from the hull
                a = math.atan2(sy, sx) + (k - 1) * TAU / 3
                bm_strut(bm, (mx + 0.12 * math.cos(a), my + 0.12 * math.sin(a), 0.74),
                         (mx + GUARD_R * math.cos(a), my + GUARD_R * math.sin(a), ROTOR_Z - 0.02), 0.02, 6)
    b.part("Arms", arms, trim, smooth=True)

    def guards(bm):
        for _name, sx, sy in MOTORS:
            bm_torus(bm, GUARD_R, 0.035, (sx * ARM_REACH, sy * ARM_REACH, ROTOR_Z - 0.02), major=40, minor=8)
    b.part("PropGuards", guards, accent, smooth=True)

    def skids(bm):
        for side in (-1, 1):
            bm_cyl(bm, 0.04, 0.04, 1.3, (0.0, side * 0.42, 0.05), rot=(0, math.pi / 2, 0), segments=10)
            for x in (-0.32, 0.32):
                bm_strut(bm, (x, side * 0.42, 0.05), (x * 0.8, side * 0.3, 0.42), 0.03, 6)
    b.part("Skids", skids, trim, smooth=True)

    def gimbal(bm):  # downward ISR camera under the nose
        bm_cyl(bm, 0.05, 0.05, 0.12, (0.42, 0, 0.36), segments=10)
        bm_sphere(bm, 0.16, (0.42, 0, 0.27), 16, 10)
    b.part("Gimbal", gimbal, trim, smooth=True)
    b.part("GimbalLens", lambda bm: bm_cyl(bm, 0.07, 0.07, 0.04, (0.575, 0, 0.27), rot=(0, math.pi / 2, 0), segments=16),
           head, smooth=True)

    def antenna_body(bm):  # multi-link antenna (Wi-Fi · 5G · LEO) on the canopy
        bm_cyl(bm, 0.14, 0.12, 0.06, (-0.2, 0, 0.84), segments=20)
        bm_cyl(bm, 0.022, 0.016, 0.5, (-0.2, 0, 1.1), segments=8)
    b.part("Antenna", antenna_body, trim, smooth=True)
    b.part("AntennaTip", lambda bm: bm_sphere(bm, 0.06, (-0.2, 0, 1.36), 14, 10), accent, smooth=True)
    b.empty("AntennaAnchor", (-0.2, 0, 1.38), display="SPHERE", size=0.12)

    for name, sx, sy in MOTORS:
        pivot = b.empty("Rotor_" + name, (sx * ARM_REACH, sy * ARM_REACH, ROTOR_Z), display="CIRCLE", size=0.4)
        along_x = sx * sy > 0  # alternate the resting blade angle
        size = (BLADE_LEN, 0.1, 0.022) if along_x else (0.1, BLADE_LEN, 0.022)
        b.part("Blades_" + name, lambda bm, size=size: bm_box(bm, size), blade, parent=pivot)

        def tips(bm, along_x=along_x):
            for s in (-1, 1):
                d = s * (BLADE_LEN / 2 - 0.05)
                bm_box(bm, (0.1, 0.1, 0.024), (d, 0, 0) if along_x else (0, d, 0))
        b.part("BladeTips_" + name, tips, accent, parent=pivot)
        b.part("Spinner_" + name, lambda bm: bm_cyl(bm, 0.06, 0.03, 0.06, (0, 0, 0.03), segments=12), trim,
               parent=pivot, smooth=True)
    return b


# ─────────────────────────────────────────────────────────────────────────────
# 3 — wired docking node
# ─────────────────────────────────────────────────────────────────────────────
def build_wired_node():
    b = AssetBuilder("wired_node")
    slate = "#64748B"  # HUD wired colour
    dark = b.mat("DockMetal", "#111827", metallic=0.85, roughness=0.35)
    body = b.mat("DockBody", "#0b1220", metallic=0.8, roughness=0.3)
    head = b.mat("DockHead", "#1e293b", metallic=0.8, roughness=0.25)
    glow = b.mat("DockGlow", "#05080f", emission=slate, strength=4.0)
    core = b.mat("DockCore", "#05080f", emission="#CBD5E1", strength=3.0)
    cable = b.mat("DockCable", "#0f172a", metallic=0.2, roughness=0.8)

    b.part("Plinth", lambda bm: bm_cyl(bm, 1.45, 1.25, 0.3, (0, 0, 0.15), segments=40), dark, smooth=False)
    b.part("PlinthGlow", lambda bm: bm_cyl(bm, 1.3, 1.3, 0.04, (0, 0, 0.32), segments=40), glow)
    b.part("Column", lambda bm: bm_box(bm, (0.75, 0.6, 1.7), (0, 0, 1.15)), body, bevel=0.06)
    b.part("ColumnStrip", lambda bm: bm_box(bm, (0.06, 0.2, 1.3), (0.39, 0, 1.1)), glow)
    b.part("Head", lambda bm: bm_box(bm, (1.05, 0.8, 0.62), (0.05, 0, 2.1)), head, bevel=0.07)
    b.part("TerminalRing", lambda bm: bm_torus(bm, 0.42, 0.06, (0.6, 0, 2.1), rot=(0, math.pi / 2, 0), major=48, minor=12),
           glow, smooth=True)
    b.part("TerminalCore", lambda bm: bm_cyl(bm, 0.16, 0.16, 0.12, (0.6, 0, 2.1), rot=(0, math.pi / 2, 0), segments=20), core)

    def cables(bm):
        for side in (-1, 1):
            bm_tube(bm, catmull([(0.3, side * 0.25, 1.8), (1.6, side * 1.6, 0.35), (2.9, side * 2.6, 0.2)], 12), 0.06, 8)
    b.part("ChargeCables", cables, cable, smooth=True)
    b.empty("BeamAnchor", (0.6, 0, 2.1))
    return b


# ─────────────────────────────────────────────────────────────────────────────
# 4 — Wi-Fi 6 access-point pole
# ─────────────────────────────────────────────────────────────────────────────
def build_wifi_node():
    b = AssetBuilder("wifi_node")
    cyan = "#00F0FF"
    base = b.mat("PoleBase", "#1f2937", metallic=0.2, roughness=0.8)
    pole = b.mat("PoleSteel", "#334155", metallic=0.85, roughness=0.45)
    shell = b.mat("APShell", "#e2e8f0", metallic=0.35, roughness=0.35)
    dark = b.mat("AntennaBlack", "#0f172a", metallic=0.2, roughness=0.6)
    glow = b.mat("WifiGlow", "#05080f", emission=cyan, strength=5.0)

    b.part("Footing", lambda bm: bm_cyl(bm, 0.7, 0.55, 0.35, (0, 0, 0.175), segments=16), base)
    b.part("Pole", lambda bm: bm_cyl(bm, 0.24, 0.15, 8.0, (0, 0, 4.2), segments=14), pole, smooth=True)
    b.part("CrossArm", lambda bm: bm_box(bm, (0.12, 1.8, 0.12), (0, 0, 7.55)), pole)
    b.part("AccessBox", lambda bm: bm_box(bm, (0.62, 1.0, 0.78), (0.18, 0, 8.15)), shell, bevel=0.08)

    def antennas(bm):
        for side in (-1, 1):
            bm_cyl(bm, 0.045, 0.035, 1.0, (0.18, side * 0.36, 9.0), rot=(-side * 0.18, 0, 0), segments=8)
    b.part("DualAntennas", antennas, dark, smooth=True)

    def lights(bm):
        bm_box(bm, (0.03, 0.7, 0.08), (0.5, 0, 8.3))
        bm_torus(bm, 0.46, 0.035, (0.18, 0, 7.72), major=40, minor=8)
        for side in (-1, 1):
            bm_sphere(bm, 0.07, (0.18, side * 0.45, 9.5), 12, 8)
    b.part("WifiLEDs", lights, glow, smooth=True)
    b.empty("BeamAnchor", (0.3, 0, 8.4))
    return b


# ─────────────────────────────────────────────────────────────────────────────
# 5 — 5G SA hexagonal lattice tower
# ─────────────────────────────────────────────────────────────────────────────
def build_5g_tower():
    b = AssetBuilder("5g_tower")
    emerald = "#10B981"
    steel = b.mat("LatticeSteel", "#64748b", metallic=0.8, roughness=0.5)
    concrete = b.mat("Foundation", "#1f2937", metallic=0.1, roughness=0.9)
    deck = b.mat("Deck", "#334155", metallic=0.8, roughness=0.4)
    radome = b.mat("PanelRadome", "#e5e7eb", metallic=0.3, roughness=0.4)
    glow = b.mat("CellGlow", "#05080f", emission=emerald, strength=5.0)
    beacon = b.mat("AviationBeacon", "#05080f", emission="#FF2D55", strength=8.0)

    H, r0, r1, levels = 27.0, 2.7, 1.05, 9

    def leg_point(k, h):
        r = r0 + (r1 - r0) * (h / H)
        a = TAU * k / 6
        return Vector((math.cos(a) * r, math.sin(a) * r, h))

    def lattice(bm):
        for k in range(6):
            bm_strut(bm, leg_point(k, 0), leg_point(k, H), 0.1, 6)
            for i in range(levels):
                h0 = H * i / levels
                h1 = H * (i + 1) / levels
                bm_strut(bm, leg_point(k, h0), leg_point((k + 1) % 6, h1), 0.035, 5)
                bm_strut(bm, leg_point(k, h1), leg_point((k + 1) % 6, h1), 0.05, 5)
    b.part("Lattice", lattice, steel)
    b.part("Foundation", lambda bm: bm_cyl(bm, r0 + 0.9, r0 + 0.6, 0.5, (0, 0, 0.25), segments=6), concrete)
    b.part("Deck", lambda bm: bm_cyl(bm, 2.0, 2.0, 0.25, (0, 0, H + 0.2), segments=6), deck)
    b.part("Mast", lambda bm: bm_cyl(bm, 0.12, 0.12, 3.2, (0, 0, H + 1.8), segments=8), steel, smooth=True)
    b.part("Beacon", lambda bm: bm_sphere(bm, 0.22, (0, 0, H + 3.45), 16, 10), beacon, smooth=True)

    def panels(bm):
        for i in range(3):
            a = TAU * i / 3 + math.pi / 6
            rot = Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(-0.1, 4, "Y")  # azimuth + electrical down-tilt
            bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((math.cos(a) * 1.9, math.sin(a) * 1.9, H + 1.5))
                                  @ rot @ Matrix.Diagonal((0.34, 1.0, 2.7, 1.0)))

    def panel_strips(bm):
        for i in range(3):
            a = TAU * i / 3 + math.pi / 6
            rot = Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(-0.1, 4, "Y")
            bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((math.cos(a) * 1.9, math.sin(a) * 1.9, H + 1.5))
                                  @ rot @ Matrix.Translation((0.19, 0, 0)) @ Matrix.Diagonal((0.05, 0.14, 2.3, 1.0)))
        bm_torus(bm, 2.05, 0.05, (0, 0, H + 0.36), major=6, minor=6)
    b.part("PanelAntennas", panels, radome)
    b.part("PanelGlow", panel_strips, glow)
    b.empty("BeamAnchor", (0, 0, H + 1.5))
    return b


# ─────────────────────────────────────────────────────────────────────────────
# 6 — LEO CubeSat
# ─────────────────────────────────────────────────────────────────────────────
def build_leo_satellite():
    b = AssetBuilder("leo_satellite")
    amber = "#F59E0B"
    gold = b.mat("GoldFoil", "#E0A21B", metallic=1.0, roughness=0.28)
    silver = b.mat("Silver", "#cbd5e1", metallic=0.9, roughness=0.3)
    pv = b.mat("Photovoltaic", "#0b1d4d", metallic=0.6, roughness=0.22)
    frame = b.mat("PVFrame", "#93c5fd", metallic=0.7, roughness=0.35)
    dish = b.mat("DishWhite", "#e2e8f0", metallic=0.6, roughness=0.3)
    glow = b.mat("TransponderGlow", "#05080f", emission=amber, strength=5.5)

    def core(bm):
        bm_box(bm, (2.0, 2.6, 2.0))
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=4, use_grid_fill=True)
        for v in bm.verts:  # crinkled multilayer-insulation foil
            n = math.sin(v.co.x * 9.1) * math.cos(v.co.y * 7.3) * math.sin(v.co.z * 5.7)
            v.co *= 1.0 + 0.025 * n
    b.part("GoldFoilCore", core, gold)
    b.part("TopPlate", lambda bm: bm_box(bm, (2.1, 2.7, 0.12), (0, 0, 1.02)), silver)

    def booms(bm):
        for side in (-1, 1):
            bm_cyl(bm, 0.06, 0.06, 1.6, (0, side * 2.1, 0), rot=(math.pi / 2, 0, 0), segments=8)
        bm_cyl(bm, 0.02, 0.02, 1.4, (0.6, 0.6, 1.7), segments=6)
        bm_cyl(bm, 0.04, 0.04, 0.9, (0, 0, -1.7), segments=8)
    b.part("Booms", booms, silver, smooth=True)

    def wings(bm):
        for side in (-1, 1):
            bm_box(bm, (2.4, 6.2, 0.07), (0, side * 6.0, 0))
    b.part("SolarWings", wings, pv)

    def wing_grid(bm):
        for side in (-1, 1):
            for gx in (-1.2, -0.6, 0.0, 0.6, 1.2):
                for z in (0.045, -0.045):
                    bm_box(bm, (0.03, 6.2, 0.012), (gx, side * 6.0, z))
            for k in range(11):
                gy = -3.1 + k * 0.62
                for z in (0.045, -0.045):
                    bm_box(bm, (2.4, 0.03, 0.012), (0, side * 6.0 + gy, z))
    b.part("SolarCellGrid", wing_grid, frame)

    profile = [(0.06 + 1.24 * (i / 12.0), -1.25 - (0.06 + 1.24 * (i / 12.0)) ** 2 / 2.4) for i in range(13)]
    b.part("TransponderDish", lambda bm: bm_lathe(bm, profile, segments=40), dish, smooth=True)

    def transponder(bm):
        bm_torus(bm, 1.3, 0.05, (0, 0, -1.95), major=48, minor=8)
        bm_cyl(bm, 0.001, 0.16, 0.34, (0, 0, -2.2), segments=16)  # feed horn, tip pointing down
    b.part("TransponderGlow", transponder, glow, smooth=True)
    b.empty("BeamAnchor", (0, 0, -2.35))
    return b


ASSETS = [
    ("flexipath_drone.glb", lambda: build_drone("flexipath")),
    ("legacy_drone.glb", lambda: build_drone("legacy")),
    ("wired_node.glb", build_wired_node),
    ("wifi_node.glb", build_wifi_node),
    ("5g_tower.glb", build_5g_tower),
    ("leo_satellite.glb", build_leo_satellite),
]


# ─────────────────────────────────────────────────────────────────────────────
# Optional showcase scene (re-imports the GLBs → round-trip validation)
# ─────────────────────────────────────────────────────────────────────────────
def build_showcase(out_dir, files):
    name = "FlexiPath_Showcase"
    if name in bpy.data.scenes:
        old = bpy.data.scenes[name]
        for o in list(old.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.scenes.remove(old, do_unlink=True)
    scene = bpy.data.scenes.new(name)
    vl = scene.view_layers[0]
    layout = {
        "flexipath_drone.glb": ((-4.0, -6.0, 0.0), 1.6),
        "legacy_drone.glb": ((-4.0, 0.0, 0.0), 1.6),
        "wired_node.glb": ((4.0, -9.0, 0.0), 1.4),
        "wifi_node.glb": ((5.5, -3.5, 0.0), 0.7),
        "5g_tower.glb": ((12.0, 3.0, 0.0), 0.3),
        "leo_satellite.glb": ((2.0, 7.0, 3.0), 0.55),
    }
    for f in files:
        before = set(bpy.data.objects)
        # Override collection too, so imported objects can never land in the user's scene.
        with bpy.context.temp_override(scene=scene, view_layer=vl, collection=scene.collection):
            bpy.ops.import_scene.gltf(filepath=os.path.join(out_dir, f))
        new_objs = set(bpy.data.objects) - before
        for o in new_objs:
            for coll in list(o.users_collection):
                if coll != scene.collection and coll not in scene.collection.children_recursive:
                    coll.objects.unlink(o)
            if scene.collection not in o.users_collection:
                scene.collection.objects.link(o)
        new_roots = [o for o in new_objs if o.parent is None]
        loc, scale = layout.get(f, ((0, 0, 0), 1.0))
        for o in new_roots:
            o.location = loc
            o.scale = (scale, scale, scale)
    cam_data = bpy.data.cameras.new("ShowcaseCam")
    cam = bpy.data.objects.new("ShowcaseCam", cam_data)
    cam.location = (-14.0, -22.0, 12.0)
    cam.rotation_euler = (math.radians(66), 0, math.radians(-38))
    scene.collection.objects.link(cam)
    scene.camera = cam
    sun_data = bpy.data.lights.new("ShowcaseSun", type="SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("ShowcaseSun", sun_data)
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.get("FlexiPath_Void") or bpy.data.worlds.new("FlexiPath_Void")
    world.color = lin("#030712")
    scene.world = world
    return scene


# ─────────────────────────────────────────────────────────────────────────────
def main():
    out_dir = resolve_out_dir()
    os.makedirs(out_dir, exist_ok=True)
    started = time.time()
    report = []
    print("[FlexiPath] Blender {} -> {}".format(bpy.app.version_string, out_dir))
    for filename, factory in ASSETS:
        builder = None
        path = os.path.join(out_dir, filename)
        try:
            builder = factory()
            builder.export(path)
            size = os.path.getsize(path)
            tris = sum(len(o.data.polygons) for o in builder.objects if o.type == "MESH")
            report.append({"file": filename, "bytes": size, "faces": tris, "objects": len(builder.objects)})
            print("[FlexiPath]   OK {:<22} {:>8.1f} KB  {:>6} faces".format(filename, size / 1024, tris))
        finally:
            if builder is not None:
                builder.cleanup()

    manifest = {
        "generator": "blender/generate_all_models.py",
        "version": GENERATOR_VERSION,
        "blender": bpy.app.version_string,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "conventions": {
            "up": "+Y (glTF)",
            "droneForward": "+X",
            "anchors": {"drones": "AntennaAnchor", "nodes": "BeamAnchor"},
            "rotors": ["Rotor_FL", "Rotor_FR", "Rotor_RL", "Rotor_RR"],
            "rotorAxis": "+Y",
        },
        "assets": report,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print("[FlexiPath] {} assets exported in {:.1f} s".format(len(report), time.time() - started))

    if want_showcase():
        scene = build_showcase(out_dir, [f for f, _ in ASSETS])
        if bpy.context.window is not None:
            bpy.context.window.scene = scene
        print("[FlexiPath] showcase scene '{}' ready".format(scene.name))
    return manifest


if __name__ == "__main__":
    main()
