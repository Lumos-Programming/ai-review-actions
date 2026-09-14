from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from test_review import review


@unittest.skipUnless(os.environ.get("RUN_DOCKER_TESTS") == "1", "Docker test disabled")
class SandboxEnvironmentTest(unittest.TestCase):
    image = os.environ.get("REVIEW_TEST_IMAGE", "ai-review-sandbox:dev")

    def source(self, directory: str) -> Path:
        source = Path(directory)
        (source / "package.json").write_text(
            json.dumps(
                {
                    "private": True,
                    "packageManager": "pnpm@12.3.4",
                    "dependencies": {"is-number": "7.0.0"},
                }
            ),
            encoding="utf-8",
        )
        return source

    def test_default_tools_are_available_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # 既定ツールを検証する。プロジェクト固有の版の取得はpublic側で検証する。
            with review.DockerSandbox(Path(directory), self.image) as sandbox:
                for command in [["pnpm", "--version"], ["actionlint", "--version"]]:
                    result = sandbox.execute(command)
                    self.assertEqual(result.exit_code, 0, result.stderr)
                result = sandbox.execute(
                    ["curl", "-fsSI", "--max-time", "3", "https://registry.npmjs.org/pnpm"]
                )
                self.assertNotEqual(result.exit_code, 0)

    def test_public_network_supports_installs_without_host_writes_or_secrets(self) -> None:
        secrets = {
            key: "not-for-sandbox"
            for key in [
                "GEMINI_API_KEY",
                "GITHUB_TOKEN",
                "GH_TOKEN",
                "AI_REVIEW_APP_PRIVATE_KEY",
            ]
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, secrets):
            source = self.source(directory)
            with review.DockerSandbox(source, self.image, network="public") as sandbox:
                for command in [
                    ["corepack", "pnpm", "--version"],
                    ["pnpm", "install", "--ignore-scripts"],
                    ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
                    ["node", "-e", "if (!require('is-number')(42)) process.exit(1)"],
                    [
                        "curl",
                        "-fsSI",
                        "--max-time",
                        "15",
                        "https://raw.githubusercontent.com/actions/create-github-app-token/bcd2ba49218906704ab6c1aa796996da409d3eb1/action.yml",
                    ],
                    [
                        "sh",
                        "-c",
                        'test -z "${GEMINI_API_KEY:-}${GITHUB_TOKEN:-}${GH_TOKEN:-}'
                        '${AI_REVIEW_APP_PRIVATE_KEY:-}" && touch generated.txt',
                    ],
                ]:
                    result = sandbox.execute(command)
                    self.assertEqual(
                        result.exit_code, 0, f"{command}: {result.stderr}\n{result.stdout}"
                    )
                config = json.loads(
                    subprocess.check_output(
                        ["docker", "inspect", sandbox._container_name],
                        text=True,
                    )
                )[0]
                self.assertEqual(config["HostConfig"]["CapDrop"], ["ALL"])
                self.assertFalse(config["HostConfig"]["CapAdd"])
                self.assertTrue(config["HostConfig"]["ReadonlyRootfs"])
                self.assertFalse(config["HostConfig"]["Privileged"])
                self.assertNotEqual(
                    sandbox.execute(["iptables", "-P", "OUTPUT", "ACCEPT"]).exit_code, 0
                )
            self.assertFalse((source / "generated.txt").exists())
            self.assertFalse((source / "node_modules").exists())
            self.assertFalse((source / "pnpm-lock.yaml").exists())

    def test_reachable_private_service_is_blocked_from_the_sandbox(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with review.DockerSandbox(Path(directory), self.image, network="public") as sandbox:
                server = f"review-network-test-{uuid4().hex}"
                subprocess.run(
                    [
                        "docker",
                        "run",
                        "--detach",
                        "--name",
                        server,
                        "--network",
                        sandbox._container_name,
                        "--entrypoint",
                        "node",
                        self.image,
                        "-e",
                        "require('http').createServer((q,s)=>s.end('reachable')).listen(80,'0.0.0.0')",
                    ],
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
                try:
                    probe = [
                        "curl",
                        "--noproxy",
                        "*",
                        "-fsS",
                        "--max-time",
                        "3",
                        f"http://{server}",
                    ]
                    reachable = subprocess.run(
                        [
                            "docker",
                            "run",
                            "--rm",
                            "--network",
                            sandbox._container_name,
                            self.image,
                            *probe,
                        ],
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=30,
                    )
                    self.assertEqual(reachable.stdout, "reachable")
                    self.assertNotEqual(sandbox.execute(probe).exit_code, 0)
                    for host in ["169.254.169.254", "10.0.0.1", "[::ffff:169.254.169.254]"]:
                        result = sandbox.execute(
                            ["curl", "--noproxy", "*", "-fsS", "--max-time", "2", f"http://{host}"]
                        )
                        self.assertNotEqual(result.exit_code, 0)
                finally:
                    subprocess.run(
                        ["docker", "rm", "--force", server],
                        check=True,
                        capture_output=True,
                        timeout=30,
                    )

    def test_policy_failure_cleans_up_without_exposing_tools(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sandbox = review.DockerSandbox(Path(directory), self.image, network="public")
            with patch.object(
                sandbox, "_restrict_public_network", side_effect=RuntimeError("policy failed")
            ):
                with self.assertRaisesRegex(RuntimeError, "policy failed"):
                    sandbox.__enter__()
            for command in [["docker", "inspect"], ["docker", "network", "inspect"]]:
                result = subprocess.run(
                    [*command, sandbox._container_name], capture_output=True, timeout=30
                )
                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
