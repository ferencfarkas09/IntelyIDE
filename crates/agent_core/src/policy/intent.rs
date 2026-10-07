//! `ToolIntent`: what an adapter sends instead of deciding itself (providers-plan 1.6, 5.4).
//! Adapters map a provider tool name to a class and pass the raw input; Rust parses and judges it.

use serde_json::Value;

wire_enums! {
    pub enum ToolClass {
        Exec,
        Write,
        Read,
        Net,
        Mcp,
        Other,
    }
}

/// What a tool call needs the broker to judge. Serialised by hand: the three delegation fields (`actor`, `isolation`,
/// `subagentFlags`) are left out when absent, so an intent without them is byte-identical to what it was before they
/// existed (specta cannot express `skip_serializing_if` in its unified export, hence no derive).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ToolIntent {
    pub class: ToolClass,
    /// The provider's own tool name (`Bash`, `Task`, `mcp__github__get_issue`); the broker needs it for
    /// class `other` and for MCP calls.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub tool: Option<String>,
    /// The shell string, exactly as the model wrote it. This is what gets judged.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub raw_command: Option<String>,
    /// Already-split argv (ACP style); judged only when there is no `raw_command`.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub argv: Option<Vec<String>>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub paths: Vec<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub url: Option<String>,
    /// MCP server name (the part after `mcp__` of `tool`).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub server: Option<String>,
    /// The MCP tool's `readOnlyHint` annotation, when it has one.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub read_only_hint: Option<bool>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub subagent_type: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub parent_tool_id: Option<String>,
    /// Who made the call ((design notes: roles-orchestration-spec) 4.1): `None` = the lead of a run without a sub-agent in
    /// flight. The harness fills it from the SDK's `agent_id`/`agent_type`, never from tool input.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub actor: Option<Actor>,
    /// `isolation` of an `Agent` input (`worktree`, `remote`), so the broker can refuse it.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub isolation: Option<String>,
    /// Facts of an `Agent` input the broker judges (it never sees the input itself).
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(optional))]
    pub subagent_flags: Option<SubagentFlags>,
    /// MCP call: the raw candidate strings of the input, for the argument guard to judge (mcp-management spec 5.4.1). NEVER
    /// serialised (the type is written by hand and skips it, specta does not list it), so it cannot reach an event, the event log,
    /// a card or the phone; `Deserialize` reads it from the sidecar's `policy/decide` message only.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(skip))]
    pub args: Vec<String>,
    /// A cap of [`collect_mcp_args`] was exceeded: the guard cannot vouch for the call (a hard stop in every mode). Like `args` it is
    /// part of the sidecar-to-Rust `policy/decide` message only and is not listed in the generated TypeScript (the sidecar types
    /// `args?: string[]` and `argsUnjudgeable?: boolean` on its own message); it serialises only when true.
    #[serde(default)]
    #[cfg_attr(feature = "specta", specta(skip))]
    pub args_unjudgeable: bool,
    pub summary: String,
}

impl serde::Serialize for ToolIntent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let present = [self.actor.is_some(), self.isolation.is_some(), self.subagent_flags.is_some(), self.args_unjudgeable].iter().filter(|p| **p).count();
        let mut st = serializer.serialize_struct("ToolIntent", 11 + present)?;
        st.serialize_field("class", &self.class)?;
        st.serialize_field("tool", &self.tool)?;
        st.serialize_field("rawCommand", &self.raw_command)?;
        st.serialize_field("argv", &self.argv)?;
        st.serialize_field("paths", &self.paths)?;
        st.serialize_field("url", &self.url)?;
        st.serialize_field("server", &self.server)?;
        st.serialize_field("readOnlyHint", &self.read_only_hint)?;
        st.serialize_field("subagentType", &self.subagent_type)?;
        st.serialize_field("parentToolId", &self.parent_tool_id)?;
        if let Some(a) = &self.actor {
            st.serialize_field("actor", a)?;
        }
        if let Some(i) = &self.isolation {
            st.serialize_field("isolation", i)?;
        }
        if let Some(f) = &self.subagent_flags {
            st.serialize_field("subagentFlags", f)?;
        }
        if self.args_unjudgeable {
            st.serialize_field("argsUnjudgeable", &true)?;
        }
        st.serialize_field("summary", &self.summary)?;
        st.end()
    }
}

wire_types! {
    /// The actor of a tool call made inside a sub-agent. `role` is the SDK `agent_type`; `?` when the sidecar cannot name
    /// it (fail closed: the broker denies an actor it does not know).
    #[serde(rename_all = "camelCase")]
    pub struct Actor {
        pub agent_id: String,
        pub role: String,
    }

    /// What an `Agent`/`Task` call asks for, as the broker needs it.
    #[serde(rename_all = "camelCase")]
    pub struct SubagentFlags {
        /// The input names a `model` (it would override the role's model).
        pub has_model: bool,
        /// `run_in_background` as given; `None` = omitted (the CLI default is background).
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub background: Option<bool>,
        #[serde(default)]
        #[cfg_attr(feature = "specta", specta(optional))]
        pub subagent_type: Option<String>,
    }

    /// Body of `policy/decide`.
    #[serde(rename_all = "camelCase")]
    pub struct PolicyRequest {
        pub agent_id: String,
        pub tool_id: String,
        pub provider: String,
        pub intent: ToolIntent,
    }
}

impl ToolIntent {
    pub fn new(class: ToolClass, summary: impl Into<String>) -> Self {
        Self {
            class,
            tool: None,
            raw_command: None,
            argv: None,
            paths: Vec::new(),
            url: None,
            server: None,
            read_only_hint: None,
            subagent_type: None,
            parent_tool_id: None,
            actor: None,
            isolation: None,
            subagent_flags: None,
            args: Vec::new(),
            args_unjudgeable: false,
            summary: summary.into(),
        }
    }

    pub fn exec(raw: &str) -> Self {
        let mut i = Self::new(ToolClass::Exec, shorten(raw));
        i.tool = Some("Bash".into());
        i.raw_command = Some(raw.to_string());
        i
    }

    pub fn write(paths: &[&str]) -> Self {
        let mut i = Self::new(ToolClass::Write, format!("write {}", paths.join(", ")));
        i.tool = Some("Write".into());
        i.paths = paths.iter().map(|p| p.to_string()).collect();
        i
    }

    pub fn read(paths: &[&str]) -> Self {
        let mut i = Self::new(ToolClass::Read, format!("read {}", paths.join(", ")));
        i.tool = Some("Read".into());
        i.paths = paths.iter().map(|p| p.to_string()).collect();
        i
    }

    pub fn net(url: &str) -> Self {
        let mut i = Self::new(ToolClass::Net, format!("fetch {url}"));
        i.tool = Some("WebFetch".into());
        i.url = Some(url.to_string());
        i
    }

    pub fn mcp(server: &str, tool: &str) -> Self {
        let mut i = Self::new(ToolClass::Mcp, format!("{server}.{tool}"));
        i.tool = Some(format!("mcp__{server}__{tool}"));
        i.server = Some(server.to_string());
        i
    }

    pub fn other(tool_name: &str) -> Self {
        let mut i = Self::new(ToolClass::Other, tool_name);
        i.tool = Some(tool_name.to_string());
        i
    }

    /// Maps a Claude tool call (name + raw input) to an intent (providers-plan 5.4 table).
    /// Unknown tool names become class `other`, which the broker answers with `ask`.
    pub fn from_claude_tool(name: &str, input: &Value) -> Self {
        let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
        match name {
            "Bash" => {
                let mut i = Self::new(ToolClass::Exec, shorten(&text("command").unwrap_or_default()));
                i.tool = Some(name.into());
                i.raw_command = text("command");
                i
            }
            "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
                let paths: Vec<String> = ["file_path", "notebook_path"].iter().filter_map(|k| text(k)).collect();
                let mut i = Self::new(ToolClass::Write, format!("{} {}", name.to_lowercase(), paths.join(", ")));
                i.tool = Some(name.into());
                i.paths = paths;
                i
            }
            "Read" | "Grep" | "Glob" | "LS" => {
                let mut paths: Vec<String> = ["file_path", "path"].iter().filter_map(|k| text(k)).collect();
                if name == "Glob" {
                    // An absolute glob pattern reads outside the cwd even without a `path`.
                    if let Some(p) = text("pattern").filter(|p| p.starts_with('/') || p.starts_with('~')) {
                        paths.push(p.split(['*', '?', '[', '{']).next().unwrap_or("").to_string());
                    }
                }
                let mut i = Self::new(ToolClass::Read, format!("{} {}", name.to_lowercase(), paths.join(", ")));
                i.tool = Some(name.into());
                i.paths = paths;
                i
            }
            "WebFetch" | "WebSearch" => {
                let url = text("url");
                let mut i = Self::new(ToolClass::Net, format!("{} {}", name, url.clone().or_else(|| text("query")).unwrap_or_default()));
                i.tool = Some(name.into());
                i.url = url;
                i
            }
            "Task" | "Agent" => {
                let mut i = Self::other(name);
                i.subagent_type = text("subagent_type");
                i.isolation = text("isolation");
                i.subagent_flags = Some(SubagentFlags {
                    has_model: input.get("model").is_some_and(|m| !m.is_null()),
                    background: input.get("run_in_background").and_then(Value::as_bool),
                    subagent_type: i.subagent_type.clone(),
                });
                i
            }
            // The CLI's own resource tools join the MCP class with the pseudo-tool key `resources` (mcp-management spec 5.4 step 1);
            // `server` comes from the input, and a call without one is judged `mcp.resource-server`.
            "ListMcpResourcesTool" | "ReadMcpResourceTool" | "ReadMcpResourceDir" | "RefreshMcpTools" => {
                let server = text("server").filter(|s| !s.is_empty());
                let mut i = Self::new(ToolClass::Mcp, format!("{}: {}", server.as_deref().unwrap_or("(no server)"), name));
                i.tool = Some(name.into());
                i.server = server;
                (i.args, i.args_unjudgeable) = collect_mcp_args(input);
                i
            }
            // Anything named `mcp__...` is an MCP call, also a malformed one (`mcp__`, `mcp____x`, `mcp__a__`): the broker denies it as
            // `mcp.unknown` instead of letting it fall into the unknown-tool row.
            _ => match name.strip_prefix("mcp__").map(|rest| rest.split_once("__").unwrap_or((rest, ""))) {
                Some((server, tool)) => {
                    let mut i = Self::mcp(server, tool);
                    i.tool = Some(name.into());
                    (i.args, i.args_unjudgeable) = collect_mcp_args(input);
                    i
                }
                None => match text("command") {
                    // Monitor and any other tool that runs a shell string are judged like Bash.
                    Some(cmd) => {
                        let mut i = Self::new(ToolClass::Exec, shorten(&cmd));
                        i.tool = Some(name.into());
                        i.raw_command = Some(cmd);
                        i
                    }
                    None => Self::other(name),
                },
            },
        }
    }
}

/// The four built-in tools of the CLI that read or refresh MCP resources; they are judged like MCP tools of the pseudo-tool `resources`.
pub const MCP_RESOURCE_TOOLS: [&str; 4] = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDir", "RefreshMcpTools"];

/// A string of an MCP call's input that could be a path, trimmed (mcp-management spec 5.4.1): no line break, at most 4096
/// characters, and either no whitespace or a start with `/`, `~` or `file://`.
pub fn mcp_candidate(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() || t.chars().count() > 4096 || t.contains(['\n', '\r']) {
        return None;
    }
    (!t.contains(char::is_whitespace) || t.starts_with('/') || t.starts_with('~') || t.starts_with("file://")).then_some(t)
}

/// Walks every string VALUE of an MCP call's input (object keys are not collected) and returns the candidate paths plus whether a
/// cap was exceeded: more than 256 candidates, nesting deeper than 16, more than 20 000 nodes or more than 8 MiB of string data.
/// The caps fail closed: the second value turns into the hard stop `mcp.args-unjudgeable`.
pub fn collect_mcp_args(input: &Value) -> (Vec<String>, bool) {
    const MAX_CANDIDATES: usize = 256;
    const MAX_DEPTH: usize = 16;
    const MAX_NODES: usize = 20_000;
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    let mut out: Vec<String> = Vec::new();
    let (mut nodes, mut bytes) = (0usize, 0usize);
    let mut stack: Vec<(&Value, usize)> = vec![(input, 0)];
    while let Some((v, depth)) = stack.pop() {
        nodes += 1;
        if nodes > MAX_NODES || depth > MAX_DEPTH {
            return (out, true);
        }
        match v {
            Value::String(s) => {
                bytes += s.len();
                if bytes > MAX_BYTES {
                    return (out, true);
                }
                if let Some(c) = mcp_candidate(s) {
                    if out.len() >= MAX_CANDIDATES {
                        return (out, true);
                    }
                    out.push(c.to_string());
                }
            }
            Value::Array(a) => stack.extend(a.iter().map(|x| (x, depth + 1))),
            Value::Object(o) => stack.extend(o.values().map(|x| (x, depth + 1))),
            _ => {}
        }
    }
    out.reverse();
    (out, false)
}

fn shorten(raw: &str) -> String {
    let line = raw.lines().next().unwrap_or("");
    let mut s: String = line.chars().take(160).collect();
    if s.len() < line.len() || raw.lines().nth(1).is_some() {
        s.push('…');
    }
    s
}
