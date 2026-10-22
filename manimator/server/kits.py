"""Customizations: custom objects and their animations, uploaded as code packages (.manimkit).

A package is one object and the animations made for it (none or more), in a zip:
    manifest.json   what it is: {"manimkit": 2, "name", "version", "description", "license",
                    "object": {"class", "style", "params": [...]},
                    "animations": [{"class", "name", "description", "params", "introducer", "remover",
                                    "run_time"}, ...]}
    kit.js          the browser engine's version: `export class <class> extends ...` for each class, importing only
                    from "manimator" (web/js/engine/KitApi.js). On the site it runs only in the sandboxed frame
                    (web/sandbox/); the chat player (web/mcp/player.html) runs it in its own page, as chats allow no
                    nested frame.
    kit.py          the Manim CE version, for the zip download (manimator/export.py): `class <class>(...)` for each.
    README.md       optional.

The object is the type "kit:<id>:<version>", each animation "kit:<id>:<version>:<class>", and an animation plays only
on its own package's object (AnimSpec.only). Packages uploaded before format 2 held one class, an object or an
animation for any object ({"manimkit": 1, "kind", "class", "params", ...} at the top level, `export default` in
kit.js): those versions still load and play, but new uploads must be format 2.

The server never runs package code: kit.py is only parsed (ast) to check it defines the classes, kit.js only read.
Each version a user uploads is kept for good (a project pins "kit:<id>:<version>"), so a project never breaks
because its author changed or deleted the package: deleting one only takes it off the lists. Every version's classes
are specs in MOBJECTS and ANIMATIONS (registry/custom.py) from the moment the server starts.
"""

from __future__ import annotations

import ast
import hashlib
import io
import json
import keyword
import math
import re
import secrets
import sqlite3
import threading
import time
import zipfile
from dataclasses import replace
from pathlib import Path

from ..registry import ANIMATIONS, MOBJECTS
from ..registry.animations import AnimSpec
from ..registry.custom import KIT_TYPE_RE, UNAVAILABLE, Unavailable, kit_type
from ..registry.mobjects import LINE, NONE, SHAPE, TEXTISH, MobjectSpec
from ..registry.params import (
    ANGLE, BOOL, COLOR, DIRECTION, DIRECTION_VECTORS, ENUM, FLOAT, FONT, INT, POINT, STR, TEXT, VECTOR, Param,
)
from ..registry.reserved import MANIM_NAMES
from .session import OpError, coerce

FORMAT = 2  # manifest.json's "manimkit": an object and its animations
OLD_FORMAT = 1  # one object or one animation: versions stored before format 2 load, uploads don't
UPLOAD_FORMATS = (FORMAT,)
SUFFIX = ".manimkit"
MAX_PACKAGE = 1024 * 1024  # the .manimkit file
MAX_UNPACKED = 2 * 1024 * 1024
FILE_LIMITS = {"manifest.json": 64 * 1024, "kit.js": 256 * 1024, "kit.py": 256 * 1024, "README.md": 64 * 1024}
REQUIRED = ("manifest.json", "kit.js", "kit.py")
KINDS = ("object", "animation")
STYLES = {"none": NONE, "shape": SHAPE, "line": LINE, "text": TEXTISH}
PARAM_KINDS = (FLOAT, INT, BOOL, COLOR, STR, TEXT, DIRECTION, ENUM, ANGLE, POINT, VECTOR, FONT)
MAX_PARAMS = 20
MAX_ANIMATIONS = 10
DESCRIPTION_WORDS = 25  # the package's description, shown whole on its card
CLASS_RE = re.compile(r"^[A-Z][A-Za-z0-9]{0,39}$")
PARAM_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
# Arguments a package's class mustn't take as settings: Manim passes or uses these itself.
RESERVED_PARAMS = {"mobject", "mobjects", "run_time", "rate_func", "lag_ratio", "name", "self", "args", "kwargs",
                   "target", "dim", "z_index", "introducer", "remover", "suspend_mobject_updating"}
MANIFEST_FIELDS = {"manimkit", "name", "version", "description", "license", "object", "animations"}
OBJECT_FIELDS = {"class", "style", "params"}
ANIMATION_FIELDS = {"class", "name", "description", "params", "introducer", "remover", "run_time"}
OLD_MANIFEST_FIELDS = {"manimkit", "name", "kind", "class", "version", "description", "license", "params", "style",
                       "introducer", "remover", "run_time"}
_JUNK = re.compile(r"(^|/)(__MACOSX/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)")
# import "x" / import a, { b } from "x" / export { a } from "x" / export * from "x"
_STATIC_IMPORT = re.compile(r"""(?:^|[;\n])\s*(?:import\s*(?:[\w*${}\s,]+?\s*from\s*)?|export\s*[\w*${}\s,]+?\s*from\s*)"""
                            r"""["']([^"'\n]+)["']""")
_DYNAMIC_IMPORT = re.compile(r"""\bimport\s*\(""")
_DEFAULT_EXPORT = re.compile(r"\bexport\s+default\b")
STATUSES = ("private", "pending", "public", "rejected", "taken_down")


class KitError(OpError):
    """A package that can't be used; the message says what to fix."""


# ---------------------------------------------------------------------- reading a package


def read_package(data: bytes) -> dict[str, str]:
    """The package's files (name -> text), checked for size and shape. Nothing in it is run or written out under
    its own name: only the known file names are taken."""
    if not data:
        raise KitError("That file is empty.")
    if len(data) > MAX_PACKAGE:
        raise KitError(f"A {SUFFIX} file can be up to {MAX_PACKAGE // 1024} KB.")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        entries = [i for i in z.infolist() if not i.is_dir() and not _JUNK.search(i.filename.replace("\\", "/"))]
    except (zipfile.BadZipFile, ValueError, OSError):
        raise KitError(f"That isn't a {SUFFIX} file (it must be a zip).") from None
    if len(entries) > 8:
        raise KitError(f"A {SUFFIX} file holds only {', '.join(FILE_LIMITS)}.")
    names = [i.filename.replace("\\", "/") for i in entries]
    tops = {n.split("/", 1)[0] for n in names}
    prefix = f"{next(iter(tops))}/" if len(tops) == 1 and all("/" in n for n in names) else ""  # one folder zipped
    files: dict[str, str] = {}
    total = 0
    for info, name in zip(entries, names):
        rel = name[len(prefix):]
        if rel not in FILE_LIMITS:
            raise KitError(f"Unexpected file {name[:80]!r}: a {SUFFIX} file holds only {', '.join(FILE_LIMITS)}.")
        if rel in files:
            raise KitError(f"{rel} is in the package twice.")
        if info.flag_bits & 0x1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise KitError(f"{rel} is encrypted or packed in a way {SUFFIX} files can't use.")
        limit = FILE_LIMITS[rel]
        total += info.file_size
        if info.file_size > limit or total > MAX_UNPACKED:
            raise KitError(f"{rel} is too large (up to {limit // 1024} KB).")
        try:
            with z.open(info) as f:
                raw = f.read(limit + 1)
        except (zipfile.BadZipFile, ValueError, OSError, EOFError, RuntimeError):
            raise KitError(f"{rel} can't be read from the zip.") from None
        if len(raw) > limit:
            raise KitError(f"{rel} is too large (up to {limit // 1024} KB).")
        try:
            files[rel] = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise KitError(f"{rel} must be UTF-8 text.") from None
    missing = [r for r in REQUIRED if r not in files]
    if missing:
        raise KitError(f"The package needs {', '.join(missing)}.")
    return files


def _text(value, where: str, most: int, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise KitError(f"manifest.json: {where} must be text.")
    text = " ".join(value.split())
    if required and not text:
        raise KitError(f"manifest.json: give a {where}.")
    if len(text) > most:
        raise KitError(f"manifest.json: {where} can be up to {most} characters.")
    return text


def _number(value, where: str, default: float) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise KitError(f"manifest.json: {where} must be a number.")
    return float(value)


_DEFAULTS = {FLOAT: 0.0, INT: 0, BOOL: False, COLOR: "#FFFFFF", STR: "", TEXT: "", DIRECTION: "UP", ANGLE: 0.0,
             POINT: [0.0, 0.0], VECTOR: [1.0, 0.0], FONT: ""}


def _param(raw, where: str) -> Param:
    if not isinstance(raw, dict):
        raise KitError(f"manifest.json: {where} must be an object like {{\"name\": \"charge\", \"kind\": \"float\"}}.")
    unknown = set(raw) - {"name", "kind", "default", "label", "tooltip", "min", "max", "step", "decimals", "slider",
                          "choices"}
    if unknown:
        raise KitError(f"manifest.json: {where} has unknown fields: {', '.join(sorted(unknown))}.")
    name = raw.get("name")
    if not isinstance(name, str) or not PARAM_RE.match(name) or keyword.iskeyword(name) or name in RESERVED_PARAMS:
        raise KitError(f"manifest.json: {where}.name must be a lowercase Python name (like \"charge\"), not a "
                       f"keyword or one of {', '.join(sorted(RESERVED_PARAMS))}.")
    kind = raw.get("kind")
    if kind not in PARAM_KINDS:
        raise KitError(f"manifest.json: {where}.kind must be one of {', '.join(PARAM_KINDS)}.")
    fields: dict = {"label": _text(raw.get("label"), f"{where}.label", 40),
                    "tooltip": _text(raw.get("tooltip"), f"{where}.tooltip", 160)}
    if kind in (FLOAT, INT):
        lo, hi = _number(raw.get("min"), f"{where}.min", -1000.0), _number(raw.get("max"), f"{where}.max", 1000.0)
        if not -1e6 <= lo < hi <= 1e6:
            raise KitError(f"manifest.json: {where}: min must be below max (both within ±1000000).")
        step = _number(raw.get("step"), f"{where}.step", 1.0 if kind == INT else 0.1)
        if not 0 < step <= hi - lo:
            raise KitError(f"manifest.json: {where}.step must be positive and fit between min and max.")
        decimals = int(_number(raw.get("decimals"), f"{where}.decimals", 0 if kind == INT else 2))
        fields.update(min=lo, max=hi, step=step, decimals=max(0, min(6, decimals)),
                      slider=bool(raw.get("slider")) and kind == FLOAT)
    if kind == ENUM:
        choices = raw.get("choices")
        if not isinstance(choices, list) or not 1 <= len(choices) <= 30:
            raise KitError(f"manifest.json: {where}.choices must list 1 to 30 choices.")
        pairs = []
        for c in choices:
            value, label = (c, c) if isinstance(c, str) else (c[0], c[1]) if isinstance(c, list) and len(c) == 2 \
                else (None, None)
            if not isinstance(value, str) or not isinstance(label, str) or not value or len(value) > 40 \
                    or len(label) > 40:
                raise KitError(f"manifest.json: {where}.choices: each is text, or [value, label].")
            pairs.append((value, label))
        fields["choices"] = tuple(pairs)
    elif kind == DIRECTION and raw.get("choices") is not None:
        choices = raw.get("choices")
        if not isinstance(choices, list) or not choices or any(c not in DIRECTION_VECTORS for c in choices):
            raise KitError(f"manifest.json: {where}.choices must be directions: {', '.join(DIRECTION_VECTORS)}.")
        fields["choices"] = tuple(dict.fromkeys(choices))
    elif raw.get("choices") is not None:
        raise KitError(f"manifest.json: {where}: only enum and direction settings have choices.")
    default = raw.get("default", fields["choices"][0][0] if kind == ENUM else _DEFAULTS.get(kind))
    p = Param(name, kind, None, **fields)
    try:
        value = coerce(p, default)
    except OpError as e:
        raise KitError(f"manifest.json: {where}.default: {e}") from None
    if kind in (FLOAT, INT, ANGLE) and value != default and not isinstance(default, bool):
        if not (isinstance(default, (int, float)) and math.isclose(float(default), float(value))):
            raise KitError(f"manifest.json: {where}.default must be between min and max.")
    return replace(p, default=value)


def _class(value, where: str, taken) -> str:
    if not isinstance(value, str) or not CLASS_RE.match(value):
        raise KitError(f"manifest.json: {where} must be a PascalCase Python class name, like \"Battery\".")
    if value in MANIM_NAMES or value in MOBJECTS or value in ANIMATIONS or value in taken:
        raise KitError(f"manifest.json: \"{value}\" is already a Manim or Manimator name, or another of your "
                       "customizations' classes; choose another class name.")
    return value


def _params(raw, where: str) -> tuple[Param, ...]:
    params = raw if raw is not None else []
    if not isinstance(params, list) or len(params) > MAX_PARAMS:
        raise KitError(f"manifest.json: {where} must be a list of up to {MAX_PARAMS} settings.")
    built = tuple(_param(p, f"{where}[{i}]") for i, p in enumerate(params))
    if len({p.name for p in built}) != len(built):
        raise KitError(f"manifest.json: two settings in {where} have the same name.")
    return built


def _fields(raw: dict, allowed: set, where: str) -> None:
    unknown = set(raw) - allowed
    if unknown:
        raise KitError(f"manifest.json: {where}unknown fields {', '.join(sorted(unknown))}. "
                       f"Fields: {', '.join(sorted(allowed))}.")


def _style(raw: dict, where: str) -> str:
    style = raw.get("style", "none")
    if style not in STYLES:
        raise KitError(f"manifest.json: {where}\"style\" must be one of {', '.join(STYLES)}.")
    return style


def _animation(raw: dict, where: str, cls: str, name: str, description: str, params) -> dict:
    """An animation's fields after its class, name and settings: whether it brings its object in or takes it away,
    and its usual length."""
    out = {"class": cls, "name": name, "description": description, "params": params,
           "introducer": bool(raw.get("introducer")), "remover": bool(raw.get("remover"))}
    if out["introducer"] and out["remover"]:
        raise KitError(f"manifest.json: {where}an animation can't both bring in and take away its object.")
    out["run_time"] = _number(raw.get("run_time"), f"{where}run_time", 1.0)
    if not 0.05 <= out["run_time"] <= 60:
        raise KitError(f"manifest.json: {where}\"run_time\" must be between 0.05 and 60 seconds.")
    return out


def _spaced(cls: str) -> str:
    """"SweepAngle" -> "Sweep angle": an animation's name when the manifest gives none."""
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", cls).split()
    return " ".join([words[0], *(w if w.isupper() else w.lower() for w in words[1:])])


def _description(value, stored: bool) -> str:
    """The package's description: its card shows all of it, so a new upload keeps it to DESCRIPTION_WORDS words (a
    version kept from before may have more)."""
    text = _text(value, "description", 200)
    if not stored and len(text.split()) > DESCRIPTION_WORDS:
        raise KitError(f"manifest.json: description can be up to {DESCRIPTION_WORDS} words.")
    return text


def read_manifest(text: str, taken_names=frozenset(), stored: bool = False) -> dict:
    """The manifest, checked: {"format", "name", "version", "description", "license",
    "object": {"class", "style", "params" (Params)} or None, "animations": [{"class", "name", "description",
    "params", "introducer", "remover", "run_time"}], "classes": every class name, the object's first}.
    `taken_names`: classes the uploader's other packages have. `stored`: a version kept from before, which may be in
    the first format (one object, or one animation for any object: "object" None)."""
    try:
        raw = json.loads(text)
    except ValueError as e:
        raise KitError(f"manifest.json isn't valid JSON ({e}).") from None
    if not isinstance(raw, dict):
        raise KitError("manifest.json must be a JSON object.")
    form = raw.get("manimkit")
    if form == OLD_FORMAT and (stored or OLD_FORMAT in UPLOAD_FORMATS):
        return _read_old_manifest(raw, taken_names)
    if form != FORMAT:
        hint = (" The first format (one object or one animation on its own) isn't uploaded any more: put the object "
                "in \"object\" and the animations made for it in \"animations\"." if form == OLD_FORMAT else "")
        raise KitError(f"manifest.json: \"manimkit\" must be {FORMAT} (this version of the format).{hint}")
    _fields(raw, MANIFEST_FIELDS, "")
    obj = raw.get("object")
    if not isinstance(obj, dict):
        raise KitError("manifest.json: give the \"object\": {\"class\": \"Battery\", \"params\": [...]}. Every "
                       "customization is one object, with the animations made for it in \"animations\".")
    _fields(obj, OBJECT_FIELDS, "object: ")
    taken = set(taken_names)
    cls = _class(obj.get("class"), "object.class", taken)
    taken.add(cls)
    out = {"format": FORMAT, "name": _text(raw.get("name"), "name", 40, required=True),
           "version": _text(raw.get("version") or "1.0", "version", 20),
           "description": _description(raw.get("description"), stored),
           "license": _text(raw.get("license"), "license", 60),
           "object": {"class": cls, "style": _style(obj, "object."), "params": _params(obj.get("params"),
                                                                                         "object.params")},
           "animations": []}
    animations = raw.get("animations")
    animations = [] if animations is None else animations
    if not isinstance(animations, list) or len(animations) > MAX_ANIMATIONS:
        raise KitError(f"manifest.json: \"animations\" must be a list of up to {MAX_ANIMATIONS} animations.")
    for i, a in enumerate(animations):
        where = f"animations[{i}]"
        if not isinstance(a, dict):
            raise KitError(f"manifest.json: {where} must be an object like {{\"class\": \"PopIn\", \"params\": []}}.")
        _fields(a, ANIMATION_FIELDS, f"{where}: ")
        name = _class(a.get("class"), f"{where}.class", taken)
        taken.add(name)
        out["animations"].append(_animation(
            a, f"{where}.", name, _text(a.get("name"), f"{where}.name", 40) or _spaced(name),
            _text(a.get("description"), f"{where}.description", 200), _params(a.get("params"), f"{where}.params")))
    out["classes"] = [cls, *(a["class"] for a in out["animations"])]
    return out


def _read_old_manifest(raw: dict, taken_names) -> dict:
    """A first-format manifest (one class), in read_manifest's shape."""
    _fields(raw, OLD_MANIFEST_FIELDS, "")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise KitError("manifest.json: \"kind\" must be \"object\" or \"animation\".")
    cls = _class(raw.get("class"), "\"class\"", taken_names)
    params = _params(raw.get("params"), "params")
    out = {"format": OLD_FORMAT, "name": _text(raw.get("name"), "name", 40, required=True),
           "version": _text(raw.get("version") or "1.0", "version", 20),
           "description": _text(raw.get("description"), "description", 200),
           "license": _text(raw.get("license"), "license", 60), "object": None, "animations": [], "classes": [cls]}
    if kind == "object":
        if any(k in raw for k in ("introducer", "remover", "run_time")):
            raise KitError("manifest.json: \"introducer\", \"remover\" and \"run_time\" are for animations.")
        out["object"] = {"class": cls, "style": _style(raw, ""), "params": params}
    else:
        if "style" in raw:
            raise KitError("manifest.json: \"style\" is for objects.")
        out["animations"].append(_animation(raw, "", cls, out["name"], out["description"], params))
    return out


def check_python(source: str, classes) -> None:
    """kit.py must parse and define the classes at its top level. It is parsed, never run."""
    try:
        tree = ast.parse(source, filename="kit.py")
    except SyntaxError as e:
        raise KitError(f"kit.py has a syntax error on line {e.lineno}: {e.msg}.") from None
    except (RecursionError, MemoryError, ValueError):
        raise KitError("kit.py can't be read.") from None
    defined = {n.name for n in tree.body if isinstance(n, ast.ClassDef)}
    for cls in [classes] if isinstance(classes, str) else classes:
        if cls not in defined:
            raise KitError(f"kit.py must define class {cls} at the top level (as manifest.json names it).")


def check_javascript(source: str, classes=None) -> None:
    """kit.js may import only from "manimator" (it runs in a sandbox that has nothing else) and must export each
    class by its name (`classes`; None: the first format's one class, as its default export)."""
    for spec in _STATIC_IMPORT.findall(source):
        if spec != "manimator":
            raise KitError(f"kit.js imports {spec[:60]!r}: packages may import only from \"manimator\".")
    if _DYNAMIC_IMPORT.search(source):
        raise KitError("kit.js can't use import(): packages may import only from \"manimator\".")
    if classes is None:
        if not _DEFAULT_EXPORT.search(source):
            raise KitError("kit.js must `export default` its class.")
        return
    for cls in classes:
        if not re.search(rf"\bexport\s+class\s+{cls}\b|\bexport\s*{{[^}}]*\b{cls}\b[^}}]*}}", source):
            raise KitError(f"kit.js must export class {cls} by its name: `export class {cls} extends ...`.")


def module_name(cls: str) -> str:
    """The Python module a class goes in, in the zip's customizations folder: "PopIn" -> "pop_in"."""
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "_", cls).lower()
    return name if not keyword.iskeyword(name) and name not in ("manim", "customizations") else f"{name}_kit"


# ---------------------------------------------------------------------- specs


def _build(cls: str):
    return lambda a: a.call(cls)


def _blocked(_a):
    raise Unavailable(UNAVAILABLE)


def make_specs(kit: dict, version: int, manifest: dict, meta: dict, blocked: bool = False) -> list:
    """The specs a package version adds to the registry: its object's MobjectSpec, then an AnimSpec for each of its
    animations, which play only on that object. (A first-format version: its one class's spec, under the plain
    "kit:<id>:<version>"; an animation of those plays on any object.)"""
    old = manifest["format"] == OLD_FORMAT
    module = module_name(manifest["classes"][0])
    info = {"id": kit["id"], "version": version, "label": manifest["version"], "name": manifest["name"],
            "module": module, "author": kit["owner_name"], "license": manifest["license"], **meta}
    out = []
    obj = manifest["object"]
    owner = kit_type(kit["id"], version) if obj else None
    if obj:
        # no style set at first: the package's own colors show until the user picks others
        out.append(MobjectSpec(owner, "Custom", "✦", module, STYLES[obj["style"]], {}, obj["params"],
                               build=_blocked if blocked else _build(obj["class"]),
                               description=UNAVAILABLE if blocked else manifest["description"],
                               kit={**info, "class": obj["class"], "kind": "object",
                                    "export": "default" if old else obj["class"]},
                               blocked=blocked))
    for a in manifest["animations"]:
        key = kit_type(kit["id"], version, "" if old else a["class"])
        out.append(AnimSpec(key, "Custom", a["params"], introducer=a["introducer"], remover=a["remover"],
                            run_time=a["run_time"], only=(owner,) if owner else (),
                            description=UNAVAILABLE if blocked else a["description"], label=a["name"],
                            call_name=a["class"],
                            kit={**info, "class": a["class"], "kind": "animation",
                                 "export": "default" if old else a["class"], "object": owner},
                            blocked=blocked))
    return out


def register(spec) -> None:
    (MOBJECTS if isinstance(spec, MobjectSpec) else ANIMATIONS).custom[spec.key] = spec


# ---------------------------------------------------------------------- the store


class KitStore:
    """Packages, their versions and who may use them: kits.db (SQLite) and kits/<id>/<version>/ files."""

    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(root / "kits.db"), check_same_thread=False, isolation_level=None)
        self._lock = threading.RLock()
        self._by_sha: dict[str, tuple[str, int]] = {}  # kit.js sha256 -> (kit id, version)
        self._keys: dict[tuple[str, int], list[str]] = {}  # (kit id, version) -> its types, the object's first
        for sql in (
            "CREATE TABLE IF NOT EXISTS kits (id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_name TEXT NOT NULL, "
            "kind TEXT NOT NULL, class TEXT NOT NULL, name TEXT NOT NULL, created REAL NOT NULL, "
            "listed INTEGER NOT NULL DEFAULT 1)",
            "CREATE TABLE IF NOT EXISTS versions (kit_id TEXT NOT NULL, version INTEGER NOT NULL, "
            "manifest TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created REAL NOT NULL, "
            "decided REAL NOT NULL DEFAULT 0, PRIMARY KEY (kit_id, version))",
            "CREATE TABLE IF NOT EXISTS library (user TEXT NOT NULL, kit_id TEXT NOT NULL, added REAL NOT NULL, "
            "PRIMARY KEY (user, kit_id))",
            "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id TEXT NOT NULL, "
            "user TEXT NOT NULL, reason TEXT NOT NULL, created REAL NOT NULL, handled INTEGER NOT NULL DEFAULT 0)",
        ):
            self._db.execute(sql)
        if "description" not in {r[1] for r in self._q("PRAGMA table_info(kits)")}:
            # the description its author wrote on the site (NULL: each version's manifest has its own)
            self._db.execute("ALTER TABLE kits ADD COLUMN description TEXT")
        for kit_id, version in self._q("SELECT kit_id, version FROM versions"):
            try:
                self._register(kit_id, version)
            except (KitError, OSError, ValueError, KeyError):  # damaged on disk: its objects show as unavailable
                continue

    def _q(self, sql: str, args=()):
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ files
    def folder(self, kit_id: str, version: int) -> Path:
        return self.root / kit_id / str(int(version))

    def file(self, kit_id: str, version: int, name: str) -> Path | None:
        if name not in FILE_LIMITS:
            return None
        path = self.folder(kit_id, version) / name
        return path if path.is_file() else None

    def js_by_sha(self, sha: str) -> Path | None:
        """The kit.js whose sha256 is `sha`. Only someone who has the code already knows it: the chat player gets
        it with the code, and loads it from here when the chat's policy lets it run no code it was handed."""
        hit = self._by_sha.get(sha)
        return self.file(hit[0], hit[1], "kit.js") if hit else None

    def _register(self, kit_id: str, version: int) -> None:
        kit = self.kit(kit_id)
        row = self._version(kit_id, version)
        folder = self.folder(kit_id, version)
        manifest = read_manifest((folder / "manifest.json").read_text(encoding="utf-8"), stored=True)
        written = self.written_description(kit_id)
        if written is not None:
            manifest["description"] = written
            if manifest["object"] is None:  # a first-format animation: its one animation is the package
                manifest["animations"][0]["description"] = written
        js = (folder / "kit.js").read_bytes()
        meta = {"js_sha256": hashlib.sha256(js).hexdigest(), "status": row["status"]}
        self._by_sha[meta["js_sha256"]] = (kit_id, version)
        specs = make_specs(kit, version, manifest, meta, blocked=row["status"] == "taken_down")
        for spec in specs:
            register(spec)
        self._keys[(kit_id, int(version))] = [s.key for s in specs]

    # ------------------------------------------------------------------ reading
    @staticmethod
    def _kit_row(r) -> dict:
        return {"id": r[0], "owner": r[1], "owner_name": r[2], "kind": r[3], "class": r[4], "name": r[5],
                "created": r[6], "listed": bool(r[7])}

    def kit(self, kit_id) -> dict | None:
        if not isinstance(kit_id, str) or not re.fullmatch(r"[0-9a-f]{12}", kit_id):
            return None
        rows = self._q("SELECT id, owner, owner_name, kind, class, name, created, listed FROM kits WHERE id = ?",
                       (kit_id,))
        return self._kit_row(rows[0]) if rows else None

    def _version(self, kit_id: str, version: int) -> dict | None:
        rows = self._q("SELECT version, manifest, status, reason, created, decided FROM versions "
                       "WHERE kit_id = ? AND version = ?", (kit_id, int(version)))
        if not rows:
            return None
        v, manifest, status, reason, created, decided = rows[0]
        return {"version": v, "manifest": json.loads(manifest), "status": status, "reason": reason,
                "created": created, "decided": decided}

    def versions(self, kit_id: str) -> list[dict]:
        rows = self._q("SELECT version FROM versions WHERE kit_id = ? ORDER BY version", (kit_id,))
        return [self._version(kit_id, r[0]) for r in rows]

    def latest(self, kit_id: str) -> int:
        rows = self._q("SELECT MAX(version) FROM versions WHERE kit_id = ? AND status != 'taken_down'", (kit_id,))
        return rows[0][0] or 0

    def owned(self, owner: str, listed_only: bool = True) -> list[dict]:
        sql = "SELECT id, owner, owner_name, kind, class, name, created, listed FROM kits WHERE owner = ?"
        rows = self._q(sql + (" AND listed = 1" if listed_only else "") + " ORDER BY created DESC", (owner,))
        return [self._kit_row(r) for r in rows]

    def summary(self, kit: dict, viewer: str | None = None, shown: int = 0) -> dict:
        """A package as the Customizations page lists it, as of version `shown` (default: the newest usable one):
        its object's type and description, and the animations made for it."""
        shown = shown or self.latest(kit["id"])
        spec = self.spec(kit["id"], shown) if shown else None
        versions = self.versions(kit["id"])
        animations = [{"type": s.key, "class": s.kit["class"], "name": s.label, "description": s.description}
                      for s in self.specs(kit["id"], shown)[1:]] if spec is not None and spec.kit["kind"] == "object" \
            else []
        return {"id": kit["id"], "name": kit["name"], "kind": kit["kind"], "class": kit["class"],
                "author": kit["owner_name"], "mine": viewer == kit["owner"], "created": kit["created"],
                "listed": kit["listed"], "type": spec.key if spec else None,
                "description": spec.description if spec else "", "animations": animations,
                "versions": [{"version": v["version"], "label": v["manifest"].get("version", ""),
                              "status": v["status"], "reason": v["reason"], "created": v["created"]}
                             for v in versions]}

    def spec(self, kit_id: str, version: int):
        """A version's main spec: its object (or a first-format version's one class)."""
        key = kit_type(kit_id, version)
        return MOBJECTS.custom.get(key) or ANIMATIONS.custom.get(key)

    def specs(self, kit_id: str, version: int) -> list:
        """Every spec of a version: its object's, then its animations'."""
        keys = self._keys.get((kit_id, int(version)), [])
        return [s for s in (MOBJECTS.custom.get(k) or ANIMATIONS.custom.get(k) for k in keys) if s is not None]

    def classes(self, kit_id: str) -> set[str]:
        """The class names of a package's newest version."""
        return {s.kit["class"] for s in self.specs(kit_id, self.latest_any(kit_id))}

    def written_description(self, kit_id: str) -> str | None:
        """The description the author wrote on the site, which every version shows; None if they haven't."""
        rows = self._q("SELECT description FROM kits WHERE id = ?", (kit_id,))
        return rows[0][0] if rows else None

    def describe(self, owner: str, kit_id: str, text) -> None:
        """The author changes the package's description: every version shows it, until a new version's manifest.json
        brings a different one."""
        kit = self.kit(kit_id)
        if kit is None or kit["owner"] != owner or not kit["listed"]:
            raise KitError("That customization isn't yours to change.")
        if not isinstance(text, str):
            raise KitError("The description must be text.")
        text = " ".join(text.split())
        if len(text) > 200 or len(text.split()) > DESCRIPTION_WORDS:
            raise KitError(f"A description can be up to {DESCRIPTION_WORDS} words.")
        self._q("UPDATE kits SET description = ? WHERE id = ?", (text, kit_id))
        for v in self.versions(kit_id):
            self._register(kit_id, v["version"])

    # ------------------------------------------------------------------ adding
    def add(self, owner: str, owner_name: str, data: bytes, limit: int, kit_id: str | None = None,
            upgrade: bool = False) -> dict:
        """A new package (or, with `kit_id`, a new version of the owner's package). Returns its row. `upgrade`: a
        bigger plan keeps more (the limit message says so)."""
        files = read_package(data)
        with self._lock:
            kit = self.kit(kit_id) if kit_id else None
            if kit_id and (kit is None or kit["owner"] != owner or not kit["listed"]):
                raise KitError("That customization isn't yours to change.")
            if kit is not None and self._q("SELECT 1 FROM versions WHERE kit_id = ? AND status = 'taken_down'",
                                           (kit["id"],)):
                raise KitError("That customization was taken down, so it can't get new versions.")
            if kit is None and len(self.owned(owner)) >= limit:
                raise KitError(f"You can keep up to {limit} customization{'s' if limit != 1 else ''}. "
                               f"Delete one first{', or upgrade' if upgrade else ''}.")
            taken = set().union(*(self.classes(k["id"]) for k in self.owned(owner) if k["id"] != kit_id))
            manifest = read_manifest(files["manifest.json"], taken)
            obj = manifest["object"]
            if kit is not None and kit["kind"] != "object":
                raise KitError("This customization is an animation on its own (the first .manimkit format), so it "
                               "can't get new versions: animations now come in their object's customization. Upload "
                               "it with the object it is for, as a new customization.")
            if kit is not None and (obj is None or obj["class"] != kit["class"]):
                raise KitError(f"A new version must keep the object {kit['class']} (start a new customization to "
                               "change that). Its animations may change.")
            check_python(files["kit.py"], manifest["classes"])
            check_javascript(files["kit.js"], None if manifest["format"] == OLD_FORMAT else manifest["classes"])
            if kit is None:
                kit = {"id": secrets.token_hex(6), "owner": owner, "owner_name": owner_name,
                       "kind": "object" if obj else "animation", "class": manifest["classes"][0],
                       "name": manifest["name"], "created": time.time(), "listed": True}
                self._db.execute("INSERT INTO kits (id, owner, owner_name, kind, class, name, created, listed) "
                                 "VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
                                 (kit["id"], owner, owner_name, kit["kind"], kit["class"], kit["name"],
                                  kit["created"]))
            else:
                self._db.execute("UPDATE kits SET name = ?, owner_name = ? WHERE id = ?",
                                 (manifest["name"], owner_name, kit["id"]))
                before = self._version(kit["id"], self.latest_any(kit["id"]))
                if before and manifest["description"] != " ".join(str(before["manifest"].get("description") or "").split()):
                    # the author changed it in manifest.json: each version shows its own again
                    self._db.execute("UPDATE kits SET description = NULL WHERE id = ?", (kit["id"],))
                    for v in self.versions(kit["id"]):
                        self._register(kit["id"], v["version"])
            version = self.latest_any(kit["id"]) + 1
            folder = self.folder(kit["id"], version)
            folder.mkdir(parents=True, exist_ok=True)
            for name, text in files.items():
                with open(folder / name, "w", encoding="utf-8", newline="\n") as f:
                    f.write(text)
            stored = {k: v for k, v in json.loads(files["manifest.json"]).items()}
            self._db.execute("INSERT INTO versions (kit_id, version, manifest, status, created) VALUES (?, ?, ?, ?, ?)",
                             (kit["id"], version, json.dumps(stored), "private", time.time()))
            self._register(kit["id"], version)
            return self.kit(kit["id"])

    def latest_any(self, kit_id: str) -> int:
        return self._q("SELECT MAX(version) FROM versions WHERE kit_id = ?", (kit_id,))[0][0] or 0

    def unlist(self, owner: str, kit_id: str) -> None:
        """Deleting a package takes it off every list; projects that use it keep working."""
        kit = self.kit(kit_id)
        if kit is None or kit["owner"] != owner or not kit["listed"]:
            raise KitError("That customization is already gone.")
        self._q("UPDATE kits SET listed = 0 WHERE id = ?", (kit_id,))
        self._q("DELETE FROM library WHERE kit_id = ?", (kit_id,))

    # ------------------------------------------------------------------ who may use what
    def latest_public(self, kit_id: str) -> int:
        """The newest version anyone may use (approved), 0 if none."""
        return self._q("SELECT MAX(version) FROM versions WHERE kit_id = ? AND status = 'public'", (kit_id,))[0][0] or 0

    def library(self, user: str) -> list[dict]:
        """The public packages a user added from the gallery (still listed and public)."""
        rows = self._q("SELECT k.id, k.owner, k.owner_name, k.kind, k.class, k.name, k.created, k.listed FROM library l "
                       "JOIN kits k ON k.id = l.kit_id WHERE l.user = ? AND k.listed = 1 ORDER BY l.added", (user,))
        return [k for k in (self._kit_row(r) for r in rows) if self.latest_public(k["id"])]

    def usable(self, owner: str) -> list:
        """The specs a user can add: the latest version of each of their packages, and the latest approved version of
        each package in their library."""
        specs = []
        for kit in self.owned(owner):
            latest = self.latest(kit["id"])
            specs += [s for s in self.specs(kit["id"], latest) if not s.blocked] if latest else []
        for kit in self.library(owner):
            if kit["owner"] == owner:
                continue
            specs += [s for s in self.specs(kit["id"], self.latest_public(kit["id"])) if not s.blocked]
        return specs

    def check_use(self, owner: str, allowed: int, key: str) -> None:
        """Raise unless this user may add this custom type to a project now (`allowed`: their plan's limit): one of
        their own packages, or an approved version of one in their library."""
        m = KIT_TYPE_RE.match(key) if isinstance(key, str) else None
        if m is None:
            raise OpError("Unknown custom object or animation.")
        if allowed <= 0:
            raise OpError("Custom objects and animations aren't part of this plan.")
        kit, row = self.kit(m.group(1)), self._version(m.group(1), int(m.group(2)))
        if kit is None or row is None or key not in self._keys.get((kit["id"], row["version"]), []):
            raise OpError("That customization doesn't exist.")
        if row["status"] == "taken_down":
            raise OpError("That customization was taken down.")
        if kit["owner"] == owner:
            return
        if row["status"] != "public" or not any(k["id"] == kit["id"] for k in self.library(owner)):
            raise OpError("That customization isn't yours or in your library. Add it from the gallery first.")

    def readable(self, viewer: str, kit_id: str, version: int, admin: bool = False) -> bool:
        """Whether someone may read a version's files: its author, the reviewer, or anyone once it is approved. (An
        approved version stays readable, so projects that use it keep playing, unless it is taken down.)"""
        kit, row = self.kit(kit_id), self._version(kit_id, version)
        if kit is None or row is None or row["status"] == "taken_down":
            return False
        return admin or kit["owner"] == viewer or row["status"] == "public"

    # ------------------------------------------------------------------ going public (reviewed by the site's owner)
    def submit(self, owner: str, kit_id: str) -> None:
        """Ask for the newest version to be made public; the reviewer decides (decide())."""
        kit = self.kit(kit_id)
        if kit is None or kit["owner"] != owner or not kit["listed"]:
            raise KitError("That customization isn't yours.")
        version = self.latest_any(kit_id)
        row = self._version(kit_id, version)
        if row["status"] == "pending":
            raise KitError("It is already waiting for review.")
        if row["status"] in ("public", "taken_down"):
            raise KitError("Its newest version is already public." if row["status"] == "public"
                           else "It was taken down.")
        self._q("UPDATE versions SET status = 'pending', reason = '', decided = 0 WHERE kit_id = ? AND version = ?",
                (kit_id, version))
        self._register(kit_id, version)

    def pending(self) -> list[dict]:
        """Versions waiting for review, oldest first, with what the reviewer reads."""
        rows = self._q("SELECT kit_id, version FROM versions WHERE status = 'pending' ORDER BY created")
        return [{**self.summary(self.kit(kid)), "review_version": v} for kid, v in rows if self.kit(kid)]

    def decide(self, kit_id: str, version: int, approve: bool, reason: str = "") -> None:
        row = self._version(kit_id, version)
        if row is None or row["status"] != "pending":
            raise KitError("That version isn't waiting for review.")
        status = "public" if approve else "rejected"
        self._q("UPDATE versions SET status = ?, reason = ?, decided = ? WHERE kit_id = ? AND version = ?",
                (status, " ".join(str(reason or "").split())[:300], time.time(), kit_id, version))
        self._register(kit_id, version)

    def take_down(self, kit_id: str, reason: str = "") -> None:
        """Stop a package everywhere: its code no longer runs or downloads, and projects show its objects as
        unavailable. It leaves the gallery and every library."""
        if self.kit(kit_id) is None:
            raise KitError("That customization doesn't exist.")
        self._q("UPDATE versions SET status = 'taken_down', reason = ?, decided = ? WHERE kit_id = ?",
                (" ".join(str(reason or "").split())[:300], time.time(), kit_id))
        self._q("DELETE FROM library WHERE kit_id = ?", (kit_id,))
        self.dismiss_reports(kit_id)
        for v in self.versions(kit_id):
            self._register(kit_id, v["version"])

    # ------------------------------------------------------------------ the gallery, libraries and reports
    def gallery(self, query: str = "", waiting: bool = False) -> list[dict]:
        """Listed packages with an approved version (and, with `waiting`, the ones waiting for review), most recently
        approved first."""
        statuses = "('public', 'pending')" if waiting else "('public')"
        rows = self._q("SELECT k.id, k.owner, k.owner_name, k.kind, k.class, k.name, k.created, k.listed, "
                       "MAX(v.decided) FROM kits k JOIN versions v ON v.kit_id = k.id "
                       f"WHERE k.listed = 1 AND v.status IN {statuses} GROUP BY k.id ORDER BY MAX(v.decided) DESC")
        out = []
        q = " ".join(str(query or "").lower().split())
        for r in rows:
            kit = self._kit_row(r[:8])
            shown = self.latest_public(kit["id"]) or self.latest(kit["id"])
            spec = self.spec(kit["id"], shown)
            extra = " ".join(f"{s.kit['class']} {s.label}" for s in self.specs(kit["id"], shown)[1:])
            text = f"{kit['name']} {kit['owner_name']} {kit['class']} {spec.description if spec else ''} {extra}".lower()
            if not q or all(word in text for word in q.split()):
                out.append(kit)
        return out

    def set_library(self, user: str, kit_id: str, add: bool) -> None:
        if add:
            kit = self.kit(kit_id)
            if kit is None or not kit["listed"] or not self.latest_public(kit_id):
                raise KitError("That customization isn't in the gallery.")
            self._q("INSERT OR IGNORE INTO library (user, kit_id, added) VALUES (?, ?, ?)", (user, kit_id, time.time()))
        else:
            self._q("DELETE FROM library WHERE user = ? AND kit_id = ?", (user, kit_id))

    def in_library(self, user: str, kit_id: str) -> bool:
        return bool(self._q("SELECT 1 FROM library WHERE user = ? AND kit_id = ?", (user, kit_id)))

    def report(self, user: str, kit_id: str, reason: str) -> None:
        if self.kit(kit_id) is None or not self.latest_public(kit_id):
            raise KitError("That customization isn't in the gallery.")
        text = " ".join(str(reason or "").split())[:500]
        if not text:
            raise KitError("Say what is wrong with it.")
        if self._q("SELECT 1 FROM reports WHERE kit_id = ? AND user = ? AND handled = 0", (kit_id, user)):
            raise KitError("You already reported it. Thank you: it will be looked at.")
        self._q("INSERT INTO reports (kit_id, user, reason, created) VALUES (?, ?, ?, ?)",
                (kit_id, user, text, time.time()))

    def reports(self) -> list[dict]:
        """Open reports, grouped by package (most reported first)."""
        rows = self._q("SELECT kit_id, reason, created FROM reports WHERE handled = 0 ORDER BY created")
        grouped: dict[str, dict] = {}
        for kid, reason, created in rows:
            kit = self.kit(kid)
            if kit is None:
                continue
            entry = grouped.setdefault(kid, {**self.summary(kit), "reasons": []})
            entry["reasons"].append({"reason": reason, "created": created})
        return sorted(grouped.values(), key=lambda e: -len(e["reasons"]))

    def dismiss_reports(self, kit_id: str) -> None:
        self._q("UPDATE reports SET handled = 1 WHERE kit_id = ?", (kit_id,))

    def review(self, kit_id: str) -> dict:
        """What waits for the reviewer on one package: the version asking to be public (0 if none) and open reports."""
        version = self._q("SELECT MAX(version) FROM versions WHERE kit_id = ? AND status = 'pending'", (kit_id,))[0][0]
        rows = self._q("SELECT reason, created FROM reports WHERE kit_id = ? AND handled = 0 ORDER BY created", (kit_id,))
        return {"version": version or 0, "reports": [{"reason": r, "created": c} for r, c in rows]}



def demo_project(key: str, still: bool = False):
    """A small scene that shows a package off (its preview): an object fading in (`still`: on screen from the start,
    for a picture of it), one of its animations playing on it, or (a first-format animation) the animation on a
    square."""
    from .session import Session

    s = Session(kits=lambda _key: None)
    sid = s.project.scenes[0].id
    anim = ANIMATIONS.custom.get(key)
    if key in MOBJECTS.custom:
        mob = s.apply("add_mobject", {"scene_id": sid, "type": key})
        if not still:
            s.apply("add_play_step", {"scene_id": sid, "anim": "FadeIn", "target_id": mob})
    elif anim is not None and anim.only:
        mob = s.apply("add_mobject", {"scene_id": sid, "type": anim.only[0]})
        s.apply("add_play_step", {"scene_id": sid, "anim": key, "target_id": mob})
    else:
        mob = s.apply("add_mobject", {"scene_id": sid, "type": "Square"})
        s.apply("set_style", {"scene_id": sid, "mob_id": mob, "name": "fill_opacity", "value": 0.5})
        s.apply("add_play_step", {"scene_id": sid, "anim": key, "target_id": mob})
    s.apply("add_wait_step", {"scene_id": sid})
    s.project.scenes[0].name = "Preview"
    return s.project
