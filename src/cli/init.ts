/**
 * Init Command
 * Scaffolds a new Goldfish agent workspace with identity and memory structure.
 */

import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

export interface InitOptions {
  path?: string;
}

function ask(rl: ReturnType<typeof createInterface>, question: string, fallback?: string): Promise<string> {
  const prompt = fallback ? `${question} (${fallback}): ` : `${question}: `;
  return rl.question(chalk.bold(prompt)).then(answer => answer.trim() || fallback || '');
}

export function buildClaudeMd(name: string, personality: string): string {
  return `# ${name}

${personality}

## Memory

You have access to a persistent memory system. Use it.

- **Daily logs:** Read \`memory/\` files for recent context (\`YYYY-MM-DD.md\`)
- **Search past conversations:**
  \`\`\`bash
  sqlite3 memory/search.sqlite \\
    "SELECT path, snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) \\
     FROM chunks_fts WHERE chunks_fts MATCH 'search terms' \\
     ORDER BY rank LIMIT 10;"
  \`\`\`
- **Write things down:** When something important happens, update today's daily log or create files in \`memory/topics/\`, \`memory/projects/\`, or \`memory/people/\`.

Session transcripts are saved automatically. The memory index is rebuilt nightly.

## Current Focus

Read \`FOCUS.md\` for current priorities (if it exists).

## Tools

Claude Code has full bash, file, and web access. List any custom tools or scripts here as you add them.
`;
}

export function buildFocusMd(): string {
  return `# Current Focus

*Update this file with what you're working on. Your agent reads it at the start of every session.*

## This Week

- (Add your current priorities here)

## Watch Items

- (Things to keep an eye on)
`;
}

export async function init(options: InitOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(chalk.bold('\n🐟 Goldfish — New Workspace Setup\n'));

    // 1. Workspace path
    const defaultPath = options.path || join(process.env.HOME || '~', 'goldfish-workspace');
    const workspacePath = resolve(await ask(rl, 'Workspace path', defaultPath));

    // 2. Agent name
    const name = await ask(rl, 'Agent name', 'Goldfish');

    // 3. Personality
    console.log(chalk.dim('\n  Describe your agent\'s personality in a sentence or two.'));
    console.log(chalk.dim('  Examples: "Direct and witty. Keeps me on track."'));
    console.log(chalk.dim('           "Warm, opinionated, a little sassy. My thinking partner."'));
    console.log(chalk.dim('           "Terse and technical. No small talk."\n'));
    const personality = await ask(rl, 'Personality', 'A helpful AI assistant. Direct, concise, and opinionated when asked.');

    rl.close();

    // Scaffold
    console.log('');

    // Create directories
    const dirs = [
      workspacePath,
      join(workspacePath, 'memory'),
      join(workspacePath, 'memory', 'sessions'),
      join(workspacePath, 'memory', 'topics'),
      join(workspacePath, 'memory', 'projects'),
      join(workspacePath, 'memory', 'people'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        console.log(chalk.dim(`  Created ${dir}/`));
      }
    }

    // Write CLAUDE.md (only if it doesn't exist)
    const claudePath = join(workspacePath, 'CLAUDE.md');
    if (existsSync(claudePath)) {
      console.log(chalk.yellow(`  Skipped CLAUDE.md (already exists)`));
    } else {
      writeFileSync(claudePath, buildClaudeMd(name, personality));
      console.log(chalk.green(`  Created CLAUDE.md — ${name}'s identity`));
    }

    // Write FOCUS.md (only if it doesn't exist)
    const focusPath = join(workspacePath, 'FOCUS.md');
    if (existsSync(focusPath)) {
      console.log(chalk.yellow(`  Skipped FOCUS.md (already exists)`));
    } else {
      writeFileSync(focusPath, buildFocusMd());
      console.log(chalk.green(`  Created FOCUS.md`));
    }

    // Copy schedule.example.yaml → schedule.yaml (in the repo, not workspace)
    const scheduleTarget = join(REPO_ROOT, 'schedule.yaml');
    const scheduleExample = join(REPO_ROOT, 'schedule.example.yaml');
    if (existsSync(scheduleTarget)) {
      console.log(chalk.yellow(`  Skipped schedule.yaml (already exists)`));
    } else if (existsSync(scheduleExample)) {
      copyFileSync(scheduleExample, scheduleTarget);
      console.log(chalk.green(`  Created schedule.yaml — edit channel IDs and times`));
    }

    // Summary
    console.log(chalk.bold.green(`\n✓ Workspace ready at ${workspacePath}\n`));
    console.log(`  Next steps:`);
    console.log(`  1. Set ${chalk.bold('GOLDFISH_WORKSPACE')}=${workspacePath} in your .env`);
    console.log(`  2. Edit ${chalk.bold('CLAUDE.md')} to customize ${name}'s personality`);
    console.log(`  3. Edit ${chalk.bold('schedule.yaml')} with your Slack channel IDs`);
    console.log(`  4. Run ${chalk.bold('pnpm run cli start')} and say hello\n`);

  } catch (error) {
    rl.close();
    if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      // User hit Ctrl+C
      console.log('\nSetup cancelled.');
      return;
    }
    throw error;
  }
}
