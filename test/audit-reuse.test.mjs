import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reuseDecision, reuseSummary, STAGE_REVISION } from '../tools/audit/run.mjs';
import { AUDIENCE_LABELS, MODE_LABELS } from '../tools/audit/core.mjs';

const plan = (mode, audience) => ({
  mode,
  audience,
  modeLabel: MODE_LABELS[mode],
  audienceLabel: AUDIENCE_LABELS[audience],
});

const previousRun = (revision, form, help, status = 'complete') => ({
  revision,
  release: { district: { community: form, work: form, help }, kiosk: { community: form, work: form, help } },
  pathResults: ['community', 'work', 'desk'].flatMap(audience => ['district', 'kiosk'].map(mode => ({
    plan: { ...plan(mode, audience), revision },
    status: audience === 'desk' ? 'terminal' : status,
    observations: audience === 'desk'
      ? { terminal: { text: '请到现场人工接待' } }
      : { form: { form }, helpOpen: { component: help } },
    phases: {},
  }))),
});

test('同一发布、同一组件版号才允许直接复用', () => {
  const prior = previousRun('1', 'C3', 'H1');
  const release = { district: { community: 'C3', work: 'C3', help: 'H1' }, kiosk: { community: 'C3', work: 'C3', help: 'H1' } };
  const decision = reuseDecision(prior, plan('district', 'community'), release, '1');
  assert.equal(decision.mode, 'reuse');
  assert.equal(decision.result, '直接复用');
});

test('换发版但报名表与帮助层版号相同，只做边界复核', () => {
  const prior = previousRun('1', 'W3', 'H1');
  const release = { district: { community: 'W3', work: 'W3', help: 'H1' }, kiosk: { community: 'W3', work: 'W3', help: 'H1' } };
  const decision = reuseDecision(prior, plan('kiosk', 'work'), release, '2');
  assert.equal(decision.mode, 'boundary');
  assert.match(decision.reason, /组件版号相同/);
});

test('帮助层变化时旧帮助结论作废，但仍可只复核组件边界', () => {
  const prior = previousRun('1', 'W3', 'H1');
  const release = { district: { community: 'C4', work: 'W3', help: 'H2' }, kiosk: { community: 'C4', work: 'W3', help: 'H2' } };
  const decision = reuseDecision(prior, plan('district', 'work'), release, '2');
  assert.equal(decision.mode, 'boundary');
  assert.match(decision.result, /帮助层须重建/);
});

test('报名表与帮助层都变化时旧证据失效', () => {
  const prior = previousRun('1', 'C3', 'H1');
  const release = { district: { community: 'C4', work: 'W3', help: 'H2' }, kiosk: { community: 'C4', work: 'W3', help: 'H2' } };
  const decision = reuseDecision(prior, plan('district', 'community'), release, '2');
  assert.equal(decision.mode, 'full');
  assert.equal(decision.result, '旧证据失效');
});

test('人工接待分支没有组件版号，换发版必须重新确认', () => {
  const prior = previousRun('1', 'C3', 'H1');
  const release = { district: { community: 'C3', work: 'W3', help: 'H1' }, kiosk: { community: 'C3', work: 'W3', help: 'H1' } };
  const decision = reuseDecision(prior, plan('district', 'desk'), release, '2');
  assert.equal(decision.mode, 'full');
  assert.equal(decision.result, '重新确认人工接待终点');
});

test('没有旧证据时不冒充复用', () => {
  const decision = reuseDecision(null, plan('district', 'community'), { district: { community: 'C3', help: 'H1' } }, '1');
  assert.equal(decision.mode, 'full');
  assert.equal(decision.result, '无可复用证据');
  assert.equal(decision.previous, undefined);
});

test('复用摘要把失效与需重新确认分开统计', () => {
  const prior = previousRun('1', 'C3', 'H1');
  const release = { district: { community: 'C4', work: 'C3', help: 'H2' }, kiosk: { community: 'C4', work: 'C3', help: 'H2' } };
  const decisions = [
    reuseDecision(prior, plan('district', 'community'), release, '2'),
    reuseDecision(prior, plan('district', 'work'), release, '2'),
    reuseDecision(prior, plan('district', 'desk'), release, '2'),
  ];
  const summary = reuseSummary(decisions);
  assert.equal(summary.invalidated.length, 1);
  assert.equal(summary.reconfirmed.length, 1);
  assert.equal(summary.validated.length, 1);
  assert.equal(summary.reused.length, 0);
});

test('演练阶段到发版的映射固定', () => {
  assert.deepEqual(STAGE_REVISION, { initial: '1', release2: '2' });
});
