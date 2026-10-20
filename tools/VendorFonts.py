"""Copy the fonts the browser engine draws Text with into manimator/web/fonts/<family>/ (dev tool).

    python tools/VendorFonts.py dejavu <folder holding DejaVuSans.ttf ...>
    python tools/VendorFonts.py extra <folder holding the npm font packages, unpacked>

DejaVu: Sans, Sans Mono and Serif, regular and bold, exactly fonts-dejavu-core (what Manim's Pango has on a plain
Linux server). matplotlib ships the same family (mpl-data/fonts/ttf), which is a convenient source.

extra: the other families, regular, bold, italic and bold italic each, from these npm packages (unpacked next to
each other, each in <name>-<version>/package/): @expo-google-fonts/crimson-pro 0.4.2, stix-two-text 0.4.2,
tinos 0.4.2, source-serif-4 0.4.2, inter 0.4.2, source-sans-3 0.4.2, ibm-plex-sans 0.4.1, lato 0.4.1 (Google Fonts
builds), geist 1.7.2 (Vercel) and computer-modern 0.1.3 (CMU Serif). All are under the SIL Open Font License.

Each folder gets the fonts, the licence and SHA256SUMS. The family list must match FONT_FILES in
manimator/web/js/engine/manim/fonts.js and FONTS in manimator/server/catalog.py.
"""

from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "manimator" / "web" / "fonts"
# fonts-dejavu-core has no italic faces, so fontconfig slants the upright glyphs (a 0.2 shear) for italic text,
# and the browser does the same.
DEJAVU = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf", "DejaVuSerif.ttf",
          "DejaVuSerif-Bold.ttf"]
FACES = ("Regular", "Bold", "Italic", "BoldItalic")
EXPO_WEIGHTS = ("400Regular", "700Bold", "400Regular_Italic", "700Bold_Italic")


def _expo(package: str, prefix: str) -> tuple[list[str], str]:
    return [f"{package}/package/{w}/{prefix}_{w}.ttf" for w in EXPO_WEIGHTS], f"{package}/package/LICENSE_FONT"


# folder -> (file name prefix, source files in FACES order, licence)
EXTRA = {
    "crimson-pro": ("CrimsonPro", *_expo("crimson-pro-0.4.2", "CrimsonPro")),
    "stix-two-text": ("STIXTwoText", *_expo("stix-two-text-0.4.2", "STIXTwoText")),
    "tinos": ("Tinos", *_expo("tinos-0.4.2", "Tinos")),
    "cmu-serif": ("CMUSerif", [f"computer-modern-0.1.3/package/fonts/cmu-serif-{f}.ttf"
                               for f in ("500-roman", "700-roman", "500-italic", "700-italic")],
                  "computer-modern-0.1.3/package/OFL.txt"),
    "source-serif-4": ("SourceSerif4", *_expo("source-serif-4-0.4.2", "SourceSerif4")),
    "inter": ("Inter", *_expo("inter-0.4.2", "Inter")),
    "geist": ("Geist", [f"geist-1.7.2/package/dist/fonts/geist-sans/Geist-{f}.ttf" for f in FACES],
              "geist-1.7.2/package/LICENSE.txt"),
    "source-sans-3": ("SourceSans3", *_expo("source-sans-3-0.4.2", "SourceSans3")),
    "ibm-plex-sans": ("IBMPlexSans", *_expo("ibm-plex-sans-0.4.1", "IBMPlexSans")),
    "lato": ("Lato", *_expo("lato-0.4.1", "Lato")),
}


def _sums(folder: Path) -> None:
    names = sorted(p.name for p in folder.iterdir() if p.name != "SHA256SUMS")
    sums = [f"{hashlib.sha256((folder / n).read_bytes()).hexdigest()}  {n}" for n in names]
    (folder / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8", newline="\n")


def dejavu(source: Path) -> None:
    target = FONTS / "dejavu"
    target.mkdir(parents=True, exist_ok=True)
    for name in DEJAVU:
        shutil.copyfile(source / name, target / name)
    licence = next((p for p in (source / "LICENSE_DEJAVU", source / "LICENSE") if p.exists()), None)
    if licence is None:
        raise SystemExit("the DejaVu licence file was not found next to the fonts")
    shutil.copyfile(licence, target / "LICENSE")
    _sums(target)
    print(f"{len(DEJAVU)} fonts -> {target.relative_to(ROOT)}")


def extra(source: Path) -> None:
    for folder, (prefix, files, licence) in EXTRA.items():
        target = FONTS / folder
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True)
        for face, src in zip(FACES, files):
            shutil.copyfile(source / src, target / f"{prefix}-{face}.ttf")
        shutil.copyfile(source / licence, target / "OFL.txt")
        _sums(target)
        print(f"{prefix}: 4 fonts -> {target.relative_to(ROOT)}")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("dejavu", "extra"):
        raise SystemExit(__doc__)
    (dejavu if sys.argv[1] == "dejavu" else extra)(Path(sys.argv[2]))
