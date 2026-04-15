#!/usr/bin/env node
// Cross-platform skill installer.
//
// Claude Code skills live at `.claude/skills/` in this repo — project-local
// skills are auto-detected by Claude Code when you open a session from the
// repo root, so no install step is needed for local use.
//
// This script handles the two cases where an install IS needed:
//   --claude-global  → symlink .claude/skills/* into ~/.claude/skills/      (all projects)
//   --openclaw       → symlink openclaw/skills/*  into ~/.openclaw/skills/  (OpenClaw agents)
//
// With no flags, both are installed. Add --uninstall to reverse.
//
// Works on Linux, macOS, and Windows. On Windows, falls back to junctions for
// directories when symlink permission is missing; falls back to copy as last
// resort.

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const CLAUDE_SRC   = join(REPO_ROOT, ".claude", "skills");
const OPENCLAW_SRC = join(REPO_ROOT, "openclaw", "skills");

const targets = {
  claudeGlobal: { src: CLAUDE_SRC,   dst: join(homedir(), ".claude", "skills"),   label: "Claude (personal ~/.claude/skills)" },
  openclaw:     { src: OPENCLAW_SRC, dst: join(homedir(), ".openclaw", "skills"), label: "OpenClaw (personal ~/.openclaw/skills)" },
};

// ---- CLI parsing ------------------------------------------------------------

const flags = new Set(process.argv.slice(2));
const uninstall = flags.delete("--uninstall");

let selected;
if (flags.size === 0) {
  selected = ["claudeGlobal", "openclaw"];
} else {
  selected = [];
  if (flags.delete("--claude-global")) selected.push("claudeGlobal");
  if (flags.delete("--openclaw"))      selected.push("openclaw");
  if (flags.size > 0) {
    console.error(`Unknown flag(s): ${[...flags].join(", ")}`);
    console.error("Usage: node scripts/install-skills.mjs [--claude-global] [--openclaw] [--uninstall]");
    process.exit(2);
  }
}

// ---- Helpers ----------------------------------------------------------------

function listSkillDirs(srcRoot) {
  if (!existsSync(srcRoot)) return [];
  return readdirSync(srcRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function linkOrCopy(src, dst) {
  const rel = relative(dirname(dst), src);
  try {
    symlinkSync(rel, dst, "dir");
    return "symlink";
  } catch (err) {
    if (process.platform === "win32" && err.code === "EPERM") {
      try {
        symlinkSync(src, dst, "junction");
        return "junction";
      } catch { /* fall through */ }
    }
    cpSync(src, dst, { recursive: true, dereference: true });
    return "copy";
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ---- Actions ----------------------------------------------------------------

function install(target) {
  const { src, dst, label } = targets[target];
  const names = listSkillDirs(src);
  if (names.length === 0) {
    console.log(`[skip] ${label} — no source skills at ${src}`);
    return;
  }
  ensureDir(dst);
  console.log(`\n→ ${label}`);
  console.log(`  source: ${src}`);
  console.log(`  target: ${dst}`);
  for (const name of names) {
    const dstPath = join(dst, name);
    const srcPath = join(src, name);
    if (existsSync(dstPath)) {
      if (isSymlink(dstPath) && resolve(dirname(dstPath), readlinkSync(dstPath)) === srcPath) {
        console.log(`  · ${name} — already linked`);
        continue;
      }
      console.log(`  ! ${name} — already exists (non-link); skipping. Remove manually to replace.`);
      continue;
    }
    const method = linkOrCopy(srcPath, dstPath);
    console.log(`  + ${name} (${method})`);
  }
}

function uninstallTarget(target) {
  const { src, dst, label } = targets[target];
  const names = listSkillDirs(src);
  if (!existsSync(dst) || names.length === 0) {
    console.log(`[skip] ${label} — nothing to uninstall`);
    return;
  }
  console.log(`\n← ${label}`);
  for (const name of names) {
    const dstPath = join(dst, name);
    if (!existsSync(dstPath) && !isSymlink(dstPath)) continue;
    if (!isSymlink(dstPath)) {
      console.log(`  ! ${name} — not a symlink; leaving alone`);
      continue;
    }
    const linkSrc = resolve(dirname(dstPath), readlinkSync(dstPath));
    if (linkSrc !== join(src, name)) {
      console.log(`  ! ${name} — link points elsewhere; leaving alone`);
      continue;
    }
    rmSync(dstPath);
    console.log(`  - ${name} (link removed)`);
  }
}

// ---- Main -------------------------------------------------------------------

console.log(uninstall ? "Uninstalling skills..." : "Installing skills...");
for (const t of selected) {
  (uninstall ? uninstallTarget : install)(t);
}
console.log("\nDone.");

if (!uninstall) {
  console.log("\nNote:");
  console.log("  • Claude Code project-local skills (.claude/skills/*) are already auto-detected");
  console.log("    when you open a session from this repo — no install needed for that.");
  if (selected.includes("claudeGlobal")) {
    console.log("  • Claude personal install: start a new session and type `/` to see the skills.");
  }
  if (selected.includes("openclaw")) {
    console.log("  • OpenClaw: restart your agent to pick up the new skills.");
  }
}
