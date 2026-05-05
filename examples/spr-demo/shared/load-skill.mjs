// Minimal Agent Skill loader — implements the client-implementor pattern from
// https://agentskills.io/client-implementation/adding-skills-support
//
// Reads SKILL.md from .claude/skills/<name>/, strips YAML frontmatter, and
// optionally appends referenced files from references/. Returns the markdown
// body suitable for direct injection into an Anthropic Messages API system
// prompt block (with cache_control: ephemeral by the caller).
//
// This is a "consumer" implementation of the Agent Skills spec — we don't run
// scripts, we don't lazy-load, we don't sandbox. We just take the markdown
// content the skill author wrote and use it as system-prompt material. That's
// the minimum spec-compliant client behavior.

import fs from "node:fs";
import path from "node:path";

const FRONTMATTER_DELIM = "---";

function stripFrontmatter(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) return { body: raw, frontmatter: null };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === FRONTMATTER_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return { body: raw, frontmatter: null };
  const fm = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").trimStart();
  return { body, frontmatter: fm };
}

/**
 * Read a SKILL.md from `<skillsRoot>/<skillName>/SKILL.md`, strip the
 * frontmatter, and optionally inline `references/*.md` files listed by the
 * caller. The skill body is the source of truth for the agent's behavior;
 * inlining references reduces tokens but loses the lazy-loading the Claude
 * Code harness provides.
 *
 * @param {object} opts
 * @param {string} opts.skillsRoot   Path to `.claude/skills/`.
 * @param {string} opts.skillName    Skill directory name.
 * @param {string[]} [opts.includeReferences]  References to inline (filename
 *   relative to the skill's `references/` dir). Defaults to all `.md` files
 *   in that directory.
 */
export function loadSkill({ skillsRoot, skillName, includeReferences }) {
  const skillDir = path.join(skillsRoot, skillName);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    throw new Error(`SKILL.md not found at ${skillFile}`);
  }
  const raw = fs.readFileSync(skillFile, "utf8");
  const { body } = stripFrontmatter(raw);

  const refsDir = path.join(skillDir, "references");
  let refsBody = "";
  if (fs.existsSync(refsDir)) {
    const refFiles =
      includeReferences ??
      fs
        .readdirSync(refsDir)
        .filter((f) => f.endsWith(".md"))
        .sort();
    if (refFiles.length > 0) {
      refsBody = refFiles
        .map((f) => {
          const full = path.join(refsDir, f);
          if (!fs.existsSync(full)) return null;
          const content = fs.readFileSync(full, "utf8");
          return `\n---\n## reference: ${f}\n\n${content.trim()}\n`;
        })
        .filter(Boolean)
        .join("\n");
    }
  }

  return {
    body: refsBody ? `${body.trim()}\n${refsBody}` : body.trim(),
    skillFile,
    refsCount: refsBody ? (refsBody.match(/^## reference:/gm) || []).length : 0,
  };
}
