// Project agent files that cap or shadow the owner's personal agents. Exports: projectAgentNote(projectDir, personalDir).
// A project's `.claude/agents/*.md` wins over a personal agent of the same name, and a `maxTurns:` line in its frontmatter
// stops the agent mid-task (the owner's rule is no maxTurns). Used by the SessionStart mode hook and by scripts/doctor.sh
// (run this file as `node project-agent-note <projectDir> <personalAgentsDir>`: it prints the note, or nothing).
// Invariants: read-only; never throws (an unreadable folder or file counts as "nothing found").
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT_FILE = /\.md$/i;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const MAX_TURNS_LINE = /^maxTurns:\s*(\S+)/m;
const NAME_LINE = /^name:\s*["']?([\w.-]+)/m;

function agentFiles(dir) {
  try {
    return readdirSync(dir).filter((file) => AGENT_FILE.test(file)).sort();
  } catch {
    return [];
  }
}

/** One finding per project agent file that sets maxTurns or shares its name with a personal agent. */
function findings(projectAgents, personalAgents) {
  const personal = new Set(agentFiles(personalAgents).map((file) => basename(file, '.md')));
  const found = [];
  for (const file of agentFiles(projectAgents)) {
    let frontmatter = '';
    try {
      frontmatter = readFileSync(join(projectAgents, file), 'utf8').match(FRONTMATTER)?.[1] ?? '';
    } catch {
      continue;
    }
    const name = frontmatter.match(NAME_LINE)?.[1] ?? basename(file, '.md');
    const reasons = [];
    const turns = frontmatter.match(MAX_TURNS_LINE)?.[1];
    if (turns) reasons.push(`maxTurns ${turns}`);
    if (personal.has(name)) reasons.push('shadows the personal agent');
    if (reasons.length) found.push(`${file} (${reasons.join(', ')})`);
  }
  return found;
}

/**
 * The one-line note for a session whose project has agent files that cap turns or shadow personal agents.
 * @param {string} projectDir - the session's project folder.
 * @param {string} personalDir - the personal agents folder (`~/.claude/agents`).
 * @returns {string} the note, or '' when there is nothing to say (also when the project agents folder is the personal one).
 */
export function projectAgentNote(projectDir, personalDir) {
  if (typeof projectDir !== 'string' || projectDir === '') return '';
  const projectAgents = join(projectDir, '.claude', 'agents');
  try {
    if (existsSync(personalDir) && realpathSync(projectAgents) === realpathSync(personalDir)) return '';
  } catch {
    // no project agents folder: findings() returns nothing
  }
  const found = findings(projectAgents, personalDir);
  if (!found.length) return '';
  return `Project agent files in ${projectAgents}: ${found.join(', ')} - these cap the agent's turns; the owner's rule is no maxTurns - tell the owner (team file: ask before editing).`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const note = projectAgentNote(process.argv[2], process.argv[3]);
  if (note) console.log(note);
}
