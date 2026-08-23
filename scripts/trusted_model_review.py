#!/usr/bin/env python3
"""Aggregate two structured Codex Action reviews over one immutable PR diff.

The model calls happen in separate, fresh GitHub Actions jobs. This module does
not call a provider and does not trust pull-request code: the aggregate job
runs this copy from the exact base commit and reads the head only as a Git
object before validating both ``final-message`` values fail closed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


SCHEMA_VERSION = "trusted-codex-action-review.v1"
GATE_SCHEMA_VERSION = "trusted-model-review-gate.v1"
ACTION_REPOSITORY = "openai/codex-action"
ACTION_COMMIT = "86365089eb2b84e0a8fb0717b304f8bdcb13b20e"
MODEL = "gpt-5.6-sol"
CODEX_VERSION = "0.149.0"
EFFORT = "high"
PERMISSION_PROFILE = ":read-only"
SAFETY_STRATEGY = "drop-sudo"
EXPECTED_JOBS = {1: "trusted-review-1", 2: "trusted-review-2"}
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
WORKFLOW_ID = re.compile(r"^[1-9][0-9]{0,39}$")
MAX_FINAL_MESSAGE_BYTES = 256 * 1024


class ReviewFailure(RuntimeError):
    """A fail-closed aggregate error safe to print in CI."""


@dataclass(frozen=True)
class ExactDiff:
    base_sha: str
    head_sha: str
    sha256: str
    byte_length: int


def _git(repo: Path, *arguments: str) -> bytes:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_PAGER": "cat",
            "LC_ALL": "C",
        }
    )
    completed = subprocess.run(
        ["git", *arguments],
        cwd=repo,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise ReviewFailure("trusted Git object inspection failed")
    return completed.stdout


def build_exact_diff(repo: Path, base_sha: str, head_sha: str) -> ExactDiff:
    """Recompute the byte-for-byte patch identity from exact commit objects."""

    if not SHA.fullmatch(base_sha) or not SHA.fullmatch(head_sha):
        raise ReviewFailure("base and head must be lowercase 40-character Git SHAs")
    for commit_sha in (base_sha, head_sha):
        resolved = _git(repo, "rev-parse", "--verify", f"{commit_sha}^{{commit}}")
        if resolved.decode("ascii", errors="strict").strip() != commit_sha:
            raise ReviewFailure("reviewed Git object does not match the requested commit")
    patch = _git(
        repo,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        base_sha,
        head_sha,
        "--",
    )
    return ExactDiff(
        base_sha=base_sha,
        head_sha=head_sha,
        sha256=hashlib.sha256(patch).hexdigest(),
        byte_length=len(patch),
    )


def _exact_object(value: object, expected: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != expected:
        raise ReviewFailure(f"{label} does not match the trusted review schema")
    return value


def _nonempty_string(value: object, *, maximum: int, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ReviewFailure(f"{label} does not match the trusted review schema")
    return value


def _validate_findings(value: object, *, label: str, allow_high: bool) -> list[dict]:
    if not isinstance(value, list) or len(value) > 100:
        raise ReviewFailure(f"{label} does not match the trusted review schema")
    expected = {"id", "severity", "title", "path", "line", "rationale", "remediation"}
    allowed_severities = {"critical", "high", "medium", "low", "info"}
    for index, raw_finding in enumerate(value):
        finding = _exact_object(raw_finding, expected, f"{label}[{index}]")
        if finding["severity"] not in allowed_severities:
            raise ReviewFailure(f"{label}[{index}] has an invalid severity")
        if not allow_high and finding["severity"] in {"critical", "high"}:
            raise ReviewFailure("critical/high findings cannot be hidden as non-blocking")
        _nonempty_string(finding["id"], maximum=80, label=f"{label}[{index}].id")
        _nonempty_string(finding["title"], maximum=240, label=f"{label}[{index}].title")
        _nonempty_string(finding["path"], maximum=1024, label=f"{label}[{index}].path")
        _nonempty_string(
            finding["rationale"], maximum=4000, label=f"{label}[{index}].rationale"
        )
        _nonempty_string(
            finding["remediation"], maximum=4000, label=f"{label}[{index}].remediation"
        )
        line = finding["line"]
        if line is not None and (
            not isinstance(line, int) or isinstance(line, bool) or line < 1
        ):
            raise ReviewFailure(f"{label}[{index}].line is invalid")
    return value


def parse_review(
    raw: str,
    *,
    diff: ExactDiff,
    reviewer_run: int,
    workflow_run_id: str,
    workflow_run_attempt: str,
) -> dict:
    """Parse and validate one Codex Action ``final-message`` exactly."""

    if not isinstance(raw, str) or not raw.strip():
        raise ReviewFailure(f"reviewer run {reviewer_run} final-message is empty")
    if len(raw.encode("utf-8")) > MAX_FINAL_MESSAGE_BYTES:
        raise ReviewFailure(f"reviewer run {reviewer_run} final-message is too large")
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        raise ReviewFailure(f"reviewer run {reviewer_run} final-message is not exact JSON") from None

    review = _exact_object(
        decoded,
        {
            "schema_version",
            "reviewer_run",
            "base_sha",
            "head_sha",
            "diff_sha256",
            "decision",
            "summary",
            "provenance",
            "blocking_findings",
            "non_blocking_findings",
        },
        f"reviewer run {reviewer_run}",
    )
    bindings = {
        "schema_version": SCHEMA_VERSION,
        "reviewer_run": reviewer_run,
        "base_sha": diff.base_sha,
        "head_sha": diff.head_sha,
        "diff_sha256": diff.sha256,
    }
    if any(review[key] != value for key, value in bindings.items()):
        raise ReviewFailure(f"reviewer run {reviewer_run} is not bound to the exact diff")
    if not isinstance(review["diff_sha256"], str) or not DIGEST.fullmatch(review["diff_sha256"]):
        raise ReviewFailure(f"reviewer run {reviewer_run} has an invalid diff digest")
    _nonempty_string(review["summary"], maximum=4000, label="review summary")

    provenance = _exact_object(
        review["provenance"],
        {
            "provider",
            "action_repository",
            "action_commit",
            "workflow_run_id",
            "workflow_run_attempt",
            "job",
            "codex_version",
            "model",
            "effort",
            "permission_profile",
            "safety_strategy",
        },
        f"reviewer run {reviewer_run} provenance",
    )
    provenance_bindings = {
        "provider": "openai_responses_api",
        "action_repository": ACTION_REPOSITORY,
        "action_commit": ACTION_COMMIT,
        "workflow_run_id": workflow_run_id,
        "workflow_run_attempt": workflow_run_attempt,
        "job": EXPECTED_JOBS[reviewer_run],
        "codex_version": CODEX_VERSION,
        "model": MODEL,
        "effort": EFFORT,
        "permission_profile": PERMISSION_PROFILE,
        "safety_strategy": SAFETY_STRATEGY,
    }
    if any(provenance[key] != value for key, value in provenance_bindings.items()):
        raise ReviewFailure(f"reviewer run {reviewer_run} has invalid action/job provenance")

    blocking = _validate_findings(
        review["blocking_findings"],
        label=f"reviewer run {reviewer_run} blocking findings",
        allow_high=True,
    )
    _validate_findings(
        review["non_blocking_findings"],
        label=f"reviewer run {reviewer_run} non-blocking findings",
        allow_high=False,
    )
    if review["decision"] not in {"passed", "blocked"}:
        raise ReviewFailure(f"reviewer run {reviewer_run} has an invalid decision")
    if blocking or review["decision"] != "passed":
        raise ReviewFailure(f"reviewer run {reviewer_run} reported a blocking finding")
    return review


def aggregate_reviews(
    diff: ExactDiff,
    raw_reviews: tuple[str, str],
    *,
    workflow_run_id: str,
    workflow_run_attempt: str,
) -> dict:
    if not WORKFLOW_ID.fullmatch(workflow_run_id):
        raise ReviewFailure("workflow run id is invalid")
    if not WORKFLOW_ID.fullmatch(workflow_run_attempt):
        raise ReviewFailure("workflow run attempt is invalid")
    reviews = [
        parse_review(
            raw,
            diff=diff,
            reviewer_run=index,
            workflow_run_id=workflow_run_id,
            workflow_run_attempt=workflow_run_attempt,
        )
        for index, raw in enumerate(raw_reviews, start=1)
    ]
    provenance_keys = {
        (
            item["provenance"]["workflow_run_id"],
            item["provenance"]["workflow_run_attempt"],
            item["provenance"]["job"],
        )
        for item in reviews
    }
    if len(provenance_keys) != 2:
        raise ReviewFailure("review jobs do not have independent action provenance")
    return {
        "schema_version": GATE_SCHEMA_VERSION,
        "status": "passed",
        "base_sha": diff.base_sha,
        "head_sha": diff.head_sha,
        "diff_sha256": diff.sha256,
        "diff_bytes": diff.byte_length,
        "action_repository": ACTION_REPOSITORY,
        "action_commit": ACTION_COMMIT,
        "codex_version": CODEX_VERSION,
        "model": MODEL,
        "effort": EFFORT,
        "workflow_run_id": workflow_run_id,
        "workflow_run_attempt": workflow_run_attempt,
        "review_jobs": [EXPECTED_JOBS[1], EXPECTED_JOBS[2]],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--workflow-run-id", required=True)
    parser.add_argument("--workflow-run-attempt", required=True)
    parser.add_argument("--review-one-env", default="TRUSTED_REVIEW_ONE")
    parser.add_argument("--review-two-env", default="TRUSTED_REVIEW_TWO")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        diff = build_exact_diff(args.repo.resolve(), args.base, args.head)
        report = aggregate_reviews(
            diff,
            (
                os.environ.get(args.review_one_env, ""),
                os.environ.get(args.review_two_env, ""),
            ),
            workflow_run_id=args.workflow_run_id,
            workflow_run_attempt=args.workflow_run_attempt,
        )
    except ReviewFailure as error:
        print(f"TRUSTED MODEL REVIEW FAILED: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
