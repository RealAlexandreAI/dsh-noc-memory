<p align="center">
  <img src="assets/readme/hero.zh.svg" alt="dsh-noc-memory —— 给 DeepSeek Harness 接上长期记忆" width="100%">
</p>

# dsh-noc-memory

给 DeepSeek Harness 接上 **Noc Memory** 长期记忆:会话开始 boot + 每日简报,记忆读写/搜索/更新,后端是部署在 Cloudflare 上的 Noc Memory MCP 服务器。

> 由 [pi-noc-memory](https://github.com/RealAlexandreAI/pi-noc-memory) 移植,协议与工具名完全一致。

[English](README.md) · [中文](README.zh.md)

## 工具

| 工具 | 说明 |
|---|---|
| `noc_boot` | 会话开始时加载:核心记忆 + 近期上下文 + 术语表 |
| `noc_briefing` | 今日工作记忆简报(`system://briefing`)——近期活动、即将过期、冷候选 |
| `noc_read` | 按 URI 读记忆(`system://…`、`noc://agent`…) |
| `noc_search` | 按关键词搜记忆(触发词召回优先,再 FTS) |
| `noc_create` | 新建记忆节点(支持 `[Baseline]/[Deviation]/[Result]/[Reusable judgment]`) |
| `noc_update` | patch(old_string/new_string)或 append 更新记忆;可选 `relation` 演变标记 |

## 快速开始

```sh
dsh plugin --profile web add dsh-noc-memory
```

需要你能连到自己的 Noc Memory 服务器——几分钟部署到 Cloudflare:[cf-noc-mem](https://github.com/RealAlexandreAI/cf-noc-mem)。

```yaml
- id: noc-memory
  name: dsh-noc-memory
  config:
    mcp_url: https://mem.example.com/mcp
    mcp_auth: Bearer <你的 token>
```

| 键 | 必填 | 含义 |
|---|---|---|
| `mcp_url` | 是 | 你的 Noc Memory MCP 端点(Streamable HTTP) |
| `mcp_auth` | 否 | 需要鉴权时填 `Bearer <token>` |

> **从 dsh-nocturne-memory(≤0.1.x)升级:** 已改名为 `dsh-noc-memory`,工具名 `nocturne_*` → `noc_*`。删除旧插件后重新添加新包;更新提示词里所有 `nocturne_*` 工具引用。

## 为什么叫 noc_*(不叫 nocturne_*)?

部分模型会先探测 `read_mcp_resource` 再调用记忆工具,浪费一次往返([上游 issue #32](https://github.com/Dataojitori/nocturne_memory/issues/32))。工具列表与 boot 协议提示词里显式的 `noc_boot` / `noc_read` 命名,能把模型直接引导到正确工具——无需 resource 兼容层。

## License

MIT

## 相关

- [cf-noc-mem](https://github.com/RealAlexandreAI/cf-noc-mem) — 本插件连接的 Cloudflare MCP 记忆服务器
- [pi-noc-memory](https://github.com/RealAlexandreAI/pi-noc-memory) — 面向 Pi 的同一套记忆工具
- [nocturne_memory](https://github.com/Dataojitori/nocturne_memory) — 上游项目
