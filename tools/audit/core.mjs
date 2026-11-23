import { chromium } from 'playwright';

export const ENTRY_PATHS = { district: '/signup/district', kiosk: '/signup/kiosk' };
export const BULLETIN_PATH = '/bulletin';
export const RELEASE_PATH = '/release';
export const CONFIRM_PATH = '/signup/confirmed';
export const AUDIENCES = ['community', 'work', 'desk'];
export const AUDIENCE_LABELS = { community: '社区居民', work: '流动职工', desk: '柜台接待' };
export const MODES = ['district', 'kiosk'];
export const MODE_LABELS = { district: '区报名页', kiosk: '街道自助终端' };

export const CLASSIFICATION = {
  observed: '已观察',
  textNotRead: '页面文本确实没读到',
  keyboardUnreachable: '键盘路径进不到',
  insufficient: '当前资料不足以判断',
};

export class DriftError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'DriftError';
    this.detail = detail;
  }
}

export class PathAbort extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PathAbort';
    this.detail = detail;
  }
}

export function hash(value) {
  const text = String(value ?? '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function compact(text, max = 240) {
  const value = String(text ?? '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function focusLabel(focus) {
  if (!focus) return '（未采集）';
  if (focus.body) return '文档 body（无可访问名称）';
  return `${focus.role || '未知角色'} “${focus.name || ''}”`;
}

export function focusKey(focus) {
  if (!focus) return 'none';
  if (focus.body) return 'body';
  return `${focus.role}:${focus.name}`;
}

export function stateFingerprint(state) {
  const latent = state.latentDrafts
    ? Object.entries(state.latentDrafts).sort().map(([key, value]) => `${key}=${value}`).join(',')
    : '';
  return [
    `rev=${state.revision ?? '-'}`,
    `area=${state.mode ?? '-'}`,
    `phase=${state.phase}`,
    `aud=${state.audience || '-'}`,
    `form=${state.form ?? '-'}`,
    `help=${state.helpComponent ?? '-'}`,
    `dlg=${state.dialogOpen ? 1 : 0}`,
    `pv=${state.preview ? 1 : 0}`,
    `draft=${state.draft}`,
    `latent=${latent}`,
    `status=${state.manualReception ?? '-'}`,
    `focus=${focusKey(state.focusAx)}`,
    `text=${hash(state.visibleText)}`,
  ].join('|');
}

export function compactState(state) {
  return {
    id: state.id,
    revision: state.revision,
    mode: state.mode,
    audience: state.audience,
    phase: state.phase,
    form: state.form,
    helpComponent: state.helpComponent,
    dialogOpen: state.dialogOpen,
    dialogAxName: state.dialogAxName,
    dialogText: compact(state.dialogText, 160),
    dialogControls: state.dialogControls,
    previewText: compact(state.previewText, 160),
    manualReception: state.manualReception,
    draft: state.draft,
    latentDrafts: state.latentDrafts ?? {},
    focus: state.focusAx,
    fingerprint: state.fingerprint,
    resolvedFingerprint: state.resolvedFingerprint ?? null,
    aliasOf: state.aliasOf ?? null,
    visibleText: compact(state.visibleText, 260),
    liveRegions: state.liveRegions,
    headingTexts: state.headingTexts,
    controls: state.controls,
  };
}

function roleOf(element) {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file'].includes(type)) return type;
    return 'textbox';
  }
  if (tag === 'dialog') return 'dialog';
  return 'generic';
}

function accessibleName(element) {
  if (!element) return '';
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.innerText ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();
  if (element.labels?.length) {
    const text = [...element.labels].map(label => label.innerText ?? '').join(' ').trim();
    if (text) return text;
  }
  if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') {
    return (element.getAttribute('placeholder') || element.getAttribute('title') || '').trim();
  }
  return (element.innerText || '').trim().slice(0, 160);
}

export async function capture(page, label = '') {
  const dom = await page.evaluate(() => {
    const main = document.querySelector('main');
    const active = document.activeElement;
    const isBody = !active || active === document.body || active === document.documentElement;
    const dialog = document.querySelector('dialog');
    const dialogOpen = Boolean(dialog?.open);
    const preview = document.querySelector('[aria-label="确认前预览"]');
    const status = document.querySelector('[role="status"]');
    const select = document.querySelector('select');
    const input = document.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    const visible = main ? main.innerText : document.body.innerText;

    const nameOf = element => {
      if (!element) return '';
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map(id => document.getElementById(id)?.innerText ?? '')
          .join(' ')
          .trim();
        if (text) return text;
      }
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel?.trim()) return ariaLabel.trim();
      if (element.labels?.length) {
        const text = [...element.labels].map(label => label.innerText ?? '').join(' ').trim();
        if (text) return text;
      }
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
        return (element.getAttribute('placeholder') || element.getAttribute('title') || '').trim();
      }
      return (element.innerText || '').trim().slice(0, 160);
    };
    const roleOf = element => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'a') return 'link';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file'].includes(type)) return type;
        return 'textbox';
      }
      if (tag === 'dialog') return 'dialog';
      return 'generic';
    };
    const controlList = root =>
      [...root.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.disabled)
        .map(element => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          role: roleOf(element),
          tabindex: element.getAttribute('tabindex'),
          inDialog: Boolean(element.closest('dialog')),
          name: nameOf(element),
        }));

    return {
      url: location.pathname + location.search,
      title: document.title,
      lang: document.documentElement.lang,
      revision: main?.dataset.publication ?? null,
      mode: main?.dataset.area ?? null,
      audience: select?.value || null,
      audienceOptions: select ? [...select.options].map(option => ({ value: option.value, label: option.textContent.trim() })) : [],
      form: document.querySelector('[data-form]')?.dataset.form ?? null,
      helpComponent: dialog?.dataset.component ?? document.querySelector('[data-component]')?.dataset.component ?? null,
      dialogOpen,
      dialogText: dialog?.innerText.trim() ?? null,
      dialogAccessibleName: dialog ? nameOf(dialog) : null,
      dialogControls: dialog ? controlList(dialog) : [],
      preview: Boolean(preview),
      previewText: preview?.innerText.trim() ?? null,
      previewAccessibleName: preview ? nameOf(preview) : null,
      manualReception: status?.innerText.trim() ?? null,
      draftValue: input?.value ?? null,
      visibleText: visible.replace(/[ \t]+/g, ' ').trim(),
      active: isBody
        ? { body: true, tag: active?.tagName ?? null }
        : {
            body: false,
            tag: active.tagName,
            id: active.id || null,
            role: roleOf(active),
            name: nameOf(active),
            value: active.value ?? null,
            inDialog: Boolean(active.closest('dialog')),
            tabindex: active.getAttribute('tabindex'),
          },
      headingTexts: [...document.querySelectorAll('h1,h2,h3')].map(heading => heading.innerText.trim()),
      liveRegions: [...document.querySelectorAll('[role="status"],[aria-live]')].map(element => element.innerText.trim()),
      controls: controlList(document),
    };
  });

  dom.focusAx = dom.active.body
    ? { body: true, role: 'body', name: '' }
    : {
        body: false,
        role: dom.active.role,
        name: dom.active.name,
        value: dom.active.value,
        inDialog: dom.active.inDialog,
        id: dom.active.id,
        tag: dom.active.tag,
      };
  dom.dialogAxName = dom.dialogAccessibleName ?? null;
  dom.draft = dom.draftValue === null ? 'no-field' : dom.draftValue === '' ? 'empty' : `filled:${hash(dom.draftValue)}`;
  dom.phase = dom.dialogOpen
    ? 'help'
    : dom.manualReception
      ? 'manual-reception'
      : dom.preview
        ? 'preview'
        : dom.form
          ? 'form'
          : dom.audience
            ? 'audience-only'
            : 'landing';
  dom.label = label;
  return dom;
}

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

export async function captureAx(page) {
  let tree = null;
  try {
    tree = await page.accessibility.snapshot({ interestingOnly: false });
  } catch {
    tree = null;
  }
  if (!tree) return { focused: null, dialogName: null, dialogControls: [] };
  const focused = findNode(tree, node => node.focused === true);
  const dialog = findNode(tree, node => node.role === 'dialog');
  return {
    focused: focused ? { role: focused.role, name: (focused.name ?? '').trim(), value: focused.value ?? null } : null,
    dialogName: dialog ? (dialog.name ?? '').trim() : null,
    dialogControls: dialog
      ? (dialog.children ?? []).map(child => ({ role: child.role, name: (child.name ?? '').trim() }))
      : [],
  };
}

export async function launchBrowser() {
  return chromium.launch();
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${url} → ${response.status}`);
  return response.json();
}

export function createRunId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}
