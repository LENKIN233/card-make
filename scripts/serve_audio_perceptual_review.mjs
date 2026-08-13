#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PERCEPTUAL_CHECKS,
  reviewAudioPerceptualEntry,
  validateAudioPerceptualWorklist,
} from './manage_audio_perceptual_worklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024;
const CHECK_LABELS = Object.freeze({
  audio_matches_text: ['音文一致', '听到的内容与逐字稿一致'],
  target_signal_audible: ['目标清楚', '本卡要训练的听力信号可以明确听到'],
  accurate_pronunciation: ['发音准确', '没有会改变理解或答案的发音错误'],
  suitable_speed: ['语速合适', '语速适合本卡的训练层级'],
  natural_rhythm: ['节奏自然', '语流和节奏像自然口语'],
  stress_and_pauses_do_not_mislead: ['重音停顿不误导', '重音与停顿不会泄露或扭曲答案'],
  no_unwanted_noise_or_clipping: ['无噪声削波', '没有多余噪声、爆音或削波'],
});

export function parseReviewStationArguments(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return {help: true};
  const options = {file: null, port: 4179};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--file', '--port'].includes(argument)) {
      throw new Error(`unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === '--file') options.file = value;
    if (argument === '--port') options.port = requirePort(value);
  }
  if (!options.file) throw new Error('--file is required');
  return options;
}

export function createAudioPerceptualReviewStation({
  root = ROOT,
  worklistPath,
} = {}) {
  const normalizedRoot = path.resolve(root);
  const worklistFile = requireAllowedWorklist(worklistPath, normalizedRoot);
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  let reviewWriteActive = false;

  return http.createServer(async (request, response) => {
    try {
      requireLoopbackRequest(request);
      setSecurityHeaders(response);
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (request.method === 'GET' && url.pathname === '/') {
        return sendHtml(response, renderReviewStation({csrfToken}));
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const loaded = loadValidatedWorklist(worklistFile, normalizedRoot);
        return sendJson(response, 200, publicState(loaded.worklist));
      }
      if (request.method === 'GET' && url.pathname === '/audio') {
        const loaded = loadValidatedWorklist(worklistFile, normalizedRoot);
        return sendAudio(request, response, loaded.worklist, url.searchParams.get('card_id'), normalizedRoot);
      }
      if (request.method === 'POST' && url.pathname === '/api/review') {
        if (request.headers['x-review-csrf'] !== csrfToken) {
          return sendJson(response, 403, {ok: false, error: '审核会话已失效，请刷新页面。'});
        }
        if (reviewWriteActive) {
          return sendJson(response, 409, {ok: false, error: '上一条审核仍在保存，请稍后重试。'});
        }
        reviewWriteActive = true;
        try {
          const body = await readJsonBody(request);
          const loaded = loadValidatedWorklist(worklistFile, normalizedRoot);
          const updated = applyReviewSubmission({
            submission: body,
            technicalAudit: loaded.technicalAudit,
            worklist: loaded.worklist,
            root: normalizedRoot,
          });
          writeJsonAtomic(worklistFile, updated);
          return sendJson(response, 200, {ok: true, state: publicState(updated)});
        } finally {
          reviewWriteActive = false;
        }
      }
      return sendJson(response, 404, {ok: false, error: '未找到。'});
    } catch (error) {
      const status = error?.statusCode || 400;
      return sendJson(response, status, {
        ok: false,
        error: String(error?.message || '审核台发生错误').replace(/\s+/g, ' ').trim(),
      });
    }
  });
}

export function applyReviewSubmission({submission, technicalAudit, worklist, root = ROOT}) {
  exactSubmissionKeys(submission);
  if (submission.listened_to_entire_asset !== true) {
    throw new Error('必须完整播放当前音频后才能提交。');
  }
  const cardId = String(submission.card_id || '');
  const current = nextReviewEntry(worklist);
  if (!current || current.card_id !== cardId) {
    throw new Error('一次只能提交审核台当前显示的一条音频。');
  }
  const checkUpdates = PERCEPTUAL_CHECKS.map(name => {
    const value = submission.checks?.[name];
    if (!['pass', 'fail'].includes(value)) {
      throw new Error(`必须明确选择 ${CHECK_LABELS[name][0]} 的通过或不通过。`);
    }
    return {name, value};
  });
  const updated = reviewAudioPerceptualEntry({
    cardId,
    checkUpdates,
    listenedToEntireAsset: true,
    notes: submission.notes ?? '',
    reviewer: submission.reviewer,
    worklist,
  });
  const errors = validateAudioPerceptualWorklist(updated, {
    root,
    technicalAudit,
  });
  if (errors.length > 0) throw new Error(`审核结果无效：${errors.join('; ')}`);
  return updated;
}

function loadValidatedWorklist(worklistFile, root) {
  const worklist = readJson(worklistFile);
  const auditFile = requireWorkspaceFile(worklist.source_technical_audit?.path, root);
  const auditBytes = fs.readFileSync(auditFile);
  if (sha256(auditBytes) !== worklist.source_technical_audit?.file_sha256) {
    throw new Error('技术音频审计文件已变化，请重新生成审核队列。');
  }
  const technicalAudit = JSON.parse(auditBytes.toString('utf8'));
  const errors = validateAudioPerceptualWorklist(worklist, {root, technicalAudit});
  if (errors.length > 0) throw new Error(`审核队列无效：${errors.join('; ')}`);
  return {technicalAudit, worklist};
}

function publicState(worklist) {
  const current = nextReviewEntry(worklist);
  return {
    ok: true,
    authority_boundary: '只记录真人逐条听感审核；不批准卡片内容，也不替代正式 audio_qc。',
    progress: worklist.progress,
    current: current
      ? {
          sequence: current.sequence,
          card_id: current.card_id,
          transcript: current.audio.transcript,
          duration_ms: current.audio.probed_duration_ms,
          knowledge_ref: current.knowledge_ref,
          training_context: current.training_context,
          checks: current.checks,
          review: current.review,
          audio_url: `/audio?card_id=${encodeURIComponent(current.card_id)}`,
        }
      : null,
    check_labels: CHECK_LABELS,
  };
}

function nextReviewEntry(worklist) {
  return worklist.entries.find(entry => entry.review.status === 'in_progress')
    ?? worklist.entries.find(entry => entry.review.status === 'pending')
    ?? null;
}

function sendAudio(request, response, worklist, cardId, root) {
  const entry = worklist.entries.find(candidate => candidate.card_id === String(cardId || ''));
  if (!entry) throw new Error('音频卡片不存在。');
  const file = requireWorkspaceFile(entry.audio.asset_path, root);
  const stat = fs.statSync(file);
  const range = parseRange(request.headers.range, stat.size);
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'audio/mpeg');
  if (range) {
    response.statusCode = 206;
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    response.setHeader('Content-Length', range.end - range.start + 1);
    fs.createReadStream(file, range).pipe(response);
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Length', stat.size);
  fs.createReadStream(file).pipe(response);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d+)-(\d*)$/);
  if (!match) throw new Error('无效的音频范围请求。');
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= size) {
    throw new Error('音频范围超出文件边界。');
  }
  return {start, end};
}

function exactSubmissionKeys(submission) {
  const expected = ['card_id', 'checks', 'listened_to_entire_asset', 'notes', 'reviewer'];
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    throw new Error('审核提交必须是对象。');
  }
  const actual = Object.keys(submission).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('审核提交字段不完整或包含未知字段。');
  }
  const checkKeys = Object.keys(submission.checks || {}).sort();
  const expectedChecks = [...PERCEPTUAL_CHECKS].sort();
  if (
    checkKeys.length !== expectedChecks.length ||
    checkKeys.some((key, index) => key !== expectedChecks[index])
  ) {
    throw new Error('七项听感检查必须完整。');
  }
}

function requireAllowedWorklist(value, root) {
  const file = requireWorkspaceFile(value, root);
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (
    !relative.startsWith('exports/') &&
    !relative.startsWith('reviews/audio_perceptual_worklists/')
  ) {
    throw new Error('审核队列必须位于 exports/ 或 reviews/audio_perceptual_worklists/。');
  }
  return file;
}

function requireWorkspaceFile(value, root) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少文件路径。');
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件必须位于内容工作区。');
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('文件必须是普通文件。');
  return resolved;
}

function requireLoopbackRequest(request) {
  const remote = request.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    const error = new Error('审核台只接受本机请求。');
    error.statusCode = 403;
    throw error;
  }
  const host = String(request.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    const error = new Error('审核台只允许 loopback host。');
    error.statusCode = 403;
    throw error;
  }
}

function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('审核提交过大。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('审核提交不是有效 JSON。');
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o644});
  fs.renameSync(temporary, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requirePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('--port must be an integer from 1024 to 65535');
  }
  return port;
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', bytes.length);
  response.end(bytes);
}

function sendHtml(response, html) {
  const bytes = Buffer.from(html);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Content-Length', bytes.length);
  response.end(bytes);
}

function renderReviewStation({csrfToken}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>软书 · 音频真人听感审核</title>
  <style>
    :root { color-scheme: light; --ink:#17201d; --muted:#66736e; --paper:#f5f1e8; --card:#fffdf8; --line:#d8d3c8; --mint:#bfe9d4; --mint-strong:#1f7357; --amber:#f2c76e; --red:#a53a35; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(920px,calc(100% - 32px)); margin:0 auto; padding:40px 0 72px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:24px; }
    h1 { margin:0; font:700 clamp(28px,5vw,48px)/1.05 Georgia,serif; letter-spacing:-.03em; }
    .eyebrow { margin:0 0 8px; color:var(--mint-strong); font-weight:700; letter-spacing:.12em; text-transform:uppercase; font-size:12px; }
    .progress { min-width:180px; text-align:right; color:var(--muted); }
    .progress strong { display:block; color:var(--ink); font-size:26px; }
    .panel { background:var(--card); border:1px solid var(--line); border-radius:24px; padding:clamp(20px,4vw,36px); box-shadow:0 18px 60px rgba(61,51,36,.08); }
    .meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:22px; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:5px 10px; color:var(--muted); font-size:13px; }
    h2 { margin:0 0 10px; font:700 clamp(23px,4vw,34px)/1.2 Georgia,serif; }
    .target { color:var(--muted); margin:0 0 22px; }
    .transcript { border-left:4px solid var(--amber); padding:4px 0 4px 18px; font-size:19px; margin:22px 0; }
    audio { width:100%; margin:6px 0 12px; }
    .listen-status { min-height:24px; color:var(--muted); font-size:14px; }
    .listen-status.done { color:var(--mint-strong); font-weight:700; }
    .reviewer { display:grid; gap:8px; margin:24px 0; }
    label { font-weight:650; }
    input[type=text], textarea { width:100%; border:1px solid var(--line); background:white; border-radius:12px; padding:12px 14px; font:inherit; color:inherit; }
    input:focus, textarea:focus, button:focus-visible { outline:3px solid rgba(31,115,87,.25); outline-offset:2px; }
    fieldset { border:0; padding:0; margin:0; display:grid; gap:12px; }
    .check { display:grid; grid-template-columns:1fr auto; align-items:center; gap:18px; border-top:1px solid var(--line); padding-top:14px; }
    .check small { display:block; color:var(--muted); font-weight:400; margin-top:2px; }
    .choice { display:flex; gap:8px; }
    .choice label { cursor:pointer; border:1px solid var(--line); border-radius:999px; padding:7px 11px; font-size:14px; }
    .choice input { accent-color:var(--mint-strong); }
    .notes { margin:22px 0; display:grid; gap:8px; }
    button { width:100%; border:0; border-radius:14px; background:var(--ink); color:white; padding:14px 18px; font:700 16px/1.2 inherit; cursor:pointer; }
    button:disabled { cursor:not-allowed; opacity:.38; }
    .message { min-height:26px; margin:14px 0 0; font-weight:650; }
    .message.error { color:var(--red); }
    .boundary { margin-top:18px; color:var(--muted); font-size:13px; text-align:center; }
    .complete { padding:48px 16px; text-align:center; }
    @media (max-width:640px) { header { align-items:flex-start; flex-direction:column; } .progress { text-align:left; } .check { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header><div><p class="eyebrow">Human perceptual QC</p><h1>逐条听，逐条确认。</h1></div><div class="progress" id="progress"></div></header>
    <section class="panel" id="app" aria-live="polite">正在读取审核队列…</section>
    <p class="boundary">只记录真人完整试听后的听感结论；不批准卡片内容，不证明来源真实性，也不提供批量通过。</p>
  </main>
  <script>
    const csrf = ${JSON.stringify(csrfToken)};
    let state = null;
    let listened = false;
    const app = document.querySelector('#app');
    const progress = document.querySelector('#progress');
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
    async function load() {
      const response = await fetch('/api/state', {cache:'no-store'});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '无法读取审核队列');
      state = body; listened = false; render();
    }
    function render() {
      progress.innerHTML = '<strong>' + state.progress.passed + ' / ' + state.progress.total + '</strong>已通过 · ' + state.progress.failed + ' 条需替换';
      if (!state.current) {
        app.innerHTML = '<div class="complete"><p class="eyebrow">Queue complete</p><h2>这份审核队列已经完成</h2><p>下一步由现有工具生成并验证正式 audio_qc 记录。</p></div>';
        return;
      }
      const entry = state.current;
      const checkRows = Object.entries(state.check_labels).map(([name, labels]) => '<div class="check"><label>' + escapeHtml(labels[0]) + '<small>' + escapeHtml(labels[1]) + '</small></label><div class="choice"><label><input required type="radio" name="' + name + '" value="pass"> 通过</label><label><input required type="radio" name="' + name + '" value="fail"> 不通过</label></div></div>').join('');
      app.innerHTML = '<div class="meta"><span class="pill">第 ' + entry.sequence + ' 条</span><span class="pill">卡片 ' + escapeHtml(entry.card_id) + '</span><span class="pill">' + escapeHtml(entry.knowledge_ref.box_name) + '</span></div><h2>' + escapeHtml(entry.training_context.main_training_goal) + '</h2><p class="target">盒内作用：' + escapeHtml(entry.training_context.box_progression_role) + '</p><audio controls preload="metadata" src="' + escapeHtml(entry.audio_url) + '"></audio><div id="listenStatus" class="listen-status">请完整播放到结尾；拖动到末尾不计为完整试听。</div><div class="transcript" lang="en">' + escapeHtml(entry.transcript) + '</div><form id="form"><div class="reviewer"><label for="reviewer">真人审核者身份</label><input id="reviewer" name="reviewer" type="text" required autocomplete="off" placeholder="github:你的账号 / team:审核员 / external:姓名"></div><fieldset><legend class="eyebrow">七项必须全部判断</legend>' + checkRows + '</fieldset><div class="notes"><label for="notes">备注（任一项不通过时必填）</label><textarea id="notes" name="notes" rows="3" placeholder="说明具体问题和需要替换的原因"></textarea></div><button id="submit" disabled>完整试听后提交这一条</button><p id="message" class="message"></p></form>';
      const audio = app.querySelector('audio');
      const button = app.querySelector('#submit');
      const status = app.querySelector('#listenStatus');
      let furthest = 0;
      let skippedAhead = false;
      audio.addEventListener('timeupdate', () => { if (!audio.seeking) furthest = Math.max(furthest, audio.currentTime); });
      audio.addEventListener('seeking', () => {
        if (audio.currentTime > furthest + .75) {
          skippedAhead = true;
          listened = false;
          button.disabled = true;
          status.textContent = '检测到向前拖动；请从头重新完整播放本条音频。';
          status.classList.remove('done');
        }
      });
      audio.addEventListener('play', () => {
        if (skippedAhead && audio.currentTime < .25) { skippedAhead = false; furthest = 0; }
      });
      audio.addEventListener('ended', () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (!skippedAhead && duration > 0 && furthest >= duration - Math.max(.35, duration * .015)) {
          listened = true; button.disabled = false; status.textContent = '已完整播放，可以提交本条审核。'; status.classList.add('done');
        }
      });
      app.querySelector('#form').addEventListener('submit', submitReview);
    }
    async function submitReview(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const message = form.querySelector('#message');
      const button = form.querySelector('#submit');
      const checks = {};
      for (const name of Object.keys(state.check_labels)) checks[name] = new FormData(form).get(name);
      const hasFailure = Object.values(checks).includes('fail');
      const notes = form.notes.value.trim();
      if (hasFailure && !notes) { message.textContent = '有不通过项时必须写明具体问题。'; message.className = 'message error'; return; }
      button.disabled = true; message.textContent = '正在保存这一条…'; message.className = 'message';
      try {
        const response = await fetch('/api/review', {method:'POST', headers:{'content-type':'application/json','x-review-csrf':csrf}, body:JSON.stringify({card_id:state.current.card_id, reviewer:form.reviewer.value.trim(), listened_to_entire_asset:listened, checks, notes})});
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '保存失败');
        state = body.state; listened = false; render();
      } catch (error) { message.textContent = error.message; message.className = 'message error'; button.disabled = !listened; }
    }
    load().catch(error => { app.innerHTML = '<p class="message error">' + escapeHtml(error.message) + '</p>'; });
  </script>
</body>
</html>`;
}

function printUsage() {
  console.log(`Usage:\n  node scripts/serve_audio_perceptual_review.mjs --file <worklist.json> [--port 4179]\n\nThe station binds only to ${LOOPBACK_HOST} and records one complete human review at a time.`);
}

async function main() {
  try {
    const options = parseReviewStationArguments(process.argv.slice(2));
    if (options.help) return printUsage();
    const server = createAudioPerceptualReviewStation({worklistPath: options.file});
    server.listen(options.port, LOOPBACK_HOST, () => {
      console.log(`[audio-review-station] http://${LOOPBACK_HOST}:${options.port}/`);
    });
  } catch (error) {
    console.error(`[audio-review-station] ${String(error.message).replace(/\s+/g, ' ').trim()}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
