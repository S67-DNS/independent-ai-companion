# 本地窗口（LOCAL-WINDOW-MVP-MINIMAL-001）

一个**独立**的本地聊天小窗口：只连你自己配置的 OpenAI-compatible 接口（或本地 Mock），
不依赖 QQ / OneBot / NapCat / AstrBot / DSH 私有接口 / 旧 Bridge / 任何通信平台 SDK。

## 启动

```bat
cd local-window
node server.mjs
```

或双击 `启动窗口.cmd`（会自动起服务并打开 http://127.0.0.1:8790/）。

默认是**本地 Mock 通道**（无需任何密钥，可直接聊天、验证流式与导出）。

## 配置真实模型

复制 `config.example.json` 为 `config.json`，改成你的接口：

```json
{
  "transport": "openai",
  "openai": {
    "baseURL": "https://你的接口/v1",
    "model": "你的模型名",
    "apiKey": "",
    "supports": { "image": false, "audio": false, "video": false }
  }
}
```

- `baseURL` 只填到 `/v1`（程序会请求 `/chat/completions`）；
- 密钥建议用环境变量 `LOCAL_WINDOW_API_KEY`，不要把明文写进会提交的文件；
- 任何情况下密钥都不会返回给页面，也不会出现在日志里；
- 若接口不支持图片/音频/视频，请把对应 `supports` 置为 `false`：发送时会被**明确拒绝**，不会静默丢弃附件。

环境变量覆盖：`LOCAL_WINDOW_CONFIG` / `LOCAL_WINDOW_DATA` / `LOCAL_WINDOW_PORT` / `LOCAL_WINDOW_TRANSPORT` /
`LOCAL_WINDOW_BASE_URL` / `LOCAL_WINDOW_MODEL` / `LOCAL_WINDOW_API_KEY`。

## 一键 TXT 导出

右上角「导出 TXT」。导出当前窗口**全部**消息（不省略旧消息、不截断正文），包含：
时间、用户/助手角色、完整文本、附件类型/MIME/文件名/大小/本地路径。

同时会落盘到数据目录 `exports/chat-<时间戳>.txt`。

> 说明：这是本地窗口的独立聊天记录，**不是 DSH 权威 Session**；不写 `memory.db`，不改人格/日记，不自动同步到任何平台。
> TXT 不可能包含媒体二进制本体，附件原文件在 `media/` 下，TXT 里保留其有效本地路径。

## 数据目录

默认：`%LOCALAPPDATA%\CORE_ENTITY\local-window\`

```
messages.jsonl     聊天记录（一行一条，按时间顺序）
media/             附件原文件
exports/           导出的 TXT
window.json        窗口元信息
```

## 多模态

- 消息结构统一为 `text / image / audio / video`；
- 附件元数据：kind、mime、name、size、本地绝对路径、id；
- 图片显示缩略图，音频/视频用浏览器原生播放；
- 当前不做语音识别、视频抽帧、音视频转码。

## 测试

```bat
node local-window/tests/run.mjs
```

隔离测试：临时数据目录 + 本地 Mock / 本地假端点，不连接真实 DSH、真实核心主体 Session、QQ 或任何平台。当前 **34 项全部通过**。

## 边界与取舍

- 只监听 `127.0.0.1`；
- 无 CDN、无遥测、无更新检查、无插件系统、无多模型菜单、无多会话侧栏、无自动摘要/自动截断/自动重试；
- 代码仅三个扩展边界：`lib/parts.mjs`（MessagePart）、`lib/transport.mjs`（ChatTransport）、`lib/exporter.mjs`（TranscriptExporter）。

## 关于曾评估的第三方单文件应用

此前评估过一个上游单文件聊天应用。本轮核实发现：上游仓库无 LICENSE 原件、无版本 tag 或 commit 对应关系，仅 README 声明许可证，且随包许可文本为本地补写。

**再分发权无法坐实，因此该内嵌应用及其适配层、测试已全部从公开候选排除，不随包分发。** 本目录保留的 `server.mjs`、`public/`、`lib/` 与 `tests/` 为独立可运行的本地窗口实现，不依赖被排除的内嵌应用。

本说明不暗示已获得上游任何额外授权，也未修改上游版权声明。

