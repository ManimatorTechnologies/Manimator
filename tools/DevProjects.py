"""Dev only: puts the golden test projects (tests/FixtureProjects.py) into a dev server's workspace, to look at them
in the editor. Stop the server first (it keeps the project list in memory), then start it again.

    python tools/DevProjects.py [data dir]      (default .cache/web-data-engine; uses its first workspace)
"""

import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from FixtureProjects import FILES, all_objects  # noqa: E402


def main(argv: list[str]) -> None:
    data_dir = Path(argv[0]) if argv else ROOT / ".cache" / "web-data-engine"
    workspaces = sorted((data_dir / "workspaces").iterdir())
    if not workspaces:
        raise SystemExit(f"no workspace in {data_dir}: open the editor once first")
    ws = workspaces[0]
    index_file = ws / "projects.json"
    index = json.loads(index_file.read_text(encoding="utf-8"))
    (ws / "projects").mkdir(exist_ok=True)
    (ws / "assets").mkdir(exist_ok=True)
    now = time.time()
    for n, (variant, three_d) in enumerate(((False, False), (True, False), (False, True), (True, True))):
        pid = f"f1c7{n:012d}"
        project = all_objects(variant=variant, three_d=three_d)
        (ws / "projects" / f"{pid}.manimator").write_text(json.dumps(project.to_dict()), encoding="utf-8")
        name = f"All objects{' 3D' if three_d else ''}{' (changed)' if variant else ''}"
        index["projects"][pid] = {"name": name, "created": now, "opened": now - n}
    # the uploads they use: a small picture and the SVG test file
    shutil.copy(ROOT / "tests" / "js" / "fixtures" / "svg" / "structure.svg", ws / "assets" / FILES["SVGMobject"])
    from PIL import Image

    Image.new("RGBA", (40, 30), (200, 120, 40, 255)).save(ws / "assets" / FILES["ImageMobject"])
    index_file.write_text(json.dumps(index), encoding="utf-8")
    print(f"{ws.name}: {len(index['projects'])} projects")


if __name__ == "__main__":
    main(sys.argv[1:])
