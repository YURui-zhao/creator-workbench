# 达人投放工作台

一个用于管理达人投放记录的全栈应用，采用 monorepo 结构：

- `frontend/`：React 18 + Vite + Ant Design + React Router v6 + Axios + xlsx
- `backend/`：Node.js + Express + better-sqlite3 + cors
- 数据库：SQLite 文件型（`backend/workbench.db`，首次启动自动创建数据表）

## 功能列表

- 投放记录管理：新增 / 编辑 / 删除 / 分页查询
- 询档筛选：时间周期、博主类型、发布日期范围、达人昵称模糊搜索，支持多条件组合
- CPM 自动计算：CPM数据（总花费 / 次周播放量 × 1000，保留 2 位小数）
- Excel 批量导入：拖拽上传 → 逐行逐列判定 → 自动去重 → **AI 智能校验**（DeepSeek 逐条判定，可一键修正）→ 确认导入
- Excel 导出：按当前筛选条件导出全部数据（含 CPM 列，列宽自适应）
- AI 智能校验：调用 DeepSeek 对导入记录逐条判定（必填/格式/数值/业务逻辑/数据质量），支持自定义业务规则与智能补全，返回问题等级与可一键应用的修正建议
- 后端健康检查：前端启动时自动检测后端连通状态（页面右上角状态标签）

## 环境要求

- Node.js 16+（推荐 18+ 或 20/22；前端 Vite 5 要求 Node 18+，better-sqlite3 使用预编译二进制、无需本地编译工具）
- npm（随 Node.js 安装）
- 现代浏览器（Chrome / Safari 等）

> 本机没有全局 Node.js 时，可直接使用 `python3 start.py` 一键启动（脚本会自动探测便携 Node 运行时）。

## DeepSeek 接入（可选，AI 智能校验功能需要）

### 1. 获取 API Key

1. 访问 DeepSeek 开放平台 https://platform.deepseek.com ，注册并登录
2. 进入「API Keys」页面，点击「创建 API Key」
3. 复制以 `sk-` 开头的密钥（**只在创建时完整显示一次**，请立即保存）
4. 平台需充值或领取免费额度后才可以调用

### 2. 配置

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env，填入真实密钥
DEEPSEEK_API_KEY=sk-你的真实密钥
```

配置后重启后端，验证是否生效：

```bash
curl http://localhost:3001/api/ai/status
# 返回 {"code":200,"data":{"available":true,...}} 表示已生效
```

> 未配置密钥时后端会打印降级提示，AI 校验自动跳过，**不影响基础导入功能**。

### 3. AI 导入功能使用指南

1. 投放管理页 → 点击「导入Excel」→ 上传 `.xlsx` / `.xls` 文件
2. 上传前可展开「高级规则」，勾选判定规则或填写自定义自然语言条件
3. 上传后自动进入 AI 校验（显示「AI正在判定数据...」加载动画）
4. 校验完成后展示统计（共/通过/警告/错误）与每条记录的问题、修正建议、AI修正值
5. 点击「一键修正」应用 AI 修正值 → 「确认导入」完成导入
6. 只有警告时可点「忽略警告，直接导入」；存在未修正错误时需先修正
7. 未配置 Key 或 AI 调用失败时自动降级：提示「AI校验失败，将跳过智能判定」，可直接按普通导入流程确认导入

### 4. 支持的判定规则

| 规则标识 | 说明 |
| --- | --- |
| `creator_type_cpm` | 达人类型CPM匹配（如美妆类CPM不超过50，超限标红并建议不再投放该达人） |
| `time_cycle_format` | 时间周期必须符合 `YYYY-Wxx` 格式，不合法自动给出修正值 |
| `duplicate_check` | 相同达人昵称 + 相同发布日期判定为重复，保留首条 |
| `magnitude_check` | 播放量与总花费的量级商业逻辑合理性 |
| `platform_link_match` | 从链接识别平台（抖音/小红书/B站等）并与博主类型匹配 |

自定义规则示例（每行一条，自然语言，优先级最高）：

```text
美妆类达人CPM不应超过50，超过则标红提示
总花费超过10万的记录需要重点审核
```

智能补全（始终开启）：根据昵称推测博主类型、从链接提取平台信息、自动修正日期/数字格式，结果写入 `corrected` 字段，可一键应用。

### 5. 常见问题

- **API 调用失败**：先访问 `/api/ai/status` 确认 Key 已生效；检查网络能否访问 `api.deepseek.com`；前端会自动降级为普通导入，基础功能不受影响
- **额度不足**：DeepSeek 返回余额不足/402 时接口会给出友好提示；请到开放平台充值或领取免费额度后重试
- **请求超时**：单批校验上限 1000 条，超时后可减少单批数量或稍后重试（前端提供「重试AI校验」按钮）
- **校验结果不准确**：可在「高级规则」中补充自定义自然语言条件细化判定
- **页面提示「AI未配置」**：右上角状态标签显示 AI 服务状态，配置 Key 并重启后端后自动变为「AI已就绪」

## 安装依赖

```bash
npm run install:all
```

该命令等价于依次执行：

```bash
npm install
npm install --prefix frontend
npm install --prefix backend
```

## 启动

### 方式一：npm 脚本（推荐）

```bash
npm run dev       # 同时启动前后端（Ctrl+C 停止）
npm run server    # 只启动后端（端口 3001）
npm run client    # 只启动前端（端口 5173）
```

### 方式二：一键脚本

```bash
python3 start.py  # 同时启动前后端，Ctrl+C 停止
```

## 访问地址

- 前端页面：http://localhost:5173/records
- 后端健康检查：http://localhost:3001/api/health
- 前端已通过 Vite 代理将 `/api` 请求转发到后端 3001，浏览器直接访问 5173 即可

## Excel 导入模板说明

点击「导入Excel」上传 `.xlsx` / `.xls` 文件。**表头必须使用下表列名**（列顺序不限，多余列会被忽略；同时兼容英文列名，如 `time_cycle`）：

| Excel 列名 | 数据库字段 | 必填 | 说明 |
| --- | --- | --- | --- |
| 时间周期 | time_cycle | 是 | 如 2024-W30 |
| 达人昵称 | nickname | 是 | 文本 |
| 达人主页 | homepage | 否 | 链接 |
| 博主类型 | creator_type | 否 | 文本 |
| 植入内容链接 | content_link | 否 | 链接 |
| 总花费 | total_cost | 是 | 数字（元） |
| 发布日期 | publish_date | 是 | YYYY-MM-DD |
| 视频发布链接 | video_link | 否 | 链接 |
| 首发播放量 | first_play | 否 | 非负整数 |
| 次周播放量 | second_week_play | 否 | 非负整数 |

示例行：

| 时间周期 | 达人昵称 | 博主类型 | 总花费 | 发布日期 | 首发播放量 | 次周播放量 |
| --- | --- | --- | --- | --- | --- | --- |
| 2024-W30 | 张三 | 数码 | 5000 | 2024-07-22 | 82000 | 135000 |

说明：

- 日期兼容 `2024-07-22`、`2024/7/22`、`2024.7.22` 及 Excel 日期序列号，导入时自动归一化为 `YYYY-MM-DD`
- 上传后先预览前 5 条并做行级校验，必填缺失/格式错误的行会显示**具体行号与原因**，确认后仅导入通过校验的行
- 逐行逐列判定：读取表格时每个单元格按所属列规则清洗与校验，无效单元格在预览表中标红并悬浮显示原因：
  - 金额：自动去掉货币符号、千分位（如 `¥5,000` → `5000`）
  - 播放量：支持千分位与 `x.x万` 写法（如 `8.2万` → `82000`）
  - 链接：无协议但形如域名时自动补全 `https://`（如 `www.example.com` → `https://www.example.com`）
  - 时间周期：格式如 `2024-W30`，自动统一大小写（`2024-w3` → `2024-W3`）
  - 日期：兼容 `2024-07-22`、`2024/7/22`、`2024.7.22` 及 Excel 日期序列号，自动归一化为 `YYYY-MM-DD`
  - 任一单元格无效则该行判定为无效数据，导入时剔除
- 自动去重：按「时间周期、达人昵称、博主类型、达人主页、植入链接、视频链接、总花费、首发播放量、次周播放量、发布日期」判定，与库中已有记录重复或文件内重复的行会被标记为无效并跳过，只保留有效数据导入
- 单次批量导入上限 1000 条
- 想快速生成模板：先在页面点「导出Excel」，导出的文件可直接作为导入模板

## 常见问题排查

### 1. 端口被占用（启动报 EADDRINUSE 或页面打不开）

```bash
lsof -i :3001   # 查看占用后端端口的进程
lsof -i :5173   # 查看占用前端端口的进程
kill -9 <PID>
```

也可换端口启动后端：`PORT=3002 npm run server`（此时需同步修改 `frontend/vite.config.js` 中的代理目标）。

### 2. 依赖安装失败

- 网络问题：`npm config get registry` 查看源，可切换镜像 `npm config set registry https://registry.npmmirror.com` 后重试
- 缓存问题：执行 `npm cache clean --force` 后重新 `npm run install:all`
- better-sqlite3 是原生模块，安装时自动下载预编译二进制；失败通常是因为 Node 版本过旧或网络受限，升级到 Node 18+ 后重试
- 权限问题（EPERM）：检查 npm 缓存目录权限，或指定临时缓存 `npm_config_cache=/tmp/npm-cache npm install`

### 3. 页面提示「网络异常 / 后端服务连接失败」

- 确认后端已启动：浏览器访问 http://localhost:3001/api/health，应返回 `{"status":"ok",...}`
- 前端页面右上角有「后端已连接 / 后端未连接」状态标签，可快速判断连通性
- 两个服务需要同时运行：`npm run dev`

### 4. 浏览器打开页面空白

- 确认访问的是 Vite 开发服务器 http://localhost:5173，而不是直接双击 `index.html`
- 强制刷新（Cmd+Shift+R）清除旧缓存

## 后端接口一览

统一响应格式：`{ code: 200, data, msg: 'success' }`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含数据库连通性） |
| GET | `/api/records` | 分页查询（page / pageSize / weekCode、timeCycle 周码 / cycleStart、cycleEnd 周期日期范围重叠筛选（可只传一端）/ creatorType / keyword / publishDate 发布日期精确（兼容 date）/ startDate、endDate 区间兼容） |
| GET | `/api/records/cycles` | 时间周期选项（含 weekCode、startDate、endDate、label，时间计算由后端统一处理） |
| GET | `/api/records/time-cycles` | 时间周期选项（去重，历史兼容接口） |
| GET | `/api/cycles/list` | 指定年份（默认 2026）全年自然周列表（按时间倒序，新增/编辑弹窗周选择使用） |
| GET | `/api/records/:id` | 单条详情 |
| POST | `/api/records` | 新增记录 |
| PUT | `/api/records/:id` | 更新记录 |
| DELETE | `/api/records/:id` | 删除记录 |
| POST | `/api/records/batch` | 批量导入 |
| GET | `/api/ai/status` | AI 服务状态（是否已配置 DeepSeek Key） |
| POST | `/api/ai/validate-records` | AI 智能校验（DeepSeek，入参 `{ records: Array, rules?: Array<string> }`，单次上限 1000 条） |

### 高级规则（AI 智能校验可选）

导入弹窗的「高级规则」面板可勾选内置规则或输入自然语言自定义条件，随请求传给后端：

- `creator_type_cpm`：达人类型CPM匹配（如美妆类CPM不超过50，超限标红并建议不再投放该达人）
- `time_cycle_format`：时间周期必须符合 `YYYY-Wxx` 格式
- `duplicate_check`：相同达人昵称 + 相同发布日期判定为重复
- `magnitude_check`：播放量与总花费的量级商业逻辑合理性
- `platform_link_match`：从链接识别平台（抖音/小红书/B站等）并与博主类型匹配

自定义条件示例（每行一条，自然语言）：

```text
美妆类达人CPM不应超过50，超过则标红提示
总花费超过10万的记录需要重点审核
```

智能补全（始终开启）：根据昵称推测博主类型、从链接提取平台、自动修正日期/数字格式，结果写入 `corrected` 字段，可一键应用。

## 时间周期规则

- 存储格式：`time_cycle` 统一为 `YYYY-Wxx`（如 `2026-W32`），数据库结构未改动
- 周规则：每周从**周一**到**周日**；每年第 1 周从当年**第一个周一**开始（如 2026-W01 = 01/05-01/11）
- 默认业务年份：2026，可通过环境变量修改：`BUSINESS_YEAR=2027 npm run server`
- 时间计算统一在后端完成（`backend/utils/dateCycle.js`），前端只负责展示
- `/api/records/cycles` 返回每个周期的 `weekCode`、`startDate`、`endDate` 和 `label`（如 `08/10-08/16`）
- 查询接口支持 `weekCode` 筛选（兼容旧的 `timeCycle` 参数），周码未补零时自动归一化（`2026-W5` → `2026-W05`）
- 前端展示统一为月日区间：筛选下拉、表格列、新增/编辑弹窗均显示 `08/10-08/16`，表格列悬浮显示完整周数（如 `2026年第32周 08/10-08/16`）
- Excel 导入支持月日区间自动识别为周码（优先匹配已有周期，未收录时按当前年份换算）；导出时间周期列为月日区间格式
