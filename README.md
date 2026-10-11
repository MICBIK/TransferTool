# TransferTool

面向 new-api 站长的上游管理面板：定时刷新上游（new-api / sub2api）余额、低余额邮件提醒、本站渠道与分组聚合、基于日志的渠道健康看板、渠道启停。

单用户、自部署：一个 Docker 镜像、一个 Node.js 22 进程、一个 SQLite 文件，不依赖 PostgreSQL / Redis。

> 当前进度：阶段 1（骨架与登录）。上游余额、本站渠道、健康看板见 [docs/PLAN.md](docs/PLAN.md) 中的后续阶段。

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
    adapters/      上游适配器（阶段 2）
    jobs/          进程内调度与定时任务（阶段 2+）
    routes/        HTTP 路由
    services/      业务逻辑（加密、密码、登录、验证码、邮件、设置…）
    middleware/    鉴权等中间件
    db/            schema 与数据库连接/迁移
  drizzle/         drizzle-kit 生成的迁移
  test/            vitest 测试
web/               前端（Vue 3 + Vite + Naive UI）
docs/PLAN.md       完整规格与分阶段计划
```
