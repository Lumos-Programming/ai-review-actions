"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { publishReview } = require("../publish/index.cjs");

function report(overrides = {}) {
  return {
    schema_version: 1,
    reviewed_head_sha: "head123",
    review_complete: true,
    summary: "調査が完了しました。",
    limitations: [],
    checks: [{ command: "git diff", status: "passed", result: "問題なし" }],
    findings: [],
    ...overrides,
  };
}

function finding(severity = "high") {
  return { severity, title: "不具合", file: "src/example.ts", line: 1, body: "具体的な根拠", evidence_step_ids: [1, 2] };
}

function evidenceReport(overrides = {}) {
  return {
    schema_version: 2,
    reviewed_head_sha: "head123",
    review_complete: true,
    summary: "文書の意味を変えない変更です。",
    limitations: [],
    verification_rationale: "文言のみの変更で、差分の内容から判断できます。",
    assessments: [{
      question: "意味が変わっていないか。", conclusion: "意味は同じです。任意リンターは不要です。",
      evidence_step_ids: [1, 2], resolved: true,
    }],
    investigation: [
      { id: 1, tool: "get_pull_request_diff", purpose: "変更内容を確認する。", command: "git diff", exit_code: 0, result: "文言の変更" },
      { id: 2, tool: "run_command", purpose: "任意ツールの有無を調べる。", command: "command -v linter", exit_code: 1, result: "ツールなし" },
    ],
    not_run_checks: [], findings: [], ...overrides,
  };
}

function harness(value = report(), { latest = {}, previous = [], files = [] } = {}) {
  const submitted = [];
  const apiCalls = [];
  const logs = [];
  const pr = {
    number: 42, head: { sha: "head123" }, base: { sha: "base123" },
    state: "open", draft: false, user: { login: "author" },
  };
  const options = {
    context: { payload: { pull_request: pr }, repo: { owner: "org", repo: "repo" }, runId: 100 },
    core: { info(message) { logs.push(message); }, notice() {} },
    reportJson: JSON.stringify(value), model: "gemini-test", runAttempt: "1",
    serverUrl: "https://github.com",
    github: {
      paginate: async (endpoint) => {
        const isFiles = endpoint === options.github.rest.pulls.listFiles;
        apiCalls.push(isFiles ? "files" : "list");
        return isFiles ? files : previous;
      },
      rest: {
        pulls: {
          listReviews() {},
          listFiles() {},
          get: async () => { apiCalls.push("get"); return { data: { ...pr, ...latest } }; },
          createReview: async (request) => {
            apiCalls.push("create");
            submitted.push(request);
            return { data: { html_url: "https://github.com/org/repo/pull/42#review" } };
          },
        },
      },
    },
  };
  return { run: () => publishReview(options), options, submitted, apiCalls, logs };
}

test("任意ツールの探索失敗ではなく根拠付きの評価で承認し、成功件数は表示しない", async () => {
  const h = harness(evidenceReport());
  assert.equal((await h.run()).event, "APPROVE");
  const body = h.submitted[0].body;
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.ok(!visible.includes("成功"));
  assert.ok(!visible.includes("失敗"));
  assert.ok(visible.includes("意味は同じです"));
  assert.ok(visible.includes("文言のみの変更"));
  assert.ok(body.includes("command -v linter"));
});

test("全コマンドの成功では承認せず、未解決の疑問や必要な検証を理由にコメントする", async () => {
  for (const changes of [
    { assessments: [] },
    { assessments: [{ question: "互換性は維持されるか。", conclusion: "対象環境を再現できません。", evidence_step_ids: [1], resolved: false }] },
    { not_run_checks: [{ command: "integration test", result: "変更した契約の検証が必要ですが、依存関係がありません。" }] },
    { review_complete: false }, { limitations: ["関連実装を読み切れていません。"] },
    { investigation: [] , assessments: [] },
  ]) {
    const h = harness(evidenceReport({
      investigation: evidenceReport().investigation.map(step => ({ ...step, exit_code: 0 })),
      ...changes,
    }));
    assert.equal((await h.run()).event, "COMMENT");
  }
});

test("観測を解釈せずに完了と申告した場合は終了コードによらず承認しない", async () => {
  for (const exit_code of [0, 1, 127]) {
  const h = harness(evidenceReport({ assessments: [{
    question: "変更は安全か。", conclusion: "差分のみ確認しました。", evidence_step_ids: [1], resolved: true,
  }], investigation: evidenceReport().investigation.map(step => ({ ...step, exit_code })) }));
  assert.equal((await h.run()).event, "COMMENT");
  }
});

test("根拠付きの評価が同じなら終了コードだけで判定を変えない", async () => {
  for (const exit_code of [0, 1, 127]) {
    const h = harness(evidenceReport({
      investigation: evidenceReport().investigation.map(step => ({ ...step, exit_code })),
    }));
    assert.equal((await h.run()).event, "APPROVE");
  }
});

test("重大な指摘でも実在する観測の根拠がなければ投稿前に拒否する", async () => {
  for (const evidence_step_ids of [undefined, [], [3], [1, 1]]) {
    const h = harness(evidenceReport({ findings: [{ ...finding(), evidence_step_ids }] }));
    await assert.rejects(h.run(), /finding.evidence_step_ids/);
    assert.deepEqual(h.apiCalls, []);
  }
});

test("修正要求は具体的な重大指摘だけから決まり、コマンド失敗だけでは要求しない", async () => {
  for (const severity of ["critical", "high", "medium", "low"]) {
    const h = harness(evidenceReport({ findings: [finding(severity)] }));
    assert.equal((await h.run()).event, ["critical", "high"].includes(severity) ? "REQUEST_CHANGES" : "COMMENT");
  }
  const h = harness(evidenceReport({ review_complete: false }));
  assert.equal((await h.run()).event, "COMMENT");
});

test("存在しない根拠・重複ID・根拠のない解決済み評価を投稿前に拒否する", async () => {
  for (const evidence_step_ids of [[3], [1, 1], [], ["1"]]) {
    const h = harness(evidenceReport({ assessments: [{
      ...evidenceReport().assessments[0], evidence_step_ids,
    }] }));
    await assert.rejects(h.run(), /レビューJSONが不正/);
    assert.deepEqual(h.apiCalls, []);
  }
  const h = harness(evidenceReport({ investigation: [evidenceReport().investigation[1]] }));
  await assert.rejects(h.run(), /investigation.id/);
  assert.deepEqual(h.apiCalls, []);
});

test("Unicodeの文字数をPydanticと揃え、上限内の絵文字を含む結果を投稿する", async () => {
  const result = "a".repeat(999) + "🎉";
  const h = harness(report({ checks: [{ command: "test", status: "passed", result }] }));
  const output = await h.run();
  assert.equal(output.published, true);
  assert.equal(output.event, "COMMENT");
  assert.equal(h.submitted[0].commit_id, "head123");
  assert.ok(h.submitted[0].body.includes(result));
});

test("上限を超える文字数や不正なレポートをAPI呼び出し前に拒否する", async () => {
  for (const value of [
    report({ checks: [{ command: "test", status: "passed", result: "🎉".repeat(1001) }] }),
    report({ reviewed_head_sha: "other" }),
    report({ checks: Array(31).fill({ command: "test", status: "passed", result: "ok" }) }),
    report({ findings: [{ ...finding(), file: "../outside" }] }),
    report({ summary: "bad\u0000text" }),
  ]) {
    const h = harness(value);
    await assert.rejects(h.run(), /レビューJSONが不正/);
    assert.deepEqual(h.apiCalls, []);
  }
});

test("旧形式の成功記録が30件あっても根拠付き評価なしでは承認しない", async () => {
  const h = harness(report({ checks: Array(30).fill({ command: "test", status: "passed", result: "ok" }) }));
  assert.equal((await h.run()).event, "COMMENT");
});

test("旧形式では重大な指摘でも自動判定せずコメントにする", async () => {
  for (const severity of ["critical", "high", "medium", "low"]) {
    const h = harness(report({ findings: [finding(severity)] }));
    assert.equal((await h.run()).event, "COMMENT");
  }
  for (const changes of [
    { review_complete: false }, { limitations: ["確認できません"] }, { checks: [] },
    { checks: [{ command: "test", status: "failed", result: "エラー" }] },
    { checks: [{ command: "test", status: "not_run", result: "実行不可" }] },
  ]) {
    const h = harness(report(changes));
    assert.equal((await h.run()).event, "COMMENT");
  }
});

test("Draftと同一BotによるPRには承認や修正要求を投稿しない", async () => {
  for (const latest of [{ draft: true }, { user: { login: "github-actions[bot]" } }]) {
    const h = harness(report({ findings: [finding()] }), { latest });
    assert.equal((await h.run()).event, "COMMENT");
  }
});

test("Head・Baseの更新またはクローズ後は投稿しない", async () => {
  for (const latest of [{ head: { sha: "new" } }, { base: { sha: "new" } }, { state: "closed" }]) {
    const h = harness(report(), { latest });
    assert.equal((await h.run()).published, false);
    assert.deepEqual(h.submitted, []);
  }
});

test("同一実行の重複投稿を防ぐ", async () => {
  const h = harness(report(), {
    previous: [{ user: { login: "github-actions[bot]" }, body: "<!-- ai-review:100:1 -->" }],
  });
  assert.equal((await h.run()).published, false);
  assert.deepEqual(h.submitted, []);
});

test("レビュー本文のメンションを抑制する", async () => {
  const h = harness(report({ summary: "@someone を確認" }));
  await h.run();
  assert.ok(h.submitted[0].body.includes("@\u200bsomeone"));
});

test("投稿APIの失敗を呼び出し元へ伝える", async () => {
  const h = harness();
  h.options.github.rest.pulls.createReview = async () => { throw new Error("permission denied"); };
  await assert.rejects(h.run(), /permission denied/);
});

test("旧形式の調査ログも折りたたみ、検証の成功件数を本文に表示しない", async () => {
  const h = harness(report({
    checks: [
      { command: "git diff", status: "passed", result: "RAW_DIFF_CONTENT" },
      { command: "pnpm test", status: "failed", result: "RAW_ERROR_CONTENT" },
    ],
  }));
  await h.run();
  const body = h.submitted[0].body;
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.ok(!visible.includes("成功 1 / 失敗 1 / 未実行 0"));
  assert.ok(visible.includes("調査未完了"));
  assert.ok(!visible.includes("RAW_DIFF_CONTENT"));
  assert.ok(!visible.includes("RAW_ERROR_CONTENT"));
  assert.ok(body.includes("RAW_DIFF_CONTENT"));
  assert.ok(body.includes("<summary>調査ログ</summary>"));
});

test("ログ内のHTMLで折りたたみやレビューの表示を壊せない", async () => {
  const h = harness(report({
    checks: [{ command: "echo '<details>'", status: "passed", result: "</details><h1>fake</h1>" }],
  }));
  await h.run();
  const body = h.submitted[0].body;
  assert.ok(body.includes("&lt;/details&gt;&lt;h1&gt;fake&lt;/h1&gt;"));
  assert.equal((body.match(/<\/details>/g) || []).length, 1);
});

test("差分の新しい行に対応する指摘をインラインコメントにし、本文に重複させない", async () => {
  const value = { ...finding(), line: 11 };
  const h = harness(report({ findings: [value] }), {
    files: [{ filename: "src/example.ts", patch: "@@ -10,2 +10,3 @@\n context\n-old\n+changed\n+added" }],
  });
  await h.run();
  const request = h.submitted[0];
  assert.deepEqual(request.comments, [{
    path: "src/example.ts", line: 11, side: "RIGHT",
    body: "**[high] 不具合**\n\n具体的な根拠",
  }]);
  assert.ok(!request.body.includes("具体的な根拠"));
  assert.ok(request.body.includes("インラインコメント 1件"));
  assert.deepEqual(h.apiCalls, ["list", "files", "get", "create"]);
});

test("差分外・削除ファイル・欠落したpatchの指摘は本文のコードリンクへフォールバックする", async () => {
  for (const files of [
    [],
    [{ filename: "src/example.ts" }],
    [{ filename: "src/example.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-deleted" }],
    [{ filename: "src/example.ts", patch: "@@ -10 +10 @@\n-old\n+new" }],
  ]) {
    const h = harness(report({ findings: [finding()] }), { files });
    await h.run();
    assert.equal(h.submitted[0].comments, undefined);
    assert.ok(h.submitted[0].body.includes("具体的な根拠"));
    const revision = files[0]?.status === "removed" ? "base123" : "head123";
    assert.ok(h.submitted[0].body.includes(`https://github.com/org/repo/blob/${revision}/src/example.ts#L1`));
  }
});

test("エスケープでログが大きくなる場合も投稿上限を守り、実行ログへ誘導する", async () => {
  const h = harness(report({
    checks: Array(30).fill({ command: "test", status: "passed", result: "&".repeat(1000) }),
  }));
  await h.run();
  assert.ok(Buffer.byteLength(h.submitted[0].body, "utf8") <= 60000);
  assert.ok(h.submitted[0].body.includes("記録が長いため"));
  const records = h.logs.filter(line => line.startsWith("AI review observation: "));
  assert.equal(records.length, 30);
  assert.equal(JSON.parse(records[0].slice("AI review observation: ".length)).result, "&".repeat(1000));
});
