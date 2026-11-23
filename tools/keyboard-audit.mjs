#!/usr/bin/env node
/**
 * 普法活动报名路径的键盘可达取证（Node.js + Playwright）
 *
 * 用法：
 *   node tools/keyboard-audit.mjs --stage initial
 *   node tools/keyboard-audit.mjs --stage release2 --prior reports/<run>.evidence.json
 *   node tools/keyboard-audit.mjs --stage initial --drift-at 120   # 演练取证中途发版，自动续采新版本
 *
 * 只导航到维护方声明的入口 URL，其余全部键盘操作；
 * 只把焦点移到“确认报名”，不按 Enter，不 POST /signup/confirmed。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startSources } from '../sources/server.mjs';
import { AUDIENCE_LABELS, BULLETIN_PATH, MODE_LABELS, RELEASE_PATH, launchBrowser } from './audit/core.mjs';
import { STAGE_REVISION, auditRevision, displayPath, priorPath } from './audit/run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = {
    stage: 'initial',
    reportDir: path.join(ROOT, 'reports'),
    prior: null,
    driftAt: null,
    keyBudget: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--stage') args.stage = argv[++i];
    else if (value === '--prior') args.prior = argv[++i];
    else if (value === '--drift-at') args.driftAt = Number(argv[++i]);
    else if (value === '--key-budget') args.keyBudget = Number(argv[++i]);
    else if (value === '--report-dir') args.reportDir = path.resolve(argv[++i]);
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`未知参数：${value}`);
  }
  return args;
}

async function loadPrior(file) {
  if (!file) return null;
  return JSON.parse(await readFile(path.resolve(file), 'utf8'));
}

function lineFor(result) {
  const label = `${MODE_LABELS[result.plan.mode]}/${AUDIENCE_LABELS[result.plan.audience]}`;
  const state = result.reused ? '复用旧证据' : result.status === 'drifted' ? '漂移中止' : result.status;
  const decision = result.reuseDecision?.result && result.reuseDecision.result !== '无可复用证据' ? `，${result.reuseDecision.result}` : '';
  return `  - ${label}：${state}${decision}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node tools/keyboard-audit.mjs --stage initial|release2 [--prior file] [--drift-at N] [--report-dir dir]');
    return;
  }
  if (!Object.hasOwn(STAGE_REVISION, args.stage)) throw new Error(`未知阶段：${args.stage}`);

  const prior = await loadPrior(args.prior);
  const source = await startSources(0);
  const browser = await launchBrowser();
  try {
    if (prior) {
      const notices = [];
      for (const mode of Object.keys(prior.release ?? {})) {
        for (const audience of Object.keys(prior.release[mode] ?? {})) {
          const previous = priorPath(prior, mode, audience);
          if (previous?.status === 'complete') notices.push(`${mode}/${audience}=${prior.release[mode][audience]}`);
        }
      }
      if (notices.length) console.log(`旧证据发版 revision=${prior.revision}：${notices.join('、')}`);
    }

    await fetch(source.url + '/scenario/' + args.stage, { method: 'POST' });
    const bulletin = await (await fetch(source.url + BULLETIN_PATH)).json();
    const release = await (await fetch(source.url + RELEASE_PATH)).json();
    const revision = String(release.revision);
    if (revision !== STAGE_REVISION[args.stage]) {
      throw new Error(`阶段 ${args.stage} 的发版为 ${revision}，与预期 ${STAGE_REVISION[args.stage]} 不符`);
    }

    const first = await auditRevision({
      source,
      browser,
      revision,
      bulletin,
      release,
      prior,
      reportDir: args.reportDir,
      root: ROOT,
      keyBudget: args.keyBudget,
      driftAt: args.driftAt,
    });

    const runs = [first];
    let finalRevision = revision;
    if (first.serialized.driftIncidents.length > 0) {
      const nextRelease = await (await fetch(source.url + RELEASE_PATH)).json();
      const nextRevision = String(nextRelease.revision);
      if (nextRevision !== revision) {
        finalRevision = nextRevision;
        const second = await auditRevision({
          source,
          browser,
          revision: nextRevision,
          bulletin,
          release: nextRelease,
          prior: first.serialized,
          reportDir: args.reportDir,
          root: ROOT,
          keyBudget: args.keyBudget,
          driftAt: null,
        });
        runs.push(second);
      }
    }

    for (const run of runs) {
      const drifted = run.serialized.driftIncidents.length > 0;
      console.log(`\n发版 ${run.serialized.revision}${drifted ? '（取证中途发生版本漂移，结论仅供追溯，不签收）' : ''}`);
      console.log(`  证据：${displayPath(ROOT, run.evidenceFile)}`);
      console.log(`  报告：${displayPath(ROOT, run.reportFile)}`);
      for (const result of run.serialized.pathResults) console.log(lineFor(result));
      const findings = run.analysis.findings.filter(item => item.severity !== 'ok');
      const blockers = findings.filter(item => item.severity === 'blocker').length;
      console.log(`  问题 ${findings.length} 项（键盘可达缺陷 ${blockers} 项）；漂移 ${run.serialized.driftIncidents.length} 次；按键 ${run.serialized.keyCount} 次；确认报名请求 ${run.serialized.confirmedPosts} 次`);
    }

    const final = runs.at(-1);
    if (runs.length > 1) {
      console.log(`\n签收对象：发版 ${finalRevision}（${displayPath(ROOT, final.reportFile)}）。发版 ${revision} 的报告仅用于漂移追溯，不得签收。`);
    } else {
      console.log(`\n签收对象：发版 ${finalRevision}（${displayPath(ROOT, final.reportFile)}）。`);
    }
  } finally {
    await browser.close();
    await source.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
