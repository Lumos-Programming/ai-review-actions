"use strict";

async function publishReview({ github, context, core, reportJson, model, runAttempt, serverUrl,
  reviewerLogin = "github-actions[bot]" }) {
  const pr = context.payload.pull_request;
  if (!pr) throw new Error("pull_requestイベントのコンテキストが必要です。");
  const target = { ...context.repo, pull_number: pr.number };
  if (typeof reviewerLogin !== "string" || reviewerLogin.length > 100 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/i.test(reviewerLogin) ||
      reviewerLogin !== reviewerLogin.trim()) {
    throw new Error("reviewer-loginに投稿トークンのアカウント名を指定してください。");
  }
  const isReviewer = user => user?.login?.toLowerCase() === reviewerLogin.toLowerCase();
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
  requireValid([1, 2].includes(report.schema_version), "schema_version");
  const evidenceBased = report.schema_version === 2;
  requireValid(report.reviewed_head_sha === pr.head.sha, "対象SHAの不一致");
  requireValid(typeof report.review_complete === "boolean", "review_complete");
  requireValid(text(report.summary, 1500), "summary");
  requireValid(array(report.limitations, 10), "limitations");
  requireValid(report.limitations.every(v => text(v, 500)), "limitationsの内容");
  requireValid(array(report.findings, 5), "findings");

  if (evidenceBased) {
    requireValid(text(report.verification_rationale, 500), "verification_rationale");
    requireValid(array(report.investigation, 30), "investigation");
    requireValid(array(report.assessments, 8), "assessments");
    requireValid(array(report.not_run_checks, 6), "not_run_checks");
    const toolNames = ["get_pull_request_diff", "list_directory", "read_file", "search_text", "run_command"];
    for (const [index, step] of report.investigation.entries()) {
      requireValid(object(step) && step.id === index + 1, "investigation.id");
      requireValid(toolNames.includes(step.tool) && Number.isInteger(step.exit_code), "investigation.tool/exit_code");
      requireValid(text(step.purpose, 500) && text(step.command, 2100) && text(step.result, 1000), "investigationの内容");
    }
    const stepIds = new Set(report.investigation.map(step => step.id));
    for (const assessment of report.assessments) {
      requireValid(object(assessment), "assessment");
      requireValid(text(assessment.question, 500) && text(assessment.conclusion, 1000), "assessmentの内容");
      requireValid(typeof assessment.resolved === "boolean", "assessment.resolved");
      const ids = assessment.evidence_step_ids;
      requireValid(array(ids, 30) && new Set(ids).size === ids.length &&
        ids.every(id => Number.isInteger(id) && stepIds.has(id)), "assessment.evidence_step_ids");
      requireValid(!assessment.resolved || ids.length > 0, "解決済み評価の根拠");
    }
    for (const check of report.not_run_checks) {
      requireValid(object(check) && text(check.command, 500) && text(check.result, 1000), "not_run_check");
    }
  } else {
    requireValid(array(report.checks, 30), "checks");
    for (const c of report.checks) {
      requireValid(object(c), "check");
      requireValid(text(c.command, 500) && text(c.result, 1000), "checkの内容");
      requireValid(["passed", "failed", "not_run"].includes(c.status), "check.status");
    }
  }
  for (const f of report.findings) {
    requireValid(object(f), "finding");
    requireValid(["critical", "high", "medium", "low"].includes(f.severity), "severity");
    requireValid(text(f.title, 200) && text(f.body, 3000), "指摘本文");
    requireValid(text(f.file, 500), "file");
    requireValid(!/^[\/]/.test(f.file) && !/[\\`\r\n]/.test(f.file) &&
      !f.file.split("/").some(p => p === ".." || p === "."), "相対パス");
    requireValid(Number.isInteger(f.line) && f.line > 0, "line");
    if (evidenceBased) {
      const ids = f.evidence_step_ids;
      requireValid(array(ids, 30) && ids.length > 0 && new Set(ids).size === ids.length &&
        ids.every(id => Number.isInteger(id) && report.investigation.some(step => step.id === id)),
      "finding.evidence_step_ids");
    }
  }

  // 終了コードやコマンドの成功件数からレビューの良否を推定しない。
  const blocking = evidenceBased && report.findings.some(f => ["critical", "high"].includes(f.severity));
  const cited = new Set(evidenceBased
    ? [...report.assessments, ...report.findings].flatMap(item => item.evidence_step_ids) : []);
  const incomplete = !evidenceBased || !report.review_complete || report.limitations.length > 0 ||
    report.assessments.length === 0 || report.assessments.some(a => !a.resolved) ||
    report.not_run_checks.length > 0 ||
    !report.investigation.some(step => step.tool === "get_pull_request_diff") ||
    report.investigation.some(step => !cited.has(step.id));
  let event = blocking ? "REQUEST_CHANGES" :
    (report.findings.length > 0 || incomplete ? "COMMENT" : "APPROVE");

  // APIの再試行などで同一実行のレビューが重複することを防ぐ。
  const marker = `<!-- ai-review:${context.runId}:${runAttempt} -->`;
  const previous = await github.paginate(github.rest.pulls.listReviews, {
    ...target, per_page: 100
  });
  if (previous.some(r => isReviewer(r.user) &&
      r.body?.includes(marker))) {
    core.info("この実行のレビューは投稿済みです。");
    return { published: false };
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = report.findings.map(finding => ({
    ...finding, evidence_step_ids: evidenceBased ? finding.evidence_step_ids : [],
  })).sort((a, b) => order[a.severity] - order[b.severity]);
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
  // 投稿に使うアカウント自身が作成したPRも、自己承認を避けてCOMMENTにする。
  const commentOnly = latest.draft || isReviewer(latest.user);
  if (commentOnly) {
    event = "COMMENT";
  }

  const renderOptions = {
    report, event, incomplete, fallbackFindings, inlineCount: comments.length,
    context, model, serverUrl, marker,
    commentOnly
  };
  let body = renderReviewBody(renderOptions);
  if (Buffer.byteLength(body, "utf8") > 60000) {
    // 改行をJSONでエスケープし、出力内容がrunnerコマンドとして解釈されることを防ぐ。
    for (const record of (report.investigation || report.checks)) {
      core.info(`AI review observation: ${JSON.stringify(record)}`);
    }
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
const findingEvidence = finding => finding.evidence_step_ids.length > 0
  ? `\n\n根拠: 観測 ${finding.evidence_step_ids.join(", ")}（レビュー本文の調査ログを参照）` : "";
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
        body: `**[${finding.severity}] ${safe(finding.title)}**\n\n${safe(finding.body)}` + findingEvidence(finding),
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

  const sections = [
    "## AIコードレビュー", "",
    `**${labels[event]}${incomplete ? " · 調査未完了" : ""}** · 指摘 ${report.findings.length}件`, "",
    incomplete ? "必要な検証が残っています。未確認事項を確認してください。" : safe(report.summary), "",
  ];
  if (commentOnly) sections.push("", "Draftまたは同一BotによるPRのため、コメントとして投稿しています。");
  if (inlineCount > 0) sections.push("", `コード上のインラインコメント ${inlineCount}件を確認してください。`);

  for (const finding of fallbackFindings) {
    const path = finding.file.split("/").map(part => encodeURIComponent(part)
      .replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16)}`)).join("/");
    const revision = finding.removed ? pr.base.sha : pr.head.sha;
    const codeUrl = `${repoUrl}/blob/${revision}/${path}#L${finding.line}`;
    sections.push("", `### [${finding.severity}] ${safe(finding.title)}`, "",
      `<a href="${escapeHtml(codeUrl)}"><code>${escapeHtml(finding.file)}:L${finding.line}</code></a>`,
      "", safe(finding.body) + findingEvidence(finding));
  }
  const checks = report.not_run_checks || [];
  if (checks.length > 0) {
    sections.push("", "### 未確認", "",
      ...checks.map(c => `- <code>${escapeHtml(c.command)}</code>: ${escapeHtml(c.result)}`));
  } else if (report.limitations.length > 0) {
    sections.push("", "### 未確認", "", ...report.limitations.map(value => `- ${safe(value)}`));
  }

  sections.push("", "<details>", "<summary>調査ログ</summary>", "");
  if (incomplete) sections.push("### 調査メモ", "", escapeHtml(report.summary), "");
  if (report.schema_version === 2) {
    sections.push("### 評価と根拠", "", escapeHtml(report.verification_rationale), "");
    for (const assessment of report.assessments) {
      const evidence = assessment.evidence_step_ids.length > 0
        ? `観測 ${assessment.evidence_step_ids.join(", ")}` : "根拠未取得";
      sections.push(`- <strong>${escapeHtml(assessment.question)}</strong> ` +
        `${escapeHtml(assessment.conclusion)}（${assessment.resolved ? "確認済み" : "未解決"} · ${evidence}）`);
    }
  } else {
    sections.push("旧形式には根拠付きの評価がないため、自動承認しません。", "");
  }
  if (checks.length > 0 && report.limitations.length > 0) {
    sections.push("", "### 制約の詳細", "", ...report.limitations.map(value => `- ${escapeHtml(value)}`));
  }
  sections.push("", "### 実行記録", "");
  if (includeLogOutput) {
    for (const [index, record] of (report.investigation || report.checks).entries()) {
      sections.push(`#### 観測 ${index + 1}`, "");
      if (record.purpose) sections.push(escapeHtml(record.purpose), "");
      sections.push("コマンド:", `<pre><code>${escapeHtml(record.command)}</code></pre>`, "",
        "結果:", `<pre><code>${escapeHtml(record.result)}</code></pre>`, "");
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
