import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startSources } from '../sources/server.mjs';

test('Chromium 可通过日常操作使用演练来源', async () => {
  const source = await startSources();
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const tab = await context.newPage();

    await tab.goto(source.url + '/signup/district');
    await tab.getByRole('combobox', { name: '场景' }).focus();
    await tab.keyboard.press('ArrowDown');
    assert.equal(await tab.getByRole('heading', { name: '活动报名表' }).count(), 1);
    await tab.getByRole('textbox', { name: '联系号码' }).fill('000');
    await tab.keyboard.press('Tab');
    assert.equal(await tab.locator(':focus').textContent(), '填写帮助');
    await tab.keyboard.press('Enter');
    assert.equal(await tab.locator(':focus').textContent(), '关闭帮助');
    await tab.keyboard.press('Escape');
    await tab.getByRole('button', { name: '回到选择' }).click();
    await tab.keyboard.press('ArrowDown');
    assert.equal(await tab.getByRole('textbox', { name: '联系号码' }).inputValue(), '000');
    await context.request.post(source.url + '/scenario/release2');
    await tab.reload();
    await tab.getByRole('combobox').selectOption('work');
    await tab.getByRole('button', { name: '填写帮助' }).focus();
    await tab.keyboard.press('Enter');
    assert.equal(await tab.locator(':focus').textContent(), '帮助内容');
    assert.equal(source.calls.filter(call => call.path === '/signup/confirmed').length, 0);
  } finally {
    await browser?.close();
    await source.close();
  }
});
