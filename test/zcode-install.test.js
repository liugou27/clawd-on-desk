const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  MARKER,
  ZCODE_HOOK_EVENTS,
  buildZcodeHookCommand,
  matcherForZcodeEvent,
  registerZcodeHooks,
  unregisterZcodeHooks,
  timeoutForZcodeEvent,
} = require("../hooks/zcode-install");
const { decodeWindowsEncodedCommand } = require("../hooks/json-utils");

const tempDirs = [];

function makeTempConfigFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-zcode-"));
  const settingsPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listCleanupBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.clawd-cleanup-`));
}

// On win32 the installer wraps commands in PowerShell -EncodedCommand (mirrors
// the Qwen cmd /s quote-stripping fix). Tests that assert on substrings inside
// the command must decode first.
function commandPayload(command) {
  return decodeWindowsEncodedCommand(command) || command;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("ZCode hook installer", () => {
  it("registers the Phase 1 state-only events under hooks.events with enabled:true and no matcher", () => {
    const settingsPath = makeTempConfigFile({
      model: "GLM-5.2",
      env: { KEEP: "me" },
    });
    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);

    const settings = readJson(settingsPath);
    // Preserves unrelated top-level keys (zcode config.json also holds plugins/mcp).
    assert.strictEqual(settings.model, "GLM-5.2");
    assert.deepStrictEqual(settings.env, { KEEP: "me" });
    // Config-file hooks require hooks.enabled: true (disabled by default).
    assert.strictEqual(settings.hooks.enabled, true);
    // Events nest under hooks.events.* (NOT hooks.* — that fails config load).
    assert.ok(settings.hooks.events, "hooks.events must exist");
    for (const event of ZCODE_HOOK_EVENTS) {
      const entry = settings.hooks.events[event][0];
      // State-only hooks omit the matcher (matcher is a regex; "*" never
      // matches, and we want to match every tool/prompt).
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(entry, "matcher"),
        false,
        `${event}: matcher must be omitted, not "*" (regex that never matches)`
      );
      assert.strictEqual(entry.hooks.length, 1);
      // ZCode's hook schema is strict: a "name" key makes config.json fail to
      // load. Clawd's entries must NOT carry "name".
      assert.ok(!("name" in entry.hooks[0]), `${event}: hook must not carry "name" (zcode rejects it)`);
      assert.strictEqual(entry.hooks[0].type, "command");
      assert.strictEqual(entry.hooks[0].timeout, timeoutForZcodeEvent(event));
      const payload = commandPayload(entry.hooks[0].command);
      assert.ok(payload.includes(MARKER), `${event}: ${payload}`);
      assert.ok(payload.includes("/usr/local/bin/node"), `${event}: ${payload}`);
      assert.ok(
        payload.endsWith(`"${event}"`) || payload.endsWith(`'${event}'`),
        `${event}: ${payload}`
      );
    }
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const before = fs.readFileSync(settingsPath, "utf8");

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, ZCODE_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), before);
  });

  it("preserves disableAllHooks and returns a warning without changing the flag", () => {
    const settingsPath = makeTempConfigFile({ disableAllHooks: true });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.disableAllHooks, true);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /disableAllHooks=true/);
  });

  it("splits Clawd out of shared matcher entries under hooks.events", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [
              { type: "command", command: "other-tool", name: "other" },
              { type: "command", command: '"/old/node" "/old/path/zcode-hook.js" "PreToolUse"', name: "clawd" },
            ],
          }],
        },
      },
    });

    const result = registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    // The user's matcher-scoped entry is preserved without Clawd.
    assert.deepStrictEqual(settings.hooks.events.PreToolUse[0], {
      matcher: "Bash",
      hooks: [{ type: "command", command: "other-tool", name: "other" }],
    });
    // Clawd's own entry omits the matcher (state-only = match all).
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(settings.hooks.events.PreToolUse[1], "matcher"),
      false
    );
    assert.ok(commandPayload(settings.hooks.events.PreToolUse[1].hooks[0].command).includes("/usr/local/bin/node"));
  });

  it("preserves existing absolute node path when detection fails", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          Stop: [{
            hooks: [{
              type: "command",
              command: '"/home/user/.nvm/versions/node/v22/bin/node" "/old/path/zcode-hook.js" "Stop"',
              name: "clawd",
            }],
          }],
        },
      },
    });

    registerZcodeHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(commandPayload(settings.hooks.events.Stop[0].hooks[0].command).includes("/home/user/.nvm/versions/node/v22/bin/node"));
  });

  it("skips startup auto-sync when ~/.zcode does not exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-zcode-home-"));
    tempDirs.push(tmpDir);

    const result = registerZcodeHooks({ silent: true, homeDir: tmpDir, nodeBin: "/usr/local/bin/node" });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0, warnings: [] });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, ".zcode", "cli", "config.json")), false);
  });

  it("wraps Windows commands in PowerShell -EncodedCommand to bypass cmd /s quote stripping", () => {
    const nodeBin = "C:\\Program Files\\nodejs\\node.exe";
    const command = buildZcodeHookCommand(
      nodeBin,
      "D:/clawd/hooks/zcode-hook.js",
      "Stop",
      {
        platform: "win32",
        powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      }
    );

    assert.ok(
      command.startsWith("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "),
      `unexpected command prefix: ${command}`
    );
    assert.strictEqual(
      decodeWindowsEncodedCommand(command),
      `& '${nodeBin}' 'D:/clawd/hooks/zcode-hook.js' 'Stop'`
    );
  });

  it("rewrites legacy bare-quoted Windows commands into EncodedCommand form on re-run", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "*",
            hooks: [{
              name: "clawd",
              type: "command",
              command: '"C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/zcode-hook.js" "PreToolUse"',
              timeout: 30000,
            }],
          }],
        },
      },
    });

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Program Files\\nodejs\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.ok(result.updated >= 1, "legacy bare command must be replaced");
    const settings = readJson(settingsPath);
    const entry = settings.hooks.events.PreToolUse[0].hooks[0];
    assert.match(entry.command, /-EncodedCommand /);
    const decoded = decodeWindowsEncodedCommand(entry.command);
    assert.ok(decoded.includes(MARKER));
    assert.ok(decoded.endsWith("'PreToolUse'"));
  });

  it("preserves an existing Windows absolute node path through the encoded command", () => {
    const settingsPath = makeTempConfigFile({});
    registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: "C:\\Tools\\node.exe",
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    const before = readJson(settingsPath);
    const stopBefore = before.hooks.events.Stop[0].hooks[0].command;
    assert.match(decodeWindowsEncodedCommand(stopBefore), /'C:\\Tools\\node\.exe'/);

    const result = registerZcodeHooks({
      silent: true,
      settingsPath,
      platform: "win32",
      nodeBin: null,
      powerShellBin: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    assert.strictEqual(result.skipped, ZCODE_HOOK_EVENTS.length);
    const after = readJson(settingsPath);
    assert.match(decodeWindowsEncodedCommand(after.hooks.events.Stop[0].hooks[0].command), /'C:\\Tools\\node\.exe'/);
  });

  it("unregister removes encoded Clawd commands while preserving user hooks", () => {
    const settingsPath = makeTempConfigFile({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{
            matcher: "*",
            hooks: [
              {
                name: "clawd",
                type: "command",
                command: buildZcodeHookCommand(
                  "C:\\Tools\\node.exe",
                  "D:/clawd/hooks/zcode-hook.js",
                  "PreToolUse",
                  { platform: "win32" }
                ),
                timeout: 30000,
              },
              { name: "user", type: "command", command: "echo keep", timeout: 30 },
            ],
          }],
          Stop: [{
            hooks: [{ name: "user", type: "command", command: "echo stop", timeout: 30 }],
          }],
        },
      },
    });

    const result = unregisterZcodeHooks({ silent: true, settingsPath, backup: true });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.changed, true);
    const settings = readJson(settingsPath);
    // PreToolUse keeps the user hook (Clawd removed).
    assert.deepStrictEqual(settings.hooks.events.PreToolUse, [{
      matcher: "*",
      hooks: [{ name: "user", type: "command", command: "echo keep", timeout: 30 }],
    }]);
    // Stop's user hook untouched.
    assert.deepStrictEqual(settings.hooks.events.Stop, [{
      hooks: [{ name: "user", type: "command", command: "echo stop", timeout: 30 }],
    }]);
    // enabled flag preserved (other config-file hooks remain).
    assert.strictEqual(settings.hooks.enabled, true);
    assert.strictEqual(listCleanupBackups(settingsPath).length, 1);
  });

  it("unregister drops the empty hooks wrapper when Clawd was the only source", () => {
    const settingsPath = makeTempConfigFile({
      plugins: { "keep-me": { enabled: true } },
    });
    registerZcodeHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const result = unregisterZcodeHooks({ silent: true, settingsPath });

    assert.ok(result.changed);
    const settings = readJson(settingsPath);
    // hooks wrapper fully cleaned up (no stale enabled/events), unrelated keys kept.
    assert.strictEqual(settings.hooks, undefined);
    assert.deepStrictEqual(settings.plugins, { "keep-me": { enabled: true } });
  });
});
