"""Synthetic policy checks; no personal media, cache or API required."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import audit


def dt(year=2020):
    return {"kind": "DateTime", "value": {"date": {"year": year, "month": 2, "day": 3},
            "time": {"hour": 12, "minute": 30, "second": 0}}}


def occurrence(tag="DateTimeOriginal", value=None):
    return {"observed_selector": {"tag_name": tag},
            "schema_id": {"table": "Exif::Main", "tag_id": "36867"},
            "value": value or dt()}


def presence():
    return {"relative_path": "2020/sample.jpg", "media_kind": "image", "extension": ".jpg",
            "native_dates": [occurrence()], "primary_gps": True, "alternative_gps": [],
            "description": True, "keywords": True, "ai_description": True}


def normalizer():
    return {"stats": {"perGroup": {}}, "edits": [], "error": None}


class AuditPolicyTests(unittest.TestCase):
    def test_consistent_file_passes(self):
        self.assertTrue(audit.classify(presence(), normalizer())["conformant"])

    def test_absent_unwritable_outputs_do_not_invent_a_failure(self):
        p = presence()
        p.update(extension=".gif", primary_gps=False, alternative_gps=[{"synthetic": True}])
        p["native_dates"] = [{**occurrence("DateCreated"), "schema_id": {"table": "XMP::photoshop", "tag_id": "DateCreated"}}]
        result = audit.classify(p, normalizer())
        self.assertTrue(result["conformant"])
        self.assertIn("gif_capture_date_in_xmp", result["notes"])

    def test_existing_unwritable_mismatch_blocks_even_without_edits(self):
        n = normalizer()
        n["stats"]["perGroup"]["title"] = {"nBlocked": 1}
        r = audit.classify(presence(), n)
        self.assertFalse(r["idempotent"])
        self.assertEqual(r["blocking"], ["title:unwritable_output"])

    def test_needed_ai_is_unresolved(self):
        n = normalizer()
        n["stats"]["perGroup"]["description"] = {"nAiErrors": 1}
        self.assertFalse(audit.classify(presence(), n)["conformant"])

    def test_dates_use_native_video_evidence_but_images_need_capture_source(self):
        p = presence()
        p["native_dates"] = [occurrence("CreateDate")]
        self.assertIn("capture_date", audit.classify(p, normalizer())["missing"])
        p.update(media_kind="video", extension=".mp4")
        self.assertNotIn("capture_date", audit.classify(p, normalizer())["missing"])

    def test_zero_and_invalid_dates_are_not_evidence(self):
        for value in [dt(0), {"kind": "Text", "value": "0000:00:00 00:00:00"},
                      {"kind": "Text", "value": "2020:02:31 12:00:00"},
                      {"kind": "Text", "value": "2020:01:01 25:00:00"}]:
            self.assertIsNone(audit.date_parts(value))
        self.assertEqual(audit.date_parts({"kind": "Unknown", "value": {"raw": "2020:02:03 12:30:00Z"}}),
                         (2020, 2, 3, 12, 30, 0))

    def test_zero_or_nonfinite_gps_is_not_evidence(self):
        for lat, lon in [(0, 0), (float("nan"), 1), (1, float("inf")), (91, 0), (True, 1)]:
            self.assertFalse(audit.valid_gps(lat, lon))
        self.assertTrue(audit.valid_gps(0, 1))

    def test_container_gps_is_a_coordinate_pair_not_arbitrary_numbers(self):
        for raw in ["51.5 -0.1", "+51.5-000.1+000.0/", "51.5, -0.1"]:
            o = occurrence("GPSCoordinates", {"kind": "Text", "value": raw})
            self.assertTrue(audit.alternative_gps(o), raw)
        for raw in ["0 0", "broken 12 34", "51 deg 30 N 0 deg 6 W", "515"]:
            o = occurrence("GPSCoordinates", {"kind": "Text", "value": raw})
            self.assertFalse(audit.alternative_gps(o), raw)

    def test_read_only_presence_does_not_mean_complete_metadata(self):
        p = presence()
        p["description"] = False
        r = audit.classify(p, normalizer())
        self.assertTrue(r["idempotent"])
        self.assertFalse(r["conformant"])
        self.assertEqual(r["missing"], ["description"])

    def test_output_cannot_overwrite_source_or_previous_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with self.assertRaises(ValueError):
                audit.validate_output(root, root / "report")
            with self.assertRaises(ValueError):
                audit.validate_output(root, audit.REPO / "private-report")
            out = root / "existing"
            out.mkdir()
            (out / "report.md").write_text("old report", encoding="utf-8")
            with self.assertRaises(ValueError):
                audit.validate_output(root / "collection", out)

    def test_collection_change_prevents_success_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            p = presence()
            audit.write_json(out / "inventory.json", [])
            (out / "presence.jsonl").write_text(json.dumps(p) + "\n", encoding="utf-8")
            n = {**normalizer(), "relative_path": p["relative_path"]}
            (out / "normaliser-results.jsonl").write_text(json.dumps(n) + "\n", encoding="utf-8")
            records = [{"relative_path": p["relative_path"], "size": 10, "mtime_ns": 20}]
            with patch.object(audit, "inventory", return_value=[]):
                with self.assertRaises(ValueError):
                    audit.analyse(out, records, out / "media", [])
            self.assertFalse(audit.read_json(out / "summary.json")["complete"])

    def test_inputs_are_not_modified_by_classification(self):
        p, n = presence(), normalizer()
        snapshot = copy.deepcopy((p, n))
        audit.classify(p, n)
        self.assertEqual((p, n), snapshot)


if __name__ == "__main__":
    unittest.main()
