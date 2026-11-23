import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { launchBrowser } from '../tools/audit/core.mjs';
import { auditRevision } from '../tools/audit/run.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let source;
let browser;
let reportDir;

async function collect(revision, { prior = null, drift = null } = {}) {
  const stage = revision === '1' ? 'initial' : 'release2';
  await fetch(source.url + '/scenario/' + stage, { method: 'POST' });
  const bulletin = await (await fetch(source.url + '/bulletin')).json();
  const release = await (await fetch(source.url + '/release')).json();
  const run = await auditRevision({
    source,
    browser,
    revision,
    bulletin,
    release,
    prior,
    reportDir,
    root: ROOT,
    driftAt: drift,
  });
  const report = await readFile(run.reportFile, 'utf8');
  const evidence = JSON.parse(await readFile(run.evidenceFile, 'utf8'));
  return { run, report, evidence };
}

let first;      // 发版 1 完整取证
let second;     // 发版 2，带发版 1 的旧证据
let driftRun;   // 取证中途发版的演练

before(async () => {
  source = await startSources();
  browser = await launchBrowser();
  reportDir = await mkdtemp(path.join(tmpdir(), 'audit-'));
  first = await collect('1');
  second = await collect('2', { prior: first.evidence });
  driftRun = await collect('1', { drift: 30 });
  await fetch(source.url + '/scenario/initial', { method: 'POST' });
});

after(async () => {
  await browser?.close();
  await source?.close();
  await rm(reportDir, { recursive: true, force: true });
});

test('发版 1 键盘取证覆盖六个分支且从不提交确认报名', () => {
  const statuses = Object.fromEntries(first.evidence.pathResults.map(result => [
    `${result.plan.mode}:${result.plan.audience}`,
    result.status,
  ]));
  assert.deepEqual(statuses, {
    'district:community': 'complete',
    'district:work': 'complete',
    'district:desk': 'terminal',
    'kiosk:community': 'complete',
    'kiosk:work': 'complete',
    'kiosk:desk': 'terminal',
  });
  assert.equal(first.evidence.confirmedPosts, 0);
  assert.equal(first.evidence.safety.confirmedRequests, 0);
  assert.equal(first.evidence.driftIncidents.length, 0);

  const desk = first.evidence.pathResults.find(result => result.plan.audience === 'desk');
  assert.match(desk.observations.terminal.text, /人工接待/);
  assert.equal(desk.observations.terminal.controlCount, 1);

  for (const label of ['已观察', '页面文本确实没读到', '键盘路径进不到', '当前资料不足以判断']) {
    assert.ok(first.report.includes(label), label);
  }
  assert.match(first.report, /确认报名.*只聚焦.*从未按下/s);
  assert.ok(first.run.analysis.findings.some(finding => finding.id === 'HELP-CONTENT-H1-district-community-work'));
  assert.ok(!first.run.analysis.findings.some(finding => finding.id.startsWith('UNREACHABLE')));
});

test('帮助层 H1 的焦点逃逸在四个分支上被合并为一条问题', () => {
  const focusFindings = first.run.analysis.findings.filter(finding => finding.id === 'HELP-FOCUS-H1');
  assert.equal(focusFindings.length, 1);
  assert.equal(focusFindings[0].paths.length, 4);
  assert.match(focusFindings[0].observedNames, /文档 body/);
  assert.match(focusFindings[0].beforeState, /^S\d{3}/);
});

test('发版 2 的 H2 帮助层在街道终端缺正文，而区报名页有正文', () => {
  const content = second.run.analysis.findings.find(finding => finding.id.startsWith('HELP-CONTENT-H2'));
  assert.ok(content, '应报告 H2 缺正文');
  assert.deepEqual(content.paths, ['街道自助终端/社区居民']);
  assert.match(content.affectedScope, /区报名页\/社区居民/);
  assert.ok(second.run.analysis.findings.some(finding => finding.id === 'HELP-ROLE-H2'));
});

test('发版切换后，边界未变的旧证据只做边界复核而不是整段重走', () => {
  const decisions = Object.fromEntries(second.evidence.reuseDecisions.map(decision => [decision.label, decision]));
  assert.equal(decisions['区报名页/社区居民'].result, '旧证据失效');
  assert.equal(decisions['区报名页/流动职工'].result, '报名表部分可复用，帮助层须重建');
  const partial = second.evidence.pathResults.filter(result => result.status === 'partial');
  assert.equal(partial.length, 2);
  assert.ok(second.evidence.keyCount < first.evidence.keyCount, '边界复核应比完整重走少按键');
  assert.equal(second.evidence.confirmedPosts, 0);
});

test('取证中途发版时立即停止并标记为不可签收', () => {
  assert.equal(driftRun.evidence.driftIncidents.length, 1);
  assert.match(driftRun.evidence.driftIncidents[0].context, /按键/);
  const drifted = driftRun.evidence.pathResults.filter(result => result.status === 'drifted');
  const skipped = driftRun.evidence.pathResults.filter(result => result.status === 'not-collected');
  assert.equal(drifted.length, 1);
  assert.equal(skipped.length, 5);
  assert.match(driftRun.report, /本报告不得签收/);
  assert.equal(driftRun.evidence.confirmedPosts, 0);
  assert.ok(driftRun.run.analysis.findings.length < first.run.analysis.findings.length);
});

test('预览分支改人群不会误入人工接待终点', () => {
  for (const result of first.evidence.pathResults.filter(item => item.status === 'complete')) {
    const info = result.observations.previewSwitch;
    assert.ok(info, result.plan.key);
    assert.equal(info.phase, 'form', `${result.plan.key} 预览改人群后应回到报名表`);
    assert.equal(info.audience === 'desk', false);
  }
});
