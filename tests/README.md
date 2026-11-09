# 测试与验证材料

## 可执行测试位置

测试文件位于 `modules/state-core/tests/`，**保留源码目录的原始相对关系**（`../src/candidate/`、`../migrations/`、`../plugins/`），因此不能随意移动到本目录。本目录只提供复现说明。

## 复现命令（在包根执行，Node.js 22+）

```bash
# 需先安装 js-yaml（preset-registry 使用）；本包不附带第三方依赖
npm install js-yaml --no-save

node --test --test-concurrency=1 modules/state-core/tests/*.test.mjs
```

UI 的独立运行验证：

```bash
cd modules/ui/local-window
LOCAL_WINDOW_TRANSPORT=mock node server.mjs
# 另开终端验证：/  /app.css  /app.js  /api/health  /api/config  /api/messages
```

## 已执行的验证结果（本轮，隔离副本）

| 项目 | 结果 |
|---|---|
| JS 语法检查 `node --check` | 110/110 通过 |
| 记忆/写入安全测试（脱敏副本，顺序执行） | 92 用例，**90 通过 / 2 失败** |
| 未脱敏对照基线（原始相对结构） | 85 用例，**81 通过 / 4 失败** |
| UI 隔离运行 | 页面、CSS、JS、`/api/health`、`/api/config`、`/api/messages` 全部 200 |
| UI 交互 | `POST /api/messages` 返回 200；随后消息数为 2，角色序列 `user`、`assistant` |
| UI 资源加载 | 页面正确引用 `app.css` 与 `app.js`；标题为中性文字 |
| 收尾 | 服务停止，端口释放；`transport=mock`，未连接外部模型或渠道 |

## 2 个失败用例（不隐瞒）

| 用例 | 现象 | 判定 |
|---|---|---|
| 并发 CAS：两个真实子进程抢同一预约 | 失败方返回 `upstream-error`（SQLite 只读/忙），而非期望的 `cas-mismatch` | **上游既有问题**：未脱敏基线同样失败 |
| 多进程竞争：3 个子进程同时 claim | 子进程未落盘报告，超时 | **上游既有问题**：未脱敏基线同样失败 |

两者都是**跨进程 SQLite 写锁**相关，属于本包明确记录的限制，不是脱敏引入的回归。基线对照中另外两个差异项（多进程锁竞争、shell 路径误判）已通过「补齐 preset 资源、避免目录名触发守卫规则、只读复制验证依赖」解决。

## 未执行 / 受限项

- 未安装依赖构建完整生产包；未运行端到端链路（需真实渠道与模型）。
- 未执行跨进程并发压力测试的成功路径。
- 未对任何二进制产物做运行时验证（本包不含二进制产物）。
- 测试结果来自**隔离副本**；不证明正式环境行为。

构建与运行日志属于内部审核材料，不随本候选包公开；本页只陈述结果与限制。
