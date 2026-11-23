# 普法活动报名路径的键盘可达取证

活动安排在 `/bulletin`。同一场活动的区报名页为 `/signup/district`，街道终端用 `/signup/kiosk`。人群从页面的原生选择器进入，草稿仅存于本次打开的页面。站点公开元素的 `data-form` 和 `data-component` 是维护方声明的表单和帮助版号；它们只标识自身，不能代替所在活动、报名人群和步骤。页面顶层 `data-publication` 标为当前发版。
 
`/release` 公布清单。变更中未列出的组件也有当前的组件版号。发版发生后可以在签收报告中引用仍获维护方声明、且边界相同的既有路径证据。运行期间如果发现页面所见总版号不等于签收目标，应建立对应新版本的结果；此前的独立证据只有可追溯且组件版号与上下文仍匹配才可被引用。界面上“确认报名”为最终停止点，工作人员可选区报名或自助终端模式。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。本机浏览器依赖由 Playwright 1.56.1 提供，可在首次准备时执行 `npx playwright install chromium`。容器方式可先执行 `docker build -t keyboard-access-sources .`，再执行 `docker run --rm keyboard-access-sources`。镜像准备完成后的验证不需要外网。

## 键盘可达取证

`tools/keyboard-audit.mjs` 会在本地启动演练来源和自己的 Chromium，只导航到 `/signup/district`、`/signup/kiosk` 这两个公开入口，之后全部用键盘操作（Tab / Shift+Tab / Home / 方向键 / Enter / Escape / 字符输入）。它只把焦点移到“确认报名”上，从不按下，也不请求 `/signup/confirmed`。

```bash
npm run audit                      # 发版 1，产出 reports/rev1-*.report.md 与同名 .evidence.json
npm run audit:release2             # 发版 2，按发版记录重新取证
node tools/keyboard-audit.mjs --stage release2 --prior reports/<发版1>.evidence.json
node tools/keyboard-audit.mjs --stage initial --drift-at 40   # 演练取证中途发版
```

- 证据 JSON 记录每个状态的指纹、焦点、可访问名称、控件、按键序列与来源请求；报告是可直接交给维护方的中文说明。
- 去重按“发版 + 模式 + 阶段 + 人群 + 报名表版号 + 帮助层版号 + 帮助层开合 + 预览 + 草稿 + 保留草稿 + 人工接待提示 + 焦点 + 可见文本”计算，外观相同但保留不同人群/草稿的页面不会合并。
- 每完成一个关键动作都会重读 `/release` 并核对 `main[data-publication]`；不一致立即停止并把报告标为不可签收。传 `--drift-at N` 可在第 N 次按键前切换阶段来演练这一点，工具会自动续采新版本并在结论里注明旧报告仅供追溯。
- `--prior` 只在同一发布、模式与页面状态仍可证明时复用旧证据：组件版号未变才做边界复核，报名表或帮助层任一变化都重建结论；人工接待分支没有组件边界，换发版必须重新确认。
- 报告把“页面文本确实没读到”“键盘路径进不到”“当前资料不足以判断”分开列出，并为每条问题给出发生前最后可达状态、按键、当时可访问名称、焦点去向和同一报名表其它人群/终端的对照。
