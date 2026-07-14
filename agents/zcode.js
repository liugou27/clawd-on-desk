// ZCode agent configuration
// ZCode is 智谱/Z.ai's Electron desktop ADE; it spawns `zcode-cli` as the
// per-session agent runtime. `zcode-cli` reads ~/.zcode/cli/config.json, whose
// hook schema is documented in ZCode's official `zcode-configuration-guide` /
// `diagnosing-hooks` skills. Config-file hooks nest under `hooks.events.*`
// (NOT `hooks.*` like plugin hooks.json), require `hooks.enabled: true`, and
// the matcher is a case-sensitive REGEX (so "*" silently never matches —
// omit the matcher to match everything).
// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop. It does NOT support
// SessionEnd or Notification.
// Phase 1: state-only hook integration (no PermissionRequest bubble).

module.exports = {
  id: "zcode",
  name: "ZCode",
  // zcode-cli is the per-session agent runtime spawned by the ZCode desktop
  // app (ZCode -> zcode-host-local -> zcode-cli). Detect the runtime, not the
  // Electron shell.
  processNames: { win: ["zcode-cli.exe"], mac: ["zcode-cli"], linux: ["zcode-cli"] },
  eventSource: "hook",
  // ZCode has no SessionEnd event; session completion relies on Stop + the
  // app's auto-fallback timeout. PostToolUseFailure maps to attention (a tool
  // failed), giving a richer "something went wrong" signal than Stop alone.
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "attention",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "zcode-config-json",
  },
  stdinFormat: "qwenHookJson",
};
