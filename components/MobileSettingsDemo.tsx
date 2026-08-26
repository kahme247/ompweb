"use client";

import { useState, useMemo, type ReactNode } from "react";
import {
  Settings2,
  ShieldCheck,
  Cpu,
  KeyRound,
  Sparkles,
  Bot,
  Cable,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  Search,
  Check,
  Plus,
  Trash2,
  Copy,
  SlidersHorizontal,
  ExternalLink,
  AlertCircle,
  Smartphone,
  Maximize2,
  CheckCircle2,
  X,
  Play
} from "lucide-react";

export type SettingsCategory =
  | "general"
  | "safety"
  | "models"
  | "providers"
  | "intelligence"
  | "agents"
  | "mcp"
  | "system";

interface CategoryMeta {
  id: SettingsCategory;
  label: string;
  description: string;
  icon: typeof Settings2;
  color: string;
  badge?: string;
}

const CATEGORIES: CategoryMeta[] = [
  {
    id: "general",
    label: "界面与操作偏好",
    description: "界面主题、工具折叠、完成提示音、提交行为",
    icon: Settings2,
    color: "#3B82F6",
  },
  {
    id: "safety",
    label: "安全与终端审批",
    description: "工具安全策略、YOLO 模式、Bash 终端命令权限",
    icon: ShieldCheck,
    color: "#10B981",
  },
  {
    id: "models",
    label: "AI 模型默认参数",
    description: "默认推理深度、回复详尽度、性格与思考块显示",
    icon: Cpu,
    color: "#8B5CF6",
  },
  {
    id: "providers",
    label: "模型服务商与 API Keys",
    description: "已连接的 OAuth、API Key 与自定义模型注册",
    icon: KeyRound,
    color: "#F59E0B",
    badge: "已配置 3 个",
  },
  {
    id: "intelligence",
    label: "智能体与记忆系统",
    description: "上下文自动压缩、持久记忆后端、自动重试机制",
    icon: Sparkles,
    color: "#EC4899",
  },
  {
    id: "agents",
    label: "智能体角色配置",
    description: "内置及自定义 Agent 角色、模型映射与工具限制",
    icon: Bot,
    color: "#06B6D4",
    badge: "6 个角色",
  },
  {
    id: "mcp",
    label: "扩展与 MCP 工具",
    description: "项目与全局 MCP Servers、技能工具箱管理",
    icon: Cable,
    color: "#6366F1",
    badge: "2 个在线",
  },
  {
    id: "system",
    label: "系统与应用更新",
    description: "版本检查、更新命令、活动会话重启管理",
    icon: RefreshCw,
    color: "#64748B",
    badge: "v0.8.2",
  },
];

// ── UI Primitives for Mobile ──────────────────────────────────────────────────

function MobileGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      {title && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            padding: "0 12px 6px",
          }}
        >
          {title}
        </div>
      )}
      <div
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      {description && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-dim)",
            lineHeight: 1.45,
            padding: "6px 12px 0",
          }}
        >
          {description}
        </div>
      )}
    </div>
  );
}

function MobileRow({
  label,
  description,
  action,
  onClick,
  isLast = false,
  icon,
}: {
  label: string;
  description?: string;
  action?: ReactNode;
  onClick?: () => void;
  isLast?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 14px",
        minHeight: 48,
        borderBottom: isLast ? "none" : "1px solid color-mix(in srgb, var(--border) 65%, transparent)",
        cursor: onClick ? "pointer" : "default",
        background: "transparent",
        transition: "background var(--dur-fast)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, paddingRight: 8 }}>
        {icon && <div style={{ flexShrink: 0 }}>{icon}</div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)", lineHeight: 1.35 }}>
            {label}
          </div>
          {description && (
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.35, marginTop: 2 }}>
              {description}
            </div>
          )}
        </div>
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

function MobileToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      style={{
        width: 44,
        height: 26,
        borderRadius: 13,
        background: checked ? "var(--accent)" : "color-mix(in srgb, var(--text-dim) 25%, transparent)",
        border: "none",
        padding: 2,
        cursor: "pointer",
        position: "relative",
        transition: "background 0.2s ease",
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          background: "#FFFFFF",
          boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
          transform: checked ? "translateX(18px)" : "translateX(0px)",
          transition: "transform 0.2s cubic-bezier(0.2, 0.85, 0.32, 1.2)",
        }}
      />
    </button>
  );
}

function MobileSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (val: T) => void;
}) {
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "6px 26px 6px 10px",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          outline: "none",
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div
        style={{
          position: "absolute",
          right: 8,
          pointerEvents: "none",
          fontSize: 10,
          color: "var(--text-muted)",
        }}
      >
        ▼
      </div>
    </div>
  );
}

// ── Main Demo Component ────────────────────────────────────────────────────────

export function MobileSettingsDemo() {
  // Navigation Stack State
  const [currentView, setCurrentView] = useState<
    | { type: "root" }
    | { type: "category"; category: SettingsCategory }
    | { type: "provider-editor"; providerId: string }
    | { type: "mcp-editor"; serverName: string }
    | { type: "agent-editor"; agentName: string }
  >({ type: "root" });

  const [searchQuery, setSearchQuery] = useState("");
  const [previewMode, setPreviewMode] = useState<"phone" | "fullscreen">("phone");
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // General Settings State
  const [keepCollapsed, setKeepCollapsed] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [submitBehavior, setSubmitBehavior] = useState("steer");

  // Safety State
  const [approvalMode, setApprovalMode] = useState("write");
  const [bashOverride, setBashOverride] = useState("prompt");

  // Models State
  const [thinkingLevel, setThinkingLevel] = useState("high");
  const [verbosity, setVerbosity] = useState("medium");
  const [personality, setPersonality] = useState("default");
  const [hideThinking, setHideThinking] = useState(false);

  // Intelligence State
  const [autoCompact, setAutoCompact] = useState(true);
  const [memoryBackend, setMemoryBackend] = useState("mnemopi");
  const [autoRetry, setAutoRetry] = useState(true);

  // Mock Providers & MCP
  const [providers, setProviders] = useState([
    { id: "dashscope", name: "阿里云百炼 (DashScope)", models: ["qwen-max", "qwen-plus", "deepseek-r1"], active: true },
    { id: "openai", name: "OpenAI", models: ["gpt-4o", "o3-mini", "gpt-4o-mini"], active: true },
    { id: "anthropic", name: "Anthropic", models: ["claude-3-5-sonnet", "claude-3-5-haiku"], active: false },
  ]);

  const [mcpServers, setMcpServers] = useState([
    { name: "filesystem", type: "stdio", enabled: true, valid: true },
    { name: "github", type: "http", enabled: true, valid: true },
    { name: "memory", type: "stdio", enabled: false, valid: true },
  ]);

  const [agents, setAgents] = useState([
    { name: "scout", description: "快速只读探索与代码定位专家", scope: "bundled", model: "qwen-plus" },
    { name: "task", description: "多步骤复杂任务执行代理", scope: "bundled", model: "qwen-max" },
    { name: "reviewer", description: "代码审查与架构规范验证", scope: "user", model: "qwen-max" },
  ]);

  // Selected Editor State
  const [editingProvider, setEditingProvider] = useState({
    id: "dashscope",
    name: "阿里云百炼 (DashScope)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "sk-••••••••••••••••••••",
    modelsStr: "qwen-max, qwen-plus, qwen-turbo, deepseek-r1, deepseek-v3",
  });

  const [editingMcp, setEditingMcp] = useState({
    name: "filesystem",
    json: JSON.stringify({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"] }, null, 2),
  });

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2500);
  };

  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return CATEGORIES;
    const q = searchQuery.toLowerCase();
    return CATEGORIES.filter(
      (c) => c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  // Header Title & Back Action
  const headerInfo = useMemo(() => {
    switch (currentView.type) {
      case "root":
        return { title: "设置", canBack: false };
      case "category": {
        const cat = CATEGORIES.find((c) => c.id === currentView.category);
        return { title: cat?.label || "设置", canBack: true, onBack: () => setCurrentView({ type: "root" }) };
      }
      case "provider-editor":
        return {
          title: editingProvider.name || "编辑服务商",
          canBack: true,
          onBack: () => setCurrentView({ type: "category", category: "providers" }),
        };
      case "mcp-editor":
        return {
          title: `MCP: ${editingMcp.name}`,
          canBack: true,
          onBack: () => setCurrentView({ type: "category", category: "mcp" }),
        };
      case "agent-editor":
        return {
          title: `Agent: ${currentView.agentName}`,
          canBack: true,
          onBack: () => setCurrentView({ type: "category", category: "agents" }),
        };
    }
  }, [currentView, editingProvider.name, editingMcp.name]);

  const renderContent = () => {
    // 1. ROOT VIEW (SETTINGS INDEX)
    if (currentView.type === "root") {
      return (
        <div style={{ padding: "14px 16px" }}>
          {/* Search Bar */}
          <div
            style={{
              position: "relative",
              marginBottom: 16,
              background: "var(--bg-panel)",
              borderRadius: 10,
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              padding: "0 10px",
            }}
          >
            <Search size={15} style={{ color: "var(--text-muted)", marginRight: 8, flexShrink: 0 }} />
            <input
              type="text"
              placeholder="搜索所有设置项、参数、提供商..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: "100%",
                height: 38,
                border: "none",
                background: "transparent",
                color: "var(--text)",
                fontSize: 13,
                outline: "none",
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-muted)",
                  padding: 4,
                  cursor: "pointer",
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Quick Notice Card */}
          <div
            style={{
              padding: "10px 14px",
              background: "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))",
              border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
              borderRadius: 12,
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Sparkles size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.35 }}>
              <span style={{ fontWeight: 600 }}>全新移动端交互：</span>
              点击任意分类直接进入专属配置卡片，告别多层局部滚动与拥挤 Tab！
            </div>
          </div>

          {/* Categories Inset Grouped List */}
          <MobileGroup title="全部设置分类">
            {filteredCategories.map((cat, idx) => {
              const Icon = cat.icon;
              return (
                <MobileRow
                  key={cat.id}
                  isLast={idx === filteredCategories.length - 1}
                  label={cat.label}
                  description={cat.description}
                  icon={
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: `color-mix(in srgb, ${cat.color} 15%, transparent)`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: cat.color,
                      }}
                    >
                      <Icon size={17} />
                    </div>
                  }
                  action={
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {cat.badge && (
                        <span
                          style={{
                            fontSize: 10.5,
                            padding: "2px 7px",
                            borderRadius: 10,
                            background: "var(--bg-subtle)",
                            color: "var(--text-muted)",
                            fontWeight: 500,
                          }}
                        >
                          {cat.badge}
                        </span>
                      )}
                      <ChevronRight size={16} style={{ color: "var(--text-dim)" }} />
                    </div>
                  }
                  onClick={() => setCurrentView({ type: "category", category: cat.id })}
                />
              );
            })}
          </MobileGroup>
        </div>
      );
    }

    // 2. CATEGORY VIEW: GENERAL
    if (currentView.type === "category" && currentView.category === "general") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="界面与展示">
            <MobileRow
              label="默认折叠工具调用"
              description="工具执行时仅显示紧凑状态，保持界面清爽"
              action={<MobileToggle checked={keepCollapsed} onChange={setKeepCollapsed} />}
            />
            <MobileRow
              label="执行完成提示音"
              description="Agent 完成长耗时任务时播放轻快提示音"
              isLast
              action={<MobileToggle checked={soundEnabled} onChange={setSoundEnabled} />}
            />
          </MobileGroup>

          <MobileGroup title="操作交互行为">
            <MobileRow
              label="运行时提交行为"
              description="当智能体正在运行时点击发送的处理策略"
              isLast
              action={
                <MobileSelect
                  value={submitBehavior}
                  options={[
                    { label: "中断并引导 (Steer)", value: "steer" },
                    { label: "加入等待队列 (Queue)", value: "queue" },
                  ]}
                  onChange={setSubmitBehavior}
                />
              }
            />
          </MobileGroup>
        </div>
      );
    }

    // 3. CATEGORY VIEW: SAFETY
    if (currentView.type === "category" && currentView.category === "safety") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="工具审批模式">
            <MobileRow
              label="审批模式 (Approval Mode)"
              description="控制 OMP 何时在调用工具前向你请求确认"
              action={
                <MobileSelect
                  value={approvalMode}
                  options={[
                    { label: "总是询问 (Always Ask)", value: "always-ask" },
                    { label: "仅写操作询问 (Write)", value: "write" },
                    { label: "全自动执行 (YOLO)", value: "yolo" },
                  ]}
                  onChange={setApprovalMode}
                />
              }
            />
            <MobileRow
              label="Bash 终端命令覆盖"
              description="专门针对终端 Shell 命令的独立安全策略"
              isLast
              action={
                <MobileSelect
                  value={bashOverride}
                  options={[
                    { label: "继承全局 (Prompt)", value: "prompt" },
                    { label: "直接允许 (Allow)", value: "allow" },
                    { label: "直接拒绝 (Deny)", value: "deny" },
                  ]}
                  onChange={setBashOverride}
                />
              }
            />
          </MobileGroup>
        </div>
      );
    }

    // 4. CATEGORY VIEW: MODELS
    if (currentView.type === "category" && currentView.category === "models") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="推理与思考深度">
            <MobileRow
              label="默认思考预算 (Reasoning)"
              description="具备思考链模型（如 R1/o3/Claude）的默认思考等级"
              action={
                <MobileSelect
                  value={thinkingLevel}
                  options={[
                    { label: "Auto (自动)", value: "auto" },
                    { label: "High (高)", value: "high" },
                    { label: "Medium (中)", value: "medium" },
                    { label: "Low (低)", value: "low" },
                  ]}
                  onChange={setThinkingLevel}
                />
              }
            />
            <MobileRow
              label="隐藏思考折叠块"
              description="对话流中不渲染模型的思考推理过程"
              isLast
              action={<MobileToggle checked={hideThinking} onChange={setHideThinking} />}
            />
          </MobileGroup>

          <MobileGroup title="模型回复风格">
            <MobileRow
              label="回复详尽度 (Verbosity)"
              description="控制支持模型生成的回复详细程度"
              action={
                <MobileSelect
                  value={verbosity}
                  options={[
                    { label: "Compact (精炼)", value: "low" },
                    { label: "Medium (标准)", value: "medium" },
                    { label: "Detailed (详尽)", value: "high" },
                  ]}
                  onChange={setVerbosity}
                />
              }
            />
            <MobileRow
              label="性格设定 (Personality)"
              description="注入系统 Prompt 的语气风格规范"
              isLast
              action={
                <MobileSelect
                  value={personality}
                  options={[
                    { label: "Default (默认严谨)", value: "default" },
                    { label: "Pragmatic (实用务实)", value: "pragmatic" },
                    { label: "Friendly (亲切友好)", value: "friendly" },
                  ]}
                  onChange={setPersonality}
                />
              }
            />
          </MobileGroup>
        </div>
      );
    }

    // 5. CATEGORY VIEW: PROVIDERS (MASTER-DETAIL DRILLDOWN)
    if (currentView.type === "category" && currentView.category === "providers") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>已配置的模型服务商</span>
            <button
              type="button"
              onClick={() => {
                setEditingProvider({
                  id: "custom",
                  name: "自定义服务商",
                  baseUrl: "https://api.example.com/v1",
                  apiKey: "",
                  modelsStr: "custom-model-1",
                });
                setCurrentView({ type: "provider-editor", providerId: "custom" });
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "5px 10px",
                background: "var(--accent)",
                color: "#FFF",
                border: "none",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              <Plus size={13} /> 添加
            </button>
          </div>

          <MobileGroup description="点击任意服务商可下钻修改 API Key、BaseURL 及模型列表。">
            {providers.map((p, idx) => (
              <MobileRow
                key={p.id}
                isLast={idx === providers.length - 1}
                label={p.name}
                description={`包含 ${p.models.join(", ")}`}
                icon={
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: p.active ? "var(--status-success)" : "var(--text-dim)",
                    }}
                  />
                }
                action={
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.models.length} 个模型</span>
                    <ChevronRight size={16} style={{ color: "var(--text-dim)" }} />
                  </div>
                }
                onClick={() => {
                  setEditingProvider({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.id === "dashscope" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://api.openai.com/v1",
                    apiKey: "sk-••••••••••••••••••••",
                    modelsStr: p.models.join(", "),
                  });
                  setCurrentView({ type: "provider-editor", providerId: p.id });
                }}
              />
            ))}
          </MobileGroup>
        </div>
      );
    }

    // 6. LEVEL 3: PROVIDER EDITOR FULLSCREEN
    if (currentView.type === "provider-editor") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="基本配置">
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 6 }}>
                服务商显示名称
              </label>
              <input
                type="text"
                value={editingProvider.name}
                onChange={(e) => setEditingProvider({ ...editingProvider, name: e.target.value })}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 6 }}>
                API Base URL
              </label>
              <input
                type="text"
                value={editingProvider.baseUrl}
                onChange={(e) => setEditingProvider({ ...editingProvider, baseUrl: e.target.value })}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ padding: "12px 14px" }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 6 }}>
                API Key 密钥
              </label>
              <input
                type="password"
                value={editingProvider.apiKey}
                onChange={(e) => setEditingProvider({ ...editingProvider, apiKey: e.target.value })}
                placeholder="sk-..."
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  outline: "none",
                }}
              />
            </div>
          </MobileGroup>

          <MobileGroup title="包含的模型列表" description="以英文逗号分隔，第一个模型为默认推荐模型。">
            <div style={{ padding: "12px 14px" }}>
              <textarea
                value={editingProvider.modelsStr}
                onChange={(e) => setEditingProvider({ ...editingProvider, modelsStr: e.target.value })}
                rows={3}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  outline: "none",
                  resize: "vertical",
                }}
              />
            </div>
          </MobileGroup>

          {/* Action Buttons */}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => showToast("正在测试连通性... 延迟: 128ms (成功)")}
              style={{
                flex: 1,
                padding: "10px 0",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                color: "var(--text)",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <Play size={13} /> 测试连接
            </button>
            <button
              type="button"
              onClick={() => {
                showToast("服务商配置已保存！");
                setCurrentView({ type: "category", category: "providers" });
              }}
              style={{
                flex: 1,
                padding: "10px 0",
                background: "var(--accent)",
                border: "none",
                borderRadius: 10,
                color: "#FFF",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <Check size={14} /> 保存配置
            </button>
          </div>
        </div>
      );
    }

    // 7. CATEGORY VIEW: MCP (MASTER-DETAIL DRILLDOWN)
    if (currentView.type === "category" && currentView.category === "mcp") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>项目 MCP 服务列表</span>
            <button
              type="button"
              onClick={() => {
                setEditingMcp({
                  name: "new-server",
                  json: JSON.stringify({ type: "stdio", command: "", args: [] }, null, 2),
                });
                setCurrentView({ type: "mcp-editor", serverName: "new-server" });
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "5px 10px",
                background: "var(--accent)",
                color: "#FFF",
                border: "none",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              <Plus size={13} /> 新建 Server
            </button>
          </div>

          <MobileGroup description="点击任意服务可全宽编辑 JSON 配置与命令行参数。">
            {mcpServers.map((s, idx) => (
              <MobileRow
                key={s.name}
                isLast={idx === mcpServers.length - 1}
                label={s.name}
                description={`类型: ${s.type} · ${s.enabled ? "已启用" : "已禁用"}`}
                icon={
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: s.enabled ? "var(--status-success)" : "var(--text-dim)",
                    }}
                  />
                }
                action={
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <MobileToggle
                      checked={s.enabled}
                      onChange={(val) => {
                        setMcpServers(mcpServers.map((item) => (item.name === s.name ? { ...item, enabled: val } : item)));
                        showToast(`已${val ? "启用" : "禁用"} ${s.name}`);
                      }}
                    />
                    <ChevronRight
                      size={16}
                      style={{ color: "var(--text-dim)", cursor: "pointer" }}
                      onClick={() => {
                        setEditingMcp({
                          name: s.name,
                          json: JSON.stringify({ type: s.type, command: s.name === "filesystem" ? "npx" : "node", args: ["server.js"] }, null, 2),
                        });
                        setCurrentView({ type: "mcp-editor", serverName: s.name });
                      }}
                    />
                  </div>
                }
                onClick={() => {
                  setEditingMcp({
                    name: s.name,
                    json: JSON.stringify({ type: s.type, command: s.name === "filesystem" ? "npx" : "node", args: ["server.js"] }, null, 2),
                  });
                  setCurrentView({ type: "mcp-editor", serverName: s.name });
                }}
              />
            ))}
          </MobileGroup>
        </div>
      );
    }

    // 8. LEVEL 3: MCP EDITOR FULLSCREEN
    if (currentView.type === "mcp-editor") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="Server 标识">
            <div style={{ padding: "12px 14px" }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 6 }}>
                服务唯一名称 (Name)
              </label>
              <input
                type="text"
                value={editingMcp.name}
                onChange={(e) => setEditingMcp({ ...editingMcp, name: e.target.value })}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>
          </MobileGroup>

          <MobileGroup title="JSON 配置 (全宽编辑)" description="支持 stdio, http, sse 等标准协议配置。">
            <div style={{ padding: "12px 14px" }}>
              <textarea
                value={editingMcp.json}
                onChange={(e) => setEditingMcp({ ...editingMcp, json: e.target.value })}
                rows={8}
                style={{
                  width: "100%",
                  padding: "10px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  lineHeight: 1.45,
                  outline: "none",
                  resize: "vertical",
                }}
              />
            </div>
          </MobileGroup>

          {/* Action Buttons */}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              type="button"
              onClick={() => {
                showToast(`已删除 ${editingMcp.name}`);
                setCurrentView({ type: "category", category: "mcp" });
              }}
              style={{
                padding: "10px 14px",
                background: "color-mix(in srgb, var(--status-error) 10%, var(--bg-panel))",
                border: "1px solid color-mix(in srgb, var(--status-error) 30%, transparent)",
                borderRadius: 10,
                color: "var(--status-error)",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <Trash2 size={13} /> 删除
            </button>
            <button
              type="button"
              onClick={() => {
                showToast("MCP 配置已成功保存！");
                setCurrentView({ type: "category", category: "mcp" });
              }}
              style={{
                flex: 1,
                padding: "10px 0",
                background: "var(--accent)",
                border: "none",
                borderRadius: 10,
                color: "#FFF",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <Check size={14} /> 保存配置
            </button>
          </div>
        </div>
      );
    }

    // 9. CATEGORY VIEW: AGENTS
    if (currentView.type === "category" && currentView.category === "agents") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="智能体角色列表" description="点击角色可修改分配模型及专属提示词。">
            {agents.map((a, idx) => (
              <MobileRow
                key={a.name}
                isLast={idx === agents.length - 1}
                label={a.name}
                description={a.description}
                icon={
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 6,
                      background: "var(--bg-subtle)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--accent)",
                    }}
                  >
                    <Bot size={15} />
                  </div>
                }
                action={
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "var(--bg-subtle)",
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {a.model}
                    </span>
                    <ChevronRight size={16} style={{ color: "var(--text-dim)" }} />
                  </div>
                }
                onClick={() => showToast(`正在打开 ${a.name} 详情...`)}
              />
            ))}
          </MobileGroup>
        </div>
      );
    }

    // 10. CATEGORY VIEW: INTELLIGENCE
    if (currentView.type === "category" && currentView.category === "intelligence") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="上下文自动压缩">
            <MobileRow
              label="启用自动压缩 (Compaction)"
              description="在接近模型上下文上限时智能无损摘要"
              action={<MobileToggle checked={autoCompact} onChange={setAutoCompact} />}
            />
          </MobileGroup>

          <MobileGroup title="记忆与经验沉淀">
            <MobileRow
              label="记忆存储后端"
              description="跨会话持久化存储项目经验与偏好知识"
              isLast
              action={
                <MobileSelect
                  value={memoryBackend}
                  options={[
                    { label: "Mnemopi (推荐)", value: "mnemopi" },
                    { label: "本地文件 (Local)", value: "local" },
                    { label: "关闭记忆 (Off)", value: "off" },
                  ]}
                  onChange={setMemoryBackend}
                />
              }
            />
          </MobileGroup>

          <MobileGroup title="异常自动恢复">
            <MobileRow
              label="失败自动重试"
              description="遇网络波动或模型偶发错误时自动重试"
              isLast
              action={<MobileToggle checked={autoRetry} onChange={setAutoRetry} />}
            />
          </MobileGroup>
        </div>
      );
    }

    // 11. CATEGORY VIEW: SYSTEM
    if (currentView.type === "category" && currentView.category === "system") {
      return (
        <div style={{ padding: "14px 16px" }}>
          <MobileGroup title="版本状态">
            <MobileRow
              label="omp-web 运行版本"
              description="已是最新稳定版本"
              action={
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--status-success)",
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: "color-mix(in srgb, var(--status-success) 12%, transparent)",
                  }}
                >
                  v0.8.2
                </span>
              }
            />
          </MobileGroup>

          <MobileGroup title="更新与维护命令" description="可在终端运行以下命令更新或重启后台服务。">
            <div style={{ padding: "12px 14px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--text)",
                }}
              >
                <span>npm install -g @kahme247/ompweb</span>
                <button
                  type="button"
                  onClick={() => showToast("已复制更新命令到剪贴板！")}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    padding: 2,
                  }}
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
          </MobileGroup>
        </div>
      );
    }

    return null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", minHeight: "100%" }}>
      {/* Control Bar: Toggle Simulator vs Fullscreen */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 20,
          margin: "16px auto",
          fontSize: 12,
          color: "var(--text)",
        }}
      >
        <span style={{ fontWeight: 600 }}>预览视图模式：</span>
        <button
          type="button"
          onClick={() => setPreviewMode("phone")}
          style={{
            padding: "4px 10px",
            border: "none",
            borderRadius: 12,
            background: previewMode === "phone" ? "var(--accent)" : "transparent",
            color: previewMode === "phone" ? "#FFF" : "var(--text-muted)",
            fontWeight: 500,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Smartphone size={13} /> 手机模拟器框
        </button>
        <button
          type="button"
          onClick={() => setPreviewMode("fullscreen")}
          style={{
            padding: "4px 10px",
            border: "none",
            borderRadius: 12,
            background: previewMode === "fullscreen" ? "var(--accent)" : "transparent",
            color: previewMode === "fullscreen" ? "#FFF" : "var(--text-muted)",
            fontWeight: 500,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Maximize2 size={13} /> 全屏真机响应
        </button>
      </div>

      {/* Main Container */}
      <div
        style={{
          width: previewMode === "phone" ? 390 : "100%",
          maxWidth: previewMode === "phone" ? 390 : 480,
          height: previewMode === "phone" ? 800 : "calc(100dvh - 80px)",
          maxHeight: previewMode === "phone" ? 800 : "100%",
          background: "var(--bg)",
          border: previewMode === "phone" ? "8px solid #2B2823" : "1px solid var(--border)",
          borderRadius: previewMode === "phone" ? 40 : 0,
          boxShadow: previewMode === "phone" ? "0 25px 50px -12px rgba(0, 0, 0, 0.35)" : "none",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          margin: "0 auto 40px",
        }}
      >
        {/* Dynamic Island / Top Notch (for Simulator) */}
        {previewMode === "phone" && (
          <div
            style={{
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div
              style={{
                width: 100,
                height: 14,
                borderRadius: 7,
                background: "#000",
              }}
            />
          </div>
        )}

        {/* Navigation Bar */}
        <div
          style={{
            height: 48,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 14px",
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ width: 60, display: "flex", alignItems: "center" }}>
            {headerInfo.canBack && (
              <button
                type="button"
                onClick={headerInfo.onBack}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                  border: "none",
                  background: "transparent",
                  color: "var(--accent)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <ChevronLeft size={18} /> 返回
              </button>
            )}
          </div>
          <div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)", textAlign: "center", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {headerInfo.title}
          </div>
          <div style={{ width: 60, display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => showToast("在实际应用中将关闭设置弹窗")}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--text-muted)",
                fontSize: 18,
                cursor: "pointer",
                padding: "2px 6px",
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Scrollable Body Content (Single Scroll Container) */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            paddingBottom: 24,
          }}
        >
          {renderContent()}
        </div>

        {/* Toast Feedback */}
        {toastMsg && (
          <div
            style={{
              position: "absolute",
              bottom: 24,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(20, 20, 20, 0.92)",
              color: "#FFF",
              padding: "8px 16px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 500,
              boxShadow: "0 8px 16px rgba(0,0,0,0.25)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              zIndex: 100,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            <CheckCircle2 size={14} style={{ color: "#10B981" }} />
            {toastMsg}
          </div>
        )}
      </div>
    </div>
  );
}
