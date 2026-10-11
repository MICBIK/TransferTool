# TransferTool

面向 new-api 站长的上游管理面板：定时刷新上游（new-api / sub2api）余额、低余额邮件提醒、本站渠道与分组聚合、基于日志的渠道健康看板、渠道启停。

单用户、自部署：一个 Docker 镜像、一个 Node.js 22 进程、一个 SQLite 文件，不依赖 PostgreSQL / Redis。

> 当前进度：阶段 3（本站渠道）。渠道健康看板见 [docs/PLAN.md](docs/PLAN.md) 中的后续阶段。

## 部署（Docker Compose）

```bash
git clone <本仓库地址> TransferTool && cd TransferTool

# 1. 准备配置
cp .env.example .env
#    编辑 .env，至少填写 ENCRYPTION_KEY、SESSION_SECRET、ADMIN_PASSWORD
openssl rand -base64 32   # 用于 ENCRYPTION_KEY
openssl rand -base64 48   # 用于 SESSION_SECRET

# 2. 数据目录（容器内以 uid 1000 的 node 用户运行）
mkdir -p data && chown 1000:1000 data

# 3. 构建并启动
docker compose up -d --build
docker compose logs -f
```

服务监听容器内 3000 端口，`docker-compose.yml` 默认只绑定到宿主机 `127.0.0.1:3000`，由反代对外提供 HTTPS。首次启动会用 `ADMIN_PASSWORD` 初始化管理员密码；登录后请在“设置”页修改，之后 `.env` 里的 `ADMIN_PASSWORD` 不再生效。

> **务必备份 `ENCRYPTION_KEY` 和 `data/` 目录。** SMTP 密码等敏感设置用 `ENCRYPTION_KEY` 加密后存放在 `data/transfertool.db` 中，密钥丢失或更换后这些内容无法解密，需要重新填写。

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `3000` |
| `DATA_DIR` | SQLite 文件目录 | `/data` |
| `ENCRYPTION_KEY` | **必填**。32 字节 base64，AES-256-GCM 加密敏感字段；缺失时启动失败 | — |
| `SESSION_SECRET` | **必填**。至少 32 字符，签名会话 Cookie | — |
| `ADMIN_PASSWORD` | 初始管理员密码（库里还没有密码哈希时使用） | — |
| `EMERGENCY_PASSWORD` | 可选。SMTP 故障时的兜底登录密码，配置后始终可用密码登录 | — |
| `COOKIE_SECURE` | 会话 Cookie 是否带 `Secure`；HTTPS 反代下保持 `true`，仅本机 http 调试时设 `false` | `true` |
| `TRUST_PROXY` | 是否信任反代的 `X-Forwarded-For` 来识别客户端 IP（登录失败按 IP 锁定）；直接暴露端口时必须设为 `false` | `true` |
| `TZ` | 时区 | — |

### 反向代理：tools.tzcode.top → 127.0.0.1:3000

HTTPS 由反代层负责。两种写法任选其一，请求头里的 `Host` 与客户端 IP 都需要透传。

**Nginx**

```nginx
server {
    listen 80;
    server_name tools.tzcode.top;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tools.tzcode.top;

    ssl_certificate     /etc/letsencrypt/live/tools.tzcode.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tools.tzcode.top/privkey.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Caddy**（自动申请并续期证书）

```caddyfile
tools.tzcode.top {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

## 上游余额与提醒

登录后在“总览”页点“添加上游”，支持两种上游：

| 类型 | 需要填写 | 余额来源 |
| --- | --- | --- |
| new-api | 站点地址、访问令牌、用户 ID（`New-Api-User`） | `GET /api/user/self`，按 `GET /api/status` 的 `quota_per_unit`（缺省 500000，缓存 24 小时）换算为美元，再乘汇率系数。优先用 `Authorization: Bearer`，被 401/403 拒绝时自动回退旧写法（令牌直接放 `Authorization`） |
| sub2api | 站点地址、API Key | `GET /v1/usage`：`unrestricted` 为钱包余额；`quota_limited` 为 **Key 限额**（界面会注明“不是钱包余额”）；响应带 `subscription` 字段显示“暂不支持订阅制”，不触发提醒 |

- 站点地址只接受 `http`/`https`，自动去掉尾部斜杠。所有上游请求 10 秒超时，**不会跟随重定向**（避免凭证被带到别的主机；遇到 301/302 请把站点地址改成最终地址）。
- 访问令牌 / API Key、用户 ID、账号、密码都用 `ENCRYPTION_KEY` 加密存储，接口永远只返回掩码；编辑时留空表示不修改。详情页的“复制”按钮会由后端解密下发并写入 `audit_log`。修改站点域名时必须同时重新填写凭证。
- 表单里的“测试连接”只调用一次上游接口，不保存任何数据。
- **调度**：进程内定时器，每分钟检查哪些上游到期（每个上游有自己的刷新间隔，默认 10 分钟）；启动时立即刷新一次；全局并发上限 5；连续 3 次失败标记“余额未知”（不会触发低余额提醒）；可在页面上“立即刷新”。余额快照保留 90 天，每天清理一次。
- **提醒规则**（邮件发到“站长邮箱”，需先在设置页配好并验证 SMTP）：
  - 余额从 ≥ 阈值跌到 < 阈值时发一封；之后仍低于阈值，每隔“重复提醒间隔”（默认 6 小时）最多再发一次；
  - 跌破紧急阈值立即发送，不受间隔限制，同一状态只发一次；
  - 回到阈值以上恢复正常，下次跌破重新提醒；
  - 查询失败不算跌破；同一轮刷新里多个上游跌破合并成一封邮件；
  - 邮件发送失败时不会丢提醒，下次刷新会重试；
  - 邮件与总览页都会给出消耗速度（按最近 24 小时快照估算，充值造成的余额上升段会被剔除）和预计耗尽时间。

### 设置项

| 位置 | 设置 | 默认 |
| --- | --- | --- |
| 设置页 → 余额提醒 | 重复提醒间隔（小时，1–168） | 6 |
| 设置页 → 余额提醒 | 余额归零自动停渠道开关 | 关闭（见下方“本站渠道”） |
| 设置页 → 本站连接 | 本站地址、访问令牌（加密）、用户 ID（可选，加密） | 未配置 |
| 每个上游 | 提醒阈值、紧急阈值（可空，须小于提醒阈值）、刷新间隔（分钟）、汇率系数、充值页地址（new-api 默认 `<站点>/console/topup`）、匹配域名、启用开关、备注 | 间隔 10 分钟，汇率 1 |

## 本站渠道

在“设置”页的“本站（new-api）连接”填写本站地址和访问令牌（用户 ID 仅旧版本站需要），点“测试连接”确认。令牌与用户 ID 同样用 `ENCRYPTION_KEY` 加密存储，接口只返回掩码。建议使用带范围的令牌，只授予：渠道读取、渠道操作、`log:read`；缺少权限时，本站返回 `ACCESS_TOKEN_SCOPE_DENIED`，界面会提示“本站令牌缺少权限：…”并带上缺少的具体权限。

- **请求写法**：与上游 new-api 相同，`Authorization: Bearer <令牌>`（配置了用户 ID 时加 `New-Api-User`），被 401/403 拒绝时用旧写法（令牌直接放 `Authorization`）重试一次；10 秒超时（渠道测试放宽到 60 秒），不跟随重定向。HTTP 200 + `success:false` 的业务错误会按失败处理并显示本站返回的消息。
- **同步**：每 5 分钟拉取一次 + “立即同步”按钮。`GET /api/channel/?p=<页>&page_size=100`，兼容 `data.items` 与 `data` 为数组两种形态，页码从 1 开始，旧版从 0 开始的会自动补读；在本站删除的渠道会从缓存中移除；同步失败时保留上次缓存。**不会请求、保存或显示渠道密钥（key）**，缓存里只有名称、地址、分组、状态、优先级、权重、响应时间等。
- **自动归类**：渠道 `base_url` 的主机名等于、或是某个上游“匹配域名”的子域，就归属该上游（多个都匹配时取最具体的）。`base_url` 为空（官方默认端点）的渠道保持未归类。在渠道页可以给任意渠道手动指定上游：手动指定优先，同步不会覆盖；点“手动 ×”可恢复自动归类。上游新增/修改匹配域名后立即重新归类。
- **启停**：单个用 `POST /api/channel/:id/status {"status":1|2}`（1 启用、2 手动禁用；3 自动禁用只读）；批量用 `POST /api/channel/status/batch {"ids":[…],"status":…}`。若本站较旧返回 404：单个回退为 `PUT /api/channel/ {"id","status"}`（只发这两个字段，**不会**先读取再整体 PUT 渠道对象；回退失败会提示“本站版本过旧，不支持单独修改状态”），批量回退为逐个调用。渠道测试用 `GET /api/channel/test/:id`。
- **页面**：
  - “渠道”页：平铺表格，可按上游/分组/状态/关键字筛选；每行启用开关、测试按钮（显示通过/未通过与耗时）、未归类渠道可直接选择上游；多选后批量启用/停用（带确认框）。
  - 上游详情页的“接入的渠道与分组”：该上游的渠道与各分组的启用数，以及“一键停用/启用全部渠道”（带确认框；一键启用只启用手动停用的渠道，本站因报错自动禁用的不动）。
  - 总览卡片显示该上游接入渠道“启用 / 总数”。
- **余额归零自动停渠道**（设置页开关，默认关闭）：某上游一次**成功**的余额刷新结果 ≤ 0（sub2api 的 Key 限额用完同样算）时，先同步一次本站，再批量停用该上游**当前为启用状态**的渠道，并把“是本工具停的”记录在数据库里；之后一次成功刷新显示余额 > 0 时，只恢复记录里**仍是手动禁用**的那些渠道（站长在此期间自己改过状态的渠道不会被动），然后清除记录。刷新失败、余额未知、订阅制一律不动作；本站不可达时本轮跳过。在面板里手动启停某渠道会接管它，不再被自动恢复。停用/恢复/失败/跳过都写入 `audit_log`（`channel.auto_disabled`、`channel.auto_restored` 等）。恢复不受开关影响：已经被本工具停掉的渠道，余额回来就会恢复。

## 登录与安全

- **登录方式**（设置页）：`仅密码`（默认）/ `仅邮件验证码` / `密码或邮件验证码`。需先配置 SMTP 与站长邮箱并“发送测试邮件”成功，才能启用含验证码的方式。
- **邮件验证码**：6 位数字，5 分钟有效，一次性，库里只存哈希；收件人固定为设置里的站长邮箱，登录页不接受输入邮箱；60 秒内只能发一次，每小时最多 5 次。
- **防暴力**：同一 IP 连续失败 5 次（密码与验证码合计）锁定 15 分钟。
- **会话**：`HttpOnly` + `SameSite=Strict`（`COOKIE_SECURE=true` 时加 `Secure`）的签名 Cookie，7 天有效；修改密码会使所有旧会话立即失效。
- **紧急密码**：配置 `EMERGENCY_PASSWORD` 后，即使登录方式为“仅邮件验证码”也能用它登录——建议启用验证码登录前先配置。
- 敏感设置（SMTP 密码等）加密存储，接口返回永远只给掩码；敏感操作写入 `audit_log`。
- 除 `/api/auth/*` 与 `/healthz` 外，所有 `/api/*` 都需要登录。

忘记密码且没有配置紧急密码时：停止容器，删除 `data/transfertool.db` 中 `auth` 表对应记录（或整个库，注意会丢失全部设置），在 `.env` 设置新的 `ADMIN_PASSWORD` 后重启。

## 本地开发

需要 Node.js 22。

```bash
npm ci
cp .env.example .env   # 开发时将 DATA_DIR 改为 ./data，COOKIE_SECURE 设为 false

# 后端（:3000）与前端（:5173，/api 代理到 :3000）
set -a; . ./.env; set +a
npm run dev:server
npm run dev:web
```

常用脚本（均在仓库根目录）：

| 命令 | 说明 |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | 后端 `tsc` + 前端 `vue-tsc` |
| `npm test` | vitest |
| `npm run build` | 构建前端（`web/dist`）与后端（`server/dist`） |
| `npm run db:generate -w server` | 修改 `server/src/db/schema.ts` 后生成迁移（启动时自动执行） |

## 目录结构

```
server/            后端（Hono + Drizzle + better-sqlite3）
  src/
    adapters/      上游适配器（new-api / sub2api）与本站渠道客户端，外部请求只经注入的 fetch
    jobs/          进程内调度器（余额刷新、本站渠道同步、快照清理）
    routes/        HTTP 路由
    services/      业务逻辑（加密、密码、登录、验证码、邮件、设置、上游、提醒状态机、渠道缓存/归类、自动停恢复…）
    middleware/    鉴权等中间件
    db/            schema 与数据库连接/迁移
  drizzle/         drizzle-kit 生成的迁移
  test/            vitest 测试
web/               前端（Vue 3 + Vite + Naive UI）
docs/PLAN.md       完整规格与分阶段计划
```
