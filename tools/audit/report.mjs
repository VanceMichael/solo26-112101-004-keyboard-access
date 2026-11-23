import { readFile } from 'node:fs/promises';
import { AUDIENCE_LABELS, MODE_LABELS, compact } from './core.mjs';
import { PHASE_LABELS } from './analyze.mjs';

export const SECTIONS = {
  A: '结论与签收边界',
  B: '方法与证据强度',
  C: '逐路径键盘轨迹',
  D: '问题清单与复现',
  E: '影响范围检索',
  F: '版本漂移与证据复用',
  G: '未能取证的部分',
  H: '问题状态索引',
  I: '证据文件',
};

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${row.join(' | ')} |`).join('\n');
  return [head, rule, body].filter(Boolean).join('\n');
}

function code(value) {
  const text = String(value ?? '');
  return text === '' ? '（空）' : `\`${text.replace(/`/g, "'")}\``;
}

function nameOf(focus) {
  if (!focus) return '（未采集）';
  if (focus.body) return 'body';
  return `${focus.role}：“${focus.name || '无名称'}”`;
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function buildReport({ run, analysis }) {
  const lines = [];
  const { revision, release, bulletin } = run;
  const { paths, findings, reuse, drift, boundaryResults, coverage } = analysis;

  lines.push(`# 普法活动报名键盘可达取证报告（发版 ${revision}）`);
  lines.push('');
  lines.push(`- 演练来源：\`${run.sourceUrl}\`（同一来源进程，阶段切换与观察记录见证据 JSON）`);
  lines.push(`- 活动：${bulletin.event} ${bulletin.name}；公开入口 \`/bulletin\` 声明模式 ${bulletin.modes.map(mode => code(mode)).join('、')}`);
  lines.push(`- 发版：\`/release\` revision=${revision}；区报名页 ${formatRelease(release.district)}；街道终端 ${formatRelease(release.kiosk)}`);
  lines.push(`- 观察对象：\`data-publication\`（总版号）、\`data-form\`（报名表版号）、\`data-component\`（帮助层版号）`);
  lines.push(`- 观察方式：Chromium 无头浏览器，仅导航到维护方声明的入口 URL；其后全部为键盘操作（Tab / Shift+Tab / ArrowUp / ArrowDown / Home / Enter / Escape / 字符输入）`);
  lines.push(`- 停止点：只把焦点移到“确认报名”，不按 Enter；全程未向 \`/signup/confirmed\` 发起请求`);
  lines.push(`- 键盘操作数：${run.keyCount} / 预算 ${run.keyBudget}；状态数：${run.stateCount}；耗时 ${(run.elapsedMs / 1000).toFixed(1)} 秒 / 演练巡查时段 ${bulletin.traversalMinutes ?? '—'} 分钟`);
  lines.push(`- 循环控制：焦点巡查遇到重复焦点边即停，不靠耗完时段结束；本次提前停止 ${run.loops.length} 处，仅在可见时间上不同的循环 ${run.dedupe?.timeOnlyCycles ?? 0} 处`);
  lines.push('');

  lines.push(`## ${SECTIONS.A}`);
  lines.push('');
  if (drift.incidents.length) {
    lines.push(`> **本报告不得签收。** 取证过程中发布版本已变化：期望 revision=${revision}，实测 revision=${drift.incidents[0].releaseRevision ?? drift.incidents[0].domRevision}。本报告仅用于追溯已取得的部分状态，负责人只签收同一版本下的结果。`);
    lines.push('');
  }
  lines.push(`本报告只对 revision=${revision} 有效。签收该版本时，下列结论为主结论：`);
  lines.push('');
  const problemCount = findings.filter(finding => finding.severity !== 'ok').length;
  const completed = paths.filter(path => ['complete', 'terminal', 'partial'].includes(path.status));
  lines.push(`- 已完成的报名分支：${completed.length} 条；其中完整走通至确认前 ${paths.filter(path => path.status === 'complete').length} 条，边界复核 ${paths.filter(path => path.status === 'partial').length} 条，人工接待终点 ${paths.filter(path => path.status === 'terminal').length} 条。`);
  lines.push(`- 问题 ${problemCount} 项：其中键盘可达缺陷 ${findings.filter(finding => finding.severity === 'blocker').length} 项，可疑待确认 ${findings.filter(finding => finding.severity === 'warning').length} 项。`);
  lines.push(`- 证据复用：${reuse.reused.length} 条路径沿用同一发版下边界未变的旧证据；${reuse.validated.length} 条路径重新复核；${reuse.invalidated.length} 条旧证据因版本或边界变化停止采用。`);
  if (run.safety) {
    lines.push(`- 安全边界：全程“确认报名”只聚焦 ${run.safety.confirmFocusCount} 次、从未按下；来源收到的 POST 请求 ${run.safety.confirmedRequests} 次${run.safety.confirmedRequests === 0 ? '（未占名额）' : `（路径：${run.safety.requestedPaths.join('、')}）`}。`);
  }
  lines.push('');
  lines.push('| 模式 | 人群 | 分支结论 | 报名表 | 帮助层 | 最终停止点 | 证据强度 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const path of paths) {
    lines.push(`| ${path.plan.modeLabel} | ${path.plan.audienceLabel} | ${pathSummary(path)} | ${code(path.formSeen)} | ${code(path.helpSeen)} | ${path.confirmReached ? '已聚焦，未按下' : '未到达'} | ${path.evidenceStrength} |`);
  }
  lines.push('');

  lines.push(`## ${SECTIONS.B}`);
  lines.push('');
  lines.push('状态判定标准：页面必须同时满足下列条件才算“到达”，否则只记为尝试：');
  lines.push('');
  lines.push('1. 页面 URL 属于维护方声明入口，\`main[data-area]\` 与计划模式一致；');
  lines.push('2. \`main[data-publication]\` 与 \`/release\` 中该时刻的发版编号一致；');
  lines.push('3. 可见文本、当前人群（原生选择器值）、报名表 \`data-form\`、帮助层 \`data-component\` 与计划匹配；');
  lines.push('4. 焦点确实落在预期控件上（以浏览器可访问性树的 \`focused\` 节点为准，而不是凭文本猜测）。');
  lines.push('');
  lines.push('证据强度分类（页面文本没读到、键盘路径进不到、当前资料不足以判断，三者互不替代）：');
  lines.push('');
  lines.push(table(['标记', '含义', '判据'], [
    ['已观察', '键盘实际进入且读到了内容', '可访问性树中存在该节点，且有可访问名称或文本'],
    ['页面文本确实没读到', '页面可见文本中不存在该信息', '元素不存在或 \`innerText\` 为空；不是“没找到”'],
    ['键盘路径进不到', '元素存在于 DOM 与可访问性树，但焦点走不到', '焦点巡查形成闭环仍缺该控件，且 DOM 中 \`tabIndex >= 0\`'],
    ['当前资料不足以判断', '来源或发版清单未提供判断依据', '例如没有该人群/模式的声明，或来源 404'],
  ]));
  lines.push('');
  lines.push('去重规则：状态指纹 = 发版 + 模式 + 阶段 + 人群 + 报名表版号 + 帮助层版号 + 帮助层开合 + 预览 + 草稿哈希 + 隐藏人群草稿 + 人工接待提示 + 焦点 + 可见文本哈希。外观相同但保留不同人群草稿的两张页面指纹不同，不会被合并。');
  lines.push('');
  lines.push('循环控制：焦点巡查遇到重复“焦点边”即停；只有指纹完全相同、差异仅在可见时间时才记为时间循环。巡查上限见下：');
  lines.push('');
  if (run.loops.length === 0) {
    lines.push('本次没有触发提前停止。');
  } else {
    lines.push(table(['巡查对象', '停止原因', '步数', '最后一次焦点'], run.loops.map(loop => [
      cell(loop.label),
      cell(loop.kind),
      String(loop.steps?.length ?? '-'),
      cell(loop.steps?.at(-1)?.focus ? nameOf(loop.steps.at(-1).focus) : '-'),
    ])));
  }
  lines.push('');

  if (run.dedupe) {
    lines.push(`去重结果：共记录 ${run.dedupe.stateCount} 个状态，合并重复访问 ${run.dedupe.collapsedRevisits} 次；外观相同但保留不同人群/草稿的状态组 ${run.dedupe.lookalikeGroups.length} 组；仅在可见时间上不同的循环 ${run.dedupe.timeOnlyCycles} 处。`);
    lines.push('');
    if (run.dedupe.lookalikeGroups.length) {
      lines.push('下列页面的可见文本完全相同，但人群或保留草稿不同，因此没有被合并成一个状态；维护方按“同一标题的两张页面”统计时，应按下表拆分，而不是只数可见标题。');
      lines.push('');
      lines.push(table(['可见文本（节选）', '变体：人群', '报名表', '帮助层', '草稿', '保留的其它草稿', '状态数', '状态'], run.dedupe.lookalikeGroups.flatMap(group =>
        group.variants.map(variant => [
          cell(compact(group.visibleText, 28)),
          code(variant.audience),
          code(variant.form),
          code(variant.help),
          code(variant.draft),
          code(variant.latent),
          String(variant.ids.length),
          variant.ids.length > 6 ? `${variant.ids.slice(0, 6).join('、')}…` : variant.ids.join('、'),
        ]))));
      lines.push('');
    }
  }
  lines.push(`## ${SECTIONS.C}`);
  lines.push('');
  lines.push('下列轨迹均以“打开入口后的状态”为 S 起始；键序列是实际按键，不是推测。');
  lines.push('');
  for (const path of paths) {
    lines.push(`### ${path.plan.modeLabel} / ${path.plan.audienceLabel}`);
    lines.push('');
    if (path.reused) {
      lines.push(`- 证据来源：直接复用发版 ${path.reusedRevision ?? path.plan.revision} 的既有取证（${path.reusedFrom ?? '原记录'}）；本次未重走该分支，键区间与轨迹属于原取证运行`);
    } else {
      lines.push(`- 运行键区间：第 ${path.startKey}–${path.endKey} 次按键；起始状态 ${path.entryState ?? '—'}；结束状态 ${path.endState ?? '—'}`);
    }
    lines.push(`- 分支结论：${pathSummary(path)}${path.error ? `（${path.error.message}）` : ''}`);
    if (path.observations?.landing) {
      lines.push(`- 入口：${code(path.observations.landing.title || '（无标题）')}；h1 ${code(path.observations.landing.h1)}；活动名可见 ${path.observations.landing.eventNameVisible ? '是' : '否'}；总版号 ${code(path.observations.landing.revision)}`);
    }
    if (path.observations?.audience) {
      const aud = path.observations.audience;
      lines.push(`- 选择人群后：阶段 ${code(aud.phase)}；报名表 ${code(aud.form)}；人工接待提示 ${code(aud.manualReception || '无')}；焦点 ${nameOf(aud.focus)}`);
    }
    if (path.observations?.formFocus) {
      lines.push('');
      lines.push('报名表焦点顺序（从“场景”选择器按 Tab 起）：');
      lines.push('');
      lines.push(table(['步', '状态', '焦点', '阶段'], path.observations.formFocus.order.map(entry => [
        String(entry.step), entry.state, cell(nameOf(entry.focus)), cell(entry.phase),
      ])));
      lines.push('');
      lines.push(`闭环：${path.observations.formFocus.closed ? '是' : '否'}；到达 body 的次数 ${path.observations.formFocus.bodyHits}；可到达名称：${path.observations.formFocus.reachableNames.map(name => code(name)).join('、')}`);
    }
    if (path.observations?.helpOpen) {
      const help = path.observations.helpOpen;
      lines.push('');
      lines.push(`帮助层：\`data-component=${help.component ?? '无'}\`；可访问名称 ${code(help.dialogAxName || '（无）')}；可见文本 ${code(help.dialogText || '（无）')}；打开后焦点 ${nameOf(help.focus)}`);
      lines.push('');
      lines.push('帮助层焦点顺序：');
      lines.push('');
      lines.push(table(['步', '状态', '焦点', '层仍打开'], (path.observations.helpFocus?.order ?? []).map(entry => [
        String(entry.step), entry.state, cell(nameOf(entry.focus)), entry.dialogOpen ? '是' : '否',
      ])));
      if (path.observations.helpShift) {
        lines.push('');
        lines.push(`按一次 Shift+Tab 后焦点 ${nameOf(path.observations.helpShift.focus)}；帮助层 ${path.observations.helpShift.dialogOpen ? '仍打开' : '已关闭'}`);
      }
      if (path.observations.helpClosed) {
        lines.push(`Escape 后：帮助层 ${path.observations.helpClosed.dialogOpen ? '仍打开' : '已关闭'}；剩余 dialog 元素 ${path.observations.helpClosed.dialogCount}；焦点回到 ${nameOf(path.observations.helpClosed.focus)}`);
      }
      if (path.observations.helpReopened) {
        lines.push(`再次按 Enter 打开：${path.observations.helpReopened.dialogOpen ? '成功' : '未打开'}；帮助层版号 ${code(path.observations.helpReopened.component)}；焦点 ${nameOf(path.observations.helpReopened.focus)}`);
      }
    }
    if (path.observations?.preview) {
      const preview = path.observations.preview;
      lines.push('');
      lines.push(`确认前预览：文本 ${code(preview.previewText || '（空）')}；进入后焦点 ${nameOf(preview.focus)}；live region ${code((preview.liveRegions ?? []).join(' / ') || '无')}`);
      lines.push('');
      lines.push(table(['步', '状态', '焦点'], (path.observations.previewFocus?.order ?? []).map(entry => [String(entry.step), entry.state, cell(nameOf(entry.focus))])));
    }
    if (path.observations?.confirm) {
      lines.push('');
      lines.push(`最终停止点：“确认报名”${path.observations.confirm.reached ? '已聚焦' : '未到达'}，未按下；焦点 ${nameOf(path.observations.confirm.focus)}`);
    }
    if (path.observations?.draftFilled) {
      lines.push(`草稿：填写后值哈希 ${code(path.observations.draftFilled.draft)}；再次进入预览文本 ${code(path.observations.previewDraft?.previewText || '（未读到）')}`);
    }
    if (path.observations?.back) {
      lines.push(`“回到选择”后：人群 ${code(path.observations.back.audience || '（空）')}；焦点 ${nameOf(path.observations.back.focus)}；保留的隐藏草稿 ${code(Object.keys(path.observations.back.latentDrafts ?? {}).join(',') || '无')}`);
    }
    if (path.observations?.reselect) {
      lines.push(`重新选择同一人群：联系号码值 ${code(path.observations.reselect.value ?? '（无输入框）')}；草稿状态 ${code(path.observations.reselect.draft)}`);
    }
    if (path.observations?.switch) {
      lines.push(`改选另一人群：${path.observations.switch.audience}；报名表 ${code(path.observations.switch.form)}；联系号码值 ${code(path.observations.switch.value ?? '（无输入框）')}`);
    }
    if (path.observations?.switchBack) {
      lines.push(`再选回原人群：报名表 ${code(path.observations.switchBack.form)}；联系号码值 ${code(path.observations.switchBack.value ?? '（无输入框）')}`);
    }
    if (path.observations?.previewSwitch) {
      const info = path.observations.previewSwitch;
      if (info.reachable === false) {
        lines.push(`预览中直接改人群：不可达（${info.reason}）；循环记录 ${(info.cycle ?? []).join(' → ')}`);
      } else {
        lines.push(`预览中直接改人群：${info.from} → ${info.to}；结果阶段 ${code(info.phase)}；人群 ${code(info.audience)}；报名表 ${code(info.form)}；预览区 ${info.preview ? '仍在' : '已消失'}`);
      }
    }
    if (path.reuseDecision && !path.reused) {
      lines.push(`- 证据复用判定：${path.reuseDecision.result}（${path.reuseDecision.reason}）`);
    }
    if (path.sectionTrail && !path.reused) {
      lines.push('');
      lines.push('该分支的按键轨迹（键 / 到达状态 / 焦点）：');
      lines.push('');
      lines.push(table(['键', '到达', '焦点'], path.sectionTrail.map(entry => [code(entry.key), entry.state ?? '—', cell(nameOf(entry.focus))])));
    }
    lines.push('');
  }

  lines.push(`## ${SECTIONS.D}`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('本次没有发现问题。');
  } else {
    const order = { blocker: 0, warning: 1, ok: 2, info: 3 };
    const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    for (const finding of sorted) {
      lines.push(`### ${finding.id} ${finding.title}`);
      lines.push('');
      lines.push(`- 严重度：${finding.severity === 'blocker' ? '阻断（键盘可达缺陷）' : finding.severity === 'warning' ? '可疑（需维护方确认）' : finding.severity === 'info' ? '说明' : '正常'}`);
      lines.push(`- 证据强度：${finding.strength}`);
      lines.push(`- 涉及版本：${finding.versions.join('、')}`);
      lines.push(`- 影响分支：${finding.paths.join('、')}`);
      lines.push(`- 现象：${finding.summary}`);
      lines.push('');
      lines.push('复现步骤（从公开入口开始）：');
      lines.push('');
      finding.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
      lines.push('');
      lines.push(`发生前最后的可达状态：${finding.beforeState}；按下的键：${finding.key}；当时可访问名称：${finding.observedNames}；焦点去向：${finding.focusAfter}`);
      lines.push('');
      lines.push(`维护方核对点：${finding.checkpoint}`);
      lines.push('');
      lines.push(`同报名表其它人群/终端：${finding.affectedScope}`);
      lines.push('');
    }
  }

  lines.push(`## ${SECTIONS.E}`);
  lines.push('');
  lines.push('下表按“同一报名表版号 / 同一帮助层版号”横向比对，用于回答“其它人群或终端是否受影响”。');
  lines.push('');
  lines.push(table(['报名表版号', '帮助层版号', '区·社区居民', '区·流动职工', '终端·社区居民', '终端·流动职工', '区·柜台接待', '终端·柜台接待'], coverage.rows.map(row => [
    code(row.form), code(row.help),
    ...coverage.columns.map(column => cell(row.cells[column] ?? '—')),
  ])));
  lines.push('');
  if (coverage.requested.length) {
    lines.push(`登记需求（data/inspection-requests.json）对照：${coverage.requested.map(item => `${item.mode}·${item.audiences.join('/')}`).join('；')}`);
    lines.push('');
  }
  lines.push('');

  lines.push(`## ${SECTIONS.F}`);
  lines.push('');
  lines.push(`本次取证锁定 revision=${revision}。取证期间每完成一个关键动作都会重新读 \`/release\` 并核对 \`main[data-publication]\`；不一致时立即终止该分支并标记“版本漂移，不可签收”。`);
  lines.push('');
  if (drift.incidents.length === 0) {
    lines.push('- 取证期间未发生版本漂移。');
  } else {
    for (const incident of drift.incidents) {
      lines.push(`- 漂移：在${incident.context}（第 ${incident.atKey} 次按键，${(incident.atElapsedMs / 1000).toFixed(1)} 秒）期望 revision ${incident.expectedRevision}，实测 ${incident.releaseRevision ?? incident.domRevision}；最后可达状态 ${incident.lastState ?? '—'}`);
    }
  }
  lines.push('');
  lines.push('证据复用判定（同一发布、模式、页面状态才可采用）：');
  lines.push('');
  lines.push(table(['旧证据', '结果', '依据'], reuse.decisions.map(decision => [decision.label, decision.result, cell(decision.reason)])));
  lines.push('');
  lines.push('本次实际复用/复核：');
  lines.push('');
  lines.push(`- 复用：${reuse.reused.map(item => item.label).join('、') || '无'}`);
  lines.push(`- 复核通过后可复用：${reuse.validated.map(item => item.label).join('、') || '无'}`);
  lines.push(`- 失效停止采用：${reuse.invalidated.map(item => `${item.label}（${item.reason}）`).join('、') || '无'}`);
  lines.push(`- 无组件边界、需在本版本重新确认：${(reuse.reconfirmed ?? []).map(item => item.label).join('、') || '无'}`);
  lines.push('');

  lines.push(`## ${SECTIONS.G}`);
  lines.push('');
  lines.push('下列条目按三类列出，未混入问题清单：');
  lines.push('');
  const gaps = analysis.gaps;
  lines.push(table(['条目', '分类', '说明'], gaps.map(gap => [cell(gap.item), cell(gap.classification), cell(gap.detail)])));
  lines.push('');
  if (analysis.unreachable.length) {
    lines.push('键盘巡查未进入、但 DOM 中存在的控件（因此判为“键盘路径进不到”，而不是“文本没读到”）：');
    lines.push('');
    lines.push(table(['模式', '人群', '控件', '状态', '说明'], analysis.unreachable.map(item => [
      cell(item.mode), cell(item.audience), cell(item.control), item.state, cell(item.detail),
    ])));
    lines.push('');
  }
  lines.push(`## ${SECTIONS.H}`);
  lines.push('');
  lines.push('下表是问题清单中“发生前最后的可达状态”的索引，便于维护方拿状态编号回到证据文件的完整记录（指纹、焦点、可访问名称、可见控件、按键序列）。');
  lines.push('');
  lines.push(table(['状态', '模式/人群', '阶段', '报名表', '帮助层', '草稿', '保留的其它草稿', '可见文本（节选）'], analysis.stateIndex.map(state => [
    state.id,
    `${MODE_LABELS[state.mode] ?? (state.mode ?? '—')}/${state.audience ? (AUDIENCE_LABELS[state.audience] ?? state.audience) : '（未选）'}`,
    PHASE_LABELS[state.phase] ?? state.phase,
    code(state.form ?? '无'),
    code(state.helpComponent ?? '无'),
    code(state.draft),
    code(Object.keys(state.latentDrafts ?? {}).join(',') || '无'),
    cell(compact(state.visibleText, 60)),
  ])));
  lines.push('');
  // referenced_state_index

  lines.push(`## ${SECTIONS.I}`);
  lines.push('');
  lines.push(`证据文件：\`${run.evidenceFile}\`（包含每个状态的指纹、焦点、可访问名称、按键序列与来源请求记录）。`);
  lines.push('');

  return lines.join('\n');
}

function formatRelease(scope) {
  if (!scope) return '（未声明）';
  return Object.entries(scope).map(([key, value]) => `${key}=${value}`).join(' / ');
}

function pathSummary(path) {
  if (path.status === 'complete') return '走通至确认前';
  if (path.status === 'terminal') return '人工接待（真实终点）';
  if (path.status === 'partial') return '边界复核';
  if (path.status === 'not-collected') return '未取证（版本漂移后停止）';
  if (path.status === 'drifted') return '版本漂移，停止';
  if (path.status === 'aborted') return `中断：${path.error?.message ?? '未知'}`;
  return path.status;
}

export async function loadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
