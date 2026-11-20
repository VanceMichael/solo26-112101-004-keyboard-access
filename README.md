# 普法活动报名路径的键盘可达取证

活动安排在 `/bulletin`。同一场活动的区报名页为 `/signup/district`，街道终端用 `/signup/kiosk`。人群从页面的原生选择器进入，草稿仅存于本次打开的页面。站点公开元素的 `data-form` 和 `data-component` 是维护方声明的表单和帮助版号；它们只标识自身，不能代替所在活动、报名人群和步骤。页面顶层 `data-publication` 标为当前发版。
 
`/release` 公布清单。变更中未列出的组件也有当前的组件版号。发版发生后可以在签收报告中引用仍获维护方声明、且边界相同的既有路径证据。运行期间如果发现页面所见总版号不等于签收目标，应建立对应新版本的结果；此前的独立证据只有可追溯且组件版号与上下文仍匹配才可被引用。界面上“确认报名”为最终停止点，工作人员可选区报名或自助终端模式。

## 本地来源

资料均为合成记录。Node.js 22 环境下执行 `npm ci`，再用 `npm run sources` 启动，默认监听 `127.0.0.1:4180`。可用环境变量 `PORT` 修改端口。在容器中运行时，服务和访问端处于同一网络命名空间。

`data/sources.json` 保存原始报文及站点页面。连续响应由来源按同一进程内的观察次数提供。阶段从 `initial` 启动，本地演练人员可用 `POST /scenario/阶段名` 切换，未覆盖的路由延用初始响应。切换不清空来源的请求记录。重开服务会复位。

执行 `npm test` 核对来源契约。本机浏览器依赖由 Playwright 1.56.1 提供，可在首次准备时执行 `npx playwright install chromium`。容器方式可先执行 `docker build -t keyboard-access-sources .`，再执行 `docker run --rm keyboard-access-sources`。镜像准备完成后的验证不需要外网。
