import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AUDIENCE_LABELS, AUDIENCES, MODES, MODE_LABELS, createRunId } from './core.mjs';
import { AuditSession, runBoundaryPath, runFullPath, serializeSession } from './walker.mjs';
import { analyze } from './analyze.mjs';
import { buildReport } from './report.mjs';

export const STAGE_REVISION = { initial: '1', release2: '2' };
export const STAGE_FOR_REVISION = { 1: 'initial', 2: 'release2' };

export function displayPath(from, to) {
  const relative = path.relative(from, to);
  return relative.startsWith('..') ? to : relative;
}

export function stamp(revision) {
  return `rev${revision}-${createRunId()}`;
}

export function priorPath(prior, mode, audience) {
  return prior?.pathResults?.find(result => result.plan.mode === mode && result.plan.audience === audience) ?? null;
}

function previousForm(previous) {
  return previous?.observations?.form?.form ?? previous?.observations?.audience?.form ?? null;
}

function previousHelp(previous) {
  return previous?.observations?.helpOpen?.component ?? null;
}

/**
 * 证据复用判定：只有同一发布、模式、页面状态才可采用。
 * 组件版号相同才允许“边界复核后复用”；报名表或帮助层任一变化都作废旧结论。
 */
export function reuseDecision(prior, plan, release, revision) {
  const previous = priorPath(prior, plan.mode, plan.audience);
  const form = release?.[plan.mode]?.[plan.audience] ?? null;
  const help = release?.[plan.mode]?.help ?? null;
  const label = `${plan.modeLabel}/${plan.audienceLabel}`;
  if (!previous) {
    return { label, result: '无可复用证据', mode: 'full', reason: '没有同一模式与人群的旧证据' };
  }

  if (plan.audience === 'desk') {
    const sameRevision = String(prior.revision) === String(revision);
    const previousTerminal = previous.status === 'terminal' && previous.observations?.terminal?.text;
    if (sameRevision && previousTerminal) {
      return { label, result: '直接复用', mode: 'reuse', reason: `同一发版 ${revision} 下人工接待终点与提示文本未变`, previous };
    }
    return {
      label,
      result: '重新确认人工接待终点',
      mode: 'full',
      reason: `人工接待分支没有报名表/帮助层版号可作为边界；发版由 ${prior.revision} 变为 ${revision}，需在本版本重新确认提示文本与是否真的没有后续控件`,
      previous,
    };
  }

  const previousFormId = previousForm(previous);
  const previousHelpId = previousHelp(previous);
  const sameRevision = String(prior.revision) === String(revision);
  const formSame = form !== null && previousFormId === form;
  const helpSame = help !== null && previousHelpId === help;

  if (sameRevision && previous.status === 'complete' && formSame && helpSame) {
    return { label, result: '直接复用', mode: 'reuse', reason: `同一发版 ${revision}，模式、人群、报名表 ${form} 与帮助层 ${help} 均未变`, previous };
  }
  if (formSame && helpSame) {
    return { label, result: '边界复核后复用', mode: 'boundary', reason: `发版由 ${prior.revision} 变为 ${revision}，但报名表 ${form} 与帮助层 ${help} 的组件版号相同；只需复核版本边界`, previous };
  }
  if (formSame && !helpSame) {
    return { label, result: '报名表部分可复用，帮助层须重建', mode: 'boundary', reason: `报名表 ${previousFormId} 未变，但帮助层由 ${previousHelpId} 变为 ${help}；旧帮助结论作废，需在新发版重新取得`, previous };
  }
  if (!formSame && helpSame) {
    return { label, result: '帮助层部分可复用，报名表须重建', mode: 'boundary', reason: `帮助层 ${help} 未变，但报名表由 ${previousFormId} 变为 ${form}；旧报名表结论作废`, previous };
  }
  return { label, result: '旧证据失效', mode: 'full', reason: `报名表 ${previousFormId}→${form}、帮助层 ${previousHelpId}→${help} 均有变化`, previous };
}

export function reuseSummary(decisions) {
  return {
    decisions: decisions.map(decision => ({ label: decision.label, result: decision.result, reason: decision.reason })),
    reused: decisions.filter(decision => decision.mode === 'reuse'),
    validated: decisions.filter(decision => decision.mode === 'boundary'),
    invalidated: decisions.filter(decision => decision.result === '旧证据失效'),
    reconfirmed: decisions.filter(decision => decision.result === '重新确认人工接待终点'),
  };
}

function planFor(revision, bulletin, release, mode, audience) {
  return {
    key: `${revision}::${mode}::${audience}`,
    revision,
    mode,
    audience,
    modeLabel: MODE_LABELS[mode],
    audienceLabel: AUDIENCE_LABELS[audience],
    entry: mode === 'district' ? '/signup/district' : '/signup/kiosk',
    eventName: bulletin.name,
    expectedForm: release?.[mode]?.[audience] ?? null,
  };
}

function notCollected(item, revision, bulletin, prior) {
  const previous = priorPath(prior, item.mode, item.audience);
  return {
    plan: planFor(revision, { name: bulletin.name }, null, item.mode, item.audience),
    status: 'not-collected',
    error: { kind: 'drift-skip', message: '发版在取证中途变化，未在本版本上开新分支' },
    observations: previous?.observations ?? {},
    phases: previous?.phases ?? {},
    milestones: [],
    startKey: 0,
    endKey: 0,
    reusedFrom: null,
    label: `${MODE_LABELS[item.mode]}/${AUDIENCE_LABELS[item.audience]}`,
  };
}

export async function auditRevision({ source, browser, revision, bulletin, release, prior, reportDir, root, keyBudget, driftAt }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = new AuditSession({
    page,
    sourceUrl: source.url,
    revision,
    release,
    bulletin,
    keyBudget,
    runId: stamp(revision),
  });

  if (driftAt) {
    let fired = false;
    session.onBeforeKey = async ({ session: current }) => {
      if (fired) return;
      if (current.keyCount + 1 >= driftAt) {
        fired = true;
        current.onBeforeKey = null;
        const next = STAGE_FOR_REVISION[revision] === 'initial' ? 'release2' : 'initial';
        await fetch(source.url + '/scenario/' + next, { method: 'POST' });
        current.driftFlippedTo = next;
      }
    };
  }

  const decisions = [];
  const results = [];
  const queue = [];
  for (const mode of MODES) {
    for (const audience of AUDIENCES) queue.push({ mode, audience });
  }

  for (const item of queue) {
    if (session.driftIncidents.length) break;
    const plan = planFor(revision, bulletin, release, item.mode, item.audience);
    const decision = reuseDecision(prior, plan, release, revision);
    decisions.push(decision);
    if (decision.mode === 'reuse') {
      results.push({
        ...decision.previous,
        reusedFrom: decision.previous.plan?.key ?? null,
        reusedRevision: decision.previous.plan?.revision ?? prior?.revision ?? null,
        reused: true,
        reuseDecision: decision,
      });
      continue;
    }
    const result = decision.mode === 'boundary'
      ? await runBoundaryPath(session, plan, decision.previous)
      : await runFullPath(session, plan);
    result.reuseDecision = decision;
    results.push(result);
  }

  const covered = new Set(results.map(result => `${result.plan.mode}:${result.plan.audience}`));
  for (const item of queue) {
    if (covered.has(`${item.mode}:${item.audience}`)) continue;
    results.push(notCollected(item, revision, bulletin, prior));
  }

  session.pathResults = results;
  const serialized = serializeSession(session);
  serialized.pathResults = results;
  serialized.reuseDecisions = decisions.map(decision => ({
    label: decision.label,
    result: decision.result,
    mode: decision.mode,
    reason: decision.reason,
    previousRevision: decision.previous?.plan?.revision ?? null,
  }));
  serialized.stage = STAGE_FOR_REVISION[revision] ?? null;
  serialized.sourceUrl = source.url;
  serialized.sourceCalls = source.calls.filter(call => call.stage === serialized.stage);
  serialized.confirmedPosts = source.calls.filter(call => call.method === 'POST' && call.path.startsWith('/signup/confirmed')).length;

  await mkdir(reportDir, { recursive: true });
  const evidenceFile = path.join(reportDir, `${serialized.runId}.evidence.json`);

  const analysis = analyze(session, {
    bulletin,
    release,
    prior,
    reuse: reuseSummary(decisions),
    targetRevision: revision,
    evidenceFile: displayPath(root, evidenceFile),
    sourceCalls: serialized.sourceCalls,
  });
  analysis.coverage.requested = JSON.parse(await readFile(path.join(root, 'data/inspection-requests.json'), 'utf8'));
  serialized.dedupe = analysis.dedupe;
  serialized.safety = analysis.safety;
  serialized.findings = analysis.findings.map(finding => ({
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    strength: finding.strength,
    paths: finding.paths,
    versions: finding.versions,
    state: finding.beforeState,
  }));

  const report = buildReport({
    run: { ...serialized, evidenceFile: displayPath(root, evidenceFile) },
    analysis,
  });
  const reportFile = path.join(reportDir, `${serialized.runId}.report.md`);

  await writeFile(evidenceFile, JSON.stringify(serialized, null, 2));
  await writeFile(reportFile, report);
  await context.close();
  return { serialized, analysis, evidenceFile, reportFile };
}
