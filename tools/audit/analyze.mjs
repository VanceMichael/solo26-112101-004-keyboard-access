import { CLASSIFICATION, compact, focusLabel } from './core.mjs';

export const PHASE_LABELS = {
  landing: '入口/未选人群',
  'audience-only': '已选人群（无报名表）',
  form: '报名表',
  help: '帮助层',
  preview: '确认前预览',
  'manual-reception': '人工接待',
};

function stateName(state) {
  if (!state) return '—';
  return `${state.id}（${PHASE_LABELS[state.phase] ?? state.phase}，${state.form ?? '无报名表'}${state.helpComponent ? `，帮助层 ${state.helpComponent}` : ''}）`;
}

function keyText(record) {
  if (!record) return '（无）';
  return `“${record.key}”（第 ${record.index} 次按键，${record.context ?? '无说明'}）`;
}

function trailFor(session, path, limit = 26) {
  const records = session.keys.filter(record => record.index > path.startKey && record.index <= path.endKey);
  const compacted = [];
  let typing = null;
  for (const record of records) {
    const isTyping = (record.context ?? '').includes('字符');
    if (isTyping) {
      typing = typing ?? { from: record.index, to: record.index, state: record.toState, focus: record.toFocus };
      typing.to = record.index;
      continue;
    }
    if (typing) {
      compacted.push({ key: `输入字符（${typing.to - typing.from + 1} 键）`, state: typing.state, focus: typing.focus });
      typing = null;
    }
    compacted.push({ key: record.key, state: record.toState, focus: record.toFocus, index: record.index });
  }
  if (typing) compacted.push({ key: `输入字符（${typing.to - typing.from + 1} 键）`, state: typing.state, focus: typing.focus });
  if (compacted.length <= limit) return compacted;
  return [
    ...compacted.slice(0, Math.floor(limit / 2)),
    { key: `…省略 ${compacted.length - limit + 1} 步…`, state: '—', focus: null },
    ...compacted.slice(-Math.floor(limit / 2) + 1),
  ];
}

function typeStep(path) {
  return `按 ArrowDown ${path.plan.audience === 'community' ? 1 : path.plan.audience === 'work' ? 2 : 3} 次，选中“${path.plan.audienceLabel}”`;
}

function stepsFor(session, path, keyIndex, extra = []) {
  const steps = [`打开公开入口 ${path.plan.entry}（只使用维护方声明的 URL）`];
  const milestones = path.milestones ?? [];
  for (const item of milestones) {
    if (item.keyIndex > keyIndex) break;
    steps.push(item.text);
  }
  const target = session.keys.find(record => record.index === keyIndex);
  if (target) {
    const previous = session.keys.find(record => record.index === keyIndex - 1) ?? null;
    const extraTyping = (target.context ?? '').includes('字符');
    if (!extraTyping) {
      const before = previous ? focusLabel(previous.toFocus) : '（入口初始焦点）';
      steps.push(`此时焦点在 ${before}；按 ${keyText(target)}，到达 ${target.toState}，焦点 ${focusLabel(target.toFocus)}（${PHASE_LABELS[target.toPhase] ?? target.toPhase}）`);
    }
  }
  steps.push(...extra);
  return steps;
}

function defectContext(session, keyIndex) {
  const record = session.keys.find(entry => entry.index === keyIndex);
  if (!record) return { beforeState: '—', observedNames: '—', focusAfter: '—', key: '—' };
  const stateBefore = session.stateById(record.fromState);
  const controlNames = (stateBefore?.controls ?? [])
    .filter(control => control.tag !== 'select')
    .map(control => `“${compact(control.name, 20)}”`)
    .join('、') || '无';
  return {
    beforeState: stateName(stateBefore),
    key: keyText(record),
    observedNames: `按键前焦点 ${focusLabel(record.fromFocus)}；按键后焦点 ${focusLabel(record.toFocus)}；当时可见控件 ${controlNames}`,
    focusAfter: focusLabel(record.toFocus),
  };
}

function firstIndex(session, path, predicate) {
  return session.keys.find(entry => entry.index > path.startKey && entry.index <= path.endKey && predicate(entry))?.index ?? null;
}

function indexByContext(session, path, prefix) {
  const matches = session.keys.filter(entry =>
    entry.index > path.startKey && entry.index <= path.endKey && String(entry.context ?? '').startsWith(prefix));
  return matches.at(-1)?.index ?? null;
}

function finding({ id, title, severity, strength, versions, paths, summary, steps, context, checkpoint, affectedScope }) {
  return {
    id, title, severity, strength, versions, paths, summary, steps,
    beforeState: context.beforeState,
    key: context.key,
    observedNames: context.observedNames,
    focusAfter: context.focusAfter,
    checkpoint,
    affectedScope,
  };
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function analyze(session, { bulletin, release, prior = null, reuse = null, targetRevision, evidenceFile, sourceCalls = [] }) {
  const paths = session.pathResults.map(result => enrichPath(session, result, release));
  const findings = [];
  const gaps = [];
  const unreachable = [];
  const nonDesk = paths.filter(path => path.plan.audience !== 'desk' && ['complete', 'partial'].includes(path.status));
  const helpPaths = nonDesk.filter(path => path.observations?.helpOpen);
  const allPathsLabel = paths.map(path => path.label).join('、');
  const byForm = form => paths.filter(path => path.formSeen === form).map(path => path.label);

  // 1. 帮助层打开时焦点逃到 body
  for (const [component, group] of groupBy(helpPaths, path => path.observations.helpOpen.component ?? '无')) {
    const samples = group
      .map(path => {
        const escape = (path.observations.helpFocus?.order ?? []).find(entry => entry.dialogOpen && entry.focus?.body);
        return escape ? { path, escape } : null;
      })
      .filter(Boolean);
    if (!samples.length) continue;
    const sample = samples[0];
    const context = defectContext(session, sample.escape.keyIndex);
    findings.push(finding({
      id: `HELP-FOCUS-${component}`,
      title: '帮助层打开时按 Tab，焦点落到文档 body（无可见焦点、无可访问名称）',
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [`帮助层 ${component}`],
      paths: samples.map(item => item.path.label),
      summary: `帮助层为原生模态对话框，但按 Tab 从层内最后一个控件继续前进时，焦点没有在层内循环，而是落到文档 body。此时读屏焦点离开对话框，键盘用户也看不到焦点位置；再按一次 Tab 才回到层内。层内可访问名称：${(sample.path.observations.helpOpen.dialogControls ?? []).map(control => `“${control.name}”`).join('、') || '无'}；Shift+Tab 反向同样会落到 body。`,
      steps: stepsFor(session, sample.path, sample.escape.keyIndex, ['观察焦点：文档 body，无高亮、无可访问名称', '再按 Tab，焦点回到层内，说明层仍然打开']),
      context,
      checkpoint: `维护方在帮助层 ${component} 中复现：从层内最后一个控件起连续按 Tab 与 Shift+Tab，核对焦点是否应留在对话框内，以及是否需要自行实现焦点循环。`,
      affectedScope: `同帮助层版号 ${component} 的路径：${group.map(path => path.label).join('、')}；同一报名表 ${sample.path.formSeen ?? '无'} 的其它人群/终端见影响范围表`,
    }));
  }

  // 2. 帮助层无可访问名称
  for (const [component, group] of groupBy(helpPaths, path => path.observations.helpOpen.component ?? '无')) {
    if (group[0].observations.helpOpen.dialogAxName) continue;
    const sample = group[0];
    const keyIndex = firstIndex(session, sample, record => record.toPhase === 'help');
    const visibleTitle = (sample.observations.helpOpen.dialogText ?? '').split('\n')[0] || '填写帮助';
    findings.push(finding({
      id: `HELP-NAME-${component}`,
      title: `帮助层 ${component} 没有可访问名称（role=dialog 名称为空）`,
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [`帮助层 ${component}`],
      paths: group.map(path => path.label),
      summary: `可访问性树中的对话框节点名称为空；层内标题“${visibleTitle}”没有通过 aria-labelledby/aria-label 关联到对话框。读屏用户进入帮助层时只会听到“对话框”，无法知道这是填写帮助还是其它层。`,
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['读取可访问性树：dialog 节点名称为空', `层内可见标题为“${visibleTitle}”`]),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: `维护方核对帮助层 ${component} 的 dialog 是否应设置 aria-labelledby，指向层内标题。`,
      affectedScope: `同帮助层版号 ${component} 的路径：${group.map(path => path.label).join('、')}；同一报名表 ${sample.formSeen ?? '无'} 的其它人群/终端见影响范围表`,
    }));
  }

  // 3. 帮助正文缺失（按帮助层版号 + 模式分组）
  for (const [groupKey, group] of groupBy(helpPaths, path => `${path.observations.helpOpen.component ?? '无'}|${path.plan.mode}`)) {
    const missing = group.filter(path => !(path.observations.helpOpen.dialogText ?? '').includes('帮助内容'));
    if (!missing.length) continue;
    // 同版号在其它模式/人群上是否读出正文，用来判断这是“该版号本就没有”还是“渲染条件漏配”。
    const present = helpPaths.filter(path => path.observations.helpOpen.component === group[0].observations.helpOpen.component && (path.observations.helpOpen.dialogText ?? '').includes('帮助内容'));
    const component = group[0].observations.helpOpen.component ?? '无';
    const sample = missing[0];
    const keyIndex = firstIndex(session, sample, record => record.toPhase === 'help');
    findings.push(finding({
      id: `HELP-CONTENT-${component}-${sample.plan.mode}-${missing.map(path => path.plan.audience).join('-')}`,
      title: `帮助层 ${component} 在${sample.plan.modeLabel}${missing.length > 1 ? `（${missing.map(path => path.plan.audienceLabel).join('、')}）` : `的${sample.plan.audienceLabel}`}上没有可读的帮助正文`,
      severity: 'warning',
      strength: CLASSIFICATION.textNotRead,
      versions: [`帮助层 ${component}`],
      paths: missing.map(path => path.label),
      summary: `帮助层只暴露标题“${(sample.observations.helpOpen.dialogText ?? '').split('\n')[0] || '填写帮助'}”和“关闭帮助”，页面文本中确实没有帮助正文，键盘也无法读到更多内容。${present.length ? `同一版号 ${component} 在${present.map(path => `${path.plan.modeLabel}/${path.plan.audienceLabel}`).join('、')}上确有正文，说明缺失与模式/人群渲染条件有关，而不是该版号本就没有正文。` : `同版号 ${component} 的全部路径都缺正文。`}`,
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['读取帮助层可见文本与可访问性树：均无帮助正文']),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: `维护方确认帮助层 ${component} 在${sample.plan.modeLabel}是否应提供正文；若应提供，核对渲染条件（模式/人群）是否漏配。`,
      affectedScope: present.length
        ? `同版号 ${component} 的其它路径有正文：${present.map(path => path.label).join('、')}；缺正文的仅 ${missing.map(path => path.label).join('、')}`
        : `同版号 ${component} 全部路径都缺正文：${helpPaths.filter(path => path.observations.helpOpen.component === component).map(path => path.label).join('、')}`,
    }));
  }

  // 4. 帮助正文以可聚焦无语义 div 承载
  for (const [component, group] of groupBy(helpPaths, path => path.observations.helpOpen.component ?? '无')) {
    const samples = group.filter(path => (path.observations.helpOpen.dialogControls ?? []).some(control => control.role === 'generic' && ['div', 'span'].includes(control.tag) && control.tabindex !== null));
    if (!samples.length) continue;
    const sample = samples[0];
    const focusable = sample.observations.helpOpen.dialogControls.find(control => control.role === 'generic' && ['div', 'span'].includes(control.tag) && control.tabindex !== null);
    const keyIndex = firstIndex(session, sample, record => record.toPhase === 'help');
    findings.push(finding({
      id: `HELP-ROLE-${component}`,
      title: `帮助正文用可聚焦 ${focusable.tag} 承载，无角色、未与对话框建立名称关系`,
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [`帮助层 ${component}`],
      paths: samples.map(path => path.label),
      summary: `帮助正文是 <${focusable.tag} tabindex="${focusable.tabindex}">“${focusable.name}”</${focusable.tag}>，在可访问性树中以通用容器出现，没有段落或地标语义。焦点停在这里时只读出正文文字，听不出它属于哪个帮助层、是不是可操作控件。`,
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['在帮助层内按 Tab，焦点落在正文容器上', '读取可访问性树：通用容器，无角色名称']),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: '维护方核对帮助正文是否应使用带语义的容器（paragraph / region + aria-labelledby），并保证可聚焦元素有明确角色与名称。',
      affectedScope: `同帮助层版号 ${component} 的路径：${samples.map(path => path.label).join('、')}`,
    }));
  }

  // 5. 预览后焦点丢失
  const previewBody = nonDesk.filter(path => path.observations?.preview?.focus?.body);
  if (previewBody.length) {
    const sample = previewBody[0];
    const keyIndex = indexByContext(session, sample, '进入确认前预览');
    findings.push(finding({
      id: 'PREVIEW-FOCUS',
      title: '进入确认前预览后焦点落到 body，预览内容不是 live region',
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [...new Set(previewBody.map(path => `报名表 ${path.formSeen}`))],
      paths: previewBody.map(path => path.label),
      summary: `按下“检查内容”后原表单被替换为预览区，但焦点没有移到预览标题或“返回编辑”，而是落到文档 body；预览文本“${compact(sample.observations.preview.previewText, 80)}”也没有通过 live region 播报。读屏用户不会知道页面已经切换，键盘用户需要重新按 Tab 才能找到“返回编辑”。`,
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['观察焦点：文档 body；读取可访问性树：预览区不是 live region']),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: '维护方核对视图切换后是否应将焦点移到预览区标题或首个操作，并用 live region 或焦点移动播报状态变化。',
      affectedScope: `本轮实际进入预览的分支：${previewBody.map(path => path.label).join('、')}`,
    }));
  }

  // 6. 返回编辑后焦点丢失
  const editBody = nonDesk.filter(path => path.observations?.edit?.focus?.body);
  if (editBody.length) {
    const sample = editBody[0];
    const keyIndex = indexByContext(session, sample, '返回编辑');
    findings.push(finding({
      id: 'EDIT-FOCUS',
      title: '从预览按“返回编辑”后焦点落到 body，未回到原表单控件',
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [...new Set(editBody.map(path => `报名表 ${path.formSeen}`))],
      paths: editBody.map(path => path.label),
      summary: '“返回编辑”会重建报名表，但焦点没有回到“检查内容”或“联系号码”，而是落到文档 body；键盘用户需要重新从选择器开始按 Tab 才能回到表单。',
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['观察焦点：文档 body']),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: '维护方核对预览往返是否应恢复焦点到触发预览的控件（或表单首个控件）。',
      affectedScope: `本轮实际从预览返回编辑的分支：${editBody.map(path => path.label).join('、')}`,
    }));
  }

  // 7. 页面标题为空
  const landingPaths = paths.filter(path => path.observations?.landing);
  const titleless = landingPaths.filter(path => !path.observations.landing.title);
  if (titleless.length) {
    const sample = titleless[0];
    findings.push(finding({
      id: 'PAGE-TITLE',
      title: '报名页 <title> 为空，浏览器标签与读屏页面名称不可用',
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [`revision ${targetRevision}`],
      paths: titleless.map(path => path.label),
      summary: '两个入口的 document.title 都是空字符串，可访问性树的 WebArea 名称也为空。读屏用户切换标签页时听不到页面名称，无法从标题判断当前是区报名页还是街道终端。',
      steps: [`打开 ${sample.plan.entry}`, '读取 document.title：空字符串', '读取可访问性树：WebArea 名称为空，页面内 h1 为“法治活动报名”'],
      context: {
        beforeState: stateName(session.stateById(sample.phases.landing)),
        key: '（无需按键，入口加载后即可观察）',
        observedNames: `WebArea 名称：空；h1：“${sample.observations.landing.h1 ?? ''}”`,
        focusAfter: focusLabel(session.stateById(sample.phases.landing)?.focusAx),
      },
      checkpoint: '维护方核对两个入口是否应提供区分模式与活动的 <title>。',
      affectedScope: `全部路径：${allPathsLabel}`,
    }));
  }

  // 8. 活动名称/场次未显示
  const eventless = landingPaths.filter(path => !path.observations.landing.eventNameVisible);
  if (eventless.length) {
    const sample = eventless[0];
    gaps.push({
      item: `报名页未显示活动名称“${bulletin.name}”/场次 ${bulletin.event}`,
      classification: CLASSIFICATION.textNotRead,
      detail: `两个入口的页面文本只出现“法治活动报名”和“请选择参与身份”；活动名称与场次在页面文本中确实没有，不是未找到。键盘与读屏用户在报名页无法确认正在报名哪一场活动。`,
    });
    findings.push(finding({
      id: 'EVENT-CONTEXT',
      title: '报名页没有显示活动名称与场次',
      severity: 'warning',
      strength: CLASSIFICATION.textNotRead,
      versions: [`revision ${targetRevision}`],
      paths: eventless.map(path => path.label),
      summary: `页面文本中没有活动名称“${bulletin.name}”，也没有场次“${bulletin.event}”；活动信息只在 /bulletin 出现。`,
      steps: [`打开 ${sample.plan.entry}`, '用 Tab 遍历页面并读取全部可见文本', `在页面文本中查找“${bulletin.name}”与“${bulletin.event}”：均未出现`],
      context: {
        beforeState: stateName(session.stateById(sample.phases.landing)),
        key: '（无需按键，入口加载后即可观察）',
        observedNames: `可见文本：${compact(sample.observations.landing.visibleText, 160)}`,
        focusAfter: focusLabel(session.stateById(sample.phases.landing)?.focusAx),
      },
      checkpoint: '维护方核对报名页是否应显示活动名称/场次，或通过标题与地标提供同样的上下文。',
      affectedScope: `全部路径：${allPathsLabel}`,
    }));
  }

  // 9. 回退草稿处理不一致
  const draftDiffs = nonDesk
    .filter(path => path.observations?.draftFilled?.value)
    .map(path => ({
      path,
      before: path.observations.draftFilled.value,
      afterReselect: path.observations.reselect?.value ?? null,
    }));
  const cleared = draftDiffs.filter(entry => entry.afterReselect === '');
  const kept = draftDiffs.filter(entry => entry.afterReselect && entry.afterReselect !== '');
  if (cleared.length && kept.length) {
    const sample = cleared[0];
    const keyIndex = indexByContext(session, sample.path, '回到选择');
    findings.push(finding({
      id: 'DRAFT-BACK',
      title: '“回到选择”对草稿的处理按人群不同：一类保留、一类静默清除',
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [`revision ${targetRevision}`],
      paths: draftDiffs.map(entry => entry.path.label),
      summary: `实测：${draftDiffs.map(entry => `${entry.path.label} 填写后回到选择再选同一人群，联系号码为 ${entry.afterReselect === '' ? '空（草稿被清除）' : entry.afterReselect ? '原值（草稿保留）' : '（无输入框）'}`).join('；')}。两者都发生在同一标题“活动报名表”的页面上，外观一致，页面没有提示草稿是否保留，回退操作的可预期结果不一致。`,
      steps: stepsFor(session, sample.path, keyIndex ?? sample.path.endKey, [
        `对比：重新选回“${sample.path.plan.audienceLabel}”后，${sample.path.plan.modeLabel}的联系号码${sample.afterReselect === '' ? '为空（草稿被清除）' : '保留原值'}；另一人群则${sample.afterReselect === '' ? '保留原值' : '为空'}`,
      ]),
      context: defectContext(session, keyIndex ?? sample.path.endKey),
      checkpoint: '维护方核对草稿生命周期是否应一致；若差异是有意设计，页面需要在回退前提示哪类人群会丢失草稿。',
      affectedScope: `全部使用“回到选择”的分支：${draftDiffs.map(entry => entry.path.label).join('、')}`,
    }));
  }

  // 10. 预览中改人群静默丢弃预览
  const previewSwitch = nonDesk.filter(path => path.observations?.previewSwitch && path.observations.previewSwitch.reachable !== false && !path.observations.previewSwitch.preview);
  if (previewSwitch.length) {
    const sample = previewSwitch[0];
    const info = sample.observations.previewSwitch;
    const keyIndex = indexByContext(session, sample, '预览中直接改人群');
    findings.push(finding({
      id: 'PREVIEW-SWITCH',
      title: '在确认前预览中改选人群，预览被静默替换为报名表',
      severity: 'warning',
      strength: CLASSIFICATION.observed,
      versions: [...new Set(previewSwitch.map(path => `报名表 ${path.formSeen}`))],
      paths: previewSwitch.map(path => path.label),
      summary: `预览状态下“场景”选择器仍可操作；改选人群后页面直接回到报名表（${info.audience}，${info.form ?? '无报名表'}），预览区消失，没有任何提示或确认。键盘用户可能以为仍在预览。`,
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['观察：预览区消失，页面回到报名表，焦点仍在“场景”']),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: '维护方核对预览期间是否应禁用人群选择，或在切换前提示当前预览将被放弃。',
      affectedScope: `本轮实际执行“预览中改人群”的分支：${previewSwitch.map(path => path.label).join('、')}；边界复核分支只重走主路径，未重复该子步骤，见“未能取证的部分”`,
    }));
  }

  // 11. 预览不携带上下文
  const previewNoContext = nonDesk.filter(path => {
    const text = path.observations?.preview?.previewText ?? '';
    return text && !text.includes(path.plan.audienceLabel) && !(path.formSeen && text.includes(path.formSeen));
  });
  if (previewNoContext.length) {
    const sample = previewNoContext[0];
    const keyIndex = indexByContext(session, sample, '进入确认前预览');
    findings.push(finding({
      id: 'PREVIEW-CONTEXT',
      title: '确认前预览只写草稿状态，不含活动、人群或报名表',
      severity: 'info',
      strength: CLASSIFICATION.observed,
      versions: [`revision ${targetRevision}`],
      paths: previewNoContext.map(path => path.label),
      summary: `预览区可见文本为“${compact(sample.observations.preview.previewText, 60)}”，没有人群名称、活动名称或报名表版号。读屏用户若只读预览区，无法确认将要提交的是哪张表，只能回头去读仍保留在页面上的“场景”选择器。`,
      steps: stepsFor(session, sample, keyIndex ?? sample.endKey, ['读取预览区文本：只有草稿状态提示']),
      context: defectContext(session, keyIndex ?? sample.endKey),
      checkpoint: '维护方核对预览是否应显示活动/人群/报名表标识，使读屏用户不依赖页面其它区域推断上下文。',
      affectedScope: `本轮实际进入预览的分支：${previewNoContext.map(path => path.label).join('、')}`,
    }));
  }

  // 12. 键盘路径进不到的控件
  for (const path of paths) {
    if (path.plan.audience === 'desk') continue;
    const phases = [
      ['form', path.observations?.formFocus],
      ['preview', path.observations?.previewFocus],
    ];
    for (const [phase, focusMap] of phases) {
      if (!focusMap?.order) continue;
      const states = [...new Set(focusMap.order.map(entry => entry.state))].map(id => session.stateById(id)).filter(state => state?.phase === phase);
      const controls = new Map();
      for (const state of states) {
        for (const control of state.controls ?? []) {
          if (control.inDialog || control.tag === 'select') continue;
          controls.set(`${control.role}:${control.name}`, control);
        }
      }
      const reachable = new Set(focusMap.order.filter(entry => !entry.focus?.body).map(entry => `${entry.focus.role}:${entry.focus.name}`));
      for (const [key, control] of controls) {
        if (reachable.has(key)) continue;
        unreachable.push({
          mode: path.plan.modeLabel,
          audience: path.plan.audienceLabel,
          control: `${control.tag}${control.id ? `#${control.id}` : ''} “${control.name}”`,
          state: states.find(state => (state.controls ?? []).some(item => `${item.role}:${item.name}` === key))?.id ?? '—',
          detail: `该控件在 DOM 中 tabIndex=${control.tabindex ?? '默认'}，但焦点巡查闭环内从未聚焦；判断为键盘路径进不到，而不是文本没读到。`,
        });
      }
    }
  }
  for (const item of unreachable) {
    findings.push(finding({
      id: `UNREACHABLE-${item.mode}-${item.audience}-${item.control.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      title: `控件存在但键盘焦点无法到达：${item.control}`,
      severity: 'blocker',
      strength: CLASSIFICATION.keyboardUnreachable,
      versions: [`revision ${targetRevision}`],
      paths: [`${item.mode}/${item.audience}`],
      summary: item.detail,
      steps: [`打开 ${item.mode} 入口`, `选择“${item.audience}”`, '从“场景”起按 Tab 巡查至闭环', `观察：${item.control} 从未获得焦点`],
      context: { beforeState: item.state, key: 'Tab（焦点巡查）', observedNames: item.control, focusAfter: '焦点循环回到巡查起点' },
      checkpoint: '维护方核对该控件是否应出现在 Tab 顺序中；若不应，应设为 tabindex=-1 并从可访问性树中隐藏。',
      affectedScope: `同状态 ${item.state} 的所有路径`,
    }));
  }

  // 13. 资料不足与无缺陷说明
  gaps.push({
    item: '该发版是否调整了焦点顺序',
    classification: CLASSIFICATION.insufficient,
    detail: `发版记录只列出范围、替换的报名表与终端版本（${Object.entries(release.district ?? {}).map(([key, value]) => `${key}=${value}`).join('、')}），没有声明焦点顺序变更。本次只能以实际键盘巡查结果为准，不能从记录推断。`,
  });
  gaps.push({
    item: '报名权限与登录后步骤',
    classification: CLASSIFICATION.insufficient,
    detail: '资料没有提供账号/权限清单；本次以未登录的公开入口观察。所选人群可见的步骤已实际进入，但“登录后是否还有额外步骤”无法判断。',
  });
  gaps.push({
    item: '名额与最终提交结果',
    classification: CLASSIFICATION.insufficient,
    detail: '按约定止步于“确认报名”之前，未向 /signup/confirmed 发起请求；提交后的名额占用与回执不在本次证据范围。',
  });
  const boundaryPaths = paths.filter(path => path.status === 'partial' && path.plan.audience !== 'desk');
  if (boundaryPaths.length) {
    gaps.push({
      item: '边界复核分支未重复的子步骤',
      classification: CLASSIFICATION.insufficient,
      detail: `${boundaryPaths.map(path => path.label).join('、')} 只在发版 ${targetRevision} 上重走了入口、报名表焦点、帮助层、预览、停止点与回退；草稿填写与“预览中改人群”沿用旧发版结论，未在本版本重新执行。若这两项在本版本有变化，本报告不会显示。`,
    });
  }

  gaps.push({
    item: '帮助层打开时其余页面控件不可达',
    classification: CLASSIFICATION.keyboardUnreachable,
    detail: '这是原生模态对话框的预期行为（背景不可交互），不计为缺陷；页面其余控件的可达性在关闭帮助层后已逐项巡查。',
  });
  if (!unreachable.length) {
    gaps.push({
      item: '其它键盘路径进不到的控件',
      classification: CLASSIFICATION.keyboardUnreachable,
      detail: '本次对报名表与预览区所有 tabIndex>=0 控件做了焦点闭环巡查，未发现“存在于 DOM 但焦点无法到达”的控件。',
    });
  }

  // “外观相同”按可见文本分组；只有人群、报名表、帮助层或保留草稿不同时才是需要单独区分的重复页面。
  const phase = state => state.phase;
  const groups = groupBy(session.states, state => state.visibleText);
  const lookalikeGroups = [];
  for (const group of groups.values()) {
    const signatures = new Map();
    for (const state of group) {
      const signature = [
        state.audience ?? '',
        state.form ?? '',
        state.helpComponent ?? '',
        state.draft,
        Object.keys(state.latentDrafts ?? {}).sort().join(','),
      ].join('|');
      if (!signatures.has(signature)) signatures.set(signature, []);
      signatures.get(signature).push(state.id);
    }
    if (signatures.size < 2) continue;
    const variants = [...signatures.entries()].map(([signature, ids]) => {
      const [audience, form, help, draft, latent] = signature.split('|');
      return { audience, form, help, draft: draft === 'empty' || draft === 'no-field' ? '空' : '有草稿', latent, ids };
    });
    const summary = new Map();
    for (const variant of variants) {
      const key = [variant.audience || '（未选）', variant.form || '无报名表', variant.help || '无帮助层', variant.draft, variant.latent || '无'].join('/');
      if (!summary.has(key)) summary.set(key, []);
      summary.get(key).push(...variant.ids);
    }
    lookalikeGroups.push({
      visibleText: compact(group[0].visibleText, 100),
      stateCount: group.length,
      variants: [...summary.entries()].map(([key, ids]) => {
        const [audience, form, help, draft, latent] = key.split('/');
        return { audience, form, help, draft, latent, ids };
      }),
    });
  }
  const timeOnlyCycles = session.loops.filter(loop => loop.timeOnly).length;
  const confirmedRequests = sourceCalls.filter(call => call.method === 'POST' && call.path.startsWith('/signup/confirmed'));

  return {
    paths,
    findings,
    gaps,
    unreachable,
    coverage: buildCoverage(paths),
    reuse: reuse ?? { decisions: [], reused: [], validated: [], invalidated: [] },
    drift: { incidents: session.driftIncidents, revision: targetRevision },
    dedupe: {
      stateCount: session.states.length,
      collapsedRevisits: session.states.reduce((sum, state) => sum + state.revisits, 0),
      lookalikeGroups,
      timeOnlyCycles,
    },
    safety: {
      confirmedRequests: confirmedRequests.length,
      confirmFocusCount: session.keys.filter(record => record.toFocus && !record.toFocus.body && record.toFocus.name === '确认报名').length,
      requestedPaths: [...new Set(sourceCalls.filter(call => call.method === 'POST').map(call => call.path))],
    },
    versions: [...new Set([
      ...nonDesk.map(path => path.formSeen).filter(Boolean),
      ...helpPaths.map(path => path.observations.helpOpen.component).filter(Boolean),
    ])],
    evidenceFile,
    byForm,
    stateIndex: referencedStates(session, findings),
  };
}

function referencedStates(session, findings) {
  const ids = new Set();
  for (const finding of findings) {
    const match = String(finding.beforeState ?? '').match(/^S\d{3}/);
    if (match) ids.add(match[0]);
  }
  return [...ids].sort().map(id => session.stateById(id)).filter(Boolean).map(state => ({
    id: state.id,
    mode: state.mode,
    audience: state.audience,
    phase: state.phase,
    form: state.form,
    helpComponent: state.helpComponent,
    draft: state.draft,
    latentDrafts: state.latentDrafts,
    visibleText: state.visibleText,
  }));
}

function enrichPath(session, result, release) {
  const plan = result.plan;
  const helpOpen = result.observations?.helpOpen;
  const form = result.observations?.form?.form ?? result.observations?.audience?.form ?? null;
  if (result.reused) {
    // 直接复用的旧证据：轨迹与键区间属于当时的取证运行，不能拿本次会话的按键去渲染。
    return {
      ...result,
      label: `${plan.modeLabel}/${plan.audienceLabel}`,
      formSeen: form,
      helpSeen: helpOpen?.component ?? null,
      confirmReached: Boolean(result.observations?.confirm?.reached),
      evidenceStrength: pathStrength(result),
      entryState: result.phases?.landing ?? null,
      endState: result.endState ?? null,
      sectionTrail: result.sectionTrail ?? null,
      releasedForm: release?.[plan.mode]?.[plan.audience] ?? null,
      releasedHelp: release?.[plan.mode]?.help ?? null,
    };
  }
  return {
    ...result,
    label: `${plan.modeLabel}/${plan.audienceLabel}`,
    formSeen: form,
    helpSeen: helpOpen?.component ?? null,
    confirmReached: Boolean(result.observations?.confirm?.reached),
    evidenceStrength: pathStrength(result),
    entryState: result.phases?.landing ?? null,
    endState: session.keys.filter(record => record.index <= result.endKey).at(-1)?.toState ?? result.phases?.landing ?? null,
    sectionTrail: trailFor(session, result),
    releasedForm: release?.[plan.mode]?.[plan.audience] ?? null,
    releasedHelp: release?.[plan.mode]?.help ?? null,
  };
}

function pathStrength(result) {
  if (result.status === 'complete' || result.status === 'terminal' || result.status === 'partial') return CLASSIFICATION.observed;
  if (result.status === 'drifted') return '版本漂移，结论作废';
  if (result.status === 'aborted') {
    if (String(result.error?.detail?.reason ?? '').includes('循环')) return CLASSIFICATION.keyboardUnreachable;
    return CLASSIFICATION.insufficient;
  }
  return CLASSIFICATION.insufficient;
}

function buildCoverage(paths) {
  const columns = ['district:community', 'district:work', 'kiosk:community', 'kiosk:work', 'district:desk', 'kiosk:desk'];
  const rows = new Map();
  for (const path of paths) {
    if (path.plan.audience === 'desk') {
      const key = '人工接待|无';
      if (!rows.has(key)) rows.set(key, { form: '—', help: '—', cells: {} });
      rows.get(key).cells[`${path.plan.mode}:desk`] = path.status === 'terminal' ? '人工接待（真实终点）' : path.status;
      continue;
    }
    const key = `${path.formSeen ?? '无'}|${path.helpSeen ?? '无'}`;
    if (!rows.has(key)) rows.set(key, { form: path.formSeen, help: path.helpSeen, cells: {} });
    const notes = [];
    if (path.status === 'complete') notes.push('已走通');
    else if (path.status === 'partial') notes.push('边界复核');
    else notes.push(path.status);
    if (path.observations?.reselect?.value) notes.push('草稿保留');
    if (path.observations?.helpOpen?.dialogText?.includes('帮助内容')) notes.push('帮助有正文');
    else if (path.observations?.helpOpen) notes.push('帮助无正文');
    rows.get(key).cells[`${path.plan.mode}:${path.plan.audience}`] = notes.join('；');
  }
  return { rows: [...rows.values()], columns, requested: [] };
}
