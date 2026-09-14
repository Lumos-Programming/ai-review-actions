# AI Review Actions

`ynufes-tech/ai-review-actions` reviews pull requests with Gemini through
[Pydantic AI](https://github.com/pydantic/pydantic-ai). The model can inspect the checkout and run
focused commands, but those operations execute in a disposable Docker sandbox rather than in the
orchestrator process that holds the Gemini API key.

## Usage

The checkout must contain both the base and head commits.

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      report: ${{ steps.review.outputs.report }}

    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
          path: source

      - id: review
        uses: ynufes-tech/ai-review-actions@v1
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          repository: ${{ github.repository }}
          pull-request-number: ${{ github.event.pull_request.number }}
          base-sha: ${{ github.event.pull_request.base.sha }}
          head-sha: ${{ github.event.pull_request.head.sha }}
          source-directory: source
```

For production workflows, pin the action to a full commit SHA rather than a movable major-version
tag.

## Output

The `report` output is a JSON object with this shape:

```json
{
  "schema_version": 1,
  "reviewed_head_sha": "commit SHA",
  "review_complete": true,
  "summary": "Japanese review summary",
  "limitations": [],
  "checks": [
    {
      "command": "git diff base...head",
      "status": "passed",
      "result": "recorded command result"
    }
  ],
  "findings": [
    {
      "severity": "high",
      "title": "finding title",
      "file": "relative/path.ts",
      "line": 10,
      "body": "problem, impact, evidence, and suggested fix"
    }
  ]
}
```

The action constructs `reviewed_head_sha` itself and records checks from executed tools rather than
trusting the model to report them. Pydantic validates all other fields before the output is exposed.

## Limits

The defaults allow 40 model requests and 15 successful tool calls. The prompt asks the model to stop
after 12 investigation calls, preserving capacity for a validated final result. If Pydantic AI
enforces a usage limit first, the action returns an incomplete report instead of discarding all
investigation evidence.

Inputs can override `request-limit`, `tool-call-limit`, and `investigation-tool-limit`.

## Sandbox model

The orchestrator runs on the GitHub Actions host and is the only process given `GEMINI_API_KEY`.
Repository tools run in a Docker container configured with:

- no network;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- CPU, memory, process, and command-time limits;
- a read-only mount of the checkout;
- a private writable `tmpfs` copy for tests and generated files;
- no GitHub or Gemini credentials injected into the container.

The default image is `node:22-bookworm`. Override `sandbox-image` with a prebuilt image containing
the dependencies required by the repository. The sandbox has no network, so it cannot download
missing packages during a review.

This action executes code from the referenced action revision in the privileged orchestrator. Pin a
trusted commit, do not expose secrets to workflows from forks, and use `persist-credentials: false`
for the reviewed checkout.

## Development

```bash
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run ty check src tests
uv run python tests/test_review.py
RUN_DOCKER_TESTS=1 uv run python tests/test_review.py DockerSandboxTest
```

The Docker test requires a running Docker daemon.
