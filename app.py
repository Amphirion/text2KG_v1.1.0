"""Text2KG：把 PDF / DOCX / TXT 文档转换为可交互知识图谱的 Flask 服务。

处理流程：
    上传文件 -> 提取纯文本 -> LLM 生成摘要 -> 用户在页面上确认/编辑摘要
    -> LLM 抽取 (nodes, links) -> 清洗与补齐图谱 -> Louvain 社区发现
    -> 写入 static/knowledge_graph.json -> 前端 Canvas 力导向图展示
"""

import json
import logging
import os
import re
import uuid

import networkx as nx
import PyPDF2
from docx import Document
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory
from openai import OpenAI

# --------------------------------------------------------------------------- #
# 基础配置
# --------------------------------------------------------------------------- #

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 服务默认监听端口（可由 .env 或环境变量 PORT 覆盖）
DEFAULT_PORT = 8090

# 显式指定 .env 路径，避免从其它工作目录启动时读不到配置
load_dotenv(os.path.join(BASE_DIR, ".env"))

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

ALLOWED_EXTENSIONS = {
    ext.strip().lower()
    for ext in os.getenv("ALLOWED_EXTENSIONS", "pdf,docx,txt").split(",")
    if ext.strip()
}

app.config.update(
    SECRET_KEY=os.getenv("SECRET_KEY", "text2kg-dev-secret"),
    # 统一使用绝对路径：服务从任何目录启动都能找到上传目录与静态文件
    UPLOAD_FOLDER=os.path.join(BASE_DIR, os.getenv("UPLOAD_FOLDER", "uploads")),
    ALLOWED_EXTENSIONS=ALLOWED_EXTENSIONS,
    MAX_CONTENT_LENGTH=int(os.getenv("MAX_CONTENT_MB", "20")) * 1024 * 1024,
    TEXT_LIMIT=int(os.getenv("TEXT_LIMIT", "50000")),
    PDF_MAX_PAGES=int(os.getenv("PDF_MAX_PAGES", "20")),
    KNOWLEDGE_GRAPH_FILE=os.path.join(app.static_folder, "knowledge_graph.json"),
    RAW_OUTPUT_FILE=os.path.join(BASE_DIR, "logs", "last_llm_raw.txt"),
    LLM_MODEL=os.getenv("DASHSCOPE_MODEL", "qwen-plus"),
    LLM_TIMEOUT=float(os.getenv("LLM_TIMEOUT", "120")),
    LLM_MAX_RETRIES=int(os.getenv("LLM_MAX_RETRIES", "2")),
)

# 让 JSON 响应保留中文而不是 \uXXXX
if hasattr(app, "json") and hasattr(app.json, "ensure_ascii"):
    app.json.ensure_ascii = False

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, "logs"), exist_ok=True)

# --------------------------------------------------------------------------- #
# 提示词
# --------------------------------------------------------------------------- #

SUMMARY_SYSTEM_PROMPT = """你是一个知识提取助手，总结用户提供的文本，要求提取其中的核心内容及相互关系，回答控制在1000字以内。注意且不要提及具体章节。"""

KG_SYSTEM_PROMPT = """
您是一名专门从事知识图创建的人工智能专家，目标是根据给定的输入或请求捕获关系。
你的任务是根据用户输入创建一个知识图。
在知识图中使用输入中的词汇或短语作为节点（nodes），每个节点都有一个id字段，其中每个节点的id就是输入中的术语或短语本身。
节点之间的关系以链接（links）表示，关系的名称以标签（label）表示。
仅以JSON格式响应，不要输出 markdown 代码块，也不要输出任何解释文字。

## 一致性要求（必须遵守） ##
- 每条 link 的 source 和 target 必须能在 nodes 的 id 中找到，禁止引用不存在的节点。
- 如果需要表达中间概念，必须先在 nodes 中定义该节点。
- 所有节点 id 必须唯一，不得重复。
- 不要输出自环（source 和 target 相同的边）。
- nodes 至少包含 5 个节点，不要返回空数组。

## 输出格式 ##
{ "nodes": [{"id": "..."}], "links": [{"source": "...", "target": "...", "label": "..."}] }

## 以下是一个输出示例 ##

输出：
{
  "nodes": [{"id": "机器"}, {"id": "计算机"}],
  "links": [{"source": "计算机", "target": "机器", "label": "属于"}]
}
"""

KG_RETRY_HINT = (
    "上一次没有返回有效的知识图谱。请重新只输出一个 JSON 对象，"
    "nodes 至少包含 5 个节点，links 的 source/target 必须与 nodes 的 id 完全一致，"
    "不要输出空数组，不要输出解释文字。"
)

# --------------------------------------------------------------------------- #
# 通用工具
# --------------------------------------------------------------------------- #

_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _text(value):
    """把模型返回的 id / name / label 统一转成字符串。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _node_id(value):
    """规范化节点 ID：去首尾空白，折叠连续空白。"""
    return re.sub(r"\s+", " ", _text(value)).strip()


def _endpoint(value):
    """兼容 source/target 直接是字符串或 {id: ...} 的情况。"""
    if isinstance(value, dict):
        value = value.get("id") or value.get("name") or value.get("label")
    return _node_id(value)


def _atomic_write_text(path, text):
    """先写同目录临时文件再原子替换，避免写入中断破坏已有文件。

    临时文件名带 uuid，避免并发请求写入同一个 .part 文件。
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp_path = f"{path}.{uuid.uuid4().hex}.part"
    try:
        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def _atomic_write_json(path, payload):
    _atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def _save_raw_output(text):
    """保存最后一次模型原始输出，便于排查解析失败的问题（不阻塞主流程）。"""
    try:
        _atomic_write_text(app.config["RAW_OUTPUT_FILE"], text)
    except Exception:  # noqa: BLE001 - 调试文件写失败不应影响接口
        logger.warning("原始模型输出写入失败", exc_info=True)


def _safe_upload_name(filename, extension):
    """生成安全的本地文件名：保留中文等 Unicode 字符，去掉路径与非法字符。

    werkzeug 的 secure_filename 会把纯中文名清成空串或只剩标点（如 "-.docx"），
    这里改为只处理真正危险的字符，并限制长度、规避 Windows 保留设备名。
    """
    base = os.path.basename((filename or "").replace("\\", "/"))
    stem = os.path.splitext(base)[0]
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
    stem = re.sub(r"\s+", " ", stem)
    stem = stem[:80].strip(" .")
    if not stem or stem.upper() in _WINDOWS_RESERVED_NAMES:
        stem = uuid.uuid4().hex
    return f"{stem}.{extension}"


def _api_key():
    key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "未配置 DASHSCOPE_API_KEY。请在项目根目录创建 .env 并写入 "
            "DASHSCOPE_API_KEY=sk-xxxx（可参考 .env.example），然后重启服务。"
        )
    return key


def _llm_client():
    return OpenAI(
        api_key=_api_key(),
        base_url=os.getenv(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ),
        timeout=app.config["LLM_TIMEOUT"],
        max_retries=app.config["LLM_MAX_RETRIES"],
    )


# --------------------------------------------------------------------------- #
# 图谱解析与清洗
# --------------------------------------------------------------------------- #


def clean_graph(graph):
    """清洗 LLM 返回的图谱。

    1. 兼容 nodes/entities、links/edges 等常见字段名；
    2. 节点去重，ID 统一为字符串；
    3. 为悬空边的端点补节点，避免前端力导向图找不到端点；
    4. 去掉自环、非法边和完全重复的边。
    """
    if isinstance(graph, list):
        # 有些模型会直接返回节点数组
        graph = {"nodes": graph, "links": []}
    if not isinstance(graph, dict):
        return {"nodes": [], "links": []}

    # 兼容 {"graph": {...}} / {"data": {...}} 这类多包一层的情况
    for wrapper in ("graph", "knowledge_graph", "data"):
        inner = graph.get(wrapper)
        if isinstance(inner, dict) and (inner.get("nodes") or inner.get("entities")):
            graph = inner
            break

    raw_nodes = graph.get("nodes") or graph.get("entities") or []
    raw_links = (
        graph.get("links")
        or graph.get("edges")
        or graph.get("relationships")
        or []
    )
    if not isinstance(raw_nodes, list):
        raw_nodes = []
    if not isinstance(raw_links, list):
        raw_links = []

    nodes = []
    seen = set()

    for node in raw_nodes:
        if isinstance(node, dict):
            nid = _node_id(node.get("id") or node.get("name") or node.get("label"))
        else:
            nid = _node_id(node)

        if not nid or nid in seen:
            continue
        seen.add(nid)
        nodes.append({"id": nid, "group": 0})

    links = []
    link_keys = set()
    for link in raw_links:
        if not isinstance(link, dict):
            continue

        src = _endpoint(link.get("source") or link.get("from") or link.get("head"))
        dst = _endpoint(link.get("target") or link.get("to") or link.get("tail"))
        if not src or not dst or src == dst:
            continue

        label = _text(
            link.get("label") or link.get("relation") or link.get("type")
        ).strip()

        # 完全重复的边只保留一条，避免图上出现重叠的线
        key = (src, dst, label)
        if key in link_keys:
            continue
        link_keys.add(key)

        # 关键：模型漏掉的节点在这里补上，保证边一定合法
        for endpoint in (src, dst):
            if endpoint not in seen:
                seen.add(endpoint)
                nodes.append({"id": endpoint, "group": 0})

        links.append({"source": src, "target": dst, "label": label})

    return {"nodes": nodes, "links": links}


def _json_candidates(cleaned):
    """从模型输出里挑出可能的 JSON 片段（整个文本、{...}、[...]）。"""
    yield cleaned
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = cleaned.find(opener), cleaned.rfind(closer)
        if start != -1 and end > start:
            yield cleaned[start:end + 1]


def parse_graph_json(text):
    """尽量从模型输出中解析 JSON，兼容 markdown 围栏、说明文字和尾逗号。"""
    if not isinstance(text, str):
        raise ValueError("模型返回内容不是文本")
    cleaned = text.replace("```json", "").replace("```", "").strip()
    if not cleaned:
        raise ValueError("模型返回为空")

    last_error = None
    for candidate in _json_candidates(cleaned):
        for value in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
            try:
                return json.loads(value)
            except Exception as exc:  # noqa: BLE001 - 逐个候选重试
                last_error = exc

    raise ValueError(f"JSON 解析失败: {last_error}")


def _louvain_groups(graph):
    """社区发现，返回 {节点: 分组编号}。失败时退化为单社区，不阻断主流程。"""
    if graph.number_of_nodes() == 0:
        return {}
    try:
        communities = nx.community.louvain_communities(graph, seed=123)
    except Exception:  # noqa: BLE001 - networkx 版本/空图都可能抛错
        logger.exception("Louvain 社区发现失败，退化为单社区")
        return {node: 0 for node in graph.nodes}

    # 按社区大小排序，保证前端配色与分组编号稳定、可复现
    ordered = sorted(communities, key=lambda members: (-len(members), min(members)))
    return {
        node: index
        for index, members in enumerate(ordered)
        for node in members
    }


# --------------------------------------------------------------------------- #
# 文件解析
# --------------------------------------------------------------------------- #


def extract_text_from_file(file_path):
    """从文件中提取文本内容；不支持/损坏的文件返回 None。"""
    extension = os.path.splitext(file_path)[1].lower()

    try:
        if extension == ".pdf":
            logger.info("处理 PDF 文件：%s", os.path.basename(file_path))
            with open(file_path, "rb") as handle:
                pdf_reader = PyPDF2.PdfReader(handle)
                pages = pdf_reader.pages[: app.config["PDF_MAX_PAGES"]]
                text = "\n".join(
                    page_text
                    for page_text in (page.extract_text() for page in pages)
                    if page_text
                )
            return text

        if extension == ".docx":
            logger.info("处理 DOCX 文件：%s", os.path.basename(file_path))
            document = Document(file_path)
            parts = [para.text for para in document.paragraphs if para.text]
            # 表格里的内容同样承载知识，按行拼接后一并返回
            for table in document.tables:
                for row in table.rows:
                    cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                    if cells:
                        parts.append(" | ".join(cells))
            return "\n".join(parts)

        if extension == ".txt":
            logger.info("处理 TXT 文件：%s", os.path.basename(file_path))
            with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
                return handle.read()

        logger.error("不支持的文件格式：%s", extension or "(无扩展名)")
        return None

    except Exception:  # noqa: BLE001 - 交给调用方统一提示
        logger.exception("文件处理过程中发生错误")
        return None


# --------------------------------------------------------------------------- #
# LLM 调用
# --------------------------------------------------------------------------- #


def generate_text_completion(model, messages, temperature=0.3, max_tokens=4096):
    """非流式调用，返回 {"response": str} 或 {"error": str}。"""
    try:
        completion = _llm_client().chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        choices = getattr(completion, "choices", None) or []
        if not choices:
            return {"error": "模型未返回任何结果"}
        content = getattr(choices[0].message, "content", None) or ""
        return {"response": content}
    except Exception as exc:  # noqa: BLE001 - 统一转成 error 字段
        logger.exception("LLM 调用失败")
        return {"error": f"Failed to generate response: {exc}"}


def generate_text_completion_stream(model, messages, temperature=0.0, max_tokens=4096):
    """流式调用并把增量拼成完整文本，返回 {"response": str} 或 {"error": str}。"""
    try:
        stream = _llm_client().chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
        )
        # 流式 chunk 可能在任意位置断开，用空字符串拼接，避免把空格插进词语中间
        pieces = []
        for chunk in stream:
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            content = getattr(choices[0].delta, "content", None)
            if content:
                pieces.append(content)
        text = "".join(pieces)
        if not text.strip():
            return {"error": "模型返回为空"}
        return {"response": text}
    except Exception as exc:  # noqa: BLE001 - 统一转成 error 字段
        logger.exception("LLM 流式调用失败")
        return {"error": f"Failed to generate response: {exc}"}


def summarize_from_text(text):
    """从文本中提取核心内容；失败返回空字符串。"""
    if not text or not text.strip():
        return ""

    messages = [
        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": text},
    ]
    result = generate_text_completion(
        app.config["LLM_MODEL"], messages, temperature=0.3
    )
    if "error" in result:
        logger.error("摘要生成失败: %s", result["error"])
        return ""

    return result["response"].replace("```", "").strip()


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #


@app.route("/")
def home():
    """首页 / 启动页。"""
    return render_template("index.html")


@app.route("/app")
def app_interface():
    """文本上传与摘要编辑主界面。"""
    return render_template("app.html")


@app.route("/graph")
def graph():
    """读取 static/knowledge_graph.json 的 3D 图谱页（生成后刷新）。"""
    return render_template("knowledge_graph.html")


@app.route("/graph0")
def graph0():
    """静态示例图谱页，用 static/demo_graph.json 作为默认展示。"""
    return render_template("demo_graph.html")


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    """访问已上传的文件（send_from_directory 已防止路径穿越）。"""
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)


@app.route("/healthz")
def healthz():
    """轻量健康检查，便于部署探活。"""
    return jsonify({"status": "ok", "model": app.config["LLM_MODEL"]})


@app.errorhandler(413)
def payload_too_large(_error):
    limit_mb = app.config["MAX_CONTENT_LENGTH"] // (1024 * 1024)
    return jsonify({"error": f"文件过大，最大支持 {limit_mb} MB"}), 413


@app.route("/upload", methods=["POST"])
def upload_file():
    """处理文件上传：保存文件 -> 提取文本 -> 生成摘要。"""
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "未选择文件"}), 400

    extension = os.path.splitext(file.filename)[1].lower().lstrip(".")
    if extension not in app.config["ALLOWED_EXTENSIONS"]:
        allowed = "、".join(sorted(app.config["ALLOWED_EXTENSIONS"]))
        return jsonify({"error": f"不支持的文件格式，仅支持：{allowed}"}), 400

    try:
        # 保留中文文件名，仅清理路径分隔符等危险字符
        safe_name = _safe_upload_name(file.filename, extension)
        safe_stem, safe_ext = os.path.splitext(safe_name)

        # 同名文件不覆盖已有文件，追加序号
        upload_dir = app.config["UPLOAD_FOLDER"]
        candidate = safe_name
        index = 1
        while os.path.exists(os.path.join(upload_dir, candidate)):
            candidate = f"{safe_stem}_{index}{safe_ext}"
            index += 1

        save_path = os.path.join(upload_dir, candidate)
        file.save(save_path)
        logger.info("文件已保存至：%s", save_path)

        text_content = extract_text_from_file(save_path)
        if text_content is None:
            return jsonify({"error": "文件内容提取失败，请确认文件未损坏"}), 400
        if not text_content.strip():
            return jsonify(
                {"error": "未能从文件中提取到文本，可能是扫描版 PDF 或空文档"}
            ), 400

        if len(text_content) > app.config["TEXT_LIMIT"]:
            text_content = text_content[: app.config["TEXT_LIMIT"]]
            logger.warning(
                "文本过长，已截断前 %s 个字符", app.config["TEXT_LIMIT"]
            )

        summary = summarize_from_text(text_content)
        if not summary.strip():
            return jsonify({"error": "摘要生成失败，请检查 API Key 后重试"}), 500

        return jsonify(
            {
                "text": text_content,
                "sum": summary,
                "file_path": f"/uploads/{candidate}",
            }
        )

    except Exception as exc:  # noqa: BLE001 - 返回结构化错误
        logger.exception("文件上传处理失败")
        return jsonify({"error": f"服务器错误：{exc}"}), 500


@app.route("/update_graph", methods=["POST"])
def update_graph():
    """根据文本生成知识图谱，写入 static/knowledge_graph.json 并返回图数据。"""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify(
            {"error": '请求体必须是 JSON 对象，例如 {"text": "..."}'}
        ), 400

    text = payload.get("text") or ""
    if not isinstance(text, str):
        text = str(text)
    text = text.strip()

    if not text:
        return jsonify({"error": "输入内容为空，请先上传文件并生成摘要"}), 400

    if len(text) > app.config["TEXT_LIMIT"]:
        text = text[: app.config["TEXT_LIMIT"]]
        logger.warning("输入文本过长，已截断至 %s 字符", app.config["TEXT_LIMIT"])

    base_messages = [
        {"role": "system", "content": KG_SYSTEM_PROMPT},
        {"role": "user", "content": text},
    ]

    kg = None
    last_error = ""
    try:
        # 模型偶尔会返回空 nodes 或带说明文字的 JSON，失败时补充更严格的提示重试一次
        for attempt in range(2):
            current_messages = list(base_messages)
            if attempt == 1:
                current_messages.append({"role": "user", "content": KG_RETRY_HINT})

            result = generate_text_completion_stream(
                app.config["LLM_MODEL"], current_messages, temperature=0.0
            )

            if "error" in result:
                last_error = result["error"]
                logger.error(
                    "LLM 调用失败（第 %s 次）：%s", attempt + 1, last_error
                )
                continue

            raw_response = result["response"]
            logger.info(
                "LLM 原始返回（第 %s 次，前 1000 字符）：%s",
                attempt + 1,
                raw_response[:1000],
            )
            _save_raw_output(raw_response)

            try:
                parsed_graph = parse_graph_json(raw_response)
            except ValueError as exc:
                last_error = str(exc)
                logger.error("LLM 返回无法解析（第 %s 次）：%s", attempt + 1, exc)
                continue

            cleaned = clean_graph(parsed_graph)
            if cleaned["nodes"]:
                kg = cleaned
                break

            last_error = "模型返回的 nodes 为空"
            logger.error("清洗后图谱为空（第 %s 次）", attempt + 1)

        if kg is None or not kg["nodes"]:
            return jsonify(
                {
                    "error": "知识图谱生成失败："
                    f"{last_error or '模型未返回有效节点'}，请重试"
                }
            ), 500

        graph = nx.Graph()
        graph.add_nodes_from(node["id"] for node in kg["nodes"])
        # 边上两端节点已在 clean_graph 中补齐，这里一定可以安全加边
        graph.add_edges_from(
            (link["source"], link["target"]) for link in kg["links"]
        )

        groups = _louvain_groups(graph)
        graph_payload = {
            "nodes": [
                {"id": node["id"], "group": groups.get(node["id"], 0)}
                for node in kg["nodes"]
            ],
            "links": kg["links"],
        }

        _atomic_write_json(app.config["KNOWLEDGE_GRAPH_FILE"], graph_payload)
        logger.info(
            "知识图谱已更新：%s 个节点，%s 条边，%s 个社区",
            len(graph_payload["nodes"]),
            len(graph_payload["links"]),
            len(set(groups.values())),
        )
        return jsonify(graph_payload)

    except Exception as exc:  # noqa: BLE001 - 返回结构化错误
        logger.exception("知识图谱生成失败")
        return jsonify({"error": f"知识图谱生成失败: {exc}"}), 500


def _parse_port(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = _parse_port(os.getenv("PORT"), DEFAULT_PORT)
    debug = os.getenv("FLASK_DEBUG", "0").strip().lower() in {"1", "true", "yes"}

    logger.info("启动 Text2KG 服务：http://%s:%s", host, port)
    try:
        app.run(host=host, port=port, debug=debug)
    except OSError as exc:
        # 端口无权限或被占用（Windows errno 10013 / 10048）时明确报错，
        # 不再静默切换到别的端口，避免预览地址与实际服务不一致。
        logger.error(
            "端口 %s 无法使用（%s），请通过 PORT 环境变量指定其它空闲端口", port, exc
        )
        raise
