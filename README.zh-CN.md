<div align="center">

# Pi Hermes Memory (adv)

*会话一结束，你的 Pi Agent 就把一切都忘了。这个扩展负责治好它。*

[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?style=flat-square&labelColor=black)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Finn763/pi-hermes-memory-adv?style=flat-square&logo=github&labelColor=black)](https://github.com/Finn763/pi-hermes-memory-adv/stargazers)
[![CI](https://github.com/Finn763/pi-hermes-memory-adv/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Finn763/pi-hermes-memory-adv/actions/workflows/ci.yml)

[English](README.md) | 中文

</div>

> 大多数「记忆」方案是把所有东西一股脑塞进 prompt。这里的记忆放在磁盘上、可检索，
> 直到真正需要时才进上下文。

Pi Agent 每次开新会话都是失忆状态——你的技术栈、你的约定、你昨天刚纠正过它的事，
全部随会话消失。Pi Hermes Memory 给它一层持久记忆：全局事实、用户画像、项目约定、
失败教训——以 Markdown 落盘、镜像进 SQLite、并以一份轻量的 token 感知策略注入，
而不是全量倾倒。

这是 [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT）
的 **adv** 分支，源自 Hermes agent 的记忆设计。在上游引擎之上，它加了
**自进化技能**（Hermes 式：直接写入并弹 `💾 Skill …` 通知）和 **与 Hermes 对齐的 review 通知语义**。

```bash
pi install git:github.com/Finn763/pi-hermes-memory-adv
```

一行安装。重启 Pi 它就开始记了——无需任何设置，不用手工维护记忆文件。

---

## 为什么需要它

长期使用 Agent 的人都会遇到的四种失败模式：

- **#1：每次会话从零开始。** 项目、技术栈、约定、偏好，每次都要重新讲一遍。
  **解法：** 四个持久化存储（全局事实、用户画像、项目约定、失败教训）落盘可检索，
  说一次就够。
- **#2：「无限记忆」把上下文吃光。** 全量注入的方案，成本一周比一周高。
  **解法：** 默认 policy-only 注入——Agent 拿到一份稳定的小策略 + 记忆工具，
  而不是把整库塞进每轮 prompt；存储有容量上限，满了自动合并而不是无限增长。
- **#3：纠正和教训随会话蒸发。** 周一修好的坑，周四又踩一次。
  **解法：** 纠正会被即时识别并保存，失败记录连原因一起存；后台 review 每 10 轮
  把值得留的东西捡回来。
- **#4：密钥被「好心」记住。** API key、token 不该进记忆。
  **解法：** 所有记忆与技能写入先过内容扫描器——密钥、token、SSH key 一律拒绝落盘。

---

## 工作方式

![Pi Hermes 记忆架构](docs/architecture.zh-CN.svg)

每条路径都是同一个形状：先扫描、再落 Markdown、最后镜像进 SQLite。复盘时钟只在有东西值得留下时才醒来。

[▶ 交互版](https://finn763.github.io/pi-hermes-memory-adv/architecture.zh-CN.html)

1. **会话开始** — 注入一份小记忆策略（固定指令 + 指针），存储本体按需调用。
2. **工作中** — Agent 用 `memory_add` / `memory_replace` / `memory_remove` 写入；
   纠正被即时识别并保存。
3. **每 10 轮**（或累计 15 次工具调用，或距上次技能写入 10 次工具调用；且你说满
   3 句之后）— 后台 review 通过 side-channel 补全读取最近消息，保存值得留的
   内容：`💾 Memory updated`。
4. **技能** — 同一次 review 可以把类级技能直接写进全局技能库，并逐个提示：
   `💾 Skill '<name>' created`；改成 `skillReviewMode: "stage"` 则改为暂存，
   用 `/memory-skills pending` 批准。
5. **存储写满时** — 自动合并（consolidation），而不是报错或丢数据。
6. **随时** — `session_search` 基于 SQLite FTS5 检索全部历史会话。

> 节奏对齐 Hermes 原版设计：`nudge_interval = 10` 个用户轮次、
> `skills.creation_nudge_interval = 10` 次工具调用（技能时钟），硬门槛 3 句，
> 同时只跑一个 review。**没有弹通知 = 没有值得存的东西**，不是坏了。

---

## 它承诺什么

| 方面 | 固定下来的行为 |
|---|---|
| 存储 | `MEMORY.md`（事实/环境）、`USER.md`（你是谁）、项目记忆（每个仓库的约定）、`failures.md`（什么没成、为什么） |
| 注入 | 默认 policy-only——可检索，不全量注入；全量注入是可选项 |
| Review 节奏 | 每 10 轮 / 15 次工具调用，另有独立的 10 次工具调用技能时钟；硬门槛 ≥3 句用户消息，同时仅一个 review |
| 通知 | `off` / `on` / `verbose`，默认 `on`——与 Hermes `display.memory_notifications` 同语义 |
| 技能 | Pi 原生 `SKILL.md`，由 Agent 写入；默认直接落盘并用 `💾 Skill …` 提示，`stage` 改为待批 |
| 密钥 | 所有写入先过扫描器；API key、token、SSH key 拒绝落盘 |
| 容量 | 默认每个存储 5,000 字符；满了自动合并 |

---

## 命令与工具

| 命令 | 作用 |
|---|---|
| `/memory-review`（别名 `/refine`） | 立即跑一次后台 review——绕过所有触发门槛 |
| `/memory-skills` | 管理技能；`pending` 列出暂存提案 |
| `/memory-skill-approve` · `/memory-skill-reject` | 按 id 批准/拒绝暂存提案，或 `all` |
| `/memory-pin` | 固定一条每会话都注入的常驻指令 |
| `/memory-insights` | 查看当前存了什么 |
| `/memory-consolidate` | 手动合并存储以释放空间 |
| `/memory-index-sessions` | 一次性导入历史 Pi 会话到检索库 |
| `/memory-sync-markdown` | 校准 SQLite 镜像与 Markdown 存储 |
| `/memory-preview-context` | 预览本会话注入的记忆策略 |
| `/memory-interview` | 几个问答，预填你的用户画像 |
| `/memory-switch-project` | 切换项目级记忆的当前项目 |
| `/learn-memory-tool` | 记忆工具的上手指引 |

Agent 自己调用的工具：
`memory_add` · `memory_replace` · `memory_remove` · `memory_search` · `session_search` · `skill_manage`。

---

## 安装

```bash
pi install git:github.com/Finn763/pi-hermes-memory-adv
```

重启 Pi（或 `/reload`），然后可选：

```bash
/memory-index-sessions    # 一次性：让历史会话可检索
/memory-interview         # 可选：预填用户画像
/memory-preview-context   # 查看当前注入了什么
```

需要 Pi ≥ 0.80.6。配置在 `~/.pi/agent/hermes-memory-config.json`，扩展启动时读取——
改完需重启 Pi 或 `/reload`。

<details>
<summary><strong>其他安装方式</strong></summary>

| 来源 | 命令 |
|---|---|
| Git（本仓库） | `pi install git:github.com/Finn763/pi-hermes-memory-adv` |
| 本地检出 | `pi install ./pi-hermes-memory-adv` |
| 一次性试用 | `pi -e git:github.com/Finn763/pi-hermes-memory-adv` |
| 卸载 | `pi remove git:github.com/Finn763/pi-hermes-memory-adv` |

</details>

---

## 数据在哪

```
~/.pi/agent/
├── hermes-memory-config.json       # 配置
├── pi-hermes-memory/
│   ├── MEMORY.md                   # 全局事实（环境、约定、工具怪癖）
│   ├── USER.md                     # 用户画像：偏好、风格
│   ├── failures.md                 # 什么没成、为什么
│   ├── sessions.db                 # SQLite：记忆镜像 + 会话全文检索
│   ├── skills/                     # 自管理技能（SKILL.md）
│   └── pending/                    # 暂存待批的技能提案（`stage` 模式）
└── projects-memory/<project>/      # 项目级记忆 + 技能
```

<details>
<summary><strong>配置项</strong></summary>

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryMode` | `"policy-only"` | 改为 `legacy-inject` = 全量上下文注入 |
| `lazyInitialization` | `false` | `true` + `policy-only` = 首次使用时才初始化 |
| `nudgeInterval` | `10` | 后台 review 的间隔（用户轮次） |
| `nudgeToolCalls` | `15` | 或累计这么多次工具调用后触发 |
| `skillNudgeInterval` | `10` | 距上次技能写入累计这么多次工具调用后触发技能时钟；`0` 关闭 |
| `reviewEnabled` | `true` | 后台 review 总开关 |
| `reviewNotifications` | `"on"` | `off` / `on` / `verbose` |
| `reviewTransport` | `"direct"` | side-channel 补全，失败回落到 `pi -p` 子进程 |
| `skillReviewMode` | `"apply"` | `apply` 直接写入技能改动（对齐 Hermes）；`stage` 暂存待批（`/memory-skills pending`）；`off` 关闭 |
| `memoryCharLimit` · `userCharLimit` · `projectCharLimit` | `5000` | 各存储的容量上限（满则合并） |
| `correctionDetection` | `true` | 纠正即时保存 |
| `failureInjectionEnabled` | `true` | 相关历史失败自动浮现 |
| `flushOnShutdown` · `flushOnCompact` | `true` | 会话结束时补一次 |

完整列表见 [`src/config.ts`](src/config.ts) → `DEFAULT_CONFIG`。

</details>

<details>
<summary><strong>升级说明</strong></summary>

启动时会自动安全迁移旧数据，无需手工操作：

- `~/.pi/agent/memory` → `~/.pi/agent/pi-hermes-memory`
- 扁平技能 `skills/*.md` → `skills/<slug>/SKILL.md`（修复 Pi 技能索引冲突，
  如 `name "..." does not match parent directory "skills"`）

升级后启动一次 Pi 即完成迁移。

</details>

---

<details>
<summary><strong>仓库结构</strong></summary>

```
src/index.ts        # 扩展入口：存储、工具、命令、生命周期
src/handlers/       # 后台 review、技能、合并、会话检索……
src/stores/         # Markdown + SQLite 存储
tests/              # 完整测试套件
docs/               # 架构图、路线图、发布说明
docs/README-full.md # 完整版旧手册
```

</details>

## 开发

```bash
git clone https://github.com/Finn763/pi-hermes-memory-adv.git
cd pi-hermes-memory-adv
npm install
npm run check     # tsc --noEmit + 开发检查
npm test          # 完整测试套件
```

仅在完整检出下可用；打包/发布版不含测试与 TypeScript 源。

## 致谢

源自 [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT），
其本身是 Hermes agent 记忆设计的移植。本分支新增 Hermes 式自进化技能与
Hermes 对齐的 review 通知语义，并保留上游署名与 MIT 许可证。

## 许可证

[MIT](LICENSE)

*记住一次，永不重复。*
