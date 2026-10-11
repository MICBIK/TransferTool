# TransferTool 规格说明（开发依据）

面向 new-api 站长的单用户自部署面板。UI 文案全部中文。

## 已定决策
- 只做自部署：一个 Docker 镜像、一个 Node.js 22 进程、一个 SQLite 文件。不依赖 PostgreSQL/Redis。不做 Cloudflare 版本。
- 后端：Hono（@hono/node-server）+ TypeScript。数据库：better-sqlite3 + Drizzle ORM（drizzle-kit 生成迁移，启动时自动迁移）。
- 前端：Vue 3 + Vite + TypeScript，打包后由后端同进程以静态文件提供（SPA 回退到 index.html）。UI 库可选 Naive UI 或 Element Plus（二选一，保持轻量）。
- 单仓库结构建议：`server/`、`web/`、根目录 `package.json`（npm workspaces）、`Dockerfile`、`docker-compose.yml`、`.env.example`。
- 监听端口 3000。部署域名 tools.tzcode.top，由站长自己的 Nginx/Caddy 反代（HTTPS 在反代层）。
- 测试：vitest。每个阶段必须通过 `npm run typecheck`、`npm test`、`npm run build`，并且 `docker build .` 成功。
- CI：`.github/workflows/ci.yml`，在 push 和 pull_request 上跑 typecheck、test、build、docker build。
- 本站 new-api 只接一个（表结构带 site_id 预留多站，但 UI 只做一个）。
- 余额归零自动停该上游全部渠道：实现，但设置默认关闭。
- sub2api 没有订阅制分组：只处理 `unrestricted`（钱包余额）和 `quota_limited`（Key 限额）；返回里有 `subscription` 字段时显示“暂不支持订阅制”，不触发提醒。
- 金额统一按美元存储。
- 不做：自动填表登录上游、渠道异常类告警、Webhook、其他上游程序适配、多用户、注册。

## 环境变量（.env）
- `PORT`（默认 3000）
- `DATA_DIR`（默认 `/data`，SQLite 文件放这里）
- `ENCRYPTION_KEY`（必填，32 字节 base64；用于 AES-256-GCM 加密敏感字段。缺失时启动报错退出）
- `SESSION_SECRET`（必填，签名会话 Cookie）
- `ADMIN_PASSWORD`（初始密码；首次启动若库里没有密码哈希则用它初始化）
- `EMERGENCY_PASSWORD`（可选；SMTP 坏了时的兜底登录密码）
- `COOKIE_SECURE`（默认 true；本机调试可设 false）
- `TZ`

## 阶段 1：骨架与登录
- 项目结构、workspaces、lint/typecheck/test/build 脚本、Dockerfile（多阶段构建，最终镜像只含运行所需）、docker-compose.yml（挂载 `./data:/data`，env_file）、.env.example、CI。
- 把本规格复制到 `docs/PLAN.md`。README 写清部署步骤（含 Nginx 与 Caddy 反代 tools.tzcode.top → 127.0.0.1:3000 的示例）。
- 数据库与迁移；表：`settings`（键值，敏感值加密）、`auth`（密码哈希、会话版本号）、`login_codes`（验证码哈希、过期时间、已用标记）、`login_attempts`（按 IP 计数/锁定）、`audit_log`（敏感字段解密访问等）。
- 加密工具：AES-256-GCM，`enc:v1:<iv>:<ciphertext+tag>` 格式，单元测试覆盖。
- 密码哈希：PBKDF2-SHA256（≥210000 次迭代）或 scrypt，常量时间比较。
- 登录方式设置：`password` / `email_code` / `both`（默认 `password`，配好 SMTP 后才能切到含验证码的方式）。
- 邮件验证码：6 位数字，有效 5 分钟，一次性，只存哈希；收件人固定为设置里的站长邮箱，登录页不允许输入邮箱；同一时间 60 秒内只能发一次、每小时最多 5 次。
- 防暴力：同一 IP 连续失败 5 次锁 15 分钟（密码与验证码都计）。
- 会话：HttpOnly、SameSite=Strict、Secure（受 COOKIE_SECURE 控制）的签名 Cookie，7 天有效；改密码时会话版本号 +1 使旧会话全部失效。
- 紧急密码：配置了 `EMERGENCY_PASSWORD` 时始终可用密码方式登录。
- SMTP：设置页可配 host/port/secure/user/pass/from、站长邮箱；“发送测试邮件”按钮。用 nodemailer。SMTP 密码加密存储。
- 前端：登录页（密码 / 获取验证码）、布局（侧边导航：总览、渠道、设置；总览与渠道先放占位）、设置页（修改密码、登录方式、SMTP、站长邮箱）。
- 除登录相关接口外所有 `/api/*` 需登录。

## 阶段 2：上游余额与提醒
- 表 `upstreams`：名称、类型（`newapi`/`sub2api`）、站点地址、匹配域名（多个）、充值页地址（newapi 默认 `<站点>/console/topup`）、阈值、紧急阈值（可空）、刷新间隔（分钟，默认 10）、汇率系数（默认 1）、启用开关、备注；加密字段：凭证（newapi 访问令牌 / sub2api API Key）、newapi 用户 ID、账号、密码。
- 表 `balance_snapshots`：upstream_id、时间、余额（USD，可空）、模式、成功与否、错误信息、原始额度字段。
- 表 `alerts`：upstream_id、状态（normal/low/critical）、上次发送时间、上次结果。
- 适配器接口 `fetchBalance(upstream) -> { ok, balanceUsd?, mode, raw?, error? }`：
  - **new-api**：`GET <站点>/api/user/self`。请求头同时带 `Authorization: Bearer <令牌>` 和 `New-Api-User: <用户ID>`；若返回 401/403 再用旧写法 `Authorization: <令牌>`（不带 Bearer）+ `New-Api-User` 重试一次。成功响应 `{ success: true, data: { quota, used_quota, ... } }`。`quota` 是内部额度，换算：先 `GET <站点>/api/status` 取 `data.quota_per_unit`（缺省 500000），余额 USD = quota / quota_per_unit，再乘汇率系数。`quota_per_unit` 缓存 24 小时。错误码 `ACCESS_TOKEN_LEGACY_RETIRED` 时提示“旧版访问令牌已失效，请到上游重新生成”。`success: false` 时取 `message`。
  - **sub2api**：`GET <站点>/v1/usage`，`Authorization: Bearer <API Key>`。`mode === 'unrestricted'` 且有 `balance` → 余额 USD = balance；`mode === 'quota_limited'` → 取响应里该 Key 的剩余额度字段（以实际响应为准，解析时容错：remaining / quota_remaining 等，取不到则标为未知），并在 UI 注明“这是 Key 限额，不是钱包余额”；有 `subscription` 字段 → 标为“暂不支持订阅制”。
  - 所有请求超时 10 秒，User-Agent 标识 TransferTool。
- 调度器：进程内，每分钟检查哪些上游到期需要刷新；全局并发上限 5；连续失败 3 次标记“余额未知”（不触发低余额提醒）。启动时立即跑一次。手动“立即刷新”按钮。
- 提醒规则：
  - 余额从 ≥ 阈值变成 < 阈值：发一封；之后仍低于阈值，每 6 小时（设置可调）最多再提醒一次。
  - 紧急阈值：跌破即发，不受间隔限制（但同一状态只发一次直到状态变化）。
  - 余额回到阈值以上：状态恢复 normal，下次跌破重新提醒。
  - 同一轮刷新中多个上游跌破，合并成一封邮件。
  - 邮件内容：上游名、当前余额、阈值、预计耗尽时间（按最近 24 小时快照的下降速度估算，充值造成的上升段要剔除）、充值页链接。
  - 查询失败不算跌破。
- 余额归零自动停渠道：设置开关（默认关）；此阶段只存设置项，实际停渠道动作在阶段 3 接入。
- 快照保留 90 天，每天清理一次。
- 前端：
  - 总览页：每个上游一张卡片（余额、阈值、状态色、消耗速度 USD/天、预计可用时长、最后刷新时间与错误、“充值”按钮新标签页打开充值页、“立即刷新”），低于阈值/异常排前。
  - 上游详情页：近 7/30 天余额曲线（ECharts 或 Chart.js 任选其一）、配置编辑、账号密码掩码显示 +“复制”按钮（复制时后端解密下发并写 audit_log）。
  - 上游新增/编辑表单：保存前可“测试连接”（调用一次适配器但不落库）。
  - 敏感字段在接口返回中永远只给掩码；编辑时留空表示不修改。

## 阶段 3：本站渠道
- 设置页：本站地址、本站访问令牌（加密）、本站用户 ID（可选，旧版兼容）。“测试连接”。本站令牌建议权限：渠道读取、渠道操作、log:read。
- 请求本站的头部写法与上游 new-api 相同（Bearer + New-Api-User，失败回退旧写法）。
- 接口（本站 new-api）：
  - `GET /api/channel/?p=<页>&page_size=100` 分页拉全部渠道（响应 `data.items` 或 `data` 数组，`data.total`，两种都要兼容）。字段：id、name、type、base_url、group（逗号分隔）、status（1 启用、2 手动禁用、3 自动禁用）、priority、weight、response_time、test_time、balance、used_quota、tag。不存渠道 key。
  - 启停单个：`POST /api/channel/:id/status`，JSON body `{ "status": 1 | 2 }`（若本站版本较旧返回 404，则回退为 `PUT /api/channel/`，body `{ id, status }`）。
  - 批量：`POST /api/channel/status/batch`，body `{ ids: [...], status }`（同样有回退：逐个调用）。
  - 测试：`GET /api/channel/test/:id`。
- 表 `channels`（缓存）：site_id、channel_id、name、base_url、groups(JSON)、status、priority、weight、response_time、upstream_id（可空）、manual_upstream（是否手动指定）、synced_at。
- 每 5 分钟同步一次 + 手动同步按钮。自动归类：base_url 的主机名与上游“匹配域名”任一相等或为其子域则归属；手动指定的优先且不被自动覆盖。
- 余额归零自动停渠道：开关打开时，上游余额 ≤ 0（查询成功）→ 批量停用其“当前为启用状态”的渠道，并记录是本工具停的；余额恢复 > 0 时只恢复本工具停掉的那些渠道。所有动作写 audit_log。
- 前端：
  - 渠道页：平铺表格，按上游/分组/状态筛选，多选批量启停，单个启停开关，测试按钮，未归类渠道可手动指定上游。
  - 上游详情页加“接入的渠道与分组”区块，以及“一键停用/启用该上游全部渠道”。
  - 总览卡片显示接入渠道数（启用/总数）。

## 阶段 4：渠道健康看板
- 每 5 分钟增量拉本站日志：`GET /api/log/?p=<页>&page_size=100&type=<2|5>&start_timestamp=<上次游标>&end_timestamp=<现在>`（type 2 = 消费，5 = 错误）。游标存 settings；首次只回溯 1 小时；单轮最多拉 50 页，超出下轮继续。响应兼容 `data.items` / `data`。日志字段：created_at、type、channel（或 channel_id）、use_time、content（错误信息）、model_name、quota。
- 只存聚合，不存原始日志。表 `channel_stats`：channel_id、bucket_start（5 分钟对齐）、requests、errors、total_use_time、error_samples(JSON，Top 5 错误信息及次数，信息截断 200 字符)。保留 30 天。
- 状态判定（阈值在设置里可调）：近 1 小时成功率 ≥ 95% 正常；80%–95% 降级；< 80% 或 30 分钟内有请求但无成功 → 异常；无请求 → 空闲。
- 提示：若长时间只有消费日志没有任何错误日志，在看板上提示“请确认本站已开启错误日志记录”。
- 前端：
  - 渠道页增加健康列（状态色、近 1h/24h 成功率、平均耗时、最近成功时间）。
  - 上游详情页：每个渠道的成功率趋势小图与错误 Top 5。
  - 总览卡片：该上游渠道整体健康状态。
  - 预计耗尽时间同时显示在总览与邮件中（阶段 2 已实现，确认展示一致）。

## 通用要求
- 代码风格统一，模块划分清晰（adapters/、jobs/、routes/、db/、services/）。
- 外部请求都封装在可注入 fetch 的客户端里，单元测试用假的 fetch 覆盖：new-api 适配器（Bearer 成功、回退旧写法、额度换算、LEGACY_RETIRED）、sub2api 适配器（三种 mode）、提醒状态机（跌破/间隔/紧急/恢复/合并/失败不算跌破）、渠道归类、自动停/恢复只动本工具停的渠道、日志聚合与状态判定、验证码/锁定逻辑。
- 不要把任何真实凭证写进仓库。
