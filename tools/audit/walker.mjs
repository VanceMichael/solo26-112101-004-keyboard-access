import {
  AUDIENCE_LABELS,
  AUDIENCES,
  CONFIRM_PATH,
  DriftError,
  MODE_LABELS,
  PathAbort,
  RELEASE_PATH,
  capture,
  captureAx,
  compact,
  focusKey,
  stateFingerprint,
} from './core.mjs';

const DEFAULT_KEY_BUDGET = 900;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AuditSession {
  constructor({ page, sourceUrl, revision, release, bulletin, keyBudget = DEFAULT_KEY_BUDGET, runId = '' }) {
    this.page = page;
    this.sourceUrl = sourceUrl;
    this.revision = String(revision);
    this.release = release;
    this.bulletin = bulletin;
    this.runId = runId;
    this.keyBudget = keyBudget;
    this.timeBudgetMs = Number(bulletin?.traversalMinutes ?? 15) * 60 * 1000;
    this.states = [];
    this.transitions = [];
    this.keys = [];
    this.stateIndex = new Map();
    this.loops = [];
    this.aborts = [];
    this.driftIncidents = [];
    this.pathResults = [];
    this.knownDrafts = {};
    this.keyCount = 0;
    this.keyPath = [];
    this.lastState = null;
    this.expectedPath = null;
    this.onBeforeKey = null;
    this.startedAt = Date.now();
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  stateById(id) {
    return this.states.find(state => state.id === id) ?? null;
  }

  async pollRelease() {
    const response = await fetch(this.sourceUrl + RELEASE_PATH);
    if (!response.ok) throw new Error(`GET /release → ${response.status}`);
    return response.json();
  }

  async checkRelease(context) {
    const release = await this.pollRelease();
    if (String(release.revision) !== this.revision) {
      const incident = {
        atKey: this.keyCount,
        atElapsedMs: this.elapsedMs(),
        context,
        expectedRevision: this.revision,
        releaseRevision: String(release.revision),
        release,
        domRevision: this.lastState?.revision ?? null,
        lastState: this.lastState?.id ?? null,
      };
      if (!this.driftIncidents.length) this.driftIncidents.push(incident);
      throw new DriftError('取证过程中发布版本发生变化', incident);
    }
    return release;
  }

  async snapshot(label, opts = {}) {
    if (opts.checkRelease !== false && this.revision) {
      await this.checkRelease(label);
    }
    const raw = await capture(this.page, label);
    const ax = await captureAx(this.page);
    if (ax.focused) {
      raw.focusAx = {
        body: false,
        role: ax.focused.role,
        name: ax.focused.name,
        value: ax.focused.value,
        inDialog: Boolean(raw.active?.inDialog),
        id: raw.active?.id ?? null,
        tag: raw.active?.tag ?? null,
      };
    } else {
      raw.focusAx = { body: true, role: 'body', name: '', inDialog: false };
    }
    raw.dialogAxName = ax.dialogName;
    raw.dialogAxControls = ax.dialogControls;
    raw.focusAxSource = 'accessibility-tree';

    if (raw.revision !== null && String(raw.revision) !== this.revision) {
      const incident = {
        atKey: this.keyCount,
        atElapsedMs: this.elapsedMs(),
        context: label,
        expectedRevision: this.revision,
        releaseRevision: null,
        domRevision: raw.revision,
        lastState: this.lastState?.id ?? null,
      };
      if (!this.driftIncidents.length) this.driftIncidents.push(incident);
      throw new DriftError('页面所见总版号与签收目标不一致', incident);
    }

    if (opts.resetDrafts) this.knownDrafts = {};
    if (opts.clearWork) this.knownDrafts.work = '';
    if (raw.phase === 'form' && raw.audience) {
      this.knownDrafts[raw.audience] = raw.draftValue ?? '';
    }
    raw.latentDrafts = Object.fromEntries(
      Object.entries(this.knownDrafts).filter(([, value]) => value !== '' && value !== null && value !== undefined),
    );
    raw.fingerprint = stateFingerprint(raw);

    const existing = this.stateIndex.get(raw.fingerprint);
    if (existing) {
      existing.revisits += 1;
      existing.lastSeenAt = this.keyCount;
      existing.labels = [...new Set([...(existing.labels ?? []), label])];
      this.lastState = existing;
      return existing;
    }
    const id = `S${String(this.states.length + 1).padStart(3, '0')}`;
    raw.id = id;
    raw.revisits = 0;
    raw.firstSeenAt = this.keyCount;
    raw.lastSeenAt = this.keyCount;
    raw.labels = [label];
    raw.section = this.expectedPath?.audience ?? null;
    this.states.push(raw);
    this.stateIndex.set(raw.fingerprint, raw);
    this.lastState = raw;
    return raw;
  }

  async press(key, context = {}) {
    if (this.keyCount >= this.keyBudget) {
      throw new PathAbort('键盘操作预算耗尽', { atKey: this.keyCount, context });
    }
    if (this.elapsedMs() >= this.timeBudgetMs) {
      throw new PathAbort('巡查时段耗尽', { atElapsedMs: this.elapsedMs(), context });
    }
    if (this.onBeforeKey) {
      await this.onBeforeKey({ key, context, session: this });
    }
    const before = this.lastState ?? (await this.snapshot(`${this.expectedPath?.label ?? ''} / 按键前`));
    await this.checkRelease(`按键 ${key} 前（${context.target ?? ''}）`);
    await this.page.keyboard.press(key);
    await wait(30);
    const after = await this.snapshot(`${this.expectedPath?.label ?? ''} / ${context.target ?? key}`, { checkRelease: false });
    this.keyCount += 1;
    const record = {
      index: this.keyCount,
      key,
      context: context.target ?? null,
      fromState: before.id,
      toState: after.id,
      fromFocus: before.focusAx,
      toFocus: after.focusAx,
      fromPhase: before.phase,
      toPhase: after.phase,
      dialogOpenBefore: before.dialogOpen,
      dialogOpenAfter: after.dialogOpen,
      insideDialogAfter: Boolean(after.active?.inDialog),
      stateChanged: before.id !== after.id,
      newState: after.firstSeenAt === this.keyCount,
      elapsedMs: this.elapsedMs(),
    };
    this.keys.push(record);
    this.transitions.push(record);
    this.keyPath.push({ key, state: after.id, focus: focusKey(after.focusAx) });
    return { before, after, record };
  }

  async typeText(text, context = {}) {
    for (const char of text) {
      await this.press(char, { ...context, target: `${context.target ?? '输入'}（字符）` });
    }
  }

  async gotoPath(url, label) {
    await this.page.goto(this.sourceUrl + url, { waitUntil: 'domcontentloaded' });
    await wait(50);
    this.keyPath = [];
    this.expectedPath = { ...(this.expectedPath ?? {}), label };
    const state = await this.snapshot(label, { resetDrafts: true });
    this.transitions.push({
      index: 0,
      key: 'goto',
      context: url,
      fromState: null,
      toState: state.id,
      fromFocus: null,
      toFocus: state.focusAx,
      fromPhase: null,
      toPhase: state.phase,
      dialogOpenBefore: false,
      dialogOpenAfter: state.dialogOpen,
      insideDialogAfter: false,
      stateChanged: true,
      newState: true,
    });
    return state;
  }

  async focusTarget(name, { role = null, direction = 'forward', maxSteps = 32, context = {} } = {}) {
    const seen = [];
    for (let step = 0; step < maxSteps; step += 1) {
      const current = this.lastState ?? (await this.snapshot('定位目标'));
      const focus = current.focusAx;
      if (!focus.body && (!role || focus.role === role) && focus.name === name) {
        return { found: true, state: current, steps: step };
      }
      const signature = focusKey(focus);
      if (seen.filter(entry => entry === signature).length >= 2) {
        return { found: false, reason: '焦点循环，未遇到目标控件', cycle: seen };
      }
      seen.push(signature);
      const key = direction === 'forward' ? 'Tab' : 'Shift+Tab';
      await this.press(key, { ...context, target: `定位“${name}”` });
    }
    return { found: false, reason: '达到定位上限仍未遇到目标控件', cycle: seen };
  }

  async cycleFocus({ maxSteps = 24, label }) {
    const start = this.lastState ?? (await this.snapshot(label));
    const startKey = focusKey(start.focusAx);
    const order = [];
    const edges = new Set();
    for (let step = 0; step < maxSteps; step += 1) {
      const { after, record } = await this.press('Tab', { target: `${label}：焦点巡查` });
      const key = focusKey(after.focusAx);
      order.push({
        step: step + 1,
        keyIndex: record.index,
        state: after.id,
        focus: after.focusAx,
        dialogOpen: after.dialogOpen,
        phase: after.phase,
        stateFingerprint: after.fingerprint,
        timeOnly: after.id === record.fromState && after.fingerprint === start.fingerprint,
      });
      if (key === startKey) {
        return { order, closed: true, startKey, steps: step + 1 };
      }
      const edge = `${focusKey(record.fromFocus)}->${key}`;
      if (edges.has(edge)) {
        const duplicate = order.filter(entry => entry.focus && focusKey(entry.focus) === key).length >= 2;
        this.loops.push({
          label,
          kind: duplicate ? 'state-fingerprint-repeat' : 'focus-edge-repeat',
          edge,
          steps: order.slice(-4),
          timeOnly: order.slice(-4).every(entry => entry.timeOnly),
        });
        return { order, closed: false, startKey, steps: step + 1, reason: '重复焦点边，提前停止' };
      }
      edges.add(edge);
    }
    this.loops.push({ label, kind: 'focus-budget', steps: order.slice(-4) });
    return { order, closed: false, startKey, steps: maxSteps, reason: '焦点巡查达到上限' };
  }

  async selectAudience(target) {
    const focus = await this.focusTarget('场景', { role: 'combobox', context: { target: '人群选择' } });
    if (!focus.found) throw new PathAbort('人群选择器不可达', { reason: focus.reason, cycle: focus.cycle });
    await this.press('Home', { target: '人群选择：回到未选择' });
    const order = ['', ...AUDIENCES];
    const index = order.indexOf(target);
    for (let i = 0; i < index; i += 1) {
      await this.press('ArrowDown', { target: `人群选择：${AUDIENCE_LABELS[order[i + 1]] ?? order[i + 1]}` });
    }
    const state = this.lastState;
    if (state.audience !== target) {
      throw new PathAbort('选择后的人群与预期不一致', { expected: target, actual: state.audience, state: state.id });
    }
    return state;
  }

  async openHelp() {
    const focus = await this.focusTarget('填写帮助', { role: 'button', context: { target: '打开帮助' } });
    if (!focus.found) throw new PathAbort('帮助按钮不可达', { reason: focus.reason });
    await this.press('Enter', { target: '打开帮助' });
    const state = this.lastState;
    if (!state.dialogOpen) throw new PathAbort('按 Enter 后帮助层未打开', { state: state.id });
    return state;
  }

  async closeHelpByButton() {
    if (!this.lastState?.dialogOpen) return this.lastState;
    const focus = await this.focusTarget('关闭帮助', { role: 'button', context: { target: '关闭帮助' } });
    if (!focus.found) throw new PathAbort('关闭帮助按钮不可达', { reason: focus.reason });
    await this.press('Enter', { target: '关闭帮助' });
    await wait(30);
    const state = await this.snapshot('帮助层关闭后', { checkRelease: false });
    if (state.dialogOpen) throw new PathAbort('按 Enter 后帮助层未关闭', { state: state.id });
    return state;
  }

  async confirmFocus() {
    const focus = await this.focusTarget('确认报名', { role: 'button', context: { target: '最终停止点（只聚焦）' } });
    if (!focus.found) return { reached: false, reason: focus.reason, cycle: focus.cycle };
    const state = this.lastState;
    return { reached: true, state };
  }
}

function milestone(result, session, text) {
  result.milestones.push({ keyIndex: session.keyCount, text });
}

function phasesRecord(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== null));
}

export async function runFullPath(session, plan) {
  const result = {
    plan,
    scope: 'full',
    status: 'running',
    startKey: session.keyCount,
    phases: {},
    observations: {},
    milestones: [],
    error: null,
    reusedFrom: null,
  };
  session.expectedPath = { mode: plan.mode, audience: plan.audience, label: `${plan.modeLabel}/${plan.audienceLabel}` };
  try {
    const landing = await session.gotoPath(plan.entry, `${plan.modeLabel} ${plan.audienceLabel} 入口`);
    result.phases.landing = landing.id;
    result.observations.landing = {
      mode: landing.mode,
      revision: landing.revision,
      title: landing.title,
      h1: landing.headingTexts[0] ?? null,
      visibleText: compact(landing.visibleText, 260),
      eventNameVisible: landing.visibleText.includes(plan.eventName),
    };
    if (landing.mode !== plan.mode) throw new PathAbort('入口页面的模式与计划不一致', { expected: plan.mode, actual: landing.mode });

    milestone(result, session, '读取入口页面，确认模式与总版号');
    const selected = await session.selectAudience(plan.audience);
    milestone(result, session, `在“场景”选择器上按 Home 回到“未选择”，再按 ArrowDown 选中“${plan.audienceLabel}”；页面显示${selected.manualReception ? `提示“${selected.manualReception}”` : `报名表 ${selected.form}`}`);
    result.phases.audience = selected.id;
    result.observations.audience = {
      audience: selected.audience,
      phase: selected.phase,
      form: selected.form,
      manualReception: selected.manualReception,
      focus: selected.focusAx,
      liveRegions: selected.liveRegions,
      visibleText: compact(selected.visibleText, 260),
    };

    if (plan.audience === 'desk') {
      result.status = 'terminal';
      result.phases.terminal = selected.id;
      result.observations.terminal = {
        kind: 'manual-reception',
        text: selected.manualReception,
        headingCount: selected.headingTexts.length,
        controlCount: selected.controls.length,
        focus: selected.focusAx,
      };
      result.endKey = session.keyCount;
      session.pathResults.push(result);
      return result;
    }

    if (!selected.form) throw new PathAbort('选择人群后未出现报名表', { state: selected.id });
    result.observations.form = { form: selected.form, audience: selected.audience };

    const formFocus = await session.cycleFocus({ maxSteps: 10, label: '报名表焦点顺序' });
    result.phases.formFocus = formFocus.order.map(entry => entry.state);
    result.observations.formFocus = {
      closed: formFocus.closed,
      start: formFocus.startKey,
      order: formFocus.order.map(entry => ({
        step: entry.step,
        state: entry.state,
        keyIndex: entry.keyIndex,
        focus: entry.focus,
        phase: entry.phase,
      })),
      reachableNames: [...new Set(formFocus.order.filter(entry => !entry.focus?.body).map(entry => entry.focus?.name))],
      bodyHits: formFocus.order.filter(entry => entry.focus?.body).length,
      form: selected.form,
    };

    milestone(result, session, '从“场景”起按 Tab 巡查报名表焦点顺序至闭环');
    const helpOpen = await session.openHelp();
    milestone(result, session, '把焦点移到“填写帮助”，按 Enter 打开帮助层');
    result.phases.helpOpen = helpOpen.id;
    result.observations.helpOpen = {
      component: helpOpen.helpComponent,
      dialogOpen: helpOpen.dialogOpen,
      dialogAxName: helpOpen.dialogAxName,
      dialogText: helpOpen.dialogText,
      dialogControls: helpOpen.dialogControls,
      focus: helpOpen.focusAx,
      form: helpOpen.form,
    };
    const helpFocus = await session.cycleFocus({ maxSteps: 8, label: '帮助层焦点顺序' });
    milestone(result, session, '在帮助层内按 Tab 巡查焦点顺序');
    result.phases.helpFocus = helpFocus.order.map(entry => entry.state);
    result.observations.helpFocus = {
      closed: helpFocus.closed,
      order: helpFocus.order.map(entry => ({
        step: entry.step,
        state: entry.state,
        keyIndex: entry.keyIndex,
        focus: entry.focus,
        dialogOpen: entry.dialogOpen,
        phase: entry.phase,
      })),
      bodyOutsideDialog: helpFocus.order.filter(entry => entry.focus?.body && entry.dialogOpen).length,
    };
    const shift = await session.press('Shift+Tab', { target: '帮助层反向巡查' });
    result.phases.helpShift = shift.after.id;
    result.observations.helpShift = {
      focus: shift.after.focusAx,
      dialogOpen: shift.after.dialogOpen,
      insideDialog: shift.record.insideDialogAfter,
    };
    await session.press('Escape', { target: 'Escape 关闭帮助' });
    milestone(result, session, '按 Escape 关闭帮助层');
    const closed = session.lastState;
    result.phases.helpClosed = closed.id;
    result.observations.helpClosed = { dialogOpen: closed.dialogOpen, focus: closed.focusAx, dialogCount: await session.page.locator('dialog').count() };

    const reopened = await session.openHelp();
    milestone(result, session, '焦点回到“填写帮助”，按 Enter 再次打开帮助层');
    result.phases.helpReopened = reopened.id;
    result.observations.helpReopened = { dialogOpen: reopened.dialogOpen, focus: reopened.focusAx, component: reopened.helpComponent };
    const closedByButton = await session.closeHelpByButton();
    milestone(result, session, '在帮助层内定位“关闭帮助”，按 Enter 关闭');
    result.phases.helpButtonClosed = closedByButton.id;
    result.observations.helpButtonClosed = { dialogOpen: closedByButton.dialogOpen, focus: closedByButton.focusAx };

    const review = await session.focusTarget('检查内容', { role: 'button', context: { target: '检查内容' } });
    if (!review.found) throw new PathAbort('检查内容不可达', { reason: review.reason });
    await session.press('Enter', { target: '进入确认前预览' });
    milestone(result, session, '定位“检查内容”，按 Enter 进入确认前预览');
    const preview = session.lastState;
    result.phases.preview = preview.id;
    result.observations.preview = {
      preview: preview.preview,
      previewText: preview.previewText,
      focus: preview.focusAx,
      liveRegions: preview.liveRegions,
      form: preview.form,
      audience: preview.audience,
    };
    const previewFocus = await session.cycleFocus({ maxSteps: 8, label: '确认前预览焦点顺序' });
    result.phases.previewFocus = previewFocus.order.map(entry => entry.state);
    result.observations.previewFocus = {
      closed: previewFocus.closed,
      order: previewFocus.order.map(entry => ({
        step: entry.step,
        state: entry.state,
        keyIndex: entry.keyIndex,
        focus: entry.focus,
        phase: entry.phase,
      })),
    };
    const confirm = await session.confirmFocus();
    milestone(result, session, '按 Tab 把焦点移到“确认报名”（只聚焦，不按 Enter）');
    result.phases.confirm = confirm.state?.id ?? null;
    result.observations.confirm = {
      reached: confirm.reached,
      focus: confirm.state?.focusAx ?? null,
      pressed: false,
      reason: confirm.reason ?? null,
    };
    if (!confirm.reached) throw new PathAbort('确认报名按钮不可达', { reason: confirm.reason });

    const edit = await session.focusTarget('返回编辑', { role: 'button', context: { target: '返回编辑' } });
    if (!edit.found) throw new PathAbort('返回编辑不可达', { reason: edit.reason });
    await session.press('Enter', { target: '返回编辑' });
    milestone(result, session, '定位“返回编辑”，按 Enter 回到报名表');
    const afterEdit = session.lastState;
    result.phases.edit = afterEdit.id;
    result.observations.edit = { focus: afterEdit.focusAx, form: afterEdit.form, audience: afterEdit.audience };

    const contact = await session.focusTarget('联系号码', { role: 'textbox', context: { target: '联系号码' } });
    if (!contact.found) throw new PathAbort('联系号码不可达', { reason: contact.reason });
    const draftValue = `K${plan.mode === 'district' ? 'D' : 'K'}${plan.audience === 'community' ? 'C' : 'W'}`;
    await session.typeText(draftValue, { target: '填写联系号码' });
    milestone(result, session, '定位“联系号码”，用键盘输入草稿');
    const draftState = session.lastState;
    result.phases.draftFilled = draftState.id;
    result.observations.draftFilled = { value: draftState.draftValue, draft: draftState.draft, focus: draftState.focusAx };

    await session.focusTarget('检查内容', { role: 'button', context: { target: '检查内容（草稿）' } });
    await session.press('Enter', { target: '草稿后预览' });
    const previewDraft = session.lastState;
    result.phases.previewDraft = previewDraft.id;
    result.observations.previewDraft = { previewText: previewDraft.previewText, focus: previewDraft.focusAx };
    await session.focusTarget('返回编辑', { role: 'button', context: { target: '返回编辑（草稿）' } });
    await session.press('Enter', { target: '返回编辑（草稿）' });
    const editDraft = session.lastState;
    result.phases.editAfterDraft = editDraft.id;
    result.observations.editAfterDraft = { value: editDraft.draftValue, focus: editDraft.focusAx };

    const back = await session.focusTarget('回到选择', { role: 'button', context: { target: '回到选择' } });
    if (!back.found) throw new PathAbort('回到选择不可达', { reason: back.reason });
    await session.press('Enter', { target: '回到选择' });
    milestone(result, session, '定位“回到选择”，按 Enter 回退');
    const backState = await session.snapshot('回到选择后', { clearWork: true, checkRelease: false });
    result.phases.back = backState.id;
    result.observations.back = {
      audience: backState.audience,
      focus: backState.focusAx,
      phase: backState.phase,
      latentDrafts: backState.latentDrafts,
      visibleText: compact(backState.visibleText, 200),
    };
    const reselected = await session.selectAudience(plan.audience);
    milestone(result, session, `重新选中“${plan.audienceLabel}”，读取联系号码的保留情况`);
    result.phases.reselect = reselected.id;
    result.observations.reselect = {
      audience: reselected.audience,
      value: reselected.draftValue,
      draft: reselected.draft,
      latentDrafts: reselected.latentDrafts,
      focus: reselected.focusAx,
      form: reselected.form,
    };

    const otherAudience = plan.audience === 'community' ? 'work' : 'community';
    const swapped = await session.selectAudience(otherAudience);
    milestone(result, session, `改选“${AUDIENCE_LABELS[otherAudience]}”，读取报名表与草稿`);
    result.phases.switch = swapped.id;
    result.observations.switch = {
      audience: swapped.audience,
      form: swapped.form,
      value: swapped.draftValue,
      draft: swapped.draft,
      latentDrafts: swapped.latentDrafts,
    };
    const backToOriginal = await session.selectAudience(plan.audience);
    milestone(result, session, `再选回“${plan.audienceLabel}”`);
    result.phases.switchBack = backToOriginal.id;
    result.observations.switchBack = {
      audience: backToOriginal.audience,
      form: backToOriginal.form,
      value: backToOriginal.draftValue,
      draft: backToOriginal.draft,
      latentDrafts: backToOriginal.latentDrafts,
    };

    const reviewBranch = await session.focusTarget('检查内容', { role: 'button', context: { target: '检查内容（改人群分支）' } });
    if (reviewBranch.found) {
      await session.press('Enter', { target: '进入预览（改人群分支）' });
      milestone(result, session, '再次定位“检查内容”，按 Enter 进入预览，准备在预览中改人群');
      const previewBranch = session.lastState;
      result.phases.previewBranch = previewBranch.id;
      const selectInPreview = await session.focusTarget('场景', { role: 'combobox', context: { target: '预览中的场景选择器' } });
      if (selectInPreview.found) {
        // 从一个非柜台人群改到另一个非柜台人群，避免把“预览被替换”与“人工接待终点”混在一起。
        await session.press('Home', { target: '预览中改人群：回到未选择' });
        const targetAudience = plan.audience === 'community' ? 'work' : 'community';
        const order = ['', 'community', 'work', 'desk'];
        for (let i = 0; i < order.indexOf(targetAudience); i += 1) {
          await session.press('ArrowDown', { target: `预览中直接改人群：${AUDIENCE_LABELS[order[i + 1]]}` });
        }
        milestone(result, session, `在预览状态下把“场景”从“${plan.audienceLabel}”改为“${AUDIENCE_LABELS[targetAudience]}”`);
        const changed = session.lastState;
        result.phases.previewSwitch = changed.id;
        result.observations.previewSwitch = {
          from: previewBranch.id,
          to: changed.id,
          phase: changed.phase,
          audience: changed.audience,
          form: changed.form,
          dialogOpen: changed.dialogOpen,
          preview: changed.preview,
          focus: changed.focusAx,
        };
        await session.selectAudience(plan.audience);
        result.phases.previewSwitchBack = session.lastState.id;
      } else {
        result.observations.previewSwitch = { from: previewBranch.id, reachable: false, reason: selectInPreview.reason, cycle: selectInPreview.cycle };
      }
    }

    result.status = 'complete';
    result.endKey = session.keyCount;
    result.elapsedMs = session.elapsedMs();
    session.pathResults.push(result);
    return result;
  } catch (error) {
    result.status = error instanceof DriftError ? 'drifted' : 'aborted';
    result.error = {
      kind: error instanceof DriftError ? 'drift' : error instanceof PathAbort ? 'abort' : 'error',
      message: error.message,
      detail: error.detail ?? null,
      stack: error instanceof DriftError || error instanceof PathAbort ? null : error.stack,
    };
    result.endKey = session.keyCount;
    result.elapsedMs = session.elapsedMs();
    session.aborts.push({ plan, error: result.error });
    session.pathResults.push(result);
    return result;
  }
}

export async function runBoundaryPath(session, plan, reusePath) {
  const result = {
    plan,
    scope: 'boundary',
    status: 'running',
    startKey: session.keyCount,
    phases: {},
    observations: {},
    milestones: [],
    error: null,
    reusedFrom: reusePath?.plan?.key ?? null,
  };
  session.expectedPath = { mode: plan.mode, audience: plan.audience, label: `${plan.modeLabel}/${plan.audienceLabel}` };
  try {
    const landing = await session.gotoPath(plan.entry, `${plan.modeLabel} ${plan.audienceLabel} 入口（边界复核）`);
    result.phases.landing = landing.id;
    result.observations.landing = {
      mode: landing.mode,
      revision: landing.revision,
      title: landing.title,
      h1: landing.headingTexts[0] ?? null,
      eventNameVisible: landing.visibleText.includes(plan.eventName),
    };
    if (landing.mode !== plan.mode) throw new PathAbort('入口页面的模式与计划不一致', { expected: plan.mode, actual: landing.mode });

    milestone(result, session, '已打开入口');
    const selected = await session.selectAudience(plan.audience);
    milestone(result, session, `在“场景”选择器上按 Home 回到“未选择”，再按 ArrowDown 选中“${plan.audienceLabel}”；报名表 ${selected.form ?? '无'}`);
    result.phases.audience = selected.id;
    result.observations.audience = { audience: selected.audience, form: selected.form, phase: selected.phase };
    if (!selected.form) throw new PathAbort('选择人群后未出现报名表', { state: selected.id });
    if (selected.form !== plan.expectedForm) {
      throw new PathAbort('报名表版号与发版记录不一致', { expected: plan.expectedForm, actual: selected.form, state: selected.id });
    }

    const formFocus = await session.cycleFocus({ maxSteps: 10, label: '报名表焦点顺序（边界复核）' });
    result.phases.formFocus = formFocus.order.map(entry => entry.state);
    result.observations.formFocus = {
      closed: formFocus.closed,
      start: formFocus.startKey,
      order: formFocus.order.map(entry => ({
        step: entry.step,
        state: entry.state,
        keyIndex: entry.keyIndex,
        focus: entry.focus,
        phase: entry.phase,
      })),
      reachableNames: [...new Set(formFocus.order.filter(entry => !entry.focus?.body).map(entry => entry.focus?.name))],
      bodyHits: formFocus.order.filter(entry => entry.focus?.body).length,
      form: selected.form,
    };

    milestone(result, session, '从“场景”起按 Tab 巡查报名表焦点顺序至闭环');
    const helpOpen = await session.openHelp();
    milestone(result, session, '把焦点移到“填写帮助”，按 Enter 打开帮助层');
    result.phases.helpOpen = helpOpen.id;
    result.observations.helpOpen = {
      component: helpOpen.helpComponent,
      dialogOpen: helpOpen.dialogOpen,
      dialogAxName: helpOpen.dialogAxName,
      dialogText: helpOpen.dialogText,
      dialogControls: helpOpen.dialogControls,
      focus: helpOpen.focusAx,
      form: helpOpen.form,
    };
    const helpFocus = await session.cycleFocus({ maxSteps: 8, label: '帮助层焦点顺序（边界复核）' });
    milestone(result, session, '在帮助层内按 Tab 巡查焦点顺序');
    result.phases.helpFocus = helpFocus.order.map(entry => entry.state);
    result.observations.helpFocus = {
      closed: helpFocus.closed,
      order: helpFocus.order.map(entry => ({
        step: entry.step,
        state: entry.state,
        keyIndex: entry.keyIndex,
        focus: entry.focus,
        dialogOpen: entry.dialogOpen,
        phase: entry.phase,
      })),
      bodyOutsideDialog: helpFocus.order.filter(entry => entry.focus?.body && entry.dialogOpen).length,
    };
    const shift = await session.press('Shift+Tab', { target: '帮助层反向巡查（边界复核）' });
    result.phases.helpShift = shift.after.id;
    result.observations.helpShift = { focus: shift.after.focusAx, dialogOpen: shift.after.dialogOpen };
    await session.press('Escape', { target: 'Escape 关闭帮助（边界复核）' });
    milestone(result, session, '按 Escape 关闭帮助层');
    result.phases.helpClosed = session.lastState.id;
    result.observations.helpClosed = { dialogOpen: session.lastState.dialogOpen, focus: session.lastState.focusAx };

    const review = await session.focusTarget('检查内容', { role: 'button', context: { target: '检查内容（边界复核）' } });
    if (!review.found) throw new PathAbort('检查内容不可达', { reason: review.reason });
    await session.press('Enter', { target: '进入确认前预览（边界复核）' });
    milestone(result, session, '定位“检查内容”，按 Enter 进入确认前预览');
    const preview = session.lastState;
    result.phases.preview = preview.id;
    result.observations.preview = { previewText: preview.previewText, focus: preview.focusAx, liveRegions: preview.liveRegions };
    const confirm = await session.confirmFocus();
    milestone(result, session, '按 Tab 把焦点移到“确认报名”（只聚焦，不按 Enter）');
    result.phases.confirm = confirm.state?.id ?? null;
    result.observations.confirm = { reached: confirm.reached, focus: confirm.state?.focusAx ?? null, pressed: false };
    if (!confirm.reached) throw new PathAbort('确认报名按钮不可达', { reason: confirm.reason });
    const edit = await session.focusTarget('返回编辑', { role: 'button', context: { target: '返回编辑（边界复核）' } });
    if (!edit.found) throw new PathAbort('返回编辑不可达', { reason: edit.reason });
    await session.press('Enter', { target: '返回编辑（边界复核）' });
    result.phases.edit = session.lastState.id;
    result.observations.edit = { focus: session.lastState.focusAx, form: session.lastState.form, audience: session.lastState.audience };

    const back = await session.focusTarget('回到选择', { role: 'button', context: { target: '回到选择（边界复核）' } });
    if (!back.found) throw new PathAbort('回到选择不可达', { reason: back.reason });
    await session.press('Enter', { target: '回到选择（边界复核）' });
    milestone(result, session, '定位“回到选择”，按 Enter 回退');
    const backState = await session.snapshot('回到选择后（边界复核）', { clearWork: true, checkRelease: false });
    result.phases.back = backState.id;
    result.observations.back = { audience: backState.audience, focus: backState.focusAx, latentDrafts: backState.latentDrafts };
    const reselected = await session.selectAudience(plan.audience);
    milestone(result, session, `重新选中“${plan.audienceLabel}”，读取联系号码的保留情况`);
    result.phases.reselect = reselected.id;
    result.observations.reselect = { audience: reselected.audience, value: reselected.draftValue, draft: reselected.draft, latentDrafts: reselected.latentDrafts };

    result.status = 'partial';
    result.endKey = session.keyCount;
    result.elapsedMs = session.elapsedMs();
    session.pathResults.push(result);
    return result;
  } catch (error) {
    result.status = error instanceof DriftError ? 'drifted' : 'aborted';
    result.error = {
      kind: error instanceof DriftError ? 'drift' : error instanceof PathAbort ? 'abort' : 'error',
      message: error.message,
      detail: error.detail ?? null,
      stack: error instanceof DriftError || error instanceof PathAbort ? null : error.stack,
    };
    result.endKey = session.keyCount;
    result.elapsedMs = session.elapsedMs();
    session.aborts.push({ plan, error: result.error });
    session.pathResults.push(result);
    return result;
  }
}

export function serializeSession(session) {
  return {
    runId: session.runId,
    revision: session.revision,
    release: session.release,
    bulletin: session.bulletin,
    startedAt: new Date(session.startedAt).toISOString(),
    elapsedMs: session.elapsedMs(),
    keyCount: session.keyCount,
    keyBudget: session.keyBudget,
    stateCount: session.states.length,
    states: session.states,
    transitions: session.transitions,
    keys: session.keys,
    loops: session.loops,
    aborts: session.aborts,
    driftIncidents: session.driftIncidents,
    pathResults: session.pathResults,
    confirmFocused: session.keys.filter(record => record.toFocus && !record.toFocus.body && record.toFocus.name === '确认报名').length,
  };
}

export { CONFIRM_PATH, MODE_LABELS, phasesRecord };
