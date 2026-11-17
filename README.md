# Text2KG — 把文档变成可交互的知识图谱

上传 **PDF / DOCX / TXT** → 自动提取文本与摘要 → 由大模型抽取「实体 + 关系」→ 清洗、社区发现 → 以浅色二维力导向图交互展示，并可导出 JSON。

---

## ⚠️ 第一步：你需要自己准备一个阿里云千问 API Key

本项目的大模型能力使用 **阿里云百炼（DashScope）的通义千问 `qwen-plus`**，通过 **OpenAI 兼容接口** 调用（Python `openai` SDK）。

**仓库里不包含任何可用的 API Key**：原作者使用的个人密钥已从代码中删除，代码只从环境变量读取。下载者必须自己申请并填入，否则「上传文档生成摘要」和「生成知识图谱」都会失败（页面会给出明确报错）。

1. 打开 [阿里云百炼控制台](https://bailian.console.aliyun.com/)，开通服务并创建 API Key（形如 `sk-...`）。模型调用按量计费，请留意账户余额与免费额度。
2. 在项目根目录把 `.env.example` 复制为 `.env`。
3. 编辑 **`.env` 的第 3 行**，把占位符换成你自己的 Key。

```ini
# .env —— 第 3 行就是填写 API Key 的位置
DASHSCOPE_API_KEY=sk-你自己的APIKey
```

保存后**重启服务**，`.env` 的修改才会生效。

### API Key 位置速查（文件 + 行号）

| 文件 | 行号 | 说明 |
| --- | --- | --- |
| **`.env`（由 `.env.example` 复制而来）** | **第 3 行** | ✅ **真正填写 API Key 的地方**：`DASHSCOPE_API_KEY=sk-your-key-here` → 替换为你的 Key |
| `.env.example` | 第 3 行 | 模板占位符，供复制用；**不要**把真实 Key 写进这个会被提交的文件 |
| `.env`（若你拿到的压缩包里已存在该文件） | 第 2 行 | 直接替换 `DASHSCOPE_API_KEY=` 后的值；最稳妥的做法是在文件内搜索 `DASHSCOPE_API_KEY=` 定位 |
| `app.py` | 第 32 行 | `load_dotenv(...)` 加载项目根目录下的 `.env` |
| `app.py` | 第 195–202 行 | `_api_key()` 读取并校验 `DASHSCOPE_API_KEY`；缺失时抛出带配置说明的错误 |
| `app.py` | 第 205–214 行 | `_llm_client()` 用该 Key 与 `DASHSCOPE_BASE_URL` 创建模型客户端 |
| `app.py` | 第 58 行 | 默认模型名 `qwen-plus` 的来源 |
| `requirements.txt` | 第 6 行 | `openai>=1.0.0`，即调用兼容接口所用的 SDK |

> **不建议**把 Key 直接硬编码进 `app.py`。若确实不方便使用 `.env`，也可以只在当前终端注入环境变量：
>
> ```bash
> # macOS / Linux
> export DASHSCOPE_API_KEY=sk-你自己的APIKey
> python app.py
> ```
>
> ```powershell
> # Windows PowerShell
> $env:DASHSCOPE_API_KEY = "sk-你自己的APIKey"
> python app.py
> ```

> 💡 想先看效果但暂时没有 Key？可以点工作台的「查看示例图谱」或访问 `/graph0`，它读取的是内置示意数据 `static/demo_graph.json`，**不调用模型**，无需 API Key。

---

## 环境要求

- **Python 3.10+**（项目在 Python 3.10 上验证）
- 可访问 `dashscope.aliyuncs.com`（调用模型）；前端 JS / CSS / 图标全部本地化，**不依赖任何 CDN**
- 一个可用的阿里云百炼 API Key（见上一节）

---

## 快速开始

```bash
# 1. 获取代码
git clone <本仓库地址>
cd text2kg_WB_frontend_design   # 进入包含 app.py 的目录

# 2. 创建并激活虚拟环境
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate

# 3. 安装依赖
pip install -r requirements.txt

# 4. 创建配置并填入 API Key（.env 第 3 行）
cp .env.example .env            # Windows CMD/PowerShell: copy .env.example .env
#   然后编辑 .env 第 3 行： DASHSCOPE_API_KEY=sk-你自己的APIKey

# 5. 启动
python app.py
```

打开浏览器访问：

| 页面 | 地址 |
| --- | --- |
| 产品首页 | <http://127.0.0.1:8090/> |
| 工作台（主界面） | <http://127.0.0.1:8090/app> |
| 知识图谱（当前生成结果） | <http://127.0.0.1:8090/graph> |
| 示例图谱（示意数据，免 Key） | <http://127.0.0.1:8090/graph0> |
| 健康检查 | <http://127.0.0.1:8090/healthz> |

默认监听 `0.0.0.0:8090`（由 `app.py` 第 29 行的 `DEFAULT_PORT = 8090` 定义）。换端口：`PORT=9000 python app.py`；PowerShell 用 `$env:PORT=9000; python app.py`。`.env` 里的 `PORT` 同样生效，进程环境变量优先级更高。

---

## 使用流程

1. 打开 `/`，点「开始使用」进入 `/app`；或直接访问 `/app`。
2. 在左侧「源文件」区域上传或拖入 PDF / DOCX / TXT（默认 ≤ 20 MB）。
3. 等待解析完成，摘要会写入「文档内容」可编辑区，你可以手工修订后再生成。
4. 点「生成知识图谱」，右侧画布渲染节点与关系：拖拽平移、滚轮缩放、点击节点查看关联、搜索节点定位。
5. 点「导出图谱」下载 `knowledge_graph.json`；文件卡片可「打开文件」或「替换文件」。
6. 处理期间弹窗的「确定」只是收起提示、任务继续在后台运行；想真正中断，点左下角主按钮上的「点击取消」。

---

## 配置项

所有配置都从 `.env` 或系统环境变量读取，未写的项使用代码默认值。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 无（**必填**） | 阿里云百炼 API Key |
| `DASHSCOPE_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容端点 |
| `DASHSCOPE_MODEL` | `qwen-plus` | 摘要与图谱抽取使用的千问模型 |
| `LLM_TIMEOUT` | `120` | 单次模型请求超时（秒） |
| `LLM_MAX_RETRIES` | `2` | SDK 网络层重试次数 |
| `HOST` / `PORT` | `0.0.0.0` / `8090` | 监听地址与端口 |
| `FLASK_DEBUG` | `0` | 设为 `1` 开启调试与热重载（仅开发） |
| `SECRET_KEY` | 开发默认值 | Flask session 密钥，公开部署前请修改 |
| `MAX_CONTENT_MB` | `20` | 单文件大小上限（MB） |
| `TEXT_LIMIT` | `50000` | 送入模型的文本字符上限 |
| `PDF_MAX_PAGES` | `20` | PDF 最多解析页数 |
| `ALLOWED_EXTENSIONS` | `pdf,docx,txt` | 允许上传的扩展名 |
| `UPLOAD_FOLDER` / `LOG_LEVEL` | `uploads` / `INFO` | 上传目录与日志级别 |

---

## 目录结构（简版）

```text
├── app.py                      # Flask 服务、路由、模型调用与图谱清洗（含 API Key 读取逻辑）
├── requirements.txt            # Python 依赖
├── .env.example                # 配置模板（第 3 行为 API Key 占位符）
├── .env                        # 你的本地配置，需自行创建，已被 .gitignore 忽略
├── test_app.py                 # 22 项单元测试（不访问真实模型）
├── templates/                  # index / app / knowledge_graph / demo_graph 四个 Jinja 页面
├── static/
│   ├── css/                    # 设计系统与各页面样式
│   ├── js/                     # 工作台逻辑、Canvas 力导向图谱渲染、图标
│   ├── demo_graph.json         # 内置示例图谱（示意数据）
│   └── knowledge_graph.json    # 最近一次生成的图谱（每次生成会覆盖）
├── uploads/                    # 运行时写入的上传文件
└── logs/                       # 运行时日志与最后一次模型原始输出，便于排障
```

---

## 常见问题

| 现象 | 处理办法 |
| --- | --- |
| 上传后提示「摘要生成失败，请检查 API Key 后重试」 | `.env` 第 3 行未填 / 填错 Key；填写后**重启服务** |
| 生成图谱返回 500，错误里写着「未配置 DASHSCOPE_API_KEY」 | 同上；这正是 `app.py` 第 195–202 行给出的提示 |
| Key 无效、报鉴权失败或额度不足 | 到[百炼控制台](https://bailian.console.aliyun.com/)确认 Key 有效、模型已开通、账户未欠费；查看 `logs/` 中的具体原因 |
| 改了 `.env` 没生效 | 环境变量只在启动时读取，必须重启 `python app.py` |
| 8090 端口被占用 | 用 `PORT=9000 python app.py` 指定其它端口；`.env` 里的 `PORT` 也要一并检查 |
| 上传 PDF 后提示「未能从文件中提取到文本」 | 扫描版 / 图片型 PDF 没有文本层，请先做 OCR 或改用可复制文字的 PDF |
| 想换成其它千问模型 | 修改 `.env` 第 5 行 `DASHSCOPE_MODEL`，需为该兼容端点支持的模型名 |
| 想接其它模型厂商 | 修改 `DASHSCOPE_BASE_URL` 与 `DASHSCOPE_MODEL`，但提示词按「中文 + 纯 JSON 输出」设计，效果需自行验证 |
| 页面样式 / 图谱显示异常 | 前端资源全本地，请强制刷新（Ctrl+F5）排除浏览器缓存 |

---

## 运行测试

单元测试全部使用猴子补丁模拟模型返回，**不需要 API Key，也不会产生调用费用**：

```bash
python -m unittest test_app -v
```

---

## 生产部署（可选）

内置 Flask 开发服务器仅供本地使用。公开部署建议交给 WSGI 服务器，并务必修改 `SECRET_KEY`、限制上传大小：

```bash
pip install waitress
waitress-serve --host=0.0.0.0 --port=8090 app:app
```
