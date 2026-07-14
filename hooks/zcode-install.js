#!/usr/bin/env node
// Merge Clawd ZCode hooks into ~/.zcode/cli/config.json.
//
// ZCode (智谱/Z.ai) is an Electron desktop ADE that spawns `zcode-cli` as the
// per-session agent runtime. `zcode-cli` reads ~/.zcode/cli/config.json. Per the
// official `zcode-configuration-guide` / `diagnosing-hooks` skills, config-file
// hooks differ from plugin hooks.json in three ways:
//   1. They nest under `hooks.events.<EventName>` (plugin hooks.json uses
//      `hooks.<EventName>` — DO NOT confuse the two, or config.json fails to load).
//   2. They are DISABLED by default; `hooks.enabled: true` is required.
//   3. The matcher is a case-sensitive REGEX; "*" silently never matches — so
//      state-only hooks OMIT the matcher to match every tool.
// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop (no SessionEnd /
// Notification). Phase 1 registers the 6 state-only events (no PermissionRequest).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  readJsonFile,
  writeJsonAtomic,
  writeJsonAtomicWithBackup,
  asarUnpackedPath,
  formatNodeHookCommand,
  decodeWindowsEncodedCommand,
  removeMatchingCommandHooks,
} = require("./json-utils");

// ZCode config-file hooks nest under hooks.events.<Event> (unlike Claude /
// Qwen settings.json hooks which sit directly under hooks.<Event>), so the
// shared extractExistingNodeBin() helper cannot see them. Walk hooks.events.*
// ourselves to reuse a previously-installed absolute node path.
function extractExistingZcodeNodeBin(settings, marker) {
  const events = settings && settings.hooks && settings.hooks.events;
  if (!events || typeof events !== "object") return null;
  for (const entries of Object.values(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== "string") continue;
        if (h.command.includes(marker)) return extractNodeBinFromCommand(h.command);
        const decoded = decodeWindowsEncodedCommand(h.command);
        if (decoded && decoded.includes(marker)) return extractNodeBinFromCommand(decoded);
      }
    }
  }
  return null;
}

// Find the node executable path in a hook command string. Handles quoted
// forms ("..."/'...') and the PowerShell call operator (`& 'node' ...`), where
// node is NOT the first token.
function extractNodeBinFromCommand(command) {
  const tokenRegex = /"([^"]+node(?:\.exe)?)"|'([^']+node(?:\.exe)?)'|(\S*node(?:\.exe)?)/gi;
  let match;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = match[1] || match[2] || match[3];
    if (candidate) return candidate;
  }
  return null;
}

const MARKER = "zcode-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".zcode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "cli", "config.json");

// The 6 state-only events ZCode supports (PermissionRequest, the 7th, is
// reserved for a future Phase 2 permission bubble). SessionEnd / Notification
// are NOT supported by ZCode — including them makes config.json fail to load.
const ZCODE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

function timeoutForZcodeEvent() {
  // State-only: no blocking PermissionRequest, so every event is a fire-and
  // -forget state report. 30s mirrors the non-permission Qwen events.
  return 30000;
}

// ZCode's matcher is a case-sensitive REGEX, so "*" silently never matches.
// For state-only hooks we want every tool/prompt, so we always OMIT the
// matcher (omitted = match everything). Kept as a helper for symmetry with
// other installers and for a future Phase 2 PermissionRequest matcher.
function matcherForZcodeEvent() {
  return null;
}

function isClawdHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.includes(MARKER)) return true;
  const decoded = decodeWindowsEncodedCommand(command);
  return !!(decoded && decoded.includes(MARKER));
}

// Mirror the Qwen / Antigravity Windows handling: wrap the command as a
// PowerShell -EncodedCommand so any shell that strips outer quotes (cmd /s)
// never mangles a node path containing a space.
function buildZcodeHookCommand(nodeBin, hookScript, event, options = {}) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    ...options,
    args: [event],
    windowsWrapper: "encoded",
  });
}

function buildZcodeHookEntry(command, event) {
  const matcher = matcherForZcodeEvent(event);
  const entry = {
    hooks: [{
      type: "command",
      command,
      timeout: timeoutForZcodeEvent(),
    }],
  };
  if (matcher !== null) entry.matcher = matcher;
  return entry;
}

function replaceEntry(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function isDesiredHookEntry(entry, desiredCommand, event) {
  if (!entry || typeof entry !== "object") return false;
  const matcher = matcherForZcodeEvent(event);
  if (matcher === null) {
    if (Object.prototype.hasOwnProperty.call(entry, "matcher")) return false;
  } else if (entry.matcher !== matcher) {
    return false;
  }
  return !!(
    Array.isArray(entry.hooks)
    && entry.hooks.length === 1
    && entry.hooks[0]
    // ZCode's hook schema is strict — a "name" key makes config.json fail to
    // load. Treat any entry still carrying "name" as not-desired so a re-run
    // strips it (migration from the pre-fix form).
    && !("name" in entry.hooks[0])
    && entry.hooks[0].type === "command"
    && entry.hooks[0].command === desiredCommand
    && entry.hooks[0].timeout === timeoutForZcodeEvent()
  );
}

function normalizeHookEntries(entries, desiredCommand, event) {
  if (!Array.isArray(entries)) return { matched: false, changed: false };

  let matched = false;
  let changed = false;
  let dedicatedIndex = -1;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;

    if (isClawdHookCommand(entry.command)) {
      matched = true;
      if (dedicatedIndex === -1) {
        replaceEntry(entry, buildZcodeHookEntry(desiredCommand, event));
        dedicatedIndex = index;
        changed = true;
      } else {
        entries.splice(index, 1);
        index--;
        changed = true;
      }
      continue;
    }

    if (!Array.isArray(entry.hooks)) continue;
    const otherHooks = [];
    let clawdHookCount = 0;
    for (const hook of entry.hooks) {
      if (hook && isClawdHookCommand(hook.command)) clawdHookCount++;
      else otherHooks.push(hook);
    }
    if (clawdHookCount === 0) continue;

    matched = true;
    if (otherHooks.length > 0) {
      entry.hooks = otherHooks;
      changed = true;
      continue;
    }

    if (dedicatedIndex === -1) {
      if (!isDesiredHookEntry(entry, desiredCommand, event)) {
        replaceEntry(entry, buildZcodeHookEntry(desiredCommand, event));
        changed = true;
      }
      dedicatedIndex = index;
      continue;
    }

    entries.splice(index, 1);
    index--;
    changed = true;
  }

  if (!matched) return { matched: false, changed: false };

  if (dedicatedIndex === -1) {
    entries.push(buildZcodeHookEntry(desiredCommand, event));
    return { matched: true, changed: true };
  }

  const dedicatedEntry = entries[dedicatedIndex];
  if (!isDesiredHookEntry(dedicatedEntry, desiredCommand, event)) {
    replaceEntry(dedicatedEntry, buildZcodeHookEntry(desiredCommand, event));
    changed = true;
  }
  return { matched: true, changed };
}

function readSettings(settingsPath) {
  try {
    return readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read config.json: ${err.message}`);
  }
}

function registerZcodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const parentDir = options.parentDir || path.join(homeDir, ".zcode");
  const settingsPath = options.settingsPath || path.join(parentDir, "cli", "config.json");

  if (!options.settingsPath && !fs.existsSync(parentDir)) {
    if (!options.silent) console.log("Clawd: ~/.zcode/ not found - skipping ZCode hook registration");
    return { added: 0, skipped: 0, updated: 0, warnings: [] };
  }

  const settings = readSettings(settingsPath);
  const warnings = [];
  if (settings && settings.disableAllHooks === true) {
    warnings.push("config.json has disableAllHooks=true; Clawd ZCode hooks will not fire until that flag is removed.");
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, MARKER).replace(/\\/g, "/"));
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingZcodeNodeBin(settings, MARKER)
    || "node";

  let changed = false;

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  // Config-file hooks are disabled by default; enable the runner so our hooks
  // actually fire. Plugin hooks auto-enable the runner, but we cannot rely on
  // a plugin being present.
  if (settings.hooks.enabled !== true) {
    settings.hooks.enabled = true;
    changed = true;
  }
  if (!settings.hooks.events || typeof settings.hooks.events !== "object") {
    settings.hooks.events = {};
  }
  const events = settings.hooks.events;

  let added = 0;
  let skipped = 0;
  let updated = 0;

  for (const event of ZCODE_HOOK_EVENTS) {
    const desiredCommand = buildZcodeHookCommand(
      nodeBin,
      hookScript,
      event,
      { platform: options.platform || process.platform }
    );

    if (!Array.isArray(events[event])) {
      events[event] = [];
      changed = true;
    }

    const result = normalizeHookEntries(events[event], desiredCommand, event);
    if (result.changed) changed = true;

    if (result.matched) {
      if (result.changed) updated++;
      else skipped++;
      continue;
    }

    events[event].push(buildZcodeHookEntry(desiredCommand, event));
    added++;
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd ZCode hooks -> ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return { added, skipped, updated, warnings };
}

function unregisterZcodeHooks(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const parentDir = options.parentDir || path.join(homeDir, ".zcode");
  const settingsPath = options.settingsPath || path.join(parentDir, "cli", "config.json");

  let settings = {};
  try {
    settings = readJsonFile(settingsPath);
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0, changed: false, settingsPath };
    throw new Error(`Failed to read config.json: ${err.message}`);
  }

  if (!settings.hooks || typeof settings.hooks !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }
  // Config-file hooks live under hooks.events.* (unlike plugin hooks.json).
  const events = settings.hooks.events;
  if (!events || typeof events !== "object") {
    return { removed: 0, changed: false, settingsPath };
  }

  let removed = 0;
  let changed = false;
  for (const event of ZCODE_HOOK_EVENTS) {
    const entries = events[event];
    if (!Array.isArray(entries)) continue;
    const result = removeMatchingCommandHooks(entries, isClawdHookCommand);
    if (!result.changed) continue;
    removed += result.removed;
    changed = true;
    if (result.entries.length > 0) events[event] = result.entries;
    else delete events[event];
  }

  // If Clawd was the only config-file hook source, clean up the now-empty
  // hooks wrapper (drop the enabled flag + empty events object) so the user's
  // config.json is left pristine, not carrying a stale "enabled": true.
  if (changed) {
    const remainingEvents = Object.keys(events).filter((k) => Array.isArray(events[k]) && events[k].length > 0);
    if (remainingEvents.length === 0) {
      delete settings.hooks.events;
      // Only drop `enabled` if nothing else references it; since the runner is
      // only meaningful for config-file hooks (plugin hooks auto-enable), and
      // we own the only config-file hooks, it is safe to drop here.
      delete settings.hooks.enabled;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
  }

  let backupPath = null;
  if (changed) backupPath = writeJsonAtomicWithBackup(settingsPath, settings, options);
  if (!options.silent) console.log(`Clawd ZCode hooks removed: ${removed}`);
  const result = { removed, changed, settingsPath };
  if (options.backup === true) result.backupPath = backupPath;
  return result;
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  MARKER,
  ZCODE_HOOK_EVENTS,
  buildZcodeHookCommand,
  matcherForZcodeEvent,
  registerZcodeHooks,
  unregisterZcodeHooks,
  timeoutForZcodeEvent,
};

if (require.main === module) {
  try {
    if (process.argv.includes("--uninstall")) unregisterZcodeHooks({});
    else registerZcodeHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
