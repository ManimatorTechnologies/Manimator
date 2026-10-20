"""Vendor the pinned JavaScript the browser engine uses into manimator/web/vendor/ (dev tool, needs npm).

    python tools/vendor_manim_web.py            # download, check and copy every package below
    python tools/vendor_manim_web.py --check    # only verify the vendored files against their SHA256SUMS

For each package: `npm pack` the pinned release into a temporary folder, check its integrity hash, unpack it, copy
the files the engine uses, write SHA256SUMS, and report anything that would break the site's Content-Security-Policy
or reach another site (URLs in code, eval / new Function, WebAssembly, Workers).

- manim-web: only its prebuilt, self-contained chunks: MathJax (TeX to SVG, with the New Computer Modern font) and
  the MP4 / WebM muxers. Manimator draws with its own Canvas2D renderer (web/js/engine/), which follows Manim's
  Cairo drawing model; manim-web's three.js renderer is not used (see docs/browser-engine.md).
- opentype.js: reads the DejaVu fonts' glyph outlines for Text.

Upgrading: pin the new version and its integrity hash here, vendor it next to the old one, run the browser tests
and tools/parity_report.py, then change the paths in web/js/engine/mw/lib.js.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "manimator" / "web" / "vendor"


@dataclass(frozen=True)
class Package:
    name: str
    version: str
    integrity: str
    files: tuple[str, ...]  # under the package; a trailing "*" matches a hashed chunk name
    folder: str  # under VENDOR
    notes: str = ""


PACKAGES = [
    Package("manim-web", "0.33.0",
            "sha512-A4k1veDZIn2269bcIlO88wRjJzvlZzFr+fGLiLaucMkIlySLdAZ2tJd7RRnqyLkuOSbrLYbvIwL+qXbU9hBpxQ==",
            ("dist/MathJaxBundle-*", "dist/mp4-muxer-*", "dist/webm-muxer-*", "LICENSE"), "manim-web/0.33.0",
            "Prebuilt chunks of manim-web: MathJax 4 (Apache-2.0, MathJax Consortium) with the New Computer Modern "
            "font, mp4-muxer and webm-muxer (MIT, Vanilagy). The LICENSE file is manim-web's own (MIT)."),
    Package("@mathjax/mathjax-newcm-font", "4.1.3",
            "sha512-gzAB3dFHilHX1l5x2xUqRL+1jDQt3Fyza1DkEMVXWC4E8SvsGdlgEza47HYi2WhVcgfkvf4zgUGzuhbq3Pjlew==",
            ("svg/dynamic/*.js",), "mathjax-newcm/4.1.3",
            "The font ranges MathJax loads on demand (double-struck, calligraphic, fraktur, script, extra arrows and "
            "symbols...), for the MathJax 4.1.3 in manim-web's chunk, whose built-in glyphs are this release's. Each "
            "file is turned into JSON here (they only call MathJaxNewcmFont.dynamicSetup with glyph data); "
            "engine/mw/mathjax.js registers them. Apache-2.0, MathJax Consortium."),
    Package("opentype.js", "2.0.0",
            "sha512-kCyjv6xdDY1W/jLWZ/L3QhhTlKUqDZMQ5+Jdlw12b3dXkKNpYBqqlMMj0YDQPShWFTMwgZI1hG14kN3XUDSg/A==",
            ("dist/opentype.min.mjs", "LICENSE"), "opentype/2.0.0", "opentype.js (MIT, Frederik De Bleser)."),
]

URL = re.compile(r"https?://[A-Za-z0-9.\-]+(?:/[^\s\"'`)<>]*)?")
HARMLESS_URL = re.compile(r"^https?://(www\.w3\.org|github\.com|docs\.microsoft\.com|www\.microsoft\.com|"
                          r"unicode\.org|typophile\.com)")
RISKS = {"eval": re.compile(r"\beval\s*\("), "new Function": re.compile(r"\bnew\s+Function\s*\("),
         "WebAssembly": re.compile(r"\bWebAssembly\b"), "Worker": re.compile(r"\bnew\s+(Shared)?Worker\s*\("),
         "import": re.compile(r"\bimport\s*\(|^\s*import\s", re.M)}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def npm_pack(pkg: Package, into: Path) -> Path:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        raise SystemExit("npm is needed to download the packages")
    out = subprocess.run([npm, "pack", f"{pkg.name}@{pkg.version}", "--json"], cwd=into, capture_output=True,
                         text=True, check=True)
    tgz = into / json.loads(out.stdout)[0]["filename"]
    digest = "sha512-" + base64.b64encode(hashlib.sha512(tgz.read_bytes()).digest()).decode()
    if digest != pkg.integrity:
        raise SystemExit(f"integrity mismatch for {pkg.name}@{pkg.version}:\n  got      {digest}\n"
                         f"  expected {pkg.integrity}")
    return tgz


def pick(package_dir: Path, pattern: str) -> list[Path]:
    if pattern.endswith("/*.js"):  # a whole folder
        return sorted(package_dir.glob(pattern))
    if pattern.endswith("*"):  # one hashed chunk
        found = sorted(package_dir.glob(pattern + ".js"))
        if len(found) != 1:
            raise SystemExit(f"expected one file for {pattern}, found {[p.name for p in found]}")
        return found
    return [package_dir / pattern]


# Runs each MathJax font range file with a stand-in MathJax object and prints the arguments it passes to
# dynamicSetup (font prefix, range name, glyphs by variant, stretchy delimiters...), as JSON.
_FONT_TO_JSON = r"""
const fs = require("fs"), vm = require("vm");
const calls = [];
const font = { dynamicSetup: (...args) => calls.push(args) };
// MathJax's output/common/Direction: stretchy characters name their direction with these.
const Direction = { DIRECTION: { None: "", Vertical: "v", Horizontal: "h" }, V: "v", H: "h" };
const sandbox = { MathJax: { _: { output: { common: { Direction },
  fonts: { "mathjax-newcm": { svg_ts: { MathJaxNewcmFont: font } } } } } } };
vm.runInNewContext(fs.readFileSync(process.argv[1], "utf8"), sandbox, { timeout: 10000 });
if (calls.length !== 1) throw new Error("expected one dynamicSetup call, got " + calls.length);
process.stdout.write(JSON.stringify({ name: calls[0][1], args: calls[0] }));
"""


def font_ranges_to_json(target: Path) -> None:
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise SystemExit("node is needed to convert the MathJax font ranges")
    for src in sorted(target.glob("*.js")):
        out = subprocess.run([node, "-e", _FONT_TO_JSON, str(src)], capture_output=True, text=True, check=True)
        data = json.loads(out.stdout)
        if data["name"] != src.stem:
            raise SystemExit(f"{src.name} registers {data['name']!r}")
        src.with_suffix(".json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8", newline="\n")
        src.unlink()


def scan(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    urls = sorted({u.rstrip(".,;") for u in URL.findall(text) if not HARMLESS_URL.match(u)})
    risks = {k: len(r.findall(text)) for k, r in RISKS.items() if r.search(text)}
    return {"urls": urls, "risks": risks} if urls or risks else {}


def write_sums(folder: Path) -> None:
    lines = [f"{sha256(p)}  {p.name}" for p in sorted(folder.iterdir()) if p.is_file() and p.name != "SHA256SUMS"]
    (folder / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def check(folder: Path) -> bool:
    ok = True
    for line in (folder / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        path = folder / name
        if not path.exists() or sha256(path) != digest:
            print(f"MISMATCH {folder.name}/{name}")
            ok = False
    return ok


def vendor(pkg: Package) -> None:
    target = VENDOR / pkg.folder
    with tempfile.TemporaryDirectory(prefix="vendor-") as tmp:
        tmp = Path(tmp)
        with tarfile.open(npm_pack(pkg, tmp)) as tar:
            tar.extractall(tmp / "x", filter="data")
        package_dir = tmp / "x" / "package"
        sources = [src for f in pkg.files for src in pick(package_dir, f)]
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        for src in sources:
            shutil.copyfile(src, target / src.name)
        if pkg.name == "@mathjax/mathjax-newcm-font":
            font_ranges_to_json(target)
    (target / "SOURCE.md").write_text(f"# {pkg.name} {pkg.version}\n\nFrom npm, integrity `{pkg.integrity}`, "
                                      f"copied by tools/vendor_manim_web.py.\n\n{pkg.notes}\n", encoding="utf-8",
                                      newline="\n")
    write_sums(target)
    size = sum(p.stat().st_size for p in target.iterdir())
    print(f"{pkg.name} {pkg.version}: {len(sources)} files, {size / 1e6:.1f} MB -> {target.relative_to(ROOT)}")
    for p in sorted(target.glob("*js")):
        found = scan(p)
        for url in found.get("urls", []):
            print(f"  {p.name}: url {url}")
        for risk, n in found.get("risks", {}).items():
            print(f"  {p.name}: {risk} x{n}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="verify the vendored files only")
    args = ap.parse_args()
    if args.check:
        ok = all(check(VENDOR / p.folder) for p in PACKAGES)
        print("vendored files ok" if ok else "vendored files changed")
        sys.exit(0 if ok else 1)
    for pkg in PACKAGES:
        vendor(pkg)


if __name__ == "__main__":
    main()
