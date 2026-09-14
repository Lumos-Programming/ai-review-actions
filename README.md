# AI Review Actions

`ynufes-tech/ai-review-actions`は、[Pydantic AI](https://github.com/pydantic/pydantic-ai)
経由のGeminiを使ってPull RequestをレビューするGitHub Actionです。モデルによるcheckoutの
調査やコマンド実行は、Gemini APIキーを保持するオーケストレーターではなく、使い捨ての
Dockerサンドボックス内で行います。

調査には`ynufes-tech/ai-review-actions`、検証と正式なPR Reviewの投稿には
`ynufes-tech/ai-review-actions/publish`を使用します。モデルAPIキーを持つ調査ジョブと、
`pull-requests: write`権限を持つ投稿ジョブを分離して利用してください。

## 使い方

checkoutにはBaseとHeadの両方のコミットが必要です。次の例のActionリビジョンは説明用です。
本番ワークフローでは、検証済みの完全なコミットSHAへ固定してください。

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]
permissions: {}
concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  analyze:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.event.pull_request.user.login != 'dependabot[bot]' &&
      github.actor != 'dependabot[bot]'
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

  publish:
    needs: analyze
    runs-on: ubuntu-latest
    timeout-minutes: 3
    permissions:
      pull-requests: write
    steps:
      - uses: ynufes-tech/ai-review-actions/publish@v1
        with:
          report: ${{ needs.analyze.outputs.report }}
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

文字列の上限はUnicodeコードポイント数で数えます。絵文字を含む場合も、調査側と投稿側の
上限判定は一致します。

## レビューの投稿

`publish` Actionは`pull_request`イベントのコンテキストと`report`入力を使用します。
checkoutやGemini APIキーは不要です。`github-token`の既定値は`${{ github.token }}`です。
モデルを変更する場合は、調査Actionと投稿Actionの両方へ同じ`model`を指定してください。
投稿本文の見出しと判定理由は日本語です。

本文には短い要約、指摘件数、検証の成功・失敗・未実行件数を表示します。
調査コマンドと実行結果は折りたたみ、HTMLとして解釈されないコード表示にします。
表示用のエスケープで本文サイズが上限を超える場合は、各記録をJSON形式で実行ログへ明示的に
出力し、本文の詳細をその実行ログへのリンクへ置き換えます。

GitHubのPR差分に対応する指摘は、該当行へのインラインコメントとして投稿します。
差分外の行やpatchを取得できないファイルの指摘は、コードへのリンク付きで本文に残します。
削除されたファイルへのリンクにはBaseコミットを使用します。
同じ指摘の全文を本文とインラインコメントへ重複して掲載しません。

JSONの構造・文字数・対象SHAを検証した後、コードで判定します。

- `critical`または`high`の指摘がある場合は`REQUEST_CHANGES`
- その他の指摘、未完了の調査、制約、失敗・未実行の検証がある場合は`COMMENT`
- 指摘と制約がなく、調査・検証が完了した場合は`APPROVE`
- Draftと`github-actions[bot]`が作成したPRでは常に`COMMENT`

投稿直前にHead・BaseのSHAとPRが開いていることを確認し、古い結果は投稿しません。
同一実行・試行のレビューがすでにある場合も投稿を省略します。AI出力は本文としてのみ扱い、
コードとして評価せず、メンション通知を抑制します。JSONの検証やAPI操作の失敗はジョブの
失敗として返します。承認を使う場合は、リポジトリ設定でGitHub ActionsによるPR承認を許可してください。

出力は`published`（新規投稿時に`true`）、`event`（判定）、`review-url`（投稿URL）です。
投稿を省略した場合、`published`は`false`、残りの出力は空文字です。

## 使用上限

既定値では、モデルリクエストを80回、ツール呼び出しを30回まで許可します。モデルには
調査ツールを24回までに抑えるよう指示し、検証済みの最終結果を生成する余力を残します。
先にPydantic AIの使用上限へ到達した場合は、調査結果をすべて破棄せず未完了のレポートを返します。

`request-limit`、`tool-call-limit`、`investigation-tool-limit`では、これらの上限を引き下げられます。

モデルや依存パッケージのバージョンについて、学習済み知識だけによる存在・互換性の断定は
指摘から除外するよう指示します。必要な外部情報を確認できない場合は制約へ記録します。

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
node --test tests/test_publish.cjs
RUN_DOCKER_TESTS=1 uv run python tests/test_review.py DockerSandboxTest
```

投稿処理のテストにはNode.js 22以降、Dockerテストには起動中のDockerデーモンが必要です。
