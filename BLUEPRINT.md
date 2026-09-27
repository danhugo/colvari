# Blueprint: Agents Squad, ứng dụng desktop vận hành coding/AI agents như một công ty

> **Trạng thái:** Draft v6 (2026-09-27). Bản này là v5 cộng các sửa theo review: định nghĩa inline Provider/Proxy/Approval/Notification/Runner, bỏ driver `agentapi` (thay bằng `term-emu` tự viết trên PTY), thống nhất tên schema `squad.event.v1`, tích hợp proxy ở P1, quy tắc transition = role AND edge, và mốc "first usable release". **Xác minh trên web (2026-09-27) đã hoàn tất: đã xác minh URL, license và trạng thái archived của mọi repo public ở mục 3 và các thư viện ở mục 11.** Cột "Verified" ở mục 3 ghi ngày kiểm tra. Kết quả đáng chú ý: Agno nay là Apache-2.0 (không còn MPL-2.0), Kilo Code là MIT, agentapi và Roo Code đã archived, tauri-plugin-pty không có LICENSE, mcp_agent_mail có rider riêng, Claude Agent SDK bản TS và Python khác license. Các mục chưa xác minh (số agent trong ACP registry, cờ ACP của Gemini CLI, ToS subscription, mức export OTel, Windows, Linux keyring) vẫn nằm trong checklist ở mục 13, là điều kiện bắt buộc để thoát P0a. **Khi fork hoặc nhúng code, ghi commit hash của file LICENSE.**

---

## 1. Vision

**Một câu:** Agents Squad là desktop app cho phép một người (Head/CEO) dựng và vận hành một "công ty" gồm nhiều coding agent khác vendor: Claude Code, Codex, OpenCode, pi, Cursor CLI, Gemini CLI, Goose...
- Mỗi agent là một node trong graph editor.
- Edge quy định role và phạm vi giao tiếp. Edge được **enforce thật** ở ba tầng: MCP tool/data, sandbox filesystem, egress network.
- Mọi agent dùng chung một kênh làm việc: board task kiểu JIRA và wiki kiểu Confluence.
- Human quan sát được toàn bộ: ai đang làm gì, tiến độ, cost (có nhãn độ tin cậy), chất lượng output và cấu hình từng agent.

**Nguyên tắc thiết kế:**
- **Human-in-command:** Human chọn runtime, model, proxy (LiteLLM/OpenRouter/Portkey), provider và role (PM, Planner, Dev, Reviewer, QA). Có approval gate cho plan, merge, vượt budget, lệnh nguy hiểm và nội dung lấy từ bên ngoài.
- **Vendor-agnostic:** ACP là chuẩn adapter chính. Dùng native driver khi ACP làm mất dữ liệu (cost, approvals, resume).
- **Graph là cấu hình và cũng là policy.** Edge compile ra `PolicySet`, enforce ở:
  - L-MCP: Gateway lọc tool, task, doc, message và danh sách tool cho phép theo role.
  - L-FS: Sandbox filesystem cho từng node.
  - L-NET: Egress proxy có lọc SNI/host.
  - Nếu thiếu L-FS hoặc L-NET, UI hiển thị rõ **advisory mode**.
- **Local-first, git-backed:** Task, docs và log đều diff, rollback và replay được. Remote runner là bước mở rộng (P7).
- **Observability-first:** Mọi hành động đi qua event bus với schema `squad.event.v1`. Cost có nhãn `actual | reported | computed | estimated | unknown`.
- **Đo chất lượng, không chỉ cost:** Có eval harness nội bộ và một subset benchmark công khai được pin version.

### 1.1 Persona, success metrics, mô hình phân phối

**Persona chính:**
- P1, "Solo tech lead / indie hacker": 1 người, 1–3 repo, đã trả tiền cho 2+ agent vendor, muốn chạy song song và kiểm soát cost.
- P2, "Team lead nhóm 3–10 dev": muốn thử pipeline agent trên repo thật, cần audit, budget và approval.
- Chưa nhắm tới: enterprise cần SSO/RBAC nhiều người dùng (để sau P7).

**Success metrics (đo từ P3):**
- Tỉ lệ task agent làm xong và qua review ngay lần đầu (first-pass acceptance) ≥ 50% trên benchmark nội bộ.
- Số lần human can thiệp trên mỗi epic ≤ 2.
- Sai lệch giữa cost `actual` và hóa đơn provider ≤ 5%.
- Time-to-first-team (cài xong tới lúc chạy được preset Startup) ≤ 15 phút.
- Escape test sandbox: 100% bị chặn trên OS hỗ trợ L1.

**Mô hình phân phối (quyết định cách bundle license):**
- Core app mã nguồn mở (đề xuất Apache-2.0), miễn phí, local-first.
- Nếu có doanh thu sau này thì từ remote runner hoặc team sync dạng hosted. **Vì vậy không bundle** thành phần AGPL, ELv2, BSL hay Commons Clause vào bản phân phối. Các thành phần này chỉ được hỗ trợ ở dạng "user tự cài, app kết nối qua protocol".

---

## 2. Build vs Fork: quyết định chiến lược

Paperclip (MIT, ~86.6k stars, chưa archived; đã kiểm tra trên web 2026-09-27) đã có org chart, ticket/goal, budget per agent, heartbeat và adapter cho Claude Code/Codex/Cursor. Gas Town (dựng trên beads) đã có role taxonomy và phần supervise CLI. Claude Code Agent Teams/subagents đã giải quyết orchestration bên trong một vendor.

| Phương án | Ưu | Nhược |
|---|---|---|
| **A. Fork Paperclip**, thêm graph editor, enforcement, wiki, desktop shell | Có sẵn org, budget, ticket, adapter. MIT | Kiến trúc web control plane. Org chart dạng cây, không có typed edge. Phải bám upstream thay đổi nhanh. Chưa rõ có sandbox không |
| **B. Build mới**, tham khảo Paperclip/Gas Town | Graph-native, enforcement 3 tầng, desktop UX | Phải làm lại phần budget/ticket |
| **C. Hybrid** | Build core mới (graph runtime, policy, sandbox, adapter). Board backend cắm được. Có adapter "Paperclip as backend" nếu API cho phép | Phải duy trì abstraction |

**Quyết định đề xuất: C, có spike 2 ngày trong P0a.** Spike đọc code Paperclip và Gas Town để trả lời:
1. Adapter interface có tách ra dùng như thư viện được không?
2. Data model có mở rộng sang typed edge được không?
3. Có isolation hay enforcement nào không?
4. Tốc độ commit upstream và mức ổn định API ra sao?

Nếu (1), (2), (3) đều "có" thì chuyển sang A.

**So sánh với Claude Code Agent Teams / subagents** (cần xác minh tính năng hiện hành trong docs Anthropic):

| Tiêu chí | Agent Teams (1 vendor) | Agents Squad |
|---|---|---|
| Đa vendor/model | Không (chỉ Claude) | Có |
| Board/wiki bền vững, human đọc được | Hạn chế | Có, git-backed |
| Cost per node/task qua proxy | Không | Có |
| Enforce phạm vi giao tiếp | Theo cấu hình subagent | Typed edge, 3 tầng |
| Eval theo role/runtime | Không | Có |

**Khác biệt cốt lõi phải giữ, dù chọn phương án nào:**
1. Typed edge compile thành policy, enforce ở MCP, FS và NET.
2. Desktop-native: PTY take-over, worktree/container per node, diff review.
3. Eval chất lượng theo role/runtime/model.
4. Wiki và doc space scope theo subgraph.
5. Cost có nhãn độ tin cậy, tách actual khỏi estimated.

---

## 3. Reference repos

**Ý nghĩa cột Verified:**
- `web 2026-09-27`: đã kiểm tra trên web ngày 2026-09-27 (URL live, file LICENSE hoặc license GitHub phát hiện, trạng thái archived). Nếu URL là redirect thì cột ghi thêm "(redirect)", và URL trong bảng là URL đích.
- `closed`: sản phẩm closed source hoặc hosted, không có repo để kiểm tra.
- `prior`: kiến thức có sẵn, **bắt buộc xác minh** (chỉ còn lại ở các dòng không có repo public).

License ghi `NOASSERTION` nghĩa là GitHub không nhận diện được một license chuẩn (license hỗn hợp hoặc có điều khoản riêng). Đọc ghi chú đi kèm. Số stars là số xấp xỉ tại ngày kiểm tra.

### 3.1 Prior art "AI company" và CLI agent manager

| Name | URL | License | Verified | Reuse |
|---|---|---|---|---|
| Paperclip | https://github.com/paperclipai/paperclip | MIT | web 2026-09-27 (~86.6k stars) | Org chart, budget, heartbeat, adapter. Mục tiêu spike build-vs-fork |
| Gas Town | https://github.com/gastownhall/gastown | MIT | web 2026-09-27 (redirect từ steveyegge) | Role taxonomy, hooks/convoys, supervise CLI |
| beads (bd) | https://github.com/gastownhall/beads | MIT | web 2026-09-27 (redirect từ steveyegge) | Task backend có dependency graph, `bd ready`, MCP |
| Vibe Kanban | https://github.com/BloopAI/vibe-kanban | Apache-2.0 | web 2026-09-27 | Executor abstraction (Rust), worktree-per-task, diff review |
| Crystal | https://github.com/stravu/crystal | MIT | web 2026-09-27 | Base Electron: session song song, worktree, diff/merge |
| Claude Squad | https://github.com/smtg-ai/claude-squad | AGPL-3.0 | web 2026-09-27 | tmux + worktree. **Chỉ tham khảo** |
| opcode (trước là Claudia) | https://github.com/winfunc/opcode | AGPL-3.0 | web 2026-09-27 (redirect từ getAsterisk) | GUI Tauri cho Claude Code. **Chỉ tham khảo** |
| Agent Orchestrator | https://github.com/Untrivial-ai/agent-orchestrator | Apache-2.0 | web 2026-09-27 (redirect từ ComposioHQ) | Lifecycle issue → PR, CI/review loop, plugin slot |
| Sculptor | https://github.com/imbue-ai/sculptor | MIT | web 2026-09-27 | Container-per-agent, pairing mode |
| agentapi (Coder) | https://github.com/coder/agentapi | MIT | web 2026-09-27 (**ARCHIVED**) | HTTP wrapper cho CLI agent qua terminal emulation. Repo đã archived nên **không nên làm dependency**. Chỉ tham khảo cách làm, fallback adapter tự viết trên PTY (driver `term-emu`) |
| uzi | https://github.com/devflowinc/uzi | MIT | web 2026-09-27 | Quản lý nhiều agent + worktree |
| ccmanager | https://github.com/kbwo/ccmanager | MIT | web 2026-09-27 | Quản lý nhiều agent + worktree |
| Omnara | https://github.com/omnara-ai/omnara | Apache-2.0 | web 2026-09-27 | Giám sát và điều khiển từ mobile |
| Happy | https://github.com/slopus/happy | MIT | web 2026-09-27 | Mobile client cho Claude Code |
| Zed agent panel | https://github.com/zed-industries/zed | NOASSERTION (GPL-3.0/AGPL-3.0/Apache-2.0 tùy crate) | web 2026-09-27 | **Reference implementation của ACP client**. Chỉ tham khảo |
| Warp agents, Amp orchestration, Conductor, Terragon, Jules, Codex cloud, Devin, Factory | sản phẩm | Closed | closed | UX: background agent, review/merge, status tổng quan |
| Claude Code subagents / Agent Teams | https://docs.anthropic.com | Closed | closed | Xem bảng so sánh ở mục 2 |
| Cline | https://github.com/cline/cline | Apache-2.0 | web 2026-09-27 | Pattern "orchestrator mode" |
| Roo Code | https://github.com/RooCodeInc/Roo-Code | Apache-2.0 | web 2026-09-27 (**ARCHIVED**) | Pattern "orchestrator mode". Chỉ tham khảo |
| Kilo Code | https://github.com/Kilo-Org/kilocode | **MIT** (không phải Apache-2.0) | web 2026-09-27 | Pattern "orchestrator mode" |

### 3.2 Framework role/graph/handoff (LLM-API, không điều khiển CLI)

| Name | URL | License | Verified | Reuse |
|---|---|---|---|---|
| OpenAI Agents SDK | https://github.com/openai/openai-agents-python, https://github.com/openai/openai-agents-js | MIT (cả hai) | web 2026-09-27 | **Mô hình handoff** (agent chuyển quyền kèm input filter), guardrails, tracing. Nguồn trực tiếp cho mục 5 |
| Google ADK | https://github.com/google/adk-python | Apache-2.0 | web 2026-09-27 | Agent phân cấp, workflow agent (sequential/parallel/loop) |
| MetaGPT | https://github.com/FoundationAgents/MetaGPT | MIT | web 2026-09-27 | SOP theo role, pub-sub, template PRD |
| ChatDev 2.0 | https://github.com/OpenBMB/ChatDev | Apache-2.0 | web 2026-09-27 | Chat chain, workflow editor |
| CrewAI | https://github.com/crewAIInc/crewAI | MIT | web 2026-09-27 | Schema role/goal/tools, hierarchical manager |
| Mastra | https://github.com/mastra-ai/mastra | NOASSERTION: Apache-2.0 core, thư mục `ee/` dùng license riêng (đã xác nhận trong LICENSE.md) | web 2026-09-27 | Workflow graph TS, hợp stack Node. Không dùng code trong `ee/` |
| Inngest AgentKit | https://github.com/inngest/agent-kit | Apache-2.0 | web 2026-09-27 | Router/network agent TS |
| Microsoft Agent Framework | https://github.com/microsoft/agent-framework | MIT | web 2026-09-27 | Typed edge, checkpoint, HITL |
| AutoGen / Magentic-One | https://github.com/microsoft/autogen | GitHub nhận diện CC-BY-4.0 (docs). Code theo LICENSE-CODE là MIT | web 2026-09-27 | Studio, speaker selection, task ledger. AutoGen đang ở chế độ maintenance |
| AG2 | https://github.com/ag2ai/ag2 | Apache-2.0 | web 2026-09-27 | Fork cộng đồng của AutoGen |
| LangGraph | https://github.com/langchain-ai/langgraph | MIT | web 2026-09-27 | State graph, checkpointer, UX của Studio |
| Letta | https://github.com/letta-ai/letta | Apache-2.0 | web 2026-09-27 | Memory blocks per agent |
| Agno | https://github.com/agno-agi/agno | **Apache-2.0** (LICENSE trên main, không còn MPL-2.0) | web 2026-09-27 | Team mode. Lưu ý copyleft cũ không còn áp dụng |
| Ruflo (claude-flow) | https://github.com/ruvnet/ruflo | MIT | web 2026-09-27 | Topology preset. Claim marketing cần tự kiểm |

### 3.3 Agent runtime và protocol

| Name | URL | License | Verified | Reuse |
|---|---|---|---|---|
| ACP (Zed) | https://agentclientprotocol.com, repo https://github.com/agentclientprotocol/agent-client-protocol | Apache-2.0 | web 2026-09-27 | Adapter chính. Con số "35+ agent" trong registry **chưa kiểm tra** |
| claude-agent-acp | https://github.com/agentclientprotocol/claude-agent-acp | Apache-2.0 | web 2026-09-27 | Claude qua ACP |
| codex-acp | https://github.com/agentclientprotocol/codex-acp | Apache-2.0 (copyright JetBrains) | web 2026-09-27 (zed-industries/codex-acp đã archived, chuyển sang đây) | Codex qua ACP |
| Claude Agent SDK (TypeScript) | https://github.com/anthropics/claude-agent-sdk-typescript | NOASSERTION: Anthropic Commercial Terms, LICENSE ghi "all rights reserved" | web 2026-09-27 | `total_cost_usd`, hooks. Không vendor code |
| Claude Agent SDK (Python) | https://github.com/anthropics/claude-agent-sdk-python | MIT | web 2026-09-27 | Như trên. License khác bản TS |
| Claude Code headless | `claude -p --output-format stream-json` + hooks | Closed | closed | **Native driver không cần SDK**: NDJSON có result event chứa cost/usage. Hooks (PreToolUse/PostToolUse/Stop) cho phép chặn tool và bắn event |
| Codex app-server / `exec --json` | repo https://github.com/openai/codex, docs https://learn.chatgpt.com/docs/app-server | Apache-2.0 | web 2026-09-27 (docs redirect từ developers.openai.com) | Persistent JSON-RPC có approvals/token-count. `exec --json` + `--output-schema` cho task một lần |
| OpenCode | https://github.com/anomalyco/opencode | MIT | web 2026-09-27 (redirect từ sst) | `opencode serve`: HTTP + OpenAPI + SSE |
| pi | https://github.com/earendil-works/pi | MIT | web 2026-09-27 (redirect từ badlogic/pi-mono) | RPC JSONL, TS SDK |
| Cursor CLI | https://cursor.com/docs/cli/reference/output-format | Closed | closed (docs HTTP 200) | stream-json. Auth riêng, không qua proxy. **Đòi hỏi native ACP còn đáng ngờ, phải test ở P0a** |
| Gemini CLI | https://github.com/google-gemini/gemini-cli | Apache-2.0 | web 2026-09-27 | stream-json có token stats. Cờ ACP (`--experimental-acp` hoặc cờ mới): **chưa kiểm tra**, xem version hiện hành |
| Goose | https://github.com/aaif-goose/goose | Apache-2.0 | web 2026-09-27 (redirect từ block) | Recipes làm role template |
| OpenHands | https://github.com/OpenHands/OpenHands | MIT (root LICENSE; điều khoản thư mục enterprise chưa kiểm tra) | web 2026-09-27 | Event stream, Docker sandbox |
| A2A | https://github.com/a2aproject/A2A | Apache-2.0 | web 2026-09-27 | Khái niệm Agent Card, Task lifecycle |
| MCP | https://modelcontextprotocol.io, repo https://github.com/modelcontextprotocol/modelcontextprotocol | MIT, đang chuyển sang Apache-2.0 | web 2026-09-27 | Tầng L-MCP |

**Bảng ACP native hay qua adapter.** Đây là giả thuyết, P0a phải chạy thật và ghi version:

| Agent | Giả thuyết | Test |
|---|---|---|
| Claude | Adapter `claude-agent-acp` | session/new, prompt, permission, cancel, resume |
| Codex | Adapter `codex-acp` (agentclientprotocol/codex-acp) | như trên |
| Gemini CLI | Native (tên cờ cần kiểm tra) | như trên |
| Goose, pi | Native | như trên |
| OpenCode | Chưa rõ native hay adapter | như trên |
| Cursor | **Đáng ngờ** | như trên. Nếu fail thì dùng NDJSON |

### 3.4 Board, message, memory

| Name | URL | License | Verified | Reuse |
|---|---|---|---|---|
| **GitHub Issues/Projects** | GitHub API + https://github.com/github/github-mcp-server | MIT (server) | web 2026-09-27 | **Backend TaskStore mà user có khả năng chọn nhất.** Ưu tiên ở P5 |
| mcp_agent_mail | https://github.com/Dicklesworthstone/mcp_agent_mail | NOASSERTION: MIT sửa đổi, kèm "OpenAI/Anthropic Rider" | web 2026-09-27 | Identity, inbox, contact policy, file lease. **Rider riêng cần review pháp lý** trước khi nhúng |
| Backlog.md | https://github.com/MrLesk/Backlog.md | MIT | web 2026-09-27 | Task + docs dạng markdown |
| Task Master | https://github.com/eyaltoledano/claude-task-master | MIT + Commons Clause (đã xác nhận trong LICENSE) | web 2026-09-27 | PRD → tasks. Chạy process riêng, không nhúng |
| Atlassian MCP | https://github.com/atlassian/atlassian-mcp-server | Apache-2.0 | web 2026-09-27 | Jira/Confluence thật |
| Linear MCP | https://linear.app/docs/mcp | Closed (hosted) | closed (docs HTTP 200) | Backend Linear |
| Plane | https://github.com/makeplane/plane | AGPL-3.0 | web 2026-09-27 | Board tự host. Chỉ kết nối qua API |
| Outline | https://github.com/outline/outline | BUSL-1.1 | web 2026-09-27 | Backend wiki. Chỉ kết nối qua API |
| AFFiNE | https://github.com/toeverything/AFFiNE | MIT core + license EE cho một số thư mục | web 2026-09-27 | Backend wiki. Chỉ kết nối qua API |
| Basic Memory | https://github.com/basicmachines-co/basic-memory | AGPL-3.0 | web 2026-09-27 | Wiki qua MCP. Process riêng |
| Graphiti | https://github.com/getzep/graphiti | Apache-2.0 | web 2026-09-27 | Memory có namespace |
| Mem0 | https://github.com/mem0ai/mem0 | Apache-2.0 | web 2026-09-27 | Memory có namespace |

### 3.5 Sandbox và isolation

| Name | URL | License | Verified | Reuse |
|---|---|---|---|---|
| **Anthropic sandbox-runtime** | https://github.com/anthropics/sandbox-runtime (npm `@anthropic-ai/sandbox-runtime`) | Apache-2.0 | web 2026-09-27 (redirect từ anthropic-experimental) | **Ứng viên số 1 cho L1**: bọc sandbox-exec (macOS) và bubblewrap (Linux), kèm network proxy lọc domain. Có thể dùng thẳng để sinh profile từ PolicySet |
| Codex Linux sandbox | https://github.com/openai/codex (landlock + seccomp) | Apache-2.0 | web 2026-09-27 | Tham khảo cách dùng Landlock/seccomp |
| Windows AppContainer / Windows Sandbox | docs Microsoft | Closed (API OS) | prior | **Đường L1 trên Windows**: AppContainer + ACL cho process. Windows Sandbox làm L2 nhẹ |
| Container Use (Dagger) | https://github.com/dagger/container-use | Apache-2.0 | web 2026-09-27 | Container + branch per agent qua MCP |
| gVisor | https://github.com/google/gvisor | Apache-2.0 | web 2026-09-27 | Runtime `runsc`, L2 cứng hơn trên Linux |
| Apple `container` / Containerization | https://github.com/apple/container | Apache-2.0 | web 2026-09-27 | L2 nhẹ trên macOS 26 (mỗi container là một micro-VM) |
| Firecracker | https://github.com/firecracker-microvm/firecracker | Apache-2.0 | web 2026-09-27 | L3 microVM trên remote runner |
| E2B | https://github.com/e2b-dev/E2B | Apache-2.0 | web 2026-09-27 | L3 cloud sandbox |
| Daytona | https://github.com/daytonaio/daytona | **AGPL-3.0** (LICENSE tại v0.190.0) | web 2026-09-27 | L3 cloud sandbox. Chỉ kết nối qua API |
| Modal | https://modal.com | Closed (hosted) | closed | L3 cloud sandbox |

### 3.6 Proxy, MCP gateway, observability, durable runtime, UI

| Name | URL | License | Verified | Reuse |
|---|---|---|---|---|
| LiteLLM | https://github.com/BerriAI/litellm | NOASSERTION: MIT core, `enterprise/` thương mại | web 2026-09-27 | Virtual key, spend log. Có rủi ro gating, supply-chain và packaging Python (mục 4.5) |
| Portkey Gateway | https://github.com/Portkey-AI/gateway | MIT | web 2026-09-27 | Proxy thay thế bằng TS/Node, **nhúng được trong Electron**, có fallback/retry. Cần kiểm tra tính năng cost/budget có trong bản OSS không |
| Bifrost (Maxim) | https://github.com/maximhq/bifrost | Apache-2.0 | web 2026-09-27 | Proxy bằng Go, single binary, hiệu năng cao. Dễ đóng gói dạng sidecar |
| Helicone | https://github.com/Helicone/helicone | Apache-2.0 | web 2026-09-27 | Proxy kiêm observability |
| OpenRouter | https://openrouter.ai | Closed (hosted) | closed | Upstream. Trả cost trong response |
| Docker MCP Gateway | https://github.com/docker/mcp-gateway | MIT | web 2026-09-27 | Prior art cho gateway: lọc tool, chạy server trong container |
| MCPJungle | https://github.com/mcpjungle/MCPJungle | MPL-2.0 | web 2026-09-27 | Registry + gateway tự host. Copyleft theo file |
| agentgateway (LF) | https://github.com/agentgateway/agentgateway | Apache-2.0 | web 2026-09-27 | Proxy MCP/A2A bằng Rust, có RBAC/authz. **Ứng viên mạnh** thay cho việc tự viết phần transport và authz |
| Langfuse | https://github.com/langfuse/langfuse | NOASSERTION: MIT core, `ee/` enterprise (copyright nay là ClickHouse, Inc.) | web 2026-09-27 | Trace store, chỉ dùng phần MIT |
| Arize Phoenix | https://github.com/Arize-ai/phoenix | Elastic-2.0 (ELv2) | web 2026-09-27 | Không bundle. Chỉ export OTLP tới bản user tự cài |
| OpenLLMetry / Traceloop | https://github.com/traceloop/openllmetry | Apache-2.0 | web 2026-09-27 | Instrument cho phần SDK chạy in-process |
| OTel Collector | https://github.com/open-telemetry/opentelemetry-collector | Apache-2.0 | web 2026-09-27 | Sidecar tùy chọn: nhận OTLP từ CLI và fan-out |
| ccusage | https://github.com/ccusage/ccusage (monorepo, LICENSE ở `apps/ccusage/LICENSE`) | MIT | web 2026-09-27 (redirect từ ryoppippi) | Parse log local |
| Temporal | https://github.com/temporalio/temporal | MIT | web 2026-09-27 | Durable orchestration cho remote runner |
| Restate | https://github.com/restatedev/restate | **BUSL-1.1** (server) | web 2026-09-27 | Durable orchestration. Restate server không bundle |
| xyflow | https://github.com/xyflow/xyflow | MIT | web 2026-09-27 | Graph editor |
| xterm.js | https://github.com/xtermjs/xterm.js | MIT | web 2026-09-27 | Terminal |
| node-pty | https://github.com/microsoft/node-pty | MIT (theo nội dung file; GitHub không nhận diện) | web 2026-09-27 | PTY |
| tauri-plugin-pty | https://github.com/Tnze/tauri-plugin-pty | **Không có LICENSE** | web 2026-09-27 (~22 stars) | Không có license nghĩa là không được phép dùng. Chỉ tham khảo nếu chọn Tauri |

> **Repo đã đổi địa chỉ** (URL trong bảng đã là URL hiện tại): sst→anomalyco/opencode, All-Hands-AI→OpenHands, block→aaif-goose, badlogic/pi-mono→earendil-works/pi, steveyegge→gastownhall, ComposioHQ→Untrivial-ai, geekan→FoundationAgents/MetaGPT, ruvnet/claude-flow→ruvnet/ruflo, claude-code-acp→claude-agent-acp, getAsterisk/opcode→winfunc/opcode, zed-industries/codex-acp→agentclientprotocol/codex-acp, anthropic-experimental/sandbox-runtime→anthropics/sandbox-runtime, ryoppippi/ccusage→ccusage/ccusage, docs Codex app-server→learn.chatgpt.com.

> **Repo đã archived** (không dùng làm dependency): coder/agentapi, RooCodeInc/Roo-Code, zed-industries/codex-acp.

> **Thư viện ở mục 11 đã kiểm tra (web 2026-09-27):** electron-vite (MIT), Pragmatic drag and drop (Apache-2.0), TipTap (MIT), Milkdown (MIT), electron-trpc (MIT, ~402 stars, chưa archived), electron-trpc-experimental (https://github.com/makp0/electron-trpc-experimental, MIT, ~14 stars, npm cập nhật lần cuối 2025-06-18), MCP TypeScript SDK (MIT đang chuyển sang Apache-2.0), better-sqlite3 (MIT), Drizzle ORM (Apache-2.0).

---

## 4. Architecture

```
┌──────────────────────────── Desktop App (Electron) ─────────────────────────────┐
│ Renderer (React): Graph Editor · Board · Wiki · Terminals · Observability ·     │
│   Eval · Approvals · Notifications        (i18n: vi/en; a11y WCAG 2.2 AA)       │
│        └──────── IPC (zod contracts qua ipcMain/contextBridge) ────────┘        │
│ Main process (Node)                                                             │
│  ┌──────────────── Orchestrator / Graph Runtime ─────────────────────────────┐  │
│  │ Graph compiler → PolicySet ─┬─> MCP Gateway      (L-MCP: tool/data scope) │  │
│  │                             ├─> Sandbox profile  (L-FS)                   │  │
│  │                             └─> Egress policy    (L-NET)                  │  │
│  │ Durable scheduler (journal SQLite) · HITL gates · Budget guard ·          │  │
│  │ Rate-limit/fallback · Context manager · Merge coordinator + CI gate       │  │
│  └─────┬──────────────────────┬──────────────────────┬───────────────────────┘  │
│  Agent Adapter Layer     MCP Gateway              Event Bus (squad.event.v1,    │
│  ACP|native|NDJSON|      (unix socket/named pipe,  redaction → SQLite append)   │
│  term-emu|PTY            token per node+session)   Cost aggregator · Eval       │
│  Workspace mgr (worktree ngoài shared root, multi-repo)                         │
│  Sandbox runner (sandbox-runtime | bwrap+landlock | AppContainer | container)   │
│  Egress proxy (CONNECT + SNI allow-list, DNS pinned)                            │
│  State Writer (single-writer cho SQLite + metadata repo)                        │
└──────┼─────────────────────┼────────────────────────┼───────────────────────────┘
   Agent processes      SQLite (app data dir, bị sandbox deny)   LLM proxy sidecar
   (sandboxed)          + metadata repo .squad/ (chỉ app ghi)    (key/node) → providers
        └── Remote runner (P7): SSH/container host, stream event về app
```

### 4.1 Agent Adapter Layer

```ts
interface AgentAdapter {
  kind: AdapterKind; // 'claude-code'|'codex'|'opencode'|'pi'|'cursor'|'gemini'|'goose'|'openhands'|'acp-generic'|'term-emu'
  capabilities(): AgentCapabilities; // streaming, approvals, costReport:'usd'|'tokens'|'none',
                                     // mcp, resume, proxyable, compaction, contextWindow, hooks
  start(cfg: NodeRuntimeConfig, sandbox: SandboxProfile, egress: EgressProfile): Promise<AgentSession>;
}
interface AgentSession {
  prompt(input: PromptInput): AsyncIterable<AgentEvent>;
  respondPermission(reqId: string, decision: 'allow'|'deny'): void;
  interrupt(): Promise<void>;
  compact?(): Promise<void>;              // kích hoạt compaction nếu runtime hỗ trợ
  stop(): Promise<void>;
  exportHandoff(): Promise<HandoffDoc>;
  usage(): UsageSnapshot;                 // gồm cacheRead/cacheWrite
}
```

**Thứ tự ưu tiên driver:**
1. **ACP:** App đóng vai ACP client (theo cách của Zed).
2. **Native**, khi ACP mất dữ liệu:
   - Claude: Agent SDK, **hoặc** `claude -p --output-format stream-json` kèm hooks (không cần SDK; hooks dùng để chặn tool theo policy và bắn event).
   - Codex: `app-server` cho node persistent, `exec --json --output-schema` cho task một lần.
   - OpenCode: `opencode serve` + SSE.
   - pi: `pi --mode rpc`.
3. **NDJSON headless:** Cursor, Gemini, Goose. Một parser tolerant kèm mapper riêng cho từng agent.
4. **term-emu:** Fallback qua terminal emulation, tự viết trên node-pty (đọc màn hình, gửi input). Chỉ tham khảo cách làm của coder/agentapi; repo đó đã archived (web 2026-09-27) nên **không** làm dependency.
5. **PTY:** node-pty + xterm.js, dùng khi human take-over và cho node subscription (mục 4.9).

**Khi spawn, adapter inject:**
- Base URL proxy + virtual key (nếu `proxyable`).
- MCP config trỏ tới Gateway qua socket, kèm token của node.
- Role prompt (`CLAUDE.md`/`AGENTS.md`).
- Env whitelist.
- Sandbox profile và egress profile.

**Rate limit và fallback:**
- Mỗi provider có một token bucket.
- Gặp 429/529 thì backoff có jitter, tôn trọng `retry-after`.
- Hết số lần retry thì chuyển sang `model.fallbacks[]`, ghi event `model.fallback`. Fallback đắt hơn cần HITL.

**Context-window management:**
- Mỗi node có `context: { maxTokens, compactAtPct (mặc định 75%), strategy: 'runtime'|'handoff-restart' }`.
- `runtime`: dùng compaction có sẵn của runtime (Claude, Codex, OpenCode đều có dạng nào đó; xác minh).
- `handoff-restart`: node tự viết HandoffDoc cho chính nó rồi mở session mới. Cách này dùng cho runtime không có compaction.
- Mỗi task mới mặc định mở session mới, trừ khi role cần giữ context (PM/Planner). Việc này giảm cost và giảm context bị nhiễm.
- Event `context.compacted` ghi số token trước và sau.

### 4.2 Orchestrator / Graph Runtime

- **Graph compiler:** Graph JSON được compile thành `PolicySet` + `Topology`, có validation (mục 7.3).
- **Durable scheduler:** Journal SQLite (WAL). Mỗi step idempotent theo `stepId`.
  - Khi khởi động: reconcile journal với PID/session, rồi resume hoặc đánh dấu `interrupted` để retry theo `attempts`.
  - `powerMonitor` suspend/resume: pause heartbeat và timeout.
  - Interface `WorkflowEngine` để thay bằng Temporal/Restate ở P7.
- **Lifecycle task:** `backlog → ready → in_progress → review → qa → merge_queue → done`, rẽ nhánh `blocked | failed | conflict`. Transition chỉ hợp lệ khi thỏa **cả hai**: role có quyền transition đó (bảng 7.1) **VÀ** task nằm trong scope của edge nối tới node (EdgeScope/taskFilter). Đây là cùng quy tắc giao như với tools ở mục 7.3. Vượt `maxAttempts` thì escalate.
- **HITL gates:** plan, merge, vượt budget, lệnh nguy hiểm, fallback đắt hơn, nội dung ngoài (mục 4.6.4), conflict chưa giải được.

### 4.2.1 Merge coordinator và xử lý conflict

1. **Phòng ngừa:**
   - File lease theo glob khi claim task.
   - Planner đánh dấu `touches: pathGlob[]` cho từng task. Scheduler không chạy song song hai task có glob giao nhau (có thể override).
2. **Merge queue tuần tự** theo từng repo/branch đích. Mỗi mục:
   1. Rebase lên HEAD mới nhất.
   2. Chạy **CI gate**: lệnh test/lint/build cấu hình per repo, chạy local trong sandbox hoặc qua GitHub Actions.
   3. Nếu pass thì chờ HITL merge (hoặc auto nếu policy cho phép).
3. **Conflict:**
   - *Textual conflict:* trả task về trạng thái `conflict`. **Chủ sở hữu mặc định là node Dev của task vào queue sau.** Node này được cấp quyền đọc diff của task đã merge.
   - *Semantic conflict* (rebase sạch nhưng CI fail): cũng trả về Dev của task sau, kèm log CI.
   - Sau `conflictMaxAttempts` (mặc định 2), escalate tới Reviewer/Lead theo edge `reports_to`, rồi tới Head.
   - Policy tùy chọn: `conflictOwner: 'later'|'reviewer'|'human'` trên từng group.
4. Không bao giờ auto-merge khi CI fail hoặc khi thiếu `test_report`.

### 4.3 Shared Board + Wiki + Mail

- **Board:** Abstraction `TaskStore`. Mặc định là SQLite. Plugin: GitHub Issues/Projects (ưu tiên), beads, Backlog.md, Jira, Linear, Plane (qua API).
- **Wiki:** Markdown theo space, template PRD/Design/ADR/TestPlan/Handoff. Plugin: Outline/AFFiNE qua API (tùy chọn).
- **Mail/Channel:** DM giữa các node có edge, channel theo group.
- **MCP Gateway tools:** `task.*`, `doc.*`, `msg.*`, `lease.*`, `handoff.submit/accept`, `artifact.attach`, `web.fetch` (đi qua quarantine, mục 4.6.4).
- **Single-writer:**
  - Agent không ghi trực tiếp vào SQLite hay `.squad/`. Mọi thay đổi đi qua Gateway tới State Writer.
  - State Writer mirror sang git với debounce, commit dưới actor `squad-bot`.
  - Human sửa tay thì file watcher đưa vào State Writer. Nếu xung đột thì hiện merge UI.
  - Metadata repo tách khỏi repo code.

**Gateway: build hay dùng lại?** P0a đánh giá **agentgateway** (authz, transport), Docker MCP Gateway và MCPJungle. Hướng đề xuất:
- Phần tool nghiệp vụ (board/wiki/mail) viết bằng `@modelcontextprotocol/sdk`.
- Nếu agentgateway nhúng được làm sidecar thì dùng nó cho transport, authz và audit. Nếu không thì tự viết một lớp mỏng.

### 4.4 Event Bus

- In-process, persist append-only vào SQLite, export JSONL.
- **Schema canonical `squad.event.v1`** (zod/JSON Schema, có version). Mapper sang OTel GenAI semconv pin theo một bản cụ thể, vì semconv vẫn *experimental*.
- **Loại event:**
  - `agent.status|message|tool_call|diff|permission_request`
  - `task.transition`, `doc.updated`, `msg.sent`
  - `mcp.call|mcp.denied`, `sandbox.violation`, `egress.denied`
  - `cost.delta`, `budget.alert`, `model.fallback`, `rate_limited`, `context.compacted`
  - `merge.queued|conflict|ci_result`
  - `injection.flagged`, `eval.result`, `human.action`
- **Redaction trước khi persist:** pattern (API key, JWT, private key, `.env`) kèm so khớp chính xác với secret app đang giữ. Áp dụng cho event, log PTY và export.
- **OTLP receiver (tùy chọn):**
  - Có thể chạy OTel Collector làm sidecar.
  - Gemini CLI và Codex export OTel (mức span cần xác minh).
  - **Claude Code chủ yếu export metrics và logs/events, không phải full GenAI span.** Timeline của node Claude dựng từ SDK/stream-json/hooks.

### 4.5 Observability & Cost

**Nguồn cost theo loại node:**

| Loại node | Nguồn | Nhãn |
|---|---|---|
| API key qua proxy (LiteLLM/Portkey/Bifrost), key per node + metadata `task_id` | Spend log của proxy | **actual** |
| Claude trực tiếp (SDK/stream-json) | `total_cost_usd` | **reported** |
| Codex/Gemini trực tiếp | tokens × bảng giá override | **computed** |
| Subscription CLI | Parse log local | **estimated (subscription)** |
| Cursor CLI | Không có | **unknown**, link tới dashboard vendor |

- **Cache token:** `UsageRecord` tách `cacheReadTokens` và `cacheWriteTokens`. Bảng giá override có giá riêng cho input, output, cache read và cache write (ví dụ cache write 5 phút và 1 giờ có giá khác nhau ở một số provider; xác minh). Proxy báo $0 khi token > 0 thì app tính lại và cảnh báo.
- "Proxy là nguồn sự thật" chỉ áp dụng cho node proxyable. Dashboard tách thành ba dòng: actual, reported/computed, estimated/unknown.

**Chọn proxy.** P0b benchmark ba ứng viên:

| Tiêu chí | LiteLLM | Portkey Gateway | Bifrost |
|---|---|---|---|
| Ngôn ngữ / đóng gói | Python, sidecar nặng (cần Python runtime hoặc binary đóng gói kiểu PyInstaller) | Node/TS, nhúng in-process hoặc sidecar | Go, single binary |
| Virtual key / budget per key trong OSS | **Xác minh** (một phần có thể thuộc enterprise) | Xác minh | Xác minh |
| Spend log | Có (`/spend/logs`, xác minh bản OSS) | Xác minh | Xác minh |
| Rủi ro | Supply-chain (nhiều dependency, từng có sự cố, xác minh), hiệu năng khi tải cao | Ít provider hơn? | Cộng đồng nhỏ hơn |

- **Mặc định đề xuất:** Bifrost hoặc Portkey làm sidecar đóng gói sẵn. LiteLLM là tùy chọn "user tự trỏ tới LiteLLM có sẵn". Chốt sau P0b.
- **Quy tắc cho mọi proxy:** App tự giữ aggregator cost và budget guard. Không phụ thuộc tính năng budget có thể bị gate thương mại.
- **Bảo mật supply-chain:** pin hash, SBOM, cập nhật có kiểm soát.

**UI:**
- Graph live: màu theo trạng thái, badge model/cost/attempt/context%.
- Swimlane timeline, cost theo node/role/task/model/ngày, budget bar.
- Panel Agent settings, tab Eval, merge queue.

### 4.6 Isolation & Enforcement

**Vấn đề:** Agent có shell sẽ né được MCP Gateway (đọc worktree khác, đọc DB, curl thẳng provider). Vì vậy cần L-FS và L-NET.

#### 4.6.1 L-FS: sandbox theo cấp

| Level | macOS | Linux | Windows | Chặn được |
|---|---|---|---|---|
| L0 (chỉ dev) | Worktree ngoài shared root | như mac | như mac | Truy cập vô tình. **Advisory** |
| **L1 (mặc định)** | **sandbox-runtime** (Seatbelt/sandbox-exec). sandbox-exec đã deprecated nhưng Claude Code và Codex vẫn dùng | **sandbox-runtime** / bubblewrap + Landlock (+ seccomp theo mẫu Codex) | **AppContainer** + ACL (P0c spike). Không làm được thì dùng L2 | Đọc chéo worktree, đọc DB/`.squad/`, đọc `~/.ssh` |
| L2 | Apple `container` (macOS 26) hoặc Docker/Podman | Docker/Podman, tùy chọn gVisor `runsc` | Windows Sandbox hoặc Docker (WSL2) | Như L1, đồng nhất giữa các OS |
| L3 (P7) | Remote: Firecracker/E2B/VM | | | Cách ly hoàn toàn khỏi máy human |

- Profile sinh từ PolicySet: edge `reviews` cấp mount **read-only** worktree đích. QA được mount read-only branch cần test.
- Sandbox của vendor CLI chỉ là lớp phụ.
- **Escape-test suite chạy trong CI trên mỗi OS.** Agent giả cố đọc worktree khác, đọc DB, curl provider, tunnel qua registry, dùng DNS exfil. Mọi thử nghiệm phải bị chặn.

#### 4.6.2 L-NET: egress proxy

Chỉ dùng danh sách domain là không đủ, vì agent có thể tunnel qua registry được allow, qua git remote hoặc qua DNS. Thiết kế:
- Mọi egress của process sandboxed **bị ép qua egress proxy local**. Sandbox chặn mọi socket, trừ socket/port của proxy. sandbox-runtime đã có mô hình này.
- **HTTP CONNECT + kiểm tra SNI/Host**, so khớp allow-list theo node. Đích mặc định: LLM proxy, MCP Gateway, registry npm/pypi/crates cấu hình được, git remote của repo.
- **DNS:** process sandboxed không có resolver trực tiếp. Proxy tự resolve, nhờ vậy đóng kênh DNS exfil.
- **Registry:** chỉ cho GET tới đường dẫn package (ví dụ chặn `PUT`/publish). Tùy chọn trỏ tới mirror (Verdaccio/devpi) để kiểm soát chặt hơn.
- **Git:** chỉ cho remote của repo đang làm. `push` chỉ tới branch prefix của node. Cách làm tốt nhất là agent không push; Merge coordinator push thay.
- Node proxyable bị chặn mọi domain provider trừ LLM proxy, nên không né được việc tracking cost.
- Giới hạn còn lại: kênh ẩn qua nội dung package hoặc qua commit message lên remote được allow. Giảm thiểu bằng cách không cho agent push và ghi log mọi request.

#### 4.6.3 Bảo mật MCP Gateway

- **Transport:** không bind TCP localhost, vì mọi process trên máy đều gọi được. Dùng **unix domain socket** (mac/Linux, quyền `0600`, đặt trong thư mục chỉ sandbox của node thấy được) hoặc **named pipe có ACL** (Windows).
- Với agent chỉ hỗ trợ MCP qua HTTP hoặc stdio: app spawn một shim stdio→socket bên trong sandbox.
- **Token:** mỗi `(nodeId, sessionId)` có một token riêng, TTL ngắn (ví dụ 1 giờ) và tự xoay vòng khi session resume.
  - Token được bind với PID/peer credential (`SO_PEERCRED`/`getpeereid` hoặc thông tin client của named pipe) nếu OS hỗ trợ.
  - Token bị thu hồi khi session stop.
  - Scope của token là PolicySet version tại thời điểm cấp.
- Audit mọi call. `mcp.denied` vượt ngưỡng thì alert.

#### 4.6.4 Prompt injection

- **Allow-list tool theo role** (không chỉ theo edge):
  - QA không có `lease.acquire` trên `src/`.
  - PM không có shell.
  - Reviewer chỉ có quyền đọc FS.
  - Enforce qua Gateway, qua hooks (Claude PreToolUse), qua approval policy của Codex và qua sandbox.
- **Gắn nhãn nguồn:** mọi nội dung từ peer hoặc bên ngoài được bọc `<untrusted source="node:X|web:url">`. System prompt của role nêu rõ đây là data, không phải chỉ thị.
- **Quarantine nội dung web:**
  - `web.fetch` đi qua Gateway. Nội dung được lưu thành artifact `external`, chạy detector heuristic (chỉ thị ẩn, lệnh shell, URL lạ) và gắn cờ `injection.flagged`.
  - Node chỉ nhận **tóm tắt do node "reader" không có tool viết ra**, theo pattern dual-LLM. Muốn nhận nguyên văn phải qua HITL.
- **Hành động nhạy cảm sau khi đọc nội dung untrusted** (push, thêm dependency mới, sửa CI config, đổi `.env`) bắt buộc qua HITL.

### 4.7 Evaluation

- **Task-level:** Có `acceptanceCriteria`. Trạng thái `done` bắt buộc có `test_report`.
- **Chỉ số theo role/runtime/model:** first-pass acceptance, số attempts trung bình, tỉ lệ reopen trong 7 ngày, cost/task, time-to-done, tỉ lệ conflict.
- **Benchmark pin version:**
  - *Công khai:* một subset cố định (ví dụ 30 task) của **SWE-bench Verified**, kèm **Terminal-Bench** cho kỹ năng shell. **Multi-SWE-bench** dùng cho repo không phải Python. Ghi lại commit hash của dataset và harness.
  - *Nội bộ:* 20–50 task có test ẩn trên repo mẫu, gồm cả task đòi hỏi phối hợp nhiều role (PRD → dev → QA). Benchmark công khai không đo được việc phối hợp này.
- Mỗi lần đổi role template, adapter hoặc model thì chạy regression.
- LLM-as-judge chỉ dùng cho doc, luôn gắn nhãn ước lượng.

### 4.8 Multi-repo / monorepo

- `Company` có `repos: Repo[]`, không còn `rootRepoPath` đơn lẻ.
- `Repo { id, path | remoteUrl, defaultBranch, ciCommand, packages?: {name, pathGlob}[] }`.
- Task có `repoId` và tùy chọn `packageScope`. Worktree tạo theo từng repo.
- Một node có thể được cấp nhiều repo, sandbox mount tương ứng.
- Với monorepo, `packageScope` sinh lease glob và giới hạn mount write vào package đó; phần còn lại mount read-only.
- Task liên repo được tách thành subtask theo repo, liên kết bằng `dependsOn`.

### 4.9 Chế độ subscription: phạm vi rõ ràng

Điều khoản consumer (Claude Pro/Max, ChatGPT plan) **được cho là** hạn chế dùng qua SDK hoặc app bên thứ ba để tự động hóa. **Cần xác minh văn bản hiện hành ở P0a.** Cho tới khi có kết quả xác minh:

| Hành vi | Node `auth.mode = subscription` |
|---|---|
| Tham gia pipeline tự động (auto-claim, auto-handoff, headless) | **Không** |
| Chạy trong PTY do human mở và gõ lệnh | Có |
| Đọc board/wiki qua MCP Gateway | Có (read-only mặc định) |
| Human bấm "attach result" để gắn diff/branch vào task | Có |
| Cost | `estimated (subscription)` |

Nói cách khác, node subscription là **"ghế của human"**, không phải thành viên autonomous. Nếu ToS cho phép rõ ràng thì mở rộng sau.

---

## 5. Handoff giữa các runtime

Thiết kế tham khảo pattern handoff của OpenAI Agents SDK: chuyển quyền kèm input filter, không chuyển transcript thô.

```ts
HandoffDoc {
  schemaVersion: 'handoff.v1',
  taskId, repoId, fromNodeId, toNodeId, attempt, createdAt,
  goal: string,
  status: 'completed'|'partial'|'blocked',
  summary: string,                           // ≤ 300 từ
  decisions: { what, why, adrDocId? }[],
  changes: { branch, commits: string[], filesTouched: string[], diffStat },
  verification: { commandsRun: string[], results, testReportArtifactId? },
  openQuestions: string[], nextSteps: string[], risks: string[],
  untrustedInputs: { artifactId, source }[], // nội dung ngoài đã dùng, để node sau biết
  references: { docIds, taskIds, messageThreadIds },
  contextBudgetHint?: { mustRead: string[], canSkip: string[], estTokens?: number }
}
```

- Gateway validate bằng zod, thiếu trường thì từ chối.
- Node nhận được prompt gồm HandoffDoc cộng với các doc trong `mustRead`, được cắt theo `context.maxTokens`.
- Edge `handoff` có thể đặt `requiresApproval`.
- Cùng schema này được dùng cho chiến lược `handoff-restart` (mục 4.1).

---

## 6. Data Model

```ts
Company   { id, name, repos: Repo[], metaRepoPath, defaultProxyId, budgetUsdMonthly, locale, createdAt }
Repo      { id, companyId, path?, remoteUrl?, defaultBranch, ciCommand, packages?: {name, pathGlob}[] }

Graph     { id, companyId, schemaVersion, version, parentVersion?, nodes, edges, groups, createdBy, createdAt }
GraphMigration { fromSchemaVersion, toSchemaVersion, script }

Node {
  id, graphId, name, avatar, role, roleTemplateId, roleTemplateVersion,
  runtime: { kind, driver: 'acp'|'native'|'ndjson'|'term-emu'|'pty', binPath?, args?, version? },
  model:   { providerId, modelId, params, fallbacks: {providerId, modelId}[] },
  auth:    { mode: 'api_key'|'proxy_key'|'subscription'|'vendor_account', secretRef? },
  proxyId?, virtualKeyRef?,
  workspace: { mode: 'worktree'|'container'|'remote', sandboxLevel: 'L0'|'L1'|'L2'|'L3',
               repoIds: string[], runnerId?, branchPrefix },
  egress:  { allowHosts: string[], registries: string[], allowGitPush: boolean },
  toolAllow: string[],                              // allow-list tool theo role
  context: { maxTokens, compactAtPct, strategy: 'runtime'|'handoff-restart', sessionPerTask: boolean },
  limits:  { budgetUsd, maxConcurrentTasks, maxTurnsPerTask, maxAttempts, autoApprove: string[],
             rateLimit?: { rpm?, tpm? } },
  heartbeatSec, status, sessionRef?
}

Edge { id, graphId, source, target,
       type: 'reports_to'|'assigns'|'reviews'|'handoff'|'can_message'|'observes'|'shares_docs',
       directed, scope: EdgeScope, requiresApproval? }
EdgeScope { taskFilter?: TaskQuery, docSpaces?: string[], channels?: string[],
            fsAccess?: 'none'|'read'|'read_write', repoIds?: string[] }

TaskQuery =                                   // JSON AST, compile ra SQL có tham số
  | { and: TaskQuery[] } | { or: TaskQuery[] } | { not: TaskQuery }
  | { field: 'status'|'type'|'priority'|'labels'|'assigneeNodeId'|'epicId'|'reporterNodeId'|'repoId',
      op: 'eq'|'in'|'contains'|'lte'|'gte', value: Scalar | Scalar[] }
  | { rel: 'assigned_to_self'|'assigned_to_edge_target'|'created_by_self' }

Group { id, graphId, name, nodeIds[], channelId, docSpace, conflictOwner?: 'later'|'reviewer'|'human' }

Task { id, companyId, repoId, packageScope?, parentId?, epicId?, title, body, type, status, priority,
       labels[], assigneeNodeId?, reporterNodeId, dependsOn[], touches: string[],
       acceptanceCriteria[], attempts, maxAttempts?, conflictAttempts, lastFailureReason?,
       branch?, estimate?, costUsd, costConfidence, tokensIn, tokensOut, createdAt, updatedAt }
TaskEvent { id, taskId, actorId, kind, payload, ts }
MergeQueueItem { id, repoId, taskId, position, status: 'queued'|'rebasing'|'ci'|'awaiting_approval'|
                 'merged'|'conflict'|'ci_failed', ciArtifactId?, ts }

Artifact { id, taskId, runId?, nodeId,
           kind: 'pr'|'diff'|'test_report'|'build_log'|'ci_log'|'handoff'|'screenshot'|'eval'|'external',
           uri, meta, trust: 'internal'|'untrusted', createdAt }

Doc     { id, space, path, title, kind: 'prd'|'design'|'adr'|'testplan'|'handoff'|'note',
          authorNodeId, version, linkedTaskIds[], updatedAt }
Message { id, channelId, threadId, fromNodeId, toNodeIds[], body, refs[], trust, ts }
Lease   { id, nodeId, repoId, pathGlob, taskId, expiresAt }
RoleTemplate { id, role, version, parentVersion?, systemPrompt, sop[], defaultTools[], toolAllow[],
               docTemplates[], changelog }

Run        { id, nodeId, taskId, attempt, sessionRef, runnerId, startedAt, endedAt,
             outcome: 'success'|'failed'|'interrupted'|'timeout', costUsd, peakContextPct }
GatewayToken { id, nodeId, sessionId, policyVersion, peerPid?, expiresAt, revokedAt? }
JournalStep  { id, stepId, kind, payload, status, ts }
Event        { id, ts, schema: 'squad.event.v1', runId?, nodeId?, taskId?, type, attrs, payload }
UsageRecord  { id, nodeId, taskId?, model, provider, tokensIn, tokensOut,
               cacheReadTokens, cacheWriteTokens, costUsd,
               source: 'proxy'|'sdk'|'computed'|'log'|'none', confidence, ts }
PriceTable   { providerId /* → Provider.id */, modelId, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, effectiveFrom }
EvalSuite    { id, kind: 'swe-bench-verified-subset'|'terminal-bench'|'multi-swe'|'internal',
               datasetRef, harnessCommit }
EvalResult   { id, suiteId, graphVersion, nodeConfigHash, taskRef, passed, metrics, ts }
Provider  { id, companyId, kind: 'anthropic'|'openai'|'google'|'openrouter'|'azure'|'bedrock'|'vertex'|'ollama'|'custom',
            name, baseUrl, authRef /* secretRef trong safeStorage */, apiVersion?, headers?,
            rateLimit?: { rpm?, tpm? }, enabled, createdAt }
Proxy     { id, companyId, kind: 'litellm'|'portkey'|'bifrost'|'openrouter',
            mode: 'bundled-sidecar'|'external', url, adminKeyRef?, version?, binHash?,
            providerIds: string[],                  // provider upstream proxy này route tới
            spendLogEndpoint?, healthStatus: 'ok'|'degraded'|'down', lastHealthAt?, createdAt }
VirtualKey { id, proxyId, nodeId, keyRef, budgetUsd?, metadata: { task_id?, node_id }, createdAt, revokedAt? }
Approval  { id, companyId, kind: 'plan'|'merge'|'budget'|'dangerous_cmd'|'fallback'|'external_content'|'conflict',
            subjectRef: { type: 'task'|'run'|'merge_queue_item'|'artifact'|'node', id },
            requestedBy /* nodeId */, reason, payload, status: 'pending'|'approved'|'rejected'|'expired',
            decidedBy? /* human userId */, decisionNote?, expiresAt?, ts, decidedAt? }
Notification { id, companyId, kind: 'approval_requested'|'budget_alert'|'run_failed'|'merge_conflict'|
                 'sandbox_violation'|'injection_flagged'|'task_done', severity: 'info'|'warn'|'critical',
               refType, refId, title, body, channels: ('in_app'|'os'|'webhook')[], readAt?, ts }
Runner    { id, companyId, kind: 'local'|'ssh'|'container-host'|'cloud',
            host?, mtlsCertRef?, capabilities: { sandboxLevels: ('L0'|'L1'|'L2'|'L3')[], os, arch },
            status: 'online'|'offline'|'draining', lastHeartbeatAt?, createdAt }
```

**Lưu trữ:**
- SQLite (better-sqlite3, WAL) + Drizzle, đặt trong app data dir và bị sandbox deny.
- Metadata repo chỉ State Writer được ghi.
- **Secret:** chỉ dùng Electron `safeStorage`. **Trên Linux, nếu không có keyring (libsecret/kwallet), safeStorage rơi về backend `basic_text`, gần như plaintext.** Khi đó phải phát hiện qua `safeStorage.getSelectedStorageBackend()`, hiện cảnh báo chặn, và cho chọn nhập secret mỗi phiên hoặc dùng passphrase riêng.

---

## 7. Graph Semantics: roles & communication scope

### 7.1 Node = role instance

| Role | Transition được phép | Tool mặc định (allow-list) |
|---|---|---|
| PM | tạo epic/story, ưu tiên backlog | task.*, doc.write (space PRD), msg.*. Không shell |
| Planner | tách task, `dependsOn`, `touches` | task.create/update, doc.read |
| Dev | claim `ready` → `in_progress` → `review` | shell (sandbox), lease.*, artifact.attach, handoff.submit |
| Reviewer | `review → qa | in_progress`, bắt buộc có comment | FS read-only, task.comment/transition |
| QA | `qa → merge_queue` (bắt buộc có `test_report`) hoặc tạo bug | shell trong sandbox read-only trên src, ghi vào thư mục test |
| Head (human) | override mọi thứ | ngầm có `observes` tới mọi node |

### 7.2 Edge types

| Edge | Hướng | Ý nghĩa | L-MCP | L-FS | L-NET |
|---|---|---|---|---|---|
| `reports_to` | A → B | Escalate, B thấy tiến độ của A | task.list của B gồm task của A; msg A→B | – | – |
| `assigns` | A → B | Giao task | `assignee=B` chỉ hợp lệ khi có edge | – | – |
| `handoff` | A → B | Pipeline kèm HandoffDoc | handoff.submit + auto-assign | B mount read branch của A | – |
| `reviews` | A → B | Review output của B | Thấy diff/PR của B | A mount read-only worktree của B | – |
| `can_message` | A ↔ B | DM | Contact whitelist | – | – |
| `shares_docs` | A ↔ B / Group | Chung doc space | Lọc theo space | – | – |
| `observes` | A → B | Chỉ xem | Chỉ có read tool | tùy chọn read-only | – |

- **Mặc định deny.** Group tạo channel + doc space chung.
- Egress **không** được mở bằng edge. Egress chỉ đến từ cấu hình node (`egress`), để graph không vô tình mở mạng.

### 7.3 Policy compile & enforcement

1. Compile: `PolicySet[nodeId] = { tools (giao của role allow-list và edge), taskQuery, docSpaces, contacts, transitions (giao của quyền role ở 7.1 và scope edge), sandboxProfile, egressProfile }`.
2. Gateway cấp token theo từng session và policy version. Mọi call được kiểm tra và ghi event.
3. Thay đổi mount hoặc egress thì cần restart session. Thay đổi L-MCP thì hot-update ở tool call kế tiếp.
4. **Validation trong editor:**
   - Cycle `handoff` không có điểm thoát.
   - Node không có inbound `assigns`.
   - Dev không có reviewer.
   - Node proxyable ở L0.
   - Node subscription nằm trong pipeline tự động (**lỗi, không chỉ cảnh báo**).
   - Cursor node (cảnh báo cost unknown).
   - Node có `web.fetch` nhưng không có HITL.

### 7.4 Presets
- **Startup:** PM → Planner → Dev×N → Reviewer → QA → merge queue.
- **Hierarchical:** Head → Lead → các team.
- **Pair:** Dev ↔ Reviewer.
- **Mesh:** Bắt buộc có budget, kèm cảnh báo cost.

---

## 8. UX, i18n, accessibility

- **Màn chính:**
  - Graph live (mặc định).
  - Board.
  - Wiki.
  - Terminals (tab theo node, có nút take-over).
  - Approvals inbox (badge đếm).
  - Cost.
  - Eval.
  - Merge queue.
- **i18n:** i18next. Chuỗi UI tách ngay từ P1. Ngôn ngữ khởi đầu: en và vi. Role template và doc template cũng có bản dịch. Prompt gửi agent mặc định tiếng Anh, có tùy chọn.
- **Accessibility (mục tiêu WCAG 2.2 AA):**
  - Mọi thao tác graph làm được bằng bàn phím (xyflow hỗ trợ focus/keyboard; bổ sung danh sách node/edge dạng bảng làm view thay thế).
  - Trạng thái không chỉ truyền đạt bằng màu (thêm icon và text).
  - Kanban kéo-thả có đường thay thế bằng bàn phím. Pragmatic DnD có hướng dẫn a11y.
  - Có `aria-live` cho thông báo approval.
  - Có chế độ tương phản cao.
- Chạy kiểm tra axe-core trong Playwright.

---

## 9. MVP Roadmap

Ước lượng cho **3 kỹ sư**. Tổng khoảng **36–42 tuần** tới P6. Con số trước đây (25–30 tuần) là lạc quan. Phần P2 cũ được tách làm hai.

| Phase | Thời lượng | Mục tiêu | Deliverables | Exit criteria |
|---|---|---|---|---|
| **P0a: Quyết định + xác minh** | 1.5 tuần | Chốt hướng | Spike Paperclip/Gas Town. Bảng ACP native/adapter chạy thật. **Checklist mục 13 hoàn tất**. Đánh giá agentgateway/Docker MCP Gateway | Có quyết định A/B/C bằng văn bản. Cột Verified đầy đủ cho mọi repo sẽ dùng |
| **P0b: Adapter + cost spike** | 2 tuần | Chạy được 2 runtime | Electron shell. Claude qua stream-json/SDK (API key). Codex app-server. `squad.event.v1`. **Benchmark proxy LiteLLM vs Portkey vs Bifrost** (đóng gói, OSS features, cost). xterm. Redaction | Hai agent chạy song song. Cost qua proxy khớp trong phạm vi 5%. Đã chọn proxy |
| **P0c: Platform spike** (song song) | 2 tuần | Rủi ro OS | Windows: node-pty/ConPTY, worktree có đường dẫn dài, **AppContainer**. mac/Linux: **sandbox-runtime** chạy Claude + Codex. Egress proxy PoC có SNI | Ma trận OS × level được ký duyệt |
| **P1: Single team, human-driven** | 4 tuần | End-to-end, human giao task | Graph editor (assigns/handoff/reviews). Board SQLite. Gateway qua unix socket/named pipe + token (P1 lọc theo assignee, chưa enforce edge đầy đủ). L0 + banner "advisory mode". State Writer. Journal. Timeline + cost. Merge queue + CI gate + HITL. i18n scaffold. **Tích hợp proxy đã chọn ở P0b**: sidecar đóng gói sẵn (hoặc trỏ tới proxy external), cấp virtual key per node, gắn metadata `task_id`, cost aggregator đọc spend log | 3 task: Dev (X), Reviewer (Y), human merge. Crash giữa chừng rồi mở lại vẫn resume. Cost khớp trong phạm vi 5% |
| **P2a: Enforcement** | 4 tuần | Enforce 3 tầng | Policy compiler + TaskQuery. L1 mac/Linux (sandbox-runtime), L2 container. Egress proxy đầy đủ. Tool allow-list theo role. Token rotation. Escape-test CI | Escape test 100% bị chặn trên mac và Linux |
| **P2b: Collaboration** | 3 tuần | Kênh chung | Wiki + template. HandoffDoc. Mail/can_message/groups. Lease + `touches`. Budget guard. RoleTemplate có version. Context manager | Handoff Claude → Codex qua HandoffDoc, không mất yêu cầu |
| **P3: Autonomy + nhiều runtime** | 4 tuần | Epic tự chạy | Planner tự tách task. Retry/escalation. Xử lý conflict. OpenCode, pi, Gemini/Cursor/Goose, driver `term-emu` (tự viết trên PTY). Rate-limit/fallback. Bảng giá có cache. Quarantine `web.fetch` | Epic 3–5 task, PRD → merge, ≤ 2 lần human can thiệp, qua 2 runtime |
| **P4: Eval + Observability** | 3 tuần | Đo chất lượng | SWE-bench Verified subset + Terminal-Bench + suite nội bộ. OTLP (Collector sidecar, Langfuse MIT). Replay. Webhook | Báo cáo so sánh 2 cấu hình, lặp lại được |
| **P5: Integrations + Windows L1** | 3 tuần | Backend thật | GitHub Issues/Projects + PR/CI. beads/Backlog.md/Jira/Linear. Multi-repo đầy đủ. Windows L1 (AppContainer) nếu P0c khả thi | Chạy trên repo GitHub thật với task từ Issues |
| **P6: Packaging** | 3 tuần | Phát hành | electron-builder, ký + notarize mac, ký Windows, auto-update, crash reporting, SBOM, a11y audit | Bản cài có ký trên 3 OS, axe không còn lỗi nghiêm trọng |
| **P7: Remote runners** | 4+ tuần | Job dài | Runner daemon, mTLS, Temporal/Restate (không bundle Restate server), L3 Firecracker/E2B | Job 8 giờ vẫn sống khi laptop sleep |

**First usable release (FUR), mốc demo trước khi có full autonomy:** P0a + P0b + P0c + P1 + P2a, **chỉ Claude và Codex**, khoảng **13–14 tuần** (P0c chạy song song). Phạm vi: graph editor, board SQLite, human giao task, Dev/Reviewer + merge queue + CI gate + HITL, proxy + cost `actual`, L1 trên mac/Linux (Windows ở L0/L2 advisory). Chưa gồm: wiki/handoff/mail (P2b), Planner tự tách task và runtime khác (P3). Exit FUR: exit criteria của P1 và P2a đều đạt, và một người ngoài team cài và chạy được preset Pair trong ≤ 15 phút. Toàn bộ MVP (P0a–P3) khoảng 24 tuần.

**Cắt scope khi trễ tiến độ** (theo thứ tự): Mesh preset, Linear/Jira backend, LLM-as-judge, Windows L1 (giữ L2), mail (chỉ giữ comment trên task).

---

## 10. Risks

| Rủi ro | Tác động | Giảm thiểu |
|---|---|---|
| Agent né Gateway qua shell | Policy vô nghĩa | L1/L2 sinh từ policy, escape-test CI, DB nằm ngoài vùng mount |
| Tunnel egress (registry, git, DNS) | Lộ dữ liệu, né cost | Egress proxy CONNECT+SNI, không có DNS trực tiếp, registry chỉ cho GET, agent không push |
| Gateway bị process khác gọi | Leo thang quyền | Unix socket/named pipe + ACL, token theo session có TTL và bind PID |
| Prompt injection từ web/peer | Agent bị điều khiển | Allow-list tool theo role, nhãn untrusted, quarantine + dual-LLM, HITL cho hành động nhạy cảm |
| ToS subscription | Tài khoản user bị khóa, rủi ro pháp lý | Node subscription chỉ là "ghế human" (mục 4.9), validator chặn đưa vào pipeline |
| Cursor/CLI auth riêng | Cost không đầy đủ | Nhãn unknown, tách khỏi actual |
| Proxy: LiteLLM gating/supply-chain/packaging Python | Hỏng cost, bản cài nặng | Benchmark 3 proxy, aggregator nội bộ, pin hash + SBOM |
| License (AGPL, ELv2, BSL, MPL, Commons Clause, `ee/`) | Pháp lý | Không bundle, chỉ kết nối qua protocol, checklist P0a |
| Merge conflict semantic giữa các Dev song song | Hỏng main, lãng phí | `touches`/lease, merge queue tuần tự, CI gate, chủ sở hữu conflict rõ ràng, escalation |
| Context tràn / chi phí cache | Chất lượng giảm, cost cao | Context manager, session theo task, giá cache riêng |
| CLI/API vendor đổi nhanh | Adapter hỏng | ACP trước, contract test fixture, pin version |
| sandbox-exec deprecated, Windows L1 khó | Mất L1 | sandbox-runtime (theo dõi upstream), Apple container / AppContainer / L2 |
| safeStorage plaintext trên Linux | Lộ key | Phát hiện backend, cảnh báo chặn, passphrase |
| Git/SQLite race | Hỏng state | Single-writer, WAL, merge UI |
| Crash/sleep | Mất tiến độ | Journal, powerMonitor, remote runner |
| Chất lượng thấp dù "done" | Ảo giác tiến độ | test_report, benchmark pin, chỉ số reopen |
| Roadmap trễ | Mất thời cơ | Danh sách cắt scope ở mục 9 |
| Cạnh tranh (Paperclip, Gas Town, Agent Teams, Conductor) | Khó khác biệt | 5 điểm khác biệt ở mục 2 |

---

## 11. Recommended Tech Stack

| Tầng | Lựa chọn | Ghi chú |
|---|---|---|
| Desktop shell | **Electron** + electron-vite (React + TS) | Tauri là phương án thay thế |
| UI | React, Tailwind, shadcn/ui (Radix, a11y tốt), Zustand, TanStack Query, i18next | |
| Graph editor | xyflow | Kèm view bảng thay thế cho a11y |
| Board | Pragmatic drag and drop | Có hướng dẫn a11y |
| Wiki | TipTap / Milkdown | |
| Terminal | xterm.js + node-pty | |
| IPC | Contract zod tự viết (hoặc electron-trpc-experimental) | electron-trpc ít hoạt động. electron-trpc-experimental rất nhỏ (~14 stars, cập nhật cuối 2025-06), nên ưu tiên contract tự viết |
| Adapter | ACP SDK, Claude stream-json/Agent SDK + hooks, Codex app-server/exec, OpenCode SDK, pi RPC, PTY fallback | agentapi đã archived: chỉ tham khảo, không làm dependency |
| MCP Gateway | `@modelcontextprotocol/sdk` + transport unix socket/named pipe. Đánh giá agentgateway cho authz | |
| Sandbox | **@anthropic-ai/sandbox-runtime** (mac/Linux), Landlock/seccomp, AppContainer (Windows), Docker/Podman/Apple container, gVisor tùy chọn | |
| Egress | Egress proxy (sandbox-runtime proxy hoặc proxy Node tự viết có CONNECT+SNI) | |
| Orchestration | Journal SQLite; Temporal/Restate ở P7 | |
| Storage | better-sqlite3 (WAL) + Drizzle, git CLI | |
| LLM proxy | Bifrost hoặc Portkey (sidecar mặc định, chốt ở P0b); LiteLLM tùy chọn; OpenRouter upstream | |
| Event schema | `squad.event.v1` + mapper OTel GenAI pin version | |
| Observability | OTel Collector sidecar tùy chọn, Langfuse (MIT), Phoenix chỉ khi user tự cài | |
| Secrets | Electron safeStorage + phát hiện backend Linux | Không dùng keytar |
| Testing | Vitest, Playwright + axe-core, contract fixture, escape-test, eval harness | |
| Packaging | electron-builder, notarize, ký Windows, electron-updater, SBOM | |

**Monorepo (pnpm + turborepo):**
```
apps/desktop  apps/runner
packages/core            # data model, TaskQuery, policy compiler, scheduler, journal, merge queue
packages/adapters/*      # acp, claude, codex, opencode, pi, ndjson, term-emu, pty   # term-emu tự viết, không phụ thuộc coder/agentapi
packages/sandbox         # profile generators (sandbox-runtime, bwrap, appcontainer, container) + escape tests
packages/egress          # egress proxy + allow-list
packages/mcp-gateway     # tools + policy filter + socket transport + token
packages/state-writer
packages/stores/*        # sqlite, github, beads, backlogmd, jira, linear
packages/observability   # event bus, redaction, otel mapper, cost aggregator, price tables, proxy clients
packages/eval            # suites (swe-bench subset, terminal-bench, internal), metrics
packages/role-templates  # versioned, i18n
packages/i18n
```

---

## 12. Những gì còn chưa làm trong v6
- Đã xong ở v5: xác minh URL, license, trạng thái archived của repo ở mục 3 và mục 11 (web 2026-09-27).
- Đã xong ở v6: định nghĩa inline Provider, Proxy, VirtualKey, Approval, Notification, Runner (mục 6); bỏ tên `agentapi` khỏi driver/kind/package (thay bằng `term-emu`); thống nhất `squad.event.v1`; P1 tích hợp proxy; quy tắc transition role AND edge; mốc FUR ở mục 9.
- Chưa đọc LICENSE theo commit hash cụ thể. Cần ghi hash khi thực sự fork hoặc nhúng.
- Chưa review pháp lý rider của mcp_agent_mail, Anthropic Commercial Terms của Claude Agent SDK (TS), phần enterprise của OpenHands.
- Chưa xác minh: số agent trong ACP registry, cờ ACP của Gemini CLI, ToS subscription, mức export OTel, Windows AppContainer, Linux keyring (xem mục 13).
- Chưa có mô hình nhiều human (RBAC, nhiều Head). Để sau P7.
- Chưa định giá cụ thể cho phần hosted.
- Chưa thiết kế cơ chế đồng bộ team qua metadata repo trên remote. Chỉ git push/pull thủ công.

---

## 13. Checklist xác minh (bắt buộc hoàn tất để thoát P0a)

1. [x] **License** (web 2026-09-27; commit hash ghi khi fork/nhúng):
   - [x] Gas Town MIT, beads MIT, claude-agent-acp Apache-2.0, mcp_agent_mail MIT + rider (cần review pháp lý), agentapi MIT (archived), Atlassian MCP Apache-2.0.
   - [x] Task Master MIT + Commons Clause, Agno **Apache-2.0** (không phải MPL-2.0), opcode AGPL-3.0, Daytona AGPL-3.0, Restate BUSL-1.1, Mastra `ee/` license riêng.
   - [x] Plane AGPL-3.0, Outline BUSL-1.1, MCPJungle MPL-2.0, sandbox-runtime Apache-2.0, Portkey MIT, Bifrost Apache-2.0, agentgateway Apache-2.0, Docker MCP Gateway MIT.
2. [ ] **Tính năng OSS và enterprise** của LiteLLM, Portkey, Bifrost: virtual key, budget per key, spend log.
3. [x] **URL live** của mọi repo đã đổi chỗ, vị trí mới của ccusage (ccusage/ccusage) và sandbox-runtime (anthropics/sandbox-runtime). Cột Verified đã điền ngày kiểm tra.
4. [ ] **Paperclip:** [x] URL/license/stars đã xác minh (web 2026-09-27: MIT, ~86.6k stars, chưa archived). Còn lại: adapter interface, data model, sandbox. Chốt build-vs-fork.
5. [ ] **ACP:** (repo ACP, claude-agent-acp, codex-acp đã xác minh URL/license) số agent trong registry, native hay adapter của 7 runtime chính, tên cờ ACP hiện hành của Gemini CLI, Cursor có ACP thật không.
6. [ ] **ToS** Anthropic (Consumer Terms, Agent SDK) và OpenAI về việc dùng subscription trong app bên thứ ba.
7. [ ] **Mức export OTel** của Claude Code, Codex, Gemini CLI theo version pin.
8. [ ] **Windows:** AppContainer có chạy được node/git/toolchain cho agent không.
9. [ ] **Linux:** tỉ lệ máy thiếu keyring trong nhóm persona. Hành vi của safeStorage khi thiếu keyring.
10. [ ] **Tính năng hiện hành** của Claude Code Agent Teams/subagents, để cập nhật bảng so sánh ở mục 2.