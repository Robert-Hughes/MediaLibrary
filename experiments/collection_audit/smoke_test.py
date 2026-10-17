"""Exercise real ExifTool reads and production normalization on fixture copies."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parent.parent


def fingerprint(path):
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path)
    args = parser.parse_args()
    extra = ["--target-dir", str(args.target_dir.resolve())] if args.target_dir else []
    fixtures = [REPO / "test_images" / name for name in
                ("keywords_basic.jpg", "gps_decimal_rational.jpg", "langalt_description.jpg")]
    original = {p: fingerprint(p) for p in fixtures}
    with tempfile.TemporaryDirectory(prefix="collection-audit-smoke-") as tmp:
        temp = Path(tmp).resolve()
        root = temp / "media"
        root.mkdir()
        for source in fixtures:
            shutil.copy2(source, root / source.name)
        before = {p.name: fingerprint(p) for p in root.iterdir()}
        command = [sys.executable, "-B", str(PACKAGE / "audit.py")]
        subprocess.run(command + ["--root", str(root), "--output", str(temp / "report")] + extra,
                       check=True, cwd=REPO)
        summary = json.loads((temp / "report/summary.json").read_text(encoding="utf-8"))
        assert summary["complete"] and summary["files"] == 3
        assert summary["missing"]["gps"] == 2
        assert summary["missing"]["ai_description"] == 3
        assert {p.name: fingerprint(p) for p in root.iterdir()} == before

        empty = temp / "empty"
        empty.mkdir()
        subprocess.run(command + ["--root", str(empty), "--output", str(temp / "empty-report")] + extra,
                       check=True, cwd=REPO)
        empty_summary = json.loads((temp / "empty-report/summary.json").read_text(encoding="utf-8"))
        assert empty_summary["complete"] and empty_summary["files"] == 0

        broken = temp / "broken"
        broken.mkdir()
        (broken / "empty.jpg").write_bytes(b"")
        failure = subprocess.run(command + ["--root", str(broken), "--output", str(temp / "failed-report")] + extra,
                                 cwd=REPO, capture_output=True)
        assert failure.returncode != 0
        assert b"Metadata scan incomplete" in failure.stderr
        assert not (temp / "failed-report/summary.json").exists()
        assert (broken / "empty.jpg").read_bytes() == b""
    assert {p: fingerprint(p) for p in fixtures} == original
    print("Real ExifTool smoke checks passed: three fixtures, empty collection, read failure; all source bytes and timestamps unchanged")


if __name__ == "__main__":
    main()
