"""Read-only collection audit using the production scanner and normalizer."""
import argparse
import collections
import csv
import datetime
import json
import math
import os
from pathlib import Path
import re
import subprocess

PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parent.parent
EXTENSIONS = {
    "image": "jpg jpeg png gif bmp webp tiff tif".split(),
    "video": "mp4 mov m4v 3gp 3g2 avi mkv webm mpg mpeg m2v mts m2ts ts wmv".split(),
    "audio": "mp3 flac m4a m4b aac wav aiff ogg opus wma ape".split(),
}
KINDS = {"." + ext: kind for kind, exts in EXTENSIONS.items() for ext in exts}
# Capture/creation evidence only: never filesystem, modification or AI dates.
DATE_PRIORITY = "DateTimeOriginal DateCreated CreationDate ContentCreateDate CreateDate MediaCreateDate TrackCreateDate DateTimeDigitized RecordedDate TimeStamp".split()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def json_lines(path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            yield json.loads(line)


def date_parts(value):
    """Return validated calendar parts, or None (including ExifTool zero dates)."""
    kind, raw = value.get("kind"), value.get("value")
    try:
        if kind == "DateTime":
            d, t = raw["date"], raw["time"]
            parts = (d["year"], d["month"], d["day"], t["hour"], t["minute"], t["second"])
        elif kind == "Date":
            parts = (raw["year"], raw["month"], raw["day"], 0, 0, 0)
        else:
            raw = raw.get("raw") if kind == "Unknown" else raw if kind == "Text" else None
            match = re.match(r"^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?", raw or "")
            if not match:
                return None
            parts = tuple(int(x or 0) for x in match.groups())
        datetime.datetime(*parts)
        return parts if 1900 <= parts[0] <= 2100 else None
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def unwrap(value):
    kind, raw = value.get("kind"), value.get("value")
    if kind == "Unknown":
        return raw.get("raw")
    if kind == "List":
        return [unwrap(v) for v in raw["items"]]
    if kind == "Struct":
        return {k: unwrap(v) for k, v in raw.items()}
    return raw


def valid_gps(lat, lon):
    return (all(isinstance(v, (float, int)) and not isinstance(v, bool) and math.isfinite(v) for v in (lat, lon))
            and abs(lat) <= 90 and abs(lon) <= 180 and (lat, lon) != (0, 0))


def alternative_gps(occurrence):
    tag = (occurrence.get("observed_selector") or {}).get("tag_name")
    value = unwrap(occurrence["value"])
    if tag in ("LocationCreated", "LocationShown"):
        return any(isinstance(v, dict) and valid_gps(v.get("GPSLatitude"), v.get("GPSLongitude"))
                   for v in (value if isinstance(value, list) else [value]))
    if tag in ("GPSCoordinates", "GPSPosition") and isinstance(value, str):
        # Decimal pair, optionally ISO-6709 signed and with altitude. Do not
        # mistake degrees/minutes/seconds or arbitrary embedded digits for a fix.
        match = re.fullmatch(r"\s*([+-]?\d+(?:\.\d+)?)(?:\s*[, ]\s*|(?=[+-]))([+-]\d+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[ ,]+[+-]?\d+(?:\.\d+)?|[+-]\d+(?:\.\d+)?)?/?\s*", value)
        return bool(match and valid_gps(float(match[1]), float(match[2])))
    return False


def inventory(root):
    rows = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in KINDS:
            continue
        if not path.resolve().is_relative_to(root):
            raise ValueError("Media symlink/junction resolves outside collection root")
        stat = path.stat()
        rows.append({"relative_path": path.relative_to(root).as_posix(),
                     "extension": path.suffix.lower(), "media_kind": KINDS[path.suffix.lower()],
                     "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                     "modified": int(stat.st_mtime),
                     "created": int(getattr(stat, "st_birthtime", stat.st_mtime))})
    return rows


def validate_output(root, output):
    if output.is_relative_to(root):
        raise ValueError("Output must be outside the audited collection")
    if output.is_relative_to(REPO) and not output.is_relative_to(PACKAGE / "runs"):
        raise ValueError("Outputs inside the repository must be under experiments/collection_audit/runs (gitignored)")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Output must be new or empty; previous reports are never overwritten")


def prepare_occurrences(out, records):
    lookup = {r["relative_path"]: r for r in records}
    seen = set()
    with (out / "occurrences.jsonl").open("w", encoding="utf-8") as stream:
        for row in json_lines(out / "scan.jsonl"):
            rel = row["relative_path"]
            if rel not in lookup or rel in seen:
                raise ValueError("Unexpected or duplicate scan result")
            seen.add(rel)
            occurrences = row["occurrences"]
            dates = [o for o in occurrences
                     if (o.get("observed_selector") or {}).get("tag_name") in DATE_PRIORITY
                     and date_parts(o["value"]) is not None]
            stream.write(json.dumps({**lookup[rel], "occurrences": occurrences,
                                     "native_dates": dates,
                                     "alternative_gps": [o for o in occurrences if alternative_gps(o)]},
                                    ensure_ascii=False) + "\n")
    if seen != lookup.keys():
        raise ValueError("Missing scan results; audit is incomplete")


def classify(presence, normalizer):
    missing, notes, blocking, changing, requires_ai = [], [], [], [], []
    dates = presence["native_dates"]
    dto = any(d["observed_selector"]["tag_name"] == "DateTimeOriginal" for d in dates)
    gif_date = presence["extension"] == ".gif" and any(
        d["schema_id"] == {"table": "XMP::photoshop", "tag_id": "DateCreated"} for d in dates)
    if not presence["primary_gps"] and not presence["alternative_gps"]:
        missing.append("gps")
    if not presence["primary_gps"] and presence["alternative_gps"]:
        notes.append("gps_in_alternative_fields")
    if not (dto or gif_date if presence["media_kind"] == "image" else bool(dates)):
        missing.append("capture_date")
    if not dto and gif_date:
        notes.append("gif_capture_date_in_xmp")
    for field in ("description", "keywords", "ai_description"):
        if not presence[field]:
            missing.append(field)
    for group, stat in normalizer["stats"]["perGroup"].items():
        if stat.get("nNormalisedDeterministic") or stat.get("nNormalisedAi"):
            changing.append(group)
        if stat.get("nAiErrors"):
            requires_ai.append(group)
        for key, reason in [("nBlocked", "unwritable_output"),
                            ("nLocationCreatedAmbiguous", "ambiguous_location"),
                            ("nUnparseableDateInputs", "unparseable_date")]:
            if stat.get(key):
                blocking.append(group + ":" + reason)
    if normalizer.get("error") and not requires_ai:
        blocking.append("normalizer_error")
    idempotent = not normalizer["edits"] and not requires_ai and not blocking
    return {"relative_path": presence["relative_path"], "media_kind": presence["media_kind"],
            "missing": missing, "notes": notes, "changing_groups": changing,
            "requires_ai_groups": requires_ai, "blocking": blocking,
            "planned_edits": len(normalizer["edits"]), "idempotent": idempotent,
            "conformant": not missing and idempotent}


def counts(rows):
    return {"files": len(rows), "conformant": sum(r["conformant"] for r in rows),
            "non_conformant": sum(not r["conformant"] for r in rows),
            "missing": dict(collections.Counter(f for r in rows for f in r["missing"])),
            "would_change": sum(r["planned_edits"] > 0 for r in rows),
            "idempotent": sum(r["idempotent"] for r in rows),
            "blocked": sum(bool(r["blocking"]) for r in rows),
            "requires_ai": sum(bool(r["requires_ai_groups"]) for r in rows),
            "changing_groups": dict(collections.Counter(g for r in rows for g in r["changing_groups"]))}


def analyse(out, records, root, exclude_folders):
    presence = {r["relative_path"]: r for r in json_lines(out / "presence.jsonl")}
    normalizer = {r["relative_path"]: r for r in json_lines(out / "normaliser-results.jsonl")}
    if presence.keys() != normalizer.keys() or presence.keys() != {r["relative_path"] for r in records}:
        raise ValueError("Audit result coverage does not match inventory")
    rows = [classify(presence[rel], normalizer[rel]) for rel in sorted(presence)]
    current = inventory(root)
    # Check additions/deletions as well as changes; never publish a stale success.
    comparable = lambda rs: {r["relative_path"]: (r["size"], r["mtime_ns"]) for r in rs}
    changed = comparable(current) != comparable(records)
    excluded = lambda r: any(r["relative_path"].startswith(folder + "/") for folder in exclude_folders)
    summary = {**counts(rows), "by_media_kind": {k: counts([r for r in rows if r["media_kind"] == k]) for k in EXTENSIONS},
               "included": counts([r for r in rows if not excluded(r)]),
               "excluded_folders": counts([r for r in rows if excluded(r)]),
               "collection_changed_during_audit": changed,
               "complete": not changed, "source": "fresh production ExifTool scans; saved metadata only"}
    write_json(out / "file-results.json", rows)
    write_json(out / "summary.json", summary)
    with (out / "file-results.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["relative_path", "media_kind", "missing", "notes", "changing_groups", "requires_ai_groups", "blocking", "planned_edits", "idempotent", "conformant"])
        writer.writeheader()
        writer.writerows({k: "; ".join(v) if isinstance(v, list) else v for k, v in r.items()} for r in rows)
    text = ["# Collection metadata audit", "", f"Complete: **{not changed}**. {summary['conformant']:,} of {summary['files']:,} files conform; {summary['non_conformant']:,} do not.", "",
            "| Media | Files | Pass | Fail | Would change | Blocked | Needs AI |",
            "|---|---:|---:|---:|---:|---:|---:|"]
    for kind, c in summary["by_media_kind"].items():
        text.append(f"| {kind} | {c['files']} | {c['conformant']} | {c['non_conformant']} | {c['would_change']} | {c['blocked']} | {c['requires_ai']} |")
    text += ["", "Required presence: usable GPS, capture date, description/caption, keywords and AI description. Images require DateTimeOriginal; GIFs may use XMP-photoshop:DateCreated. Videos/audio may use a usable native capture/creation date. Structured and container GPS count. Zero/invalid coordinates and dates do not count.", "",
             "Idempotence uses all nine current production normalization groups, including unwritable-output policy. No AI client is supplied: a required AI decision is unresolved, not a pass. No drafts are read, staged or applied. No media are written. Scanner configuration may be materialised in the normal application cache.", "",
             "This checks metadata presence and normalization consistency, not factual correctness of dates, locations or AI descriptions. Creation timestamps can represent encoding/finalization rather than exposure. Filesystem dates are not capture-date evidence.", "",
             "All media were freshly scanned. Inventory paths, sizes and nanosecond modification times were checked again after the run; additions/deletions invalidate completeness. `file-results.csv` lists every file and reason. `normaliser-results.jsonl` retains edits, conflicts and blocked-field evidence. Optional folder exclusions affect the separate included totals only; full totals always cover every file.", "",
             "Outputs contain private paths and metadata. Keep the run directory private; commit only the generic tool and synthetic tests."]
    (out / "report.md").write_text("\n".join(text) + "\n", encoding="utf-8")
    if changed:
        raise ValueError("Collection changed during audit; results marked incomplete")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--exclude-folder", action="append", default=[], help="Relative folder separated in included totals, e.g. Assets")
    parser.add_argument("--target-dir", type=Path, help="Optional shared Cargo build directory")
    args = parser.parse_args()
    root, out = args.root.resolve(strict=True), args.output.resolve()
    if not root.is_dir():
        parser.error("Root must be a directory")
    validate_output(root, out)
    excluded = []
    for folder in args.exclude_folder:
        relative = Path(folder)
        if relative.is_absolute() or ".." in relative.parts:
            parser.error("Excluded folders must be relative to root")
        excluded.append(relative.as_posix().strip("/"))
    out.mkdir(parents=True, exist_ok=True)
    records = inventory(root)
    write_json(out / "inventory.json", records)
    cargo = ["cargo", "run", "--manifest-path", str(PACKAGE / "Cargo.toml")]
    if args.target_dir:
        cargo += ["--target-dir", str(args.target_dir.resolve())]
    def run(command):
        subprocess.run(command, cwd=REPO, check=True, env={**os.environ, "LC_ALL": "C", "LANG": "C"})
    run(cargo + ["--", "schema", str(out)])
    run(cargo + ["--", "scan", str(out), str(root)])
    prepare_occurrences(out, records)
    run(["node", str(REPO / "node_modules/esbuild/bin/esbuild"), str(PACKAGE / "build-inputs.ts"), "--bundle", "--platform=node", "--format=esm", "--outfile=" + str(out / "build-inputs.mjs")])
    run(["node", str(out / "build-inputs.mjs"), str(out)])
    run(cargo + ["--", "run", str(out)])
    summary = analyse(out, records, root, excluded)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
