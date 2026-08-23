#!/usr/bin/env python3
"""Regressions for the fail-closed Codex Action review aggregate."""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import trusted_model_review as review


BASE_SHA = "1" * 40
HEAD_SHA = "2" * 40
WORKFLOW_RUN_ID = "9001002"
WORKFLOW_RUN_ATTEMPT = "1"
ROOT = Path(__file__).resolve().parents[1]


def exact_diff(text: str = "diff --git a/a b/a\n+untrusted instructions\n") -> review.ExactDiff:
    encoded = text.encode("utf-8")
    return review.ExactDiff(
        base_sha=BASE_SHA,
        head_sha=HEAD_SHA,
        sha256=review.hashlib.sha256(encoded).hexdigest(),
        byte_length=len(encoded),
    )


def finding(severity: str = "medium") -> dict:
    return {
        "id": "REVIEW-1",
        "severity": severity,
        "title": "Concrete review finding",
        "path": "src/example.ts",
        "line": 12,
        "rationale": "The exact diff introduces a correctness regression.",
        "remediation": "Repair the affected branch and add a regression test.",
    }


def review_body(
    diff: review.ExactDiff,
    run: int,
    *,
    decision: str = "passed",
    blocking: list[dict] | None = None,
    non_blocking: list[dict] | None = None,
) -> dict:
    return {
        "schema_version": review.SCHEMA_VERSION,
        "reviewer_run": run,
        "base_sha": diff.base_sha,
        "head_sha": diff.head_sha,
        "diff_sha256": diff.sha256,
        "decision": decision,
        "summary": "Independent exact-diff review completed.",
        "provenance": {
            "provider": "openai_responses_api",
            "action_repository": review.ACTION_REPOSITORY,
            "action_commit": review.ACTION_COMMIT,
            "workflow_run_id": WORKFLOW_RUN_ID,
            "workflow_run_attempt": WORKFLOW_RUN_ATTEMPT,
            "job": review.EXPECTED_JOBS[run],
            "codex_version": review.CODEX_VERSION,
            "model": review.MODEL,
            "effort": review.EFFORT,
            "permission_profile": review.PERMISSION_PROFILE,
            "safety_strategy": review.SAFETY_STRATEGY,
        },
        "blocking_findings": [] if blocking is None else blocking,
        "non_blocking_findings": [] if non_blocking is None else non_blocking,
    }


def encoded(body: dict) -> str:
    return json.dumps(body, separators=(",", ":"))


class TrustedModelReviewTests(unittest.TestCase):
    def test_exact_diff_recomputed_from_exact_commits(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", repo], check=True)
            subprocess.run(["git", "-C", repo, "config", "user.name", "Test"], check=True)
            subprocess.run(
                ["git", "-C", repo, "config", "user.email", "test@example.invalid"],
                check=True,
            )
            path = repo / "review.txt"
            path.write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "-C", repo, "add", "review.txt"], check=True)
            subprocess.run(["git", "-C", repo, "commit", "-qm", "base"], check=True)
            base = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()
            path.write_text("base\nhead\n", encoding="utf-8")
            subprocess.run(["git", "-C", repo, "commit", "-qam", "head"], check=True)
            head = subprocess.check_output(
                ["git", "-C", repo, "rev-parse", "HEAD"], text=True
            ).strip()

            diff = review.build_exact_diff(repo, base, head)
            patch = subprocess.check_output(
                [
                    "git", "-C", repo, "diff", "--no-ext-diff", "--no-textconv",
                    "--binary", "--full-index", "--no-renames", "--src-prefix=a/",
                    "--dst-prefix=b/", base, head, "--",
                ]
            )

        self.assertEqual(diff.sha256, review.hashlib.sha256(patch).hexdigest())
        self.assertEqual(diff.byte_length, len(patch))

    def test_two_bound_independent_action_jobs_pass(self):
        diff = exact_diff()
        report = review.aggregate_reviews(
            diff,
            (encoded(review_body(diff, 1)), encoded(review_body(diff, 2))),
            workflow_run_id=WORKFLOW_RUN_ID,
            workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
        )
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["review_jobs"], ["trusted-review-1", "trusted-review-2"])
        self.assertEqual(report["action_commit"], review.ACTION_COMMIT)
        self.assertEqual(report["codex_version"], review.CODEX_VERSION)
        self.assertEqual(report["diff_sha256"], diff.sha256)

    def test_stale_head_and_diff_fail_closed(self):
        diff = exact_diff()
        stale_head = review_body(diff, 1)
        stale_head["head_sha"] = "3" * 40
        with self.assertRaisesRegex(review.ReviewFailure, "not bound to the exact diff"):
            review.parse_review(
                encoded(stale_head), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )
        stale_digest = review_body(diff, 1)
        stale_digest["diff_sha256"] = "4" * 64
        with self.assertRaisesRegex(review.ReviewFailure, "not bound to the exact diff"):
            review.parse_review(
                encoded(stale_digest), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )

    def test_wrong_run_or_action_job_provenance_fails_closed(self):
        diff = exact_diff()
        wrong_run = review_body(diff, 1)
        wrong_run["reviewer_run"] = 2
        with self.assertRaisesRegex(review.ReviewFailure, "not bound to the exact diff"):
            review.parse_review(
                encoded(wrong_run), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )
        wrong_job = review_body(diff, 1)
        wrong_job["provenance"]["job"] = "trusted-review-2"
        with self.assertRaisesRegex(review.ReviewFailure, "invalid action/job provenance"):
            review.parse_review(
                encoded(wrong_job), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )
        wrong_action = review_body(diff, 1)
        wrong_action["provenance"]["action_commit"] = "0" * 40
        with self.assertRaisesRegex(review.ReviewFailure, "invalid action/job provenance"):
            review.parse_review(
                encoded(wrong_action), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )

    def test_blocking_and_disguised_high_findings_fail_closed(self):
        diff = exact_diff()
        blocked = review_body(diff, 1, decision="blocked", blocking=[finding("high")])
        with self.assertRaisesRegex(review.ReviewFailure, "blocking finding"):
            review.parse_review(
                encoded(blocked), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )
        disguised = review_body(diff, 1, non_blocking=[finding("critical")])
        with self.assertRaisesRegex(review.ReviewFailure, "cannot be hidden"):
            review.parse_review(
                encoded(disguised), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )

    def test_empty_markdown_and_extra_fields_fail_closed(self):
        diff = exact_diff()
        for raw, pattern in (("", "empty"), ("```json\n{}\n```", "not exact JSON")):
            with self.subTest(raw=raw), self.assertRaisesRegex(review.ReviewFailure, pattern):
                review.parse_review(
                    raw, diff=diff, reviewer_run=1,
                    workflow_run_id=WORKFLOW_RUN_ID,
                    workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
                )
        extra = review_body(diff, 1)
        extra["provider_response_id"] = "retired-provider-id"
        with self.assertRaisesRegex(review.ReviewFailure, "does not match"):
            review.parse_review(
                encoded(extra), diff=diff, reviewer_run=1,
                workflow_run_id=WORKFLOW_RUN_ID,
                workflow_run_attempt=WORKFLOW_RUN_ATTEMPT,
            )

    def test_cli_missing_review_output_fails_without_leaking_content(self):
        stderr = io.StringIO()
        with mock.patch.object(review, "build_exact_diff", return_value=exact_diff()), mock.patch.dict(
            os.environ, {"TRUSTED_REVIEW_ONE": "", "TRUSTED_REVIEW_TWO": ""}, clear=False
        ), redirect_stderr(stderr):
            result = review.main(
                [
                    "--repo", ".", "--base", BASE_SHA, "--head", HEAD_SHA,
                    "--workflow-run-id", WORKFLOW_RUN_ID,
                    "--workflow-run-attempt", WORKFLOW_RUN_ATTEMPT,
                ]
            )
        self.assertEqual(result, 1)
        self.assertIn("final-message is empty", stderr.getvalue())

    def test_workflow_uses_two_pinned_last_step_codex_jobs_and_trusted_aggregate(self):
        workflow = (ROOT / ".github/workflows/trusted-model-review.yml").read_text(
            encoding="utf-8"
        )
        action = f"openai/codex-action@{review.ACTION_COMMIT}"
        self.assertEqual(workflow.count(action), 2)
        self.assertEqual(workflow.count('permission-profile: ":read-only"'), 2)
        self.assertEqual(workflow.count("safety-strategy: drop-sudo"), 2)
        self.assertEqual(workflow.count("model: gpt-5.6-sol"), 2)
        self.assertEqual(workflow.count('codex-version: "0.149.0"'), 2)
        self.assertEqual(workflow.count("effort: high"), 2)
        self.assertEqual(workflow.count("output-schema: |"), 2)
        self.assertIn("pull_request_target:", workflow)
        self.assertIn("secrets.OPENAI_API_KEY", workflow)
        self.assertIn("has no fallback provider", workflow)
        self.assertIn("if: ${{ always() }}", workflow)
        self.assertIn("needs.trusted-review-1.result", workflow)
        self.assertIn("needs.trusted-review-2.result", workflow)
        self.assertIn("Checkout exact trusted base commit only", workflow)
        self.assertEqual(
            workflow.count(
                "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
            ),
            3,
        )
        self.assertNotIn("refs/pull/${{ github.event.pull_request.number }}/merge", workflow)
        self.assertIn("project_doc_max_bytes=0", workflow)
        self.assertNotIn("models: read", workflow)
        self.assertNotIn("prompt-file:", workflow)
        self.assertNotIn("output-schema-file:", workflow)
        for job, next_job in (
            ("trusted-review-1", "trusted-review-2"),
            ("trusted-review-2", "trusted-model-review"),
        ):
            block = workflow.split(f"  {job}:\n", 1)[1].split(f"  {next_job}:\n", 1)[0]
            last_step = block.rsplit("\n      - name:", 1)[1]
            self.assertIn(action, last_step)


if __name__ == "__main__":
    unittest.main()
