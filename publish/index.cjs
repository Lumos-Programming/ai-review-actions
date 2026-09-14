"use strict";

async function publishReview({ github, context, core, reportJson, model, runAttempt, serverUrl }) {
  const pr = context.payload.pull_request;
  if (!pr) throw new Error("pull_requestイベントのコンテキストが必要です。");
  const target = { ...context.repo, pull_number: pr.number };
  const raw = (reportJson || "").trim();

  // 空出力・巨大な出力・不正なJSONでは投稿せず失敗させる。
  if (!raw || Buffer.byteLength(raw, "utf8") > 60000) {
    throw new Error("レビュー結果が空、またはサイズ上限を超えています。");
  }
  const fenced = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  const report = JSON.parse(fenced ? fenced[1] : raw);

  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  // Pydanticと同じUnicodeコードポイント数で上限を検証する。
  const text = (v, max) => typeof v === "string" &&
    v.trim().length > 0 && Array.from(v).length <= max && !v.includes("\u0000");
  const array = (v, max) => Array.isArray(v) && v.length <= max;
  const requireValid = (ok, label) => {
    if (!ok) throw new Error(`レビューJSONが不正です: ${label}`);
  };

  requireValid(object(report), "ルートオブジェクト");
  requireValid(report.schema_version === 1, "schema_version");
  requireValid(report.reviewed_head_sha === pr.head.sha, "対象SHAの不一致");
  requireValid(typeof report.review_complete === "boolean", "review_complete");
  requireValid(text(report.summary, 1500), "summary");
  requireValid(array(report.limitations, 10), "limitations");
  requireValid(report.limitations.every(v => text(v, 500)), "limitationsの内容");
  requireValid(array(report.checks, 30), "checks");
  requireValid(array(report.findings, 5), "findings");

  for (const c of report.checks) {
    requireValid(object(c), "check");
    requireValid(text(c.command, 500) && text(c.result, 1000), "checkの内容");
    requireValid(["passed", "failed", "not_run"].includes(c.status), "check.status");
  }
  for (const f of report.findings) {
    requireValid(object(f), "finding");
    requireValid(["critical", "high", "medium", "low"].includes(f.severity), "severity");
    requireValid(text(f.title, 200) && text(f.body, 3000), "指摘本文");
    requireValid(text(f.file, 500), "file");
    requireValid(!/^[\/]/.test(f.file) && !/[\\`\r\n]/.test(f.file) &&
      !f.file.split("/").some(p => p === ".." || p === "."), "相対パス");
    requireValid(Number.isInteger(f.line) && f.line > 0, "line");
  }

  // 判定はモデルの自由文ではなく、このコードで決定する。
  const blocking = report.findings.some(f => ["critical", "high"].includes(f.severity));
  const incomplete = !report.review_complete || report.limitations.length > 0 ||
    report.checks.length === 0 || report.checks.some(c => c.status !== "passed");
  let event = blocking ? "REQUEST_CHANGES" :
    (report.findings.length > 0 || incomplete ? "COMMENT" : "APPROVE");

  // APIの再試行などで同一実行のレビューが重複することを防ぐ。
  const marker = `<!-- ai-review:${context.runId}:${runAttempt} -->`;
  const previous = await github.paginate(github.rest.pulls.listReviews, {
    ...target, per_page: 100
  });
  if (previous.some(r => r.user?.login === "github-actions[bot]" &&
      r.body?.includes(marker))) {
    core.info("この実行のレビューは投稿済みです。");
    return { published: false };
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...report.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const files = findings.length > 0
    ? await github.paginate(github.rest.pulls.listFiles, { ...target, per_page: 100 })
    : [];
  const { comments, fallbackFindings } = placeFindings(findings, files);

  // 投稿直前に確認し、別のコミットや別のマージ先へ古い結果を使わない。
  const { data: latest } = await github.rest.pulls.get(target);
  if (latest.state !== "open" || latest.head.sha !== pr.head.sha ||
      latest.base.sha !== pr.base.sha) {
    core.notice("PRが更新またはクローズされたため、古いレビューの投稿を中止しました。");
    return { published: false };
  }

  // Draftは調査結果だけを返す。
  // github-actions自身が作成したPRも、自己承認を避けてCOMMENTにする。
  if (latest.draft || latest.user.login === "github-actions[bot]") {
    event = "COMMENT";
  }

  const renderOptions = {
    report, event, incomplete, fallbackFindings, inlineCount: comments.length,
    context, model, serverUrl, marker,
    commentOnly: latest.draft || latest.user.login === "github-actions[bot]"
  };
  let body = renderReviewBody(renderOptions);
  if (Buffer.byteLength(body, "utf8") > 60000) {
    body = renderReviewBody({ ...renderOptions, includeLogOutput: false });
  }
  requireValid(Buffer.byteLength(body, "utf8") <= 60000, "投稿本文のサイズ");

  // 通常コメントではなく、対象コミットを指定した正式なPR Review。
  // 権限不足などで失敗した場合は、成功したふりをせずジョブを失敗させる。
  const { data: review } = await github.rest.pulls.createReview({
    ...target,
    commit_id: pr.head.sha,
    event,
    body,
    ...(comments.length > 0 ? { comments } : {})
  });
  core.info(`レビューを投稿しました: ${event} / ${review.html_url}`);
  return { published: true, event, reviewUrl: review.html_url };
}

// AI出力をコードとして評価せず、意図しないメンション通知も抑制する。
const safe = value => value.replace(/@/g, "@\u200b");
const escapeHtml = value => safe(value).replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function placeFindings(findings, files) {
  const removedPaths = new Set(files.filter(file => file.status === "removed")
    .map(file => file.filename));
  const linesByPath = new Map();
  for (const file of files) {
    if (file.status === "removed" || !file.patch) continue;
    const lines = new Set();
    let newLine = null;
    for (const row of file.patch.split("\n")) {
      const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number(hunk[1]);
      } else if (newLine !== null && (row.startsWith("+") || row.startsWith(" "))) {
        lines.add(newLine++);
      }
    }
    linesByPath.set(file.filename, lines);
  }

  const comments = [];
  const fallbackFindings = [];
  for (const finding of findings) {
    if (linesByPath.get(finding.file)?.has(finding.line)) {
      comments.push({
        path: finding.file, line: finding.line, side: "RIGHT",
        body: `**[${finding.severity}] ${safe(finding.title)}**\n\n${safe(finding.body)}`,
      });
    } else {
      fallbackFindings.push({ ...finding, removed: removedPaths.has(finding.file) });
    }
  }
  return { comments, fallbackFindings };
}

function renderReviewBody({
  report, event, incomplete, fallbackFindings, inlineCount, context, model,
  serverUrl, marker, commentOnly, includeLogOutput = true,
}) {
  const pr = context.payload.pull_request;
  const repoUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}`;
  const runUrl = `${repoUrl}/actions/runs/${context.runId}`;
  const labels = { APPROVE: "承認", COMMENT: "コメント", REQUEST_CHANGES: "変更をリクエスト" };
  const counts = { passed: 0, failed: 0, not_run: 0 };
  for (const check of report.checks) counts[check.status]++;

  const sections = [
    "## AIコードレビュー", "",
    `**${labels[event]}${incomplete ? " · 検証未完了" : ""}** · 指摘 ${report.findings.length}件`, "",
    safe(report.summary), "",
    `検証: 成功 ${counts.passed} / 失敗 ${counts.failed} / 未実行 ${counts.not_run}`,
  ];
  if (incomplete) sections.push("", "未完了の調査・検証があるため、自動承認していません。");
  if (commentOnly) sections.push("", "Draftまたは同一BotによるPRのため、コメントとして投稿しています。");
  if (inlineCount > 0) sections.push("", `コード上のインラインコメント ${inlineCount}件を確認してください。`);

  for (const finding of fallbackFindings) {
    const path = finding.file.split("/").map(part => encodeURIComponent(part)
      .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)).join("/");
    const revision = finding.removed ? pr.base.sha : pr.head.sha;
    const codeUrl = `${repoUrl}/blob/${revision}/${path}#L${finding.line}`;
    sections.push("", `### [${finding.severity}] ${safe(finding.title)}`, "",
      `<a href="${escapeHtml(codeUrl)}"><code>${escapeHtml(finding.file)}:L${finding.line}</code></a>`,
      "", safe(finding.body));
  }
  if (report.limitations.length > 0) {
    sections.push("", "### 未確認の点", ...report.limitations.map(value => `- ${safe(value)}`));
  }

  sections.push("", "<details>", `<summary>調査・検証の詳細（${report.checks.length}件）</summary>`, "");
  if (includeLogOutput) {
    const statusLabels = { passed: "✅ 成功", failed: "❌ 失敗", not_run: "⏭️ 未実行" };
    for (const [index, check] of report.checks.entries()) {
      sections.push(`#### ${index + 1}. ${statusLabels[check.status]}`, "",
        "コマンド:", `<pre><code>${escapeHtml(check.command)}</code></pre>`, "",
        "結果:", `<pre><code>${escapeHtml(check.result)}</code></pre>`, "");
    }
  } else {
    sections.push(`記録が長いため、詳細は[実行ログ](${runUrl})を参照してください。`, "");
  }
  sections.push("</details>", "", "---",
    `[実行ログ](${runUrl}) · 対象: \`${pr.head.sha.slice(0, 7)}\` · モデル: \`${safe(model)}\``,
    "AIによる補助レビューです。通常のCIと人間による確認も実施してください。", marker);
  return sections.join("\n");
}

module.exports = { publishReview };
