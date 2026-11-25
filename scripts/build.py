from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json

root = Path(__file__).resolve().parent.parent
version = json.loads((root / "extension" / "manifest.json").read_text())["version"]
target = root / "dist" / f"eq-normalizer-{version}.xpi"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for path in sorted((root / "extension").rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(root / "extension"))
print(target)
