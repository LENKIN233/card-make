#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from run_trusted_media_review import run_review_package


ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "spec" / "trusted-media-runner-lock.json").read_text())


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def general_result(transcript: str, **overrides):
    value = {
        "transcript_heard": transcript,
        "matches_text": True,
        "target_signal_audible": True,
        "accurate_pronunciation": True,
        "suitable_speed": True,
        "natural_rhythm": True,
        "stress_pauses_do_not_mislead": True,
        "no_unwanted_noise_or_clipping": True,
        "notes": "",
    }
    value.update(overrides)
    return repr(value)


class FakeAdapter:
    def __init__(self, *, unresolved=False):
        self.unresolved = unresolved

    def generate(self, audio_path: Path, prompt: str, temperature: float) -> str:
        card_id = audio_path.stem
        expected = f"Sentence one for {card_id}. Sentence two is complete."
        if "Use exactly one key" in prompt:
            return repr({"transcript_heard": expected})
        if "Focus only on English pronunciation" in prompt:
            return repr(
                {
                    "transcript_heard": expected,
                    "accurate_pronunciation": True,
                    "specific_error": "",
                }
            )
        if card_id == "000002":
            return general_result(expected, accurate_pronunciation=False)
        if card_id == "000003":
            return general_result(
                f"Sentence one for {card_id}.",
                matches_text=False,
            )
        if card_id == "000005":
            return general_result(
                f"Sentence one for {card_id}.",
                matches_text=False,
                accurate_pronunciation=False,
            )
        if card_id == "000004":
            if self.unresolved:
                if temperature == 0.0:
                    return general_result(expected, natural_rhythm=False)
                if temperature == 0.1:
                    return general_result(expected, suitable_speed=False)
                return general_result(expected, target_signal_audible=False)
            if temperature == 0.1:
                return general_result(expected, natural_rhythm=False)
        return general_result(expected)


def worklist(asset_root: Path, count=4):
    entries = []
    for index in range(1, count + 1):
        card_id = f"{index:06d}"
        payload = f"audio-{card_id}".encode()
        relative = f"ai_tts/cet4/test/{card_id}.mp3"
        path = asset_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        entries.append(
            {
                "card_id": card_id,
                "entry_identity_sha256": digest(f"entry-{card_id}".encode()),
                "training_context": {"main_training_goal": "listen completely"},
                "audio": {
                    "asset_path": relative,
                    "file_sha256": digest(payload),
                    "transcript": f"Sentence one for {card_id}. Sentence two is complete.",
                },
                "review": {"status": "pending"},
            }
        )
    return {
        "schema_version": "audio-perceptual-worklist.v3",
        "track": "cet4",
        "entries": entries,
    }


class TrustedMediaRunnerTests(unittest.TestCase):
    def test_full_runs_adjudication_and_specialists_produce_passed_decisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = run_review_package(
                worklist=worklist(root, count=5),
                asset_root=root,
                output_dir=root / "output",
                adapter=FakeAdapter(),
                lock=LOCK,
                model_manifest_sha256=digest(b"weights"),
                workflow_run_id="32975067429",
                workflow_run_attempt=1,
                expected_asset_count=5,
            )
            runs = {run["name"]: run for run in package["runs"]}
            self.assertEqual(runs["a"]["card_count"], 5)
            self.assertEqual(runs["b"]["card_count"], 5)
            self.assertEqual(runs["c"]["card_count"], 1)
            self.assertEqual(runs["d"]["card_count"], 2)
            self.assertEqual(runs["e"]["card_count"], 2)
            self.assertEqual(runs["f"]["card_count"], 2)
            self.assertEqual(runs["g"]["card_count"], 2)
            self.assertEqual(package["result"]["passed_card_count"], 5)
            decisions = {item["card_id"]: item for item in package["decisions"]}
            self.assertEqual(decisions["000002"]["acceptance_sources"], [["a", "d"], ["b", "e"]])
            self.assertEqual(decisions["000003"]["acceptance_sources"], [["a", "f"], ["b", "g"]])
            self.assertEqual(decisions["000004"]["acceptance_sources"], [["a"], ["c"]])
            self.assertEqual(
                decisions["000005"]["acceptance_sources"],
                [["a", "d", "f"], ["b", "e", "g"]],
            )
            for run in runs.values():
                self.assertEqual(run["complete_asset_count"], run["card_count"])
                self.assertTrue((root / "output" / run["path"]).is_file())

    def test_unresolved_three_run_disagreement_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "unresolved three-run disagreement"):
                run_review_package(
                    worklist=worklist(root),
                    asset_root=root,
                    output_dir=root / "output",
                    adapter=FakeAdapter(unresolved=True),
                    lock=LOCK,
                    model_manifest_sha256=digest(b"weights"),
                    workflow_run_id="32975067429",
                    workflow_run_attempt=1,
                    expected_asset_count=4,
                )

    def test_exact_asset_hash_mismatch_fails_before_model_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = worklist(root, count=1)
            candidate["entries"][0]["audio"]["file_sha256"] = digest(b"wrong")
            with self.assertRaisesRegex(ValueError, "audio SHA-256 mismatch"):
                run_review_package(
                    worklist=candidate,
                    asset_root=root,
                    output_dir=root / "output",
                    adapter=FakeAdapter(),
                    lock=LOCK,
                    model_manifest_sha256=digest(b"weights"),
                    workflow_run_id="32975067429",
                    workflow_run_attempt=1,
                    expected_asset_count=1,
                )


if __name__ == "__main__":
    unittest.main()
