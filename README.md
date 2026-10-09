# 新版 GMP 落地增值评估工具

> 独立于 ERP 的前后端分离 Web 应用。认证机构审核组在 ISO 13485 现场审核时，用手机/网页**极简点选**采集 GMP 落地情况，并在末次会议前生成增值评估报告。

---

## 一、能力概览

| 角色 | 核心能力 |
|------|---------|
| **组长** | 创建/编辑/归档项目；上传 **Word 版认证审核计划**（P1~P12 过程划分）或 Excel；系统按内置映射表把 ISO 13485 条款落到**新版 GMP 检查项**，再按「过程 × 审核组 × 天」拆成**过程工作包**；实时看板、报告复核导出 |
| **审核员 / 下厂组长** | **免密登录**（按姓名）；进入**过程工作台**：按「P 过程 × 天」看到自己的**工作包**，逐条走**审核关注点**（模板给的 87 条专业要点）—— 四态判定 + 现场记录 + 客观证据；同时勾选本工作包的 **GMP 检查项落地情况**（默认已落地，只取消未落实项）；**无提交按钮**，点击即存；**localStorage 弱网暂存**自动补传 |
| **管理员** | 映射表 CRUD 与导入导出；用户增删禁用与重置密码；项目归档与数据导出；操作日志 |

> **两个「层」的分工**：审核关注点回答「这条要求你现场确认了什么」（专业观察），GMP 检查项回答「新版 GMP 这条做到没有」（落地评估）。两者并列记录，互不干扰。

### 产品硬约束（已在代码中落实）
1. **无提交按钮**——四态判定点击即存；关注点的现场记录为 600ms 防抖自动保存。
2. 无人点过的条款/关注点**默认为「已落地·待核实」**，不静默丢弃；只有显式点过或填过记录才计入「已核实」。
3. 四状态**固定配色**，前端 ECharts 与后端统计共用同一组色值（`#2E7D32` / `#F9A825` / `#C62828` / `#9E9E9E`）。
4. 弱网是常态：点击先落 localStorage，再防抖批量 POST；`online` / `visibilitychange` / `beforeunload` 三重兜底补传。
5. 越权防护：审核员只能看到**本审核组**的工作包，改别组工作包返回 403。
6. 营销与表述红线：AI 提示词与报告声明均明确禁止「直接提交监管」「包通过检查」类承诺。

---

## 一·补、审核计划一键导入（组长唯一操作）

**组长只做一件事：把 Word 版认证审核计划拖进网页，点一下。** 不需要新建项目、不需要填任何字段。

系统自动完成全链路：

| 自动提取项 | 来源（实测 CMD 模板） |
|-----------|---------------------|
| **项目名 = 受审核方名称** | 表头「受审核方名称」的下一非空行 |
| 审核开始 / 结束日期 | 「审核日期：2026年10月12日 上午至2026年10月14日 下午」 |
| 认证项目编号 | 「管理体系认证项目编号：Q260917455,QY260917614」 |
| 审核组成员 | 「审核组成员」表 → 自动建免密账号 |
| 审核组 / 工作包 / 条款分派 | 按 P 过程 × 代码 × 日期时段拆分 + 映射表分派 |

**实测结果**：一份真实计划 → 1 个项目、3 个审核组、22 个工作包、125 条条款记录，全程零手工填写。

### 接口与幂等

- `POST /api/projects/quick-import`（multipart，字段名 `file`）—— 组长主路径
- **幂等**：同企业名项目已存在时自动复用并覆盖导入（先清旧工作包再灌），重复上传不会产生两个项目
- **格式限制**：仅 `.docx`。PDF 表格结构解析不可靠，接口会明确提示「请用 Word 另存为 .docx」
- 旧接口 `POST /projects/:id/plans/word` 保留，供补传/改计划使用

### 自动提取的三处易错点（已修）

1. `extractMeta` 原来只扫前 60 行 —— 但审核期间写在第 88 行，会漏。改为全量扫描
2. 企业名与「受审核方名称」表头**分行**书写，不能依赖同行相邻
3. 认证编号是 `Q` + 6~9 位数字，原正则 `/Q\d{4,6}/` 会漏；且原逻辑把整行「审核类别：…」当成了编号

---

## 一·补之二、计划格式解析规则

支持的真实格式特征：

| 计划书写法 | 解析结果 |
|------------|---------|
| `P7特殊过程确认及关键工序验证过程7.5.1、7.5.6…` | 过程码 P7 + 过程名 + 条款串 |
| `7.5.8~7.5.11` | 区间展开为 4 条 |
| `4.1（4）`、`7.5.6（8.5.1、8.5.2）` | 括号内为 **GB/T 19001（ISO 9001）** 并列条款，单独标记不参与 GMP 映射 |
| `8.3`（映射表只有 8.3.1 / 8.3.4） | 父级条款回退：按前缀聚合子项，取风险最重的一条 |
| 审核员写 `A（南京）`、`B（南通）` | 代号 A/B + 审核场所南京/南通；姓名从「审核组成员」表关联 |
| `7.5.1f）` 括号不闭合 | 笔误容错，解析为 7.5.1 |

导入后自动生成：
- **审核组**：代号即组名（A组 / B组 / C组），自动关联成员
- **过程工作包** `PlanSlot`：过程 × 组 × 场所 × 日期时段（唯一键含全部维度，故同过程同组当天可排两场）
- **工作包 → 检查项** `SlotRecord`
- **缺失项分三类告警**：`mappingGap`（映射表缺口）/ `knownNoItem`（法规确无检查项，仍不得漏审）/ `dual9001`（GB/T 19001，不告警）
- **账号兜底**：组内审核员在系统中无账号时**自动创建免密账号**，否则工作包分派下去没人能登录

实测（基于一份 CMD 年度审核计划样本）：
```
22 个工作包 · 261 条条款明细 · 全部落到 125 个检查项
mappingGap=0   knownNoItem=4   dual9001=44   未建工作包=0
审核过程 12 个 · 审核关注点 87 条（可判定 66 · 容器 21）
```

### 同一条款被多个过程/组覆盖怎么办

这是本工具的核心业务问题：**同一个 ISO 条款会同时落进多个 P 过程**（真实计划里 2.3.1 散在 9 个过程、3 个审核组）。重复有两个来源：

| 来源 | 判定依据 | 代码字段 |
|------|----------|----------|
| **跨 P 过程** | 同一检查项被多个 `PlanSlot` 引用（`slot.processCode` 去重） | `ClauseRow.processCodes` / `refCount` |
| **跨审核组** | 同一检查项被多个 `AuditGroup` 分派 | `groupNames` / `groupCount` |

**报告口径：按检查项唯一归并。** `collectRows()` 用 `seen: Set<gmpClauseId>` 去重，多组判定按 severity（`not_landed > partial > na > landed`）取最严重值归并为一行。
**否则一条不符合会被数多次，红线统计被放大，造成误判。**

归并后保留溯源信息：
- `groupStatus[]` —— 各组各自判定，供末次会议核对
- `conflict` —— 组间判定不一致（有组判未落地、有组判已落地）**必须末次会议当面澄清**
- `dupList` —— 报告第 4 视图「重复条款」逐条披露重复分派明细

审核员端每条检查项也带黄条提示「P8、P9、P10 也审这一条 / B组也审这一条」，避免重复劳动或漏判。

---

## 一·再二、P1~P12 过程权威口径

`server/src/process-meta.ts` 是唯一依据（业务负责人口述确认）：

| 码 | 过程名（口述原话） | 审核要素 |
|----|------------------|---------|
| P1 | 领导层审核 | 内审、管理评审等相关要求 |
| P2 | 文件管理和记录管理 | 文件与记录控制 |
| P3 | 人力资源 | 人员健康档案、培训、任命等相关内容 |
| P4 | 基础设施 | 主要设施维护保养验证、工作环境控制、环境确认验证、监视测量设备计量校准、**软件确认** |
| P5 | 销售 | 售前、售中、售后相关记录 |
| P6 | 设计开发 | 设计开发过程、医疗器械文档 |
| P7 | 验证与确认 | 工艺验证与确认、关键工序验证 |
| P8 | 采购 | 供应商管理、采购相关 |
| P9 | 生产 | 生产现场控制、生产批记录追溯性、过程检验 |
| P10 | 检验环节 | 进货检验、成品检验 |
| P11 | 仓库管理 | 区域划分、产品防护、账卡物一致性 |
| P12 | 数据分析和改进 | 数据统计分析、纠正预防措施 |

**两条归属规则（勿改）**：
- **基础设施验证归 P4，不归 P7** —— P7 只管工艺验证与关键工序验证
- 每个过程带 `scopeNote`，写明审条款的落点，组间判定分歧时据此澄清

---

## 一·再三、现场核查要点（P1~P12 记录模板，辅助）

> **定位**：本工具内核是 200 条指导原则检查项的落地评估。核查要点来自 Word 记录模板，在审核员端**默认折叠**，标注「不计入报告」，仅作现场提示。

数据源为 12 份 `P1*.docx` ~ `P12*.docx` 过程记录模板，用 `npm run extract:focus` 从左侧「审核关注点」列抽取：

| 字段 | 含义 |
|------|------|
| `title` | 关注点标题（左栏加粗段） |
| `detail` | 该关注点的补充说明（左栏非加粗段） |
| `checklist` | **模板右栏「审核记录」要点清单** —— 审核员逐条核查/填写的内容（如「公司成立于 年」「部门： 人数： 负责人：」） |
| `fillable` | 是否可判定；仅整条标题为「实施评价 / 小结 / 效果评价」等收口语时才为 false |

> 一个单元格内可能有**多个**加粗关注点（如 P7 的「特殊过程确认」「关键工序验证」是两条），抽取时按加粗段落切分，因此 87 条而非 72 条。

实测落库：87 条中可判定 66 条、纯容器节点 21 条（无自身记录内容、仅作分组标题）。

---

## 二、快速启动

> **组长怎么开始**：打开 http://127.0.0.1:8780/ → 组长账号登录 → 把 Word 审核计划拖进网页 → 看到「导入成功」和系统自动读出的企业名/日期/成员 → 点「进入项目看板」。**不需要新建项目，不需要填任何字段。**
>
> **审核员/下厂组长**：免密，登录页直接点自己的姓名即可（姓名在上传计划时自动创建）。

### 方式 A：Docker 一键部署（推荐）

```bash
cd gmp-audit-tool
# 可选：配置 DeepSeek Key（不配置也能用，自动降级规则引擎）
echo "DEEPSEEK_API_KEY=sk-xxxx" > .env

docker compose up -d --build
```

访问：`http://localhost:8080`
手机访问：`http://<服务器局域网IP>:8080`（现场审核同网段直接打开）

> 数据持久化在 Docker 卷 `gmp_data`（SQLite 文件 `/data/gmp.db`）。

### 方式 B：本地开发

**环境要求**：Node.js ≥ 20、npm ≥ 10

```bash
# ---------- 后端 ----------
cd server
npm install
cp .env.example .env          # 按需修改 JWT_SECRET / DEEPSEEK_API_KEY
npm run db:push               # 建表 + 初始化种子数据（200 检查项 + 映射 + 示例项目）
npm run dev                   # http://localhost:3000

# ---------- 前端（另开一个终端）----------
cd web
npm install
npm run dev                   # http://localhost:5173，已配置 /api 代理到 :3000
```

生产构建：

```bash
cd server && npm run build && npm start   # 产物 dist/
cd web && npm run build                   # 产物 dist/，可直接丢给 Nginx
```

### 前端产物部署到 Nginx

```nginx
server {
    listen 80;
    root /var/www/gmp-audit;   # web/dist 内容放这里
    index index.html;
    client_max_body_size 20m;  # Excel 上传

    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }

    location / { try_files $uri $uri/ /index.html; }
}
```

参考配置见 `web/nginx.conf`。

---

## 三、环境变量

### 后端（`server/.env`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `file:./dev.db` | SQLite 路径。Docker 中为 `file:/data/gmp.db` |
| `PORT` | `3000` | 服务端口 |
| `JWT_SECRET` | `change-me-...` | **生产务必修改** |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `DEFAULT_ADMIN_PASSWORD` | 见 `.env` 的 `DEFAULT_ADMIN_PASSWORD` | 仅 seed 时使用的管理员初始密码 |
| `DEEPSEEK_API_KEY` | 空 | 留空则自动降级为规则引擎，功能不受影响 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | 兼容任何 OpenAI 格式接口 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `CORS_ORIGIN` | `*` | 逗号分隔；生产建议收敛 |
| `MAX_PLAN_ROWS` | `2000` | 单次 Excel 最大行数 |

### 前端

| 变量 | 说明 |
|------|------|
| `VITE_API_TARGET` | dev 模式下 `/api` 代理目标，默认 `http://localhost:3000` |

---

## 四、默认账号

| 登录名 | 姓名 | 角色 | 密码 |
|--------|------|------|------|
| `admin` | 系统管理员 | 管理员 | 见 `.env` 的 `DEFAULT_ADMIN_PASSWORD` |
| `zhangwei` | 张伟 | 组长 | `Leader@123` |
| — | 张明 / 李华 / 王芳 | 审核员 | **免密**，登录页输入姓名即可 |

> 审核员免密登录依赖姓名唯一匹配。**建议登录名与姓名保持一致**，否则审核计划无法自动分派。生产部署后请立即修改管理员与组长密码。

---

## 五、数据库初始化（种子数据）

`npm run db:push` 或 `npm run db:seed` 会写入：

1. **默认账号**：1 管理员 + 1 组长 + 3 审核员
2. **200 条 GMP 检查项**，分属 14 个章节：
   质量管理体系 22 · 管理职责 12 · 资源管理 12 · 人员与能力 14 · 设施与设备 16 · 文件与记录控制 18 · 生产与过程控制 18 · 质量控制与检验 16 · 验证与确认 18 · 委托生产与外协加工 14 · 产品实现与放行 14 · 追溯与召回 10 · 质量保证 10 · 计算机化系统与数据完整性 6
3. **全量映射表**：按 `ISO_CLAUSES` 规则为每条检查项自动建立 ISO 13485 条款归属。**一条检查项可挂多个 ISO 条款**（如「生产与过程控制」同时归属 7.5.1 / 7.5.6），否则 7.5.1、8.2.1 这类跨章节条款会分派到 0 项（远超「至少 10 条示例」要求）
4. **示例项目**：`示例医疗器械有限公司` + 14 条示例审核计划（已自动分派检查项，刻意覆盖三大重点章节）

5. **审核过程 12 个（P1..P12）+ 审核关注点 87 条**，由 `server/prisma/focus-seed.ts` 从 `focus-points.json` 写入；`focus-points.json` 可用 `npm run extract:focus` 从 12 份记录模板重新抽取

数据源文件：`server/prisma/seed-data.ts`（检查项与映射规则）、`server/focus-points.json`（审核关注点）

---

## 六、报告规则

### 状态与统计口径
- 四态：`landed` 已落地 / `partial` 部分落地 / `not_landed` 未落地 / `uncovered` 未覆盖
- **已分派但无人勾选 = 未覆盖**
- 「部分落地」**不计入不符合**，只单列占比
- 落地率 = (已落地 + 部分落地×0.5) / 总数
- 同一检查项被多人勾选时，取**更严重**的状态（未落地 > 部分落地 > 未覆盖 > 已落地）

### 红线预警（触发任一即告警）
| 维度 | 阈值 |
|------|------|
| 关键项不符合 | ≥ 3 |
| 关键 + 主要合计不符合 | ≥ 10 |
| 总不符合 | ≥ 20 |

### 报告固定结构
一、审核概况　二、红线预警　三、分章节四状态分布　四、三大重点章节专项统计　五、审核员进度　六、未落地清单　七、未覆盖清单　八、审核组结论与增值建议　九、声明

**三大重点章节单独统计**：质量保证 / 验证与确认 / 委托生产与外协加工

### 导出
- **Word**：后端 `docx` 生成（宋体正文、表格化统计、红线告警块）
- **PDF**：报告页「打印 / 存 PDF」，已内置 `@media print` 样式（避免 headless Chromium 中文与体积坑）

---

## 七、API 速览

| 方法 | 路径 | 角色 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 组长/管理员 | 账号密码登录 |
| POST | `/api/auth/login-auditor` | 审核员/下厂组长 | 免密登录（按姓名），返回参与项目 |
| GET | `/api/auth/me` | 全部 | 校验 Token |
| GET/POST | `/api/projects` | — / 组长 | 项目列表 / 新建 |
| PATCH/DELETE | `/api/projects/:id` | 组长 | 编辑 / 归档（逻辑删除） |
| POST | `/api/projects/:id/plans/word` | 组长 | **上传 Word 审核计划**，按 P 过程 × 审核组拆工作包 |
| POST | `/api/projects/:id/plans/excel` | 组长 | 旧通道：Excel 审核计划（兜底） |
| POST | `/api/projects/:id/plans` | 组长 | 手动加行 |
| DELETE | `/api/projects/:id/plans/:planId` | 组长 | 删除计划行，清理孤儿评估 |
| GET | `/api/projects/:id/board` | 组长 | 实时看板（进度/覆盖率/红线） |
| GET | `/api/projects/:id/process-slots` | 审核员 | **本人（或指定组）的过程工作包**：检查项 + 关注点 + 双进度 |
| POST | `/api/projects/:id/focus-records` | 审核员 | **批量保存关注点判定**（越权返回 403） |
| GET | `/api/processes` | 全部 | P1~P12 全量过程与关注点（模板维护用） |
| GET | `/api/assessments/my?projectId=` | 审核员 | 纯条款视图清单（备用入口） |
| POST | `/api/assessments/batch` | 审核员 | 检查项批量同步，幂等 upsert |
| GET | `/api/assessments/export?projectId=` | 组长 | 导出勾选结果 CSV |
| POST | `/api/reports/generate` | 组长 | 生成报告（`withAi` 控制是否重跑 AI） |
| GET | `/api/reports/:id` | 全部 | 报告详情 |
| PATCH | `/api/reports/:id` | 组长 | 编辑 AI 文本 / 复核确认 |
| GET | `/api/reports/:id/export.docx` | 全部 | 导出 Word |
| — | `/api/admin/*` | 管理员 | 映射表 / 用户 / 日志 / 统计 |

### 验证脚本
```bash
npm run verify:plan   # 真实 Word → 解析 → 建项目 → 分派 → 同过程多组独立性
npm run verify:slot   # 过程工作包 + 关注点写入 + 跨组留痕
npm run verify:http   # 真实 HTTP：登录 → 上传 → 取工作包 → 提交 → 越权 403（需先起服务）
```

---

## 八、目录结构

```
gmp-audit-tool/
├─ docker-compose.yml
├─ server/
│  ├─ prisma/
│  │  ├─ schema.prisma        # 16 张表（含过程/关注点/工作包）
│  │  ├─ seed-data.ts         # 200 条 GMP 检查项 + ISO 映射规则
│  │  ├─ focus-seed.ts        # ★ 由 focus-points.json 生成过程与关注点结构
│  │  ├─ seed.ts              # 初始化脚本
│  │  ├─ e2e-word.ts          # 真实 Word 端到端验证
│  │  ├─ e2e-slot.ts          # 过程工作包端到端验证
│  │  └─ http-check.ts        # 真实 HTTP 接口验证
│  ├─ extract-focus.ts        # ★ 从 P1~P12 记录模板抽取关注点
│  └─ src/
│     ├─ index.ts / config.ts / db.ts / middleware.ts / log.ts
│     ├─ plan-parser.ts       # ★ Word 审核计划解析（P 过程 × 审核组）
│     ├─ process-dispatch.ts  # ★ 解析结果落库：组/工作包/条款映射
│     ├─ dispatch.ts           # 条款级自动分派（Excel 通道）
│     ├─ report-engine.ts / ai.ts / docx.ts / types.ts
│     └─ routes/               # auth / projects / assessments / processes / reports / admin
└─ web/
   ├─ Dockerfile / nginx.conf / vite.config.ts
   └─ src/
      ├─ api.ts / types.ts / router.ts
      ├─ sync.ts                # ★ 弱网离线同步（条款/章节/关注点三队列）
      ├─ components/
      │  ├─ EChart.vue / RedlineBanner.vue
      │  ├─ FocusJudge.vue      # ★ 四态判定条
      │  └─ FocusNote.vue       # ★ 现场记录框 + 客观证据
      └─ views/
         ├─ ProcessSlotView.vue # ★ 审核员过程工作台（A 方案主界面）
         ├─ AuditorProjectView.vue # 纯条款反选视图（备用）
         └─ Login / Auditor / Leader×2 / Report / Admin
```

---

## 九、待确认事项（当前实现已按默认决策落地）

| # | 事项 | 当前默认 | 如需调整 |
|---|------|---------|---------|
| 1 | 默认密码策略 | 不强制首登改密，管理员可重置 | `server/.env` 的 `DEFAULT_ADMIN_PASSWORD` |
| 2 | 审核计划格式 | **Word（.docx）为主通道**，Excel 保留兜底 | `server/src/routes/projects.ts` |
| 2b | 审核关注点是否进入报告 | 当前**不进报告**，仅在过程工作台记录 | `server/src/docx.ts` |
| 2c | 「不适用(na)」是否强制组长审批 | 当前审核员可直接标，报告中单列 | `server/src/routes/assessments.ts` |
| 2d | 关注点与检查项是否双向联动 | 当前**并列独立**（关注点=过程观察，检查项=GMP 落地） | `server/src/routes/processes.ts` |
| 3 | 报告 PDF | 浏览器打印（非后端生成） | 引入 headless Chromium |
| 4 | 「部分落地」是否计不符合 | 不计入，单列占比 | `server/src/types.ts` |
| 5 | 200 条检查项表述 | 落地核查要点表述（非逐字引用法规） | `server/prisma/seed-data.ts` |
| 6 | 报告确认后审核员再改 | 报告自动回到「待复核」 | `server/src/routes/assessments.ts` |
| 7 | JWT 时效 | 7 天，不做刷新 | `JWT_EXPIRES_IN` |

---

## 十、已知的运维提醒

- **SQLite 单机写入**：适合审核组并发（10~20 人）场景。若要支持多机构同时使用，建议切 PostgreSQL：改 `schema.prisma` 的 `datasource.provider` 与 `DATABASE_URL`，其余代码无需改动。
- **JWT_SECRET 未修改时**：任何人拿到 Token 即可冒用，生产务必修改。
- **Docker 卷备份**：SQLite 数据在 `gmp_data` 卷中，迁移时用 `docker run --rm -v gmp_data:/data -v $(pwd):/backup alpine tar czf /backup/gmp-data.tgz /data`。
- **无版本控制**：本项目未内置 git，请自行纳入版本管理。

---

## 十一、免责声明

本工具输出为**审核辅助材料**，不构成对受审核方产品注册、体系认证或其他行政许可结果的承诺。整改建议的最终实施责任在受审核方。
