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
  return { severity, title: "不具合", file: "src/example.ts", line: 1, body: "具体的な根拠" };
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

test("Unicodeの文字数をPydanticと揃え、上限内の絵文字を含む結果を投稿する", async () => {
  const result = "a".repeat(999) + "🎉";
  const h = harness(report({ checks: [{ command: "test", status: "passed", result }] }));
  const output = await h.run();
  assert.equal(output.published, true);
  assert.equal(output.event, "APPROVE");
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

test("使用上限の30件の検証記録を受け取る", async () => {
  const h = harness(report({ checks: Array(30).fill({ command: "test", status: "passed", result: "ok" }) }));
  assert.equal((await h.run()).event, "APPROVE");
});

test("重大な指摘は修正要求にし、軽微な指摘と未完了の調査はコメントにする", async () => {
  for (const severity of ["critical", "high", "medium", "low"]) {
    const h = harness(report({ findings: [finding(severity)] }));
    const expected = ["critical", "high"].includes(severity) ? "REQUEST_CHANGES" : "COMMENT";
    assert.equal((await h.run()).event, expected);
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

test("調査ログを既定で折りたたみ、本文は要約と検証件数だけにする", async () => {
  const h = harness(report({
    checks: [
      { command: "git diff", status: "passed", result: "RAW_DIFF_CONTENT" },
      { command: "pnpm test", status: "failed", result: "RAW_ERROR_CONTENT" },
    ],
  }));
  await h.run();
  const body = h.submitted[0].body;
  const visible = body.replace(/<details>[\s\S]*?<\/details>/g, "");
  assert.ok(visible.includes("成功 1 / 失敗 1 / 未実行 0"));
  assert.ok(visible.includes("検証未完了"));
  assert.ok(!visible.includes("RAW_DIFF_CONTENT"));
  assert.ok(!visible.includes("RAW_ERROR_CONTENT"));
  assert.ok(body.includes("RAW_DIFF_CONTENT"));
  assert.ok(body.includes("<summary>調査・検証の詳細（2件）</summary>"));
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
  const records = h.logs.filter(line => line.startsWith("AI review check: "));
  assert.equal(records.length, 30);
  assert.equal(JSON.parse(records[0].slice("AI review check: ".length)).result, "&".repeat(1000));
});
