# AI Review Actions

`ynufes-tech/ai-review-actions`は、[Pydantic AI](https://github.com/pydantic/pydantic-ai)
経由のGeminiを使ってPull RequestをレビューするGitHub Actionです。モデルによるcheckoutの
調査やコマンド実行は、Gemini APIキーを保持するオーケストレーターではなく、使い捨ての
Dockerサンドボックス内で行います。

## 使い方

checkoutにはBaseとHeadの両方のコミットが必要です。次の例のActionリビジョンは説明用です。
本番ワークフローでは、検証済みの完全なコミットSHAへ固定してください。

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

レビュー文の既定言語は日本語です。別の言語が必要な場合は`review-language`を指定してください。

## 出力

`report`出力は次の形式のJSONオブジェクトです。

```json
{
  "schema_version": 1,
  "reviewed_head_sha": "コミットSHA",
  "review_complete": true,
  "summary": "レビューの要約",
  "limitations": [],
  "checks": [
    {
      "command": "git diff base...head",
      "status": "passed",
      "result": "記録されたコマンド結果"
    }
  ],
  "findings": [
    {
      "severity": "high",
      "title": "指摘のタイトル",
      "file": "relative/path.ts",
      "line": 10,
      "body": "問題、影響、根拠、修正案"
    }
  ]
}
```

Actionはcheckoutが指定されたHead SHAと一致することを検証し、`reviewed_head_sha`を自身で
設定します。実行済みの`checks`もモデルの申告を信用せず、ツールの実行結果から記録します。
必要だが実行できなかった検証は、モデルが`not_run`として申告し、Pydanticで検証します。

## 使用上限

既定値では、モデルリクエストを80回、ツール呼び出しを30回まで許可します。モデルには
調査ツールを24回までに抑えるよう指示し、検証済みの最終結果を生成する余力を残します。
先にPydantic AIの使用上限へ到達した場合は、調査結果をすべて破棄せず未完了のレポートを返します。

`request-limit`、`tool-call-limit`、`investigation-tool-limit`では、これらの上限を引き下げられます。

## サンドボックス

オーケストレーターはGitHub Actionsホスト上で動作し、この処理だけに`GEMINI_API_KEY`を渡します。
リポジトリ用ツールは、次の制約を設定したDockerコンテナで実行します。

- ネットワーク接続なし
- Linux capabilityをすべて削除し、`no-new-privileges`を有効化
- CPU、メモリ、プロセス数、コマンド実行時間を制限
- checkoutは読み取り専用でマウント
- テストと生成物には非公開の書き込み可能な`tmpfs`コピーを使用
- GitHubやGeminiの認証情報をコンテナへ渡さない

既定イメージはdigestへ固定した`node:22-bookworm`です。リポジトリが必要とする依存関係を含む
事前構築済みイメージを`sandbox-image`で指定できます。サンドボックスにはネットワーク接続が
ないため、レビュー中に不足パッケージをダウンロードすることはできません。上書きする場合も、
供給元を信頼できるイメージをdigestへ固定してください。

指定したActionリビジョンのコードは、権限を持つオーケストレーター内で実行されます。信頼できる
コミットへ固定し、fork由来のワークフローへSecretを渡さず、レビュー対象のcheckoutでは
`persist-credentials: false`を使用してください。

## 開発

```bash
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run ty check src tests
uv run python tests/test_review.py
RUN_DOCKER_TESTS=1 uv run python tests/test_review.py DockerSandboxTest
```

Dockerテストには、起動中のDockerデーモンが必要です。
