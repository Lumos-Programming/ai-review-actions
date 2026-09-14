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

  // AI出力は本文としてだけ扱い、コードとして評価しない。
  // 意図しないメンション通知も抑制する。
  const safe = s => s.replace(/@/g, "@\u200b");
  const sections = ["## AIコードレビュー", "", safe(report.summary)];
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...report.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of findings) {
    sections.push("", `### [${f.severity}] ${safe(f.title)}`,
      "", `**対象:** \`${safe(f.file)}:L${f.line}\``, "", safe(f.body));
  }
  if (findings.length === 0) {
    sections.push("", incomplete
      ? "調査は未完了です。指摘がないことを理由に承認はしていません。"
      : "調査した範囲では、明確な問題は見つかりませんでした。");
  }
  if (report.limitations.length > 0) {
    sections.push("", "### 調査上の制約", ...report.limitations.map(v => `- ${safe(v)}`));
  }
  sections.push("", "### 調査・検証の記録");
  for (const c of report.checks) {
    sections.push(`- **${c.status}**: ${safe(c.command)} — ${safe(c.result)}`);
  }

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
    sections.push("", "Draftまたは同一Botが作成したPRのため、COMMENTとして投稿します。");
  }

  sections.splice(2, 0, `**判定: ${event}**`, "");
  const runUrl = `${serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  sections.push("", "---",
    `モデル: \`${safe(model)}\` / 対象: \`${pr.head.sha}\``,
    `[実行ログ](${runUrl})`,
    "AIによる補助レビューです。通常のCIと人間による確認も実施してください。",
    marker);
  const body = sections.join("\n");
  requireValid(Buffer.byteLength(body, "utf8") <= 60000, "投稿本文のサイズ");

  // 通常コメントではなく、対象コミットを指定した正式なPR Review。
  // 権限不足などで失敗した場合は、成功したふりをせずジョブを失敗させる。
  const { data: review } = await github.rest.pulls.createReview({
    ...target,
    commit_id: pr.head.sha,
    event,
    body
  });
  core.info(`レビューを投稿しました: ${event} / ${review.html_url}`);
  return { published: true, event, reviewUrl: review.html_url };
}

module.exports = { publishReview };
