from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError
from pydantic_ai.models.test import TestModel

SCRIPT = Path(__file__).parents[1] / "src" / "review.py"
SPEC = importlib.util.spec_from_file_location("review", SCRIPT)
assert SPEC and SPEC.loader
review = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = review
SPEC.loader.exec_module(review)


class FakeSandbox:
    def __init__(self, result: object) -> None:
        self.result = result
        self.calls: list[tuple[list[str], int]] = []

    def execute(self, command: list[str], timeout_seconds: int = 120):
        self.calls.append((command, timeout_seconds))
        return self.result


class CheckoutSandbox(FakeSandbox):
    def __init__(self, head_sha: str = "head456") -> None:
        super().__init__(review.CommandResult(exit_code=0, stdout="", stderr=""))
        self.head_sha = head_sha

    def execute(self, command: list[str], timeout_seconds: int = 120):
        self.calls.append((command, timeout_seconds))
        if command == ["git", "rev-parse", "HEAD"]:
            return review.CommandResult(exit_code=0, stdout=self.head_sha, stderr="")
        return review.CommandResult(exit_code=0, stdout="", stderr="")


class ReviewReportTest(unittest.TestCase):
    def test_rejects_a_finding_outside_the_repository(self) -> None:
        with self.assertRaises(ValidationError):
            review.Finding(
                severity="high",
                title="unsafe path",
                file="../secret.txt",
                line=1,
                body="details",
            )

    def test_writes_a_valid_multiline_github_output(self) -> None:
        report = review.ReviewReport(
            reviewed_head_sha="abc123",
            review_complete=False,
            summary="first line\nsecond line",
            limitations=["not enough time"],
            checks=[
                review.ReviewCheck(
                    command="git diff --stat",
                    status="passed",
                    result="one file changed",
                )
            ],
            findings=[],
        )

        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "github-output"
            review.write_github_output(report, output_path)
            output = output_path.read_text(encoding="utf-8")

        first_line, payload, last_line = output.split("\n", 2)
        delimiter = first_line.removeprefix("report<<")
        self.assertEqual(last_line, f"{delimiter}\n")
        self.assertEqual(json.loads(payload), report.model_dump(mode="json"))


class ReviewPromptTest(unittest.TestCase):
    def config(self) -> review.ReviewConfig:
        return review.ReviewConfig(
            repository="owner/repository",
            pull_request_number=42,
            base_sha="base123",
            head_sha="head456",
            model="gemini-test",
            api_key="secret",
            source_dir=Path("/checkout"),
            sandbox_image="node:test",
        )

    def test_identifies_the_target_and_reserves_the_tool_budget(self) -> None:
        prompt = review.build_review_prompt(self.config())

        self.assertIn("owner/repository", prompt)
        self.assertIn("PR番号: 42", prompt)
        self.assertIn("Base SHA: base123", prompt)
        self.assertIn("Head SHA: head456", prompt)
        self.assertIn("すべて日本語で記述", prompt)
        self.assertIn("ツール呼び出しは最大24回", prompt)
        self.assertIn("review_completeをfalse", prompt)

    def test_a_review_cannot_be_complete_without_recorded_investigation(self) -> None:
        model = TestModel(
            call_tools=[],
            custom_output_args={
                "review_complete": True,
                "summary": "問題は見つかりませんでした。",
                "limitations": [],
                "findings": [],
            },
        )
        sandbox = CheckoutSandbox()

        report = review.review_pull_request(self.config(), sandbox, model=model)

        self.assertFalse(report.review_complete)
        self.assertEqual(report.reviewed_head_sha, "head456")
        self.assertIn("調査ツール", report.limitations[0])

    def test_rejects_a_checkout_at_a_different_head(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "does not match head-sha"):
            review.review_pull_request(
                self.config(),
                CheckoutSandbox(head_sha="different"),
                model=TestModel(call_tools=[]),
            )

    def test_preserves_required_checks_that_were_not_run(self) -> None:
        model = TestModel(
            call_tools=[],
            custom_output_args={
                "review_complete": False,
                "summary": "依存関係がないため検証できませんでした。",
                "limitations": ["依存関係がありません。"],
                "not_run_checks": [
                    {"command": "pnpm test", "result": "node_modulesがありません。"}
                ],
                "findings": [],
            },
        )

        report = review.review_pull_request(self.config(), CheckoutSandbox(), model=model)

        self.assertEqual(report.checks[-1].status, "not_run")
        self.assertEqual(report.checks[-1].command, "pnpm test")


class ReviewConfigTest(unittest.TestCase):
    def test_rejects_limits_above_the_action_ceiling(self) -> None:
        environment = {
            "REVIEW_REPOSITORY": "owner/repository",
            "REVIEW_PULL_REQUEST_NUMBER": "42",
            "REVIEW_BASE_SHA": "base123",
            "REVIEW_HEAD_SHA": "head456",
            "REVIEW_MODEL": "gemini-test",
            "GEMINI_API_KEY": "secret",
            "REVIEW_SOURCE_DIRECTORY": "/checkout",
            "REVIEW_SANDBOX_IMAGE": "node:test",
            "REVIEW_LANGUAGE": "日本語",
            "REVIEW_REQUEST_LIMIT": "81",
            "REVIEW_TOOL_CALL_LIMIT": "30",
            "REVIEW_INVESTIGATION_TOOL_LIMIT": "24",
        }

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(ValueError, "between 2 and 80"):
                review.ReviewConfig.from_env()


class ReviewToolsTest(unittest.TestCase):
    def test_diff_tool_uses_the_configured_commits_and_records_the_check(self) -> None:
        sandbox = FakeSandbox(review.CommandResult(exit_code=0, stdout="diff output", stderr=""))
        tools = review.ReviewTools(sandbox, base_sha="base123", head_sha="head456")

        result = tools.get_pull_request_diff()

        self.assertEqual(
            sandbox.calls,
            [
                (
                    [
                        "git",
                        "--no-pager",
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "base123...head456",
                    ],
                    120,
                )
            ],
        )
        self.assertEqual(result, "[exit_code=0]\ndiff output")
        self.assertEqual(tools.checks[0].status, "passed")
        self.assertIn("base123...head456", tools.checks[0].command)

    def test_file_tools_reject_paths_outside_the_workspace(self) -> None:
        sandbox = FakeSandbox(review.CommandResult(exit_code=0, stdout="unexpected", stderr=""))
        tools = review.ReviewTools(sandbox, base_sha="base123", head_sha="head456")

        with self.assertRaises(ValueError):
            tools.read_file("../secret.txt")

        self.assertEqual(sandbox.calls, [])


@unittest.skipUnless(os.environ.get("RUN_DOCKER_TESTS") == "1", "Docker test disabled")
class DockerSandboxTest(unittest.TestCase):
    def test_copies_the_repository_without_exposing_secrets_or_host_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "marker.txt").write_text("from checkout", encoding="utf-8")
            os.environ["GEMINI_API_KEY"] = "must-not-enter-sandbox"

            with review.DockerSandbox(
                source,
                image=(
                    "alpine:3.22@sha256:"
                    "14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
                ),
            ) as sandbox:
                result = sandbox.execute(
                    [
                        "sh",
                        "-lc",
                        'cat marker.txt && test -z "${GEMINI_API_KEY:-}" && touch generated.txt',
                    ]
                )

            self.assertEqual(result.exit_code, 0, result.stderr)
            self.assertIn("from checkout", result.stdout)
            self.assertFalse((source / "generated.txt").exists())


if __name__ == "__main__":
    unittest.main()
