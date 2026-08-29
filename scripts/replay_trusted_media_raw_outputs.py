#!/usr/bin/env python3
"""Replay retained trusted-media model responses against packaged results."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from run_trusted_media_review import (
    parse_general,
    parse_pronunciation,
    parse_transcript,
    transcript_similarity,
)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def replay_record(record, purpose: str, expected_transcript: str, threshold: float):
    raw_outputs = record.get("raw_outputs")
    if (
        not isinstance(raw_outputs, list)
        or not 1 <= len(raw_outputs) <= 2
        or any(not isinstance(raw, str) or not raw.strip() or len(raw) > 1024 * 1024 for raw in raw_outputs)
    ):
        raise ValueError("raw_outputs must contain one or two bounded non-empty strings")
    parser = {
        "full_perceptual": parse_general,
        "adjudication": parse_general,
        "pronunciation": parse_pronunciation,
        "blind_transcript": parse_transcript,
    }.get(purpose)
    if parser is None:
        raise ValueError(f"unsupported run purpose: {purpose}")
    parsed = parser(raw_outputs[-1])
    if purpose in {"full_perceptual", "adjudication"}:
        parsed["notes"] = ""
        if transcript_similarity(expected_transcript, parsed["transcript_heard"]) < threshold:
            parsed["matches_text"] = False
    if parsed != record.get("result"):
        raise ValueError("packaged result does not replay the final retained raw output")


def replay_package(run_package_path: Path, run_root: Path, worklist_path: Path, lock_path: Path):
    package = load_json(run_package_path)
    worklist = load_json(worklist_path)
    lock = load_json(lock_path)
    entries = {str(entry["card_id"]): entry for entry in worklist.get("entries", [])}
    replayed = 0
    for run in package.get("runs", []):
        run_path = (run_root / run["path"]).resolve()
        if run_root.resolve() not in run_path.parents or not run_path.is_file() or run_path.is_symlink():
            raise ValueError(f"unsafe run path: {run.get('path')}")
        for line in run_path.read_text(encoding="utf-8").splitlines():
            if not line:
                continue
            record = json.loads(line)
            entry = entries.get(str(record.get("card_id")))
            if entry is None:
                raise ValueError("run record has no exact worklist entry")
            replay_record(
                record,
                run["purpose"],
                entry["audio"]["transcript"],
                lock["transcript_similarity_threshold"],
            )
            replayed += 1
    return {"schema_version": "trusted-media-raw-replay.v1", "ok": True, "records": replayed}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-package", required=True, type=Path)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--worklist", required=True, type=Path)
    parser.add_argument("--lock", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(replay_package(
        args.run_package,
        args.run_root,
        args.worklist,
        args.lock,
    ), sort_keys=True))


if __name__ == "__main__":
    main()
