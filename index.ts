import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    AgentProfile,
    AgentStartedEvent,
    AgentStepFinishedEvent,
    AgentStepStartedEvent,
    CommandDefinition,
    ContextFile,
    ContextMessage,
    Extension,
    ExtensionContext,
    ModeDefinition,
    ProjectStoppedEvent,
    ResponseChunkEvent,
    SubagentFinishedEvent,
    SubagentStartedEvent,
    TaskClosedEvent,
    TaskDeletedEvent,
    ToolCalledEvent,
    ToolDefinition,
    ToolFinishedEvent,
} from '@aiderdesk/extensions';

import { ContextMemoryMode, InvocationMode } from '@aiderdesk/extensions';
import { z } from 'zod';

export interface ExtensionConfig {
    defaultGoalMaxRounds?: number;
    defaultDebateRounds?: number;
    defaultIdleTimeoutSeconds?: number;
    enableAllMcpServersByDefault?: boolean;
    maxSubagentDepth?: number;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
    defaultGoalMaxRounds: 3,
    defaultDebateRounds: 2,
    defaultIdleTimeoutSeconds: 180,
    enableAllMcpServersByDefault: true,
    maxSubagentDepth: 2,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, 'config.json');
const CONFIG_COMPONENT_PATH = join(__dirname, 'ConfigComponent.jsx');

export const readExtensionConfig = (customPath?: string): ExtensionConfig => {
    const targetPath = customPath ?? CONFIG_PATH;
    try {
        if (existsSync(targetPath)) {
            const raw = readFileSync(targetPath, 'utf-8');
            const parsed = JSON.parse(raw);
            return {
                defaultGoalMaxRounds:
                    typeof parsed.defaultGoalMaxRounds === 'number'
                        ? parsed.defaultGoalMaxRounds
                        : DEFAULT_CONFIG.defaultGoalMaxRounds,
                defaultDebateRounds:
                    typeof parsed.defaultDebateRounds === 'number'
                        ? parsed.defaultDebateRounds
                        : DEFAULT_CONFIG.defaultDebateRounds,
                defaultIdleTimeoutSeconds:
                    typeof parsed.defaultIdleTimeoutSeconds === 'number'
                        ? parsed.defaultIdleTimeoutSeconds
                        : DEFAULT_CONFIG.defaultIdleTimeoutSeconds,
                enableAllMcpServersByDefault:
                    typeof parsed.enableAllMcpServersByDefault === 'boolean'
                        ? parsed.enableAllMcpServersByDefault
                        : DEFAULT_CONFIG.enableAllMcpServersByDefault,
                maxSubagentDepth:
                    typeof parsed.maxSubagentDepth === 'number'
                        ? parsed.maxSubagentDepth
                        : DEFAULT_CONFIG.maxSubagentDepth,
            };
        }
    } catch {
        // Fall back to defaults
    }
    return { ...DEFAULT_CONFIG };
};

export const writeExtensionConfig = (
    config: Partial<ExtensionConfig>,
    customPath?: string,
): ExtensionConfig => {
    const targetPath = customPath ?? CONFIG_PATH;
    const current = readExtensionConfig(targetPath);
    const merged: ExtensionConfig = {
        defaultGoalMaxRounds:
            typeof config.defaultGoalMaxRounds === 'number'
                ? config.defaultGoalMaxRounds
                : current.defaultGoalMaxRounds,
        defaultDebateRounds:
            typeof config.defaultDebateRounds === 'number'
                ? config.defaultDebateRounds
                : current.defaultDebateRounds,
        defaultIdleTimeoutSeconds:
            typeof config.defaultIdleTimeoutSeconds === 'number'
                ? config.defaultIdleTimeoutSeconds
                : current.defaultIdleTimeoutSeconds,
        enableAllMcpServersByDefault:
            typeof config.enableAllMcpServersByDefault === 'boolean'
                ? config.enableAllMcpServersByDefault
                : current.enableAllMcpServersByDefault,
        maxSubagentDepth:
            typeof config.maxSubagentDepth === 'number'
                ? config.maxSubagentDepth
                : current.maxSubagentDepth,
    };
    const tmpPath = `${targetPath}.tmp.${Date.now()}`;
    writeFileSync(tmpPath, `${JSON.stringify(merged, null, 4)}\n`, 'utf-8');
    renameSync(tmpPath, targetPath);
    return merged;
};

const ORCHESTRATOR_USER_MESSAGE = `You are in orchestrator mode. Your primary tools are run_dynamic_agent and run_dynamic_agent_goal.

Work in these steps:
1. Decompose the user's task into small, focused subtasks. Each subtask must have a clear scope and a verifiable outcome.
2. Delegate each subtask to run_dynamic_agent with an inline profile: a short name, a role description, and a precise task prompt that includes all needed context (file paths, constraints, expected output).
3. Use run_dynamic_agent_goal instead of run_dynamic_agent when a subtask has a verifiable end state (tests pass, typecheck clean, file exists) and may need several iterations to converge. The tool returns a first line GOAL_RESULT: <status>; treat 'incomplete' or 'blocked' as a signal to refine the goal or fall back to run_dynamic_agent.
4. Use run_agent_debate when a decision is contested and orthogonal critique helps: an advocate and a critic open with independent positions, rebut each other in pairs, and a synthesizer merges the strongest points. The tool returns a first line DEBATE_RESULT: <status>; treat 'blocked' as a signal to fall back to run_dynamic_agent.
5. Run independent subtasks in parallel when possible.
6. Verify each returned result against the subtask outcome. Re-run a subtask with a refined prompt when the result is incomplete or wrong.
7. Do not implement subtasks yourself. Do the work yourself only when delegation is impossible or failed twice.
8. Aggregate the verified results and give the user a final summary: what was done, which files changed, and any open issues.`;

const ORCHESTRATOR_ASSISTANT_MESSAGE = `OK, I will decompose the task, delegate subtasks to dynamic agents, run goal loops when a subtask has a verifiable end state, run debates when a decision is contested, and aggregate their results.`;

export const textFromContent = (content: unknown): string => {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return (content as Array<{ type?: string; text?: string }>)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('');
};

export const extractResultText = (messages: readonly ContextMessage[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }
        if (message.role === 'assistant') {
            const text = textFromContent(message.content).trim();
            if (text.length > 0) {
                return text;
            }
        }
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) {
            continue;
        }
        if (message.role === 'tool') {
            let text = textFromContent(message.content).trim();
            if (!text && typeof message.content === 'object' && message.content !== null) {
                try {
                    text = JSON.stringify(message.content);
                } catch {
                    text = String(message.content);
                }
            }
            if (text.length > 0) {
                return `[Tool result]: ${text}`;
            }
        }
    }
    return '';
};

export const AGENT_PRESETS = {
    reviewer:
        'You are an expert code reviewer. Analyze code thoroughly, assess security vulnerabilities, detect defects, and enforce quality standards.',
    tester: 'You are a testing specialist. Develop comprehensive tests, verify edge conditions, and execute test suites.',
    architect:
        'You are a software architect. Design systems, define clean interfaces, and organize modular structures.',
    refactorer:
        'You are a refactoring specialist. Simplify code, eliminate duplication, and improve readability without altering behavior.',
    researcher:
        'You are a codebase researcher. Investigate the codebase, map connections, and produce rigorous architectural analysis.',
} as const;

export type AgentPreset = keyof typeof AGENT_PRESETS;

export interface ParsedCommandArgs {
    rounds?: number;
    preset?: string;
    timeoutSeconds?: number;
    text: string;
}

export const parseCommandArgs = (args: string[]): ParsedCommandArgs => {
    let rounds: number | undefined;
    let preset: string | undefined;
    let timeoutSeconds: number | undefined;
    const textParts: string[] = [];

    const stripQuotes = (val: string): string => {
        if (
            val.length >= 2 &&
            ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'")))
        ) {
            return val.slice(1, -1);
        }
        return val;
    };

    for (let i = 0; i < args.length; i++) {
        const rawArg = args[i];
        if (!rawArg) {
            continue;
        }
        const arg = stripQuotes(rawArg);

        if (arg === '-r' || arg === '--rounds') {
            const next = args[i + 1];
            if (next !== undefined && /^\d+$/.test(stripQuotes(next))) {
                rounds = Number.parseInt(stripQuotes(next), 10);
                i++;
            } else {
                textParts.push(arg);
            }
        } else if (arg.startsWith('--rounds=')) {
            const val = stripQuotes(arg.slice('--rounds='.length));
            if (/^\d+$/.test(val)) {
                rounds = Number.parseInt(val, 10);
            } else {
                textParts.push(arg);
            }
        } else if (arg === '-p' || arg === '--preset') {
            const next = args[i + 1];
            if (next !== undefined) {
                preset = stripQuotes(next);
                i++;
            } else {
                textParts.push(arg);
            }
        } else if (arg.startsWith('--preset=')) {
            preset = stripQuotes(arg.slice('--preset='.length));
        } else if (arg === '-t' || arg === '--timeout') {
            const next = args[i + 1];
            if (next !== undefined && /^\d+$/.test(stripQuotes(next))) {
                timeoutSeconds = Number.parseInt(stripQuotes(next), 10);
                i++;
            } else {
                textParts.push(arg);
            }
        } else if (arg.startsWith('--timeout=')) {
            const val = stripQuotes(arg.slice('--timeout='.length));
            if (/^\d+$/.test(val)) {
                timeoutSeconds = Number.parseInt(val, 10);
            } else {
                textParts.push(arg);
            }
        } else if (i === 0 && /^\d+$/.test(arg)) {
            rounds = Number.parseInt(arg, 10);
        } else {
            textParts.push(arg);
        }
    }

    return {
        rounds,
        preset,
        timeoutSeconds,
        text: textParts.join(' ').trim(),
    };
};

const ORCHESTRATOR_DESCRIPTION = [
    'ORCHESTRATOR MODE. You are an orchestrator. Do NOT solve the task yourself.',
    'Instead:',
    '1. Decompose the user task into small, independent subtasks.',
    '2. Call run_dynamic_agent once per subtask with a complete, self-contained prompt.',
    '3. After all subtasks finish, synthesize the results into a final answer.',
    'Rules:',
    '- Each subtask prompt must be fully self-contained (no references to other subtask results unless you pass them explicitly).',
    '- Prefer parallel execution: call multiple run_dynamic_agent tools in the same turn when subtasks are independent.',
    '- Use run_dynamic_agent_goal instead of run_dynamic_agent when a subtask has a verifiable end state (tests pass, typecheck clean, file exists) and may need several iterations.',
    '- Use run_agent_debate when a decision is contested and orthogonal critique before synthesis beats one opinion.',
    '- Do not write code or answer questions yourself — delegate everything to dynamic agents.',
].join('\n');

const ORCHESTRATOR_AGENT_PROFILE: AgentProfile = {
    id: 'dynamic-agents-orchestrator',
    name: 'Orchestrator',
    provider: 'openai-compatible',
    model: 'non-stop',
    maxTokens: 16384,
    maxIterations: 0,
    minTimeBetweenToolCalls: 0,
    systemPrompt: ORCHESTRATOR_USER_MESSAGE,
    enabledServers: [],
    toolApprovals: {},
    toolSettings: {},
    disabledExtensionTools: [],
    includeContextFiles: false,
    includeRepoMap: false,
    usePowerTools: true,
    useAiderTools: false,
    useTodoTools: true,
    useSubagents: false,
    useTaskTools: false,
    useMemoryTools: false,
    useSkillsTools: true,
    useExtensionTools: true,
    customInstructions: '',
    subagent: {
        enabled: false,
        contextMemory: ContextMemoryMode.Off,
        systemPrompt: '',
        invocationMode: InvocationMode.OnDemand,
        color: '#a78bfa',
        description: 'Dynamic subagents are provided by the run_dynamic_agent extension tool.',
    },
};

export const runInputSchema = z.object({
    prompt: z
        .string()
        .min(1)
        .describe('Task for the dynamic agent. Give complete, self-contained instructions.'),
    name: z
        .string()
        .optional()
        .describe('Session-scoped name. Reusing the same name reuses the same profile.'),
    systemPrompt: z
        .string()
        .min(1)
        .describe(
            'Instructions and role for the subagent. Required. Also used as its description.',
        ),
    provider: z.string().optional(),
    model: z.string().optional(),
    maxTokens: z
        .number()
        .int()
        .positive()
        .max(128000)
        .optional()
        .describe(
            'Maximum output tokens for the subagent. Pass this value when the subagent writes long reports and hits the token limit.',
        ),
    includeContextFiles: z.boolean().optional(),
    useAiderTools: z
        .boolean()
        .optional()
        .describe('Override the parent useAiderTools for this agent.'),
    usePowerTools: z
        .boolean()
        .optional()
        .describe('Override the parent usePowerTools for this agent.'),
    useTodoTools: z
        .boolean()
        .optional()
        .describe('Override the parent useTodoTools for this agent.'),
    enabledServers: z
        .array(z.string())
        .optional()
        .describe('List of enabled MCP servers for this agent. Defaults to parent agent servers.'),
    useSkillsTools: z
        .boolean()
        .optional()
        .describe('Override the parent useSkillsTools for this agent.'),
    useTaskTools: z
        .boolean()
        .optional()
        .describe('Override the parent useTaskTools for this agent.'),
    useMemoryTools: z
        .boolean()
        .optional()
        .describe('Override the parent useMemoryTools for this agent.'),
    idleTimeoutSeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'Maximum seconds of inactivity before interrupting the subagent. Defaults to 180 seconds. Set to 0 to disable.',
        ),
    preset: z
        .enum(['reviewer', 'tester', 'architect', 'refactorer', 'researcher'])
        .optional()
        .describe('Preset archetype for specialized system instructions and role.'),
    contextFiles: z
        .array(z.string())
        .optional()
        .describe('List of file paths to load into the subagent context.'),
});

export const listInputSchema = z.object({
    reason: z.string().describe('Brief explanation of why you are calling this tool'),
});

export type SpawnOutcomeStatus = 'ok' | 'timeout' | 'error' | 'aborted';

export interface SpawnOutcome {
    status: SpawnOutcomeStatus;
    text: string;
    seconds: number;
    stepsCount: number;
    toolCallsCount: number;
}

export interface RoundRequest {
    name: string;
    systemPrompt: string;
    prompt: string;
    maxTokens?: number;
    provider?: string;
    model?: string;
}

type TaskContextLike = NonNullable<ReturnType<ExtensionContext['getTaskContext']>>;

const GOAL_RUNNER_SYSTEM_PROMPT = [
    'You are a goal-driven worker agent.',
    'You receive a goal and work toward it autonomously inside a single reply.',
    'Implement as much as possible, run the given verification steps, and fix what fails.',
    'You can delegate subtasks or run independent reviews by calling run_dynamic_agent.',
].join('\n');

const GOAL_VERDICT_INSTRUCTIONS = [
    'End your reply with exactly one verdict line and nothing after it:',
    "- 'GOAL: achieved' when the goal is fully met and verified,",
    "- 'GOAL: continue: <what remains>' when work remains,",
    "- 'GOAL: blocked: <reason>' when you cannot proceed.",
].join('\n');

export type GoalVerdict =
    | { kind: 'achieved' }
    | { kind: 'continue'; remaining: string }
    | { kind: 'blocked'; reason: string }
    | { kind: 'malformed'; raw: string }
    | { kind: 'absent' };

export const parseGoalVerdict = (text: string): GoalVerdict => {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const last = lines[lines.length - 1];
    if (!last) {
        return { kind: 'absent' };
    }
    if (last === 'GOAL: achieved') {
        return { kind: 'achieved' };
    }
    if (last.startsWith('GOAL: continue: ')) {
        const remaining = last.slice('GOAL: continue: '.length).trim();
        return remaining.length > 0
            ? { kind: 'continue', remaining }
            : { kind: 'malformed', raw: last };
    }
    if (last.startsWith('GOAL: blocked: ')) {
        const reason = last.slice('GOAL: blocked: '.length).trim();
        return reason.length > 0 ? { kind: 'blocked', reason } : { kind: 'malformed', raw: last };
    }
    if (last.startsWith('GOAL:')) {
        return { kind: 'malformed', raw: last };
    }
    return { kind: 'absent' };
};

export const stripGoalVerdictLine = (text: string): string => {
    const lines = text.split('\n');
    let endIndex = lines.length - 1;
    while (endIndex >= 0 && (lines[endIndex]?.trim().length ?? 0) === 0) {
        endIndex -= 1;
    }
    const endLine = lines[endIndex];
    if (endIndex < 0 || !endLine || !endLine.trim().startsWith('GOAL:')) {
        return text;
    }
    const kept = lines.slice(0, endIndex);
    while (kept.length > 0 && (kept[kept.length - 1]?.trim().length ?? 0) === 0) {
        kept.pop();
    }
    return kept.join('\n');
};

const summarizeRoundText = (text: string): string => {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= 400) {
        return collapsed;
    }
    return `${collapsed.slice(0, 400)}...`;
};

export interface GoalRoundHistoryEntry {
    round: number;
    verdict: string;
    summary: string;
}

export interface GoalRoundPromptInput {
    goal: string;
    task?: string;
    verifyInstructions?: string;
    round: number;
    maxRounds: number;
    history: GoalRoundHistoryEntry[];
    previousText: string;
    formatNote?: string;
}

export const buildGoalRoundPrompt = (input: GoalRoundPromptInput): string => {
    const sections: string[] = [];
    sections.push(`Goal: ${input.goal}`);
    const task = input.task?.trim();
    if (task && task.length > 0 && task !== input.goal.trim()) {
        sections.push(`Task instructions: ${task}`);
    }
    const verify = input.verifyInstructions?.trim();
    if (verify && verify.length > 0) {
        sections.push(`Verification steps: ${verify}`);
    }
    const totalRoundsLabel =
        input.maxRounds === 0 || !Number.isFinite(input.maxRounds)
            ? 'unlimited'
            : String(input.maxRounds);
    sections.push(`Round ${input.round} of ${totalRoundsLabel}.`);
    if (input.history.length > 0) {
        const historyLines = input.history.map(
            (entry) => `- Round ${entry.round} (${entry.verdict}): ${entry.summary}`,
        );
        sections.push(`History of previous rounds:\n${historyLines.join('\n')}`);
    }
    if (input.previousText.trim().length > 0) {
        sections.push(`Previous round result:\n${input.previousText.trim()}`);
    }
    if (input.formatNote) {
        sections.push(input.formatNote);
    }
    sections.push(`Continue working toward the goal. ${GOAL_VERDICT_INSTRUCTIONS}`);
    return sections.join('\n\n');
};

export type GoalLoopStatus = 'achieved' | 'incomplete' | 'blocked';

export interface GoalLoopResult {
    status: GoalLoopStatus;
    reason?: string;
    rounds: number;
    text: string;
}

export interface GoalLoopOptions {
    goal: string;
    task?: string;
    verifyInstructions?: string;
    maxRounds: number;
    systemPrompt: string;
    name: string;
    runRound: (req: RoundRequest) => Promise<SpawnOutcome>;
    signal?: AbortSignal;
}

export const runGoalLoop = async (options: GoalLoopOptions): Promise<GoalLoopResult> => {
    const history: GoalRoundHistoryEntry[] = [];
    let previousText = '';
    let formatNote: string | undefined;

    if (options.signal?.aborted) {
        return { status: 'blocked', reason: 'aborted before start', rounds: 0, text: '' };
    }

    const isUnlimited = options.maxRounds === 0 || !Number.isFinite(options.maxRounds);
    for (let round = 1; isUnlimited || round <= options.maxRounds; round += 1) {
        if (options.signal?.aborted) {
            return { status: 'blocked', reason: 'aborted', rounds: round - 1, text: previousText };
        }
        const prompt = buildGoalRoundPrompt({
            goal: options.goal,
            task: options.task,
            verifyInstructions: options.verifyInstructions,
            round,
            maxRounds: options.maxRounds,
            history,
            previousText,
            formatNote,
        });
        const outcome = await options.runRound({
            name: options.name,
            systemPrompt: options.systemPrompt,
            prompt,
        });
        const stripped = stripGoalVerdictLine(outcome.text);
        if (outcome.status !== 'ok') {
            return {
                status: 'blocked',
                reason: `round ${round} ${outcome.status}`,
                rounds: round,
                text: stripped,
            };
        }
        const verdict = parseGoalVerdict(outcome.text);
        if (verdict.kind === 'achieved') {
            return { status: 'achieved', rounds: round, text: stripped };
        }
        if (verdict.kind === 'blocked') {
            return { status: 'blocked', reason: verdict.reason, rounds: round, text: stripped };
        }
        if (verdict.kind === 'absent') {
            return { status: 'incomplete', reason: 'no verdict', rounds: round, text: stripped };
        }
        if (verdict.kind === 'malformed') {
            formatNote = `Your previous reply ended with an invalid goal verdict line: '${verdict.raw}'. ${GOAL_VERDICT_INSTRUCTIONS}`;
        } else {
            formatNote = undefined;
        }
        history.push({
            round,
            verdict: verdict.kind === 'malformed' ? 'malformed' : 'continue',
            summary: summarizeRoundText(stripped),
        });
        previousText = stripped;
    }
    return {
        status: 'incomplete',
        reason: 'max rounds reached',
        rounds: options.maxRounds,
        text: previousText,
    };
};

export type DebateVerdict =
    | { kind: 'agree' }
    | { kind: 'disagree'; reason: string }
    | { kind: 'malformed'; raw: string }
    | { kind: 'absent' };

export const DEBATE_VERDICT_INSTRUCTIONS =
    'Your reply MUST end with exactly one verdict line as the very last line: ' +
    'either "DEBATE: agree" (if you accept the opponent\'s position or agree on a resolution) ' +
    'or "DEBATE: disagree: <why you maintain your disagreement>". ' +
    'Nothing may follow the verdict line.';

export const parseDebateVerdict = (text: string): DebateVerdict => {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) {
        return { kind: 'absent' };
    }
    const last = lines[lines.length - 1];
    if (!last) {
        return { kind: 'absent' };
    }
    if (last === 'DEBATE: agree') {
        return { kind: 'agree' };
    }
    if (last.startsWith('DEBATE: disagree:')) {
        const reason = last.slice('DEBATE: disagree:'.length).trim();
        if (reason.length > 0) {
            return { kind: 'disagree', reason };
        }
    }
    if (last.startsWith('DEBATE:')) {
        return { kind: 'malformed', raw: last };
    }
    return { kind: 'absent' };
};

export const stripDebateVerdictLine = (text: string): string => {
    const lines = text.split('\n');
    let lastNonEmptyIndex = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const currentLine = lines[i];
        if (currentLine !== undefined && currentLine.trim().length > 0) {
            lastNonEmptyIndex = i;
            break;
        }
    }
    if (lastNonEmptyIndex === -1) {
        return text;
    }
    const targetLine = lines[lastNonEmptyIndex];
    if (targetLine?.trim().startsWith('DEBATE:')) {
        return lines.slice(0, lastNonEmptyIndex).join('\n').trimEnd();
    }
    return text;
};

export const formatGoalResult = (result: GoalLoopResult): string => {
    let firstLine: string;
    if (result.status === 'achieved') {
        firstLine = `GOAL_RESULT: achieved (rounds ${result.rounds})`;
    } else if (result.status === 'incomplete') {
        firstLine = `GOAL_RESULT: incomplete (rounds ${result.rounds}, ${result.reason ?? 'unknown'})`;
    } else {
        firstLine = `GOAL_RESULT: blocked (rounds ${result.rounds}, reason: ${result.reason ?? 'unknown'})`;
    }
    return result.text.trim().length > 0 ? `${firstLine}\n\n${result.text}` : firstLine;
};

export const DEBATE_ADVOCATE_PROMPT = [
    'You are a dedicated advocate in a structured debate.',
    'Build the strongest evidence-based case FOR the proposal or topic.',
    'Focus on upside, strategic benefits, feasibility, and supporting evidence.',
    'State the concrete conditions where this approach delivers maximum value.',
].join('\n');

export const DEBATE_CRITIC_PROMPT = [
    'You are a dedicated critic in a structured debate.',
    'Attack the assumptions, hidden costs, failure modes, and edge cases of the proposal or topic.',
    'Argue the countercase with precision, highlight systemic risks, and do not hedge.',
    'State the concrete evidence or guarantees that would change your mind.',
].join('\n');

export const DEBATE_SYNTHESIZER_PROMPT = [
    'You are an impartial synthesizer in a structured debate.',
    'Merge the strongest points of both the advocate and the critic without favoring either side.',
    'Produce a balanced synthesis with actionable recommendations and explicit trade-offs.',
    'If the disagreement cannot be resolved by evidence, end your reply with exactly one line:',
    "'NO_CONSENSUS: <comma-separated list of unresolved disagreements>'.",
].join('\n');

export interface DebateAgentNames {
    advocate: string;
    critic: string;
    synthesizer: string;
}

export const buildDebateAgentNames = (n: number): DebateAgentNames => ({
    advocate: `debate-${n}-advocate`,
    critic: `debate-${n}-critic`,
    synthesizer: `debate-${n}-synthesizer`,
});

export interface DebateOpening {
    advocate: string;
    critic: string;
}

export interface DebateRebuttalPair {
    pair: number;
    advocate: string;
    critic: string;
}

export interface DebateRecord {
    topic: string;
    openings: DebateOpening;
    rebuttals: DebateRebuttalPair[];
}

export const buildDebateTranscript = (record: DebateRecord): string => {
    const blocks: string[] = [];
    blocks.push(`TOPIC: ${record.topic.trim()}`);
    blocks.push(`=== OPENING: ADVOCATE ===\n${record.openings.advocate.trim()}`);
    blocks.push(`=== OPENING: CRITIC ===\n${record.openings.critic.trim()}`);
    for (const rebuttal of record.rebuttals) {
        blocks.push(
            `=== REBUTTAL PAIR ${rebuttal.pair}: ADVOCATE ===\n${rebuttal.advocate.trim()}`,
        );
        blocks.push(`=== REBUTTAL PAIR ${rebuttal.pair}: CRITIC ===\n${rebuttal.critic.trim()}`);
    }
    return blocks.join('\n\n');
};

export type DebatePromptVariant =
    | { kind: 'opening'; role: 'advocate' | 'critic'; topic: string }
    | {
          kind: 'rebuttal';
          role: 'advocate' | 'critic';
          pair: number;
          topic: string;
          ownOpening: string;
          opponentLatest: string;
      }
    | { kind: 'synthesis'; transcript: string };

export const buildDebateRoundPrompt = (variant: DebatePromptVariant): string => {
    if (variant.kind === 'opening') {
        const roleLabel = variant.role === 'advocate' ? 'advocate' : 'critic';
        return [
            `Debate topic: ${variant.topic.trim()}`,
            '',
            `You are giving the opening statement as the ${roleLabel}. State your position clearly based on the topic. Do not assume what the other side will argue.`,
        ].join('\n');
    }
    if (variant.kind === 'rebuttal') {
        const isAdvocate = variant.role === 'advocate';
        const roleLabel = isAdvocate ? 'advocate' : 'critic';
        const opponentLabel = isAdvocate ? 'critic' : 'advocate';
        return [
            `Debate topic: ${variant.topic.trim()}`,
            '',
            `Your opening position as ${roleLabel}:`,
            variant.ownOpening.trim(),
            '',
            `Latest statement from the ${opponentLabel}:`,
            variant.opponentLatest.trim(),
            '',
            `This is rebuttal pair ${variant.pair}. Address the points above directly: defend your strongest claims and challenge the weaknesses in the ${opponentLabel}'s latest statement.`,
        ].join('\n');
    }
    return [
        'You are the neutral synthesizer. Below is the full debate transcript.',
        '',
        variant.transcript.trim(),
        '',
        'Synthesize both perspectives. Identify points of agreement, core trade-offs, and an actionable path forward. If the positions cannot be reconciled, end your reply with exactly one line: NO_CONSENSUS: <unresolved items>.',
    ].join('\n');
};

export type DebateSequenceStatus = 'synthesis' | 'synthesis_failed' | 'blocked';

export interface DebateSequenceResult {
    status: DebateSequenceStatus;
    rounds: number;
    text: string;
    stage?: string;
    reason?: string;
}

export interface DebateSequenceOptions {
    topic: string;
    rounds: number;
    names: DebateAgentNames;
    advocateSystemPrompt?: string;
    criticSystemPrompt?: string;
    synthesizerSystemPrompt?: string;
    maxTokens?: number;
    provider?: string;
    model?: string;
    runRound: (req: RoundRequest) => Promise<SpawnOutcome>;
    signal?: AbortSignal;
}

export const runDebateSequence = async (
    options: DebateSequenceOptions,
): Promise<DebateSequenceResult> => {
    if (options.signal?.aborted) {
        return {
            status: 'blocked',
            rounds: 0,
            text: '',
            stage: 'init',
            reason: 'aborted before start',
        };
    }

    const advocateSystemPrompt = options.advocateSystemPrompt ?? DEBATE_ADVOCATE_PROMPT;
    const criticSystemPrompt = options.criticSystemPrompt ?? DEBATE_CRITIC_PROMPT;
    const synthesizerSystemPrompt = options.synthesizerSystemPrompt ?? DEBATE_SYNTHESIZER_PROMPT;

    // Stage 1: Advocate Opening
    const advocateOpeningPrompt = buildDebateRoundPrompt({
        kind: 'opening',
        role: 'advocate',
        topic: options.topic,
    });
    const advocateOpeningOutcome = await options.runRound({
        name: options.names.advocate,
        systemPrompt: advocateSystemPrompt,
        prompt: advocateOpeningPrompt,
        maxTokens: options.maxTokens,
        provider: options.provider,
        model: options.model,
    });
    if (advocateOpeningOutcome.status !== 'ok') {
        return {
            status: 'blocked',
            rounds: 0,
            stage: 'advocate-opening',
            reason: advocateOpeningOutcome.status,
            text: advocateOpeningOutcome.text,
        };
    }
    const advocateOpeningText = advocateOpeningOutcome.text;

    if (options.signal?.aborted) {
        return {
            status: 'blocked',
            rounds: 0,
            stage: 'advocate-opening',
            reason: 'aborted',
            text: advocateOpeningText,
        };
    }

    // Stage 2: Critic Opening (independent — sees only topic)
    const criticOpeningPrompt = buildDebateRoundPrompt({
        kind: 'opening',
        role: 'critic',
        topic: options.topic,
    });
    const criticOpeningOutcome = await options.runRound({
        name: options.names.critic,
        systemPrompt: criticSystemPrompt,
        prompt: criticOpeningPrompt,
        maxTokens: options.maxTokens,
        provider: options.provider,
        model: options.model,
    });
    if (criticOpeningOutcome.status !== 'ok') {
        const partialRecord: DebateRecord = {
            topic: options.topic,
            openings: {
                advocate: advocateOpeningText,
                critic: criticOpeningOutcome.text,
            },
            rebuttals: [],
        };
        return {
            status: 'blocked',
            rounds: 0,
            stage: 'critic-opening',
            reason: criticOpeningOutcome.status,
            text: buildDebateTranscript(partialRecord),
        };
    }
    const criticOpeningText = criticOpeningOutcome.text;

    const record: DebateRecord = {
        topic: options.topic,
        openings: {
            advocate: advocateOpeningText,
            critic: criticOpeningText,
        },
        rebuttals: [],
    };

    let latestAdvocateStatement = advocateOpeningText;
    let latestCriticStatement = criticOpeningText;
    let completedPairs = 0;

    // Stage 3: Rebuttal pairs
    const isUnlimited = options.rounds === 0 || !Number.isFinite(options.rounds);
    let pair = 1;
    while (isUnlimited || pair <= options.rounds) {
        if (options.signal?.aborted) {
            return {
                status: 'blocked',
                rounds: completedPairs,
                stage: `rebuttal-pair-${pair}-init`,
                reason: 'aborted',
                text: buildDebateTranscript(record),
            };
        }

        // Advocate rebuts critic's latest
        const advocateRebuttalPrompt = buildDebateRoundPrompt({
            kind: 'rebuttal',
            role: 'advocate',
            pair,
            topic: options.topic,
            ownOpening: advocateOpeningText,
            opponentLatest: latestCriticStatement,
        });
        const advocateRebuttalOutcome = await options.runRound({
            name: options.names.advocate,
            systemPrompt: advocateSystemPrompt,
            prompt: advocateRebuttalPrompt,
            maxTokens: options.maxTokens,
            provider: options.provider,
            model: options.model,
        });
        if (advocateRebuttalOutcome.status !== 'ok') {
            return {
                status: 'blocked',
                rounds: completedPairs,
                stage: `rebuttal-pair-${pair}-advocate`,
                reason: advocateRebuttalOutcome.status,
                text: buildDebateTranscript(record),
            };
        }
        const advocateVerdict = parseDebateVerdict(advocateRebuttalOutcome.text);
        latestAdvocateStatement = stripDebateVerdictLine(advocateRebuttalOutcome.text);

        if (options.signal?.aborted) {
            return {
                status: 'blocked',
                rounds: completedPairs,
                stage: `rebuttal-pair-${pair}-advocate`,
                reason: 'aborted',
                text: buildDebateTranscript(record),
            };
        }

        // Critic rebuts advocate's latest
        const criticRebuttalPrompt = buildDebateRoundPrompt({
            kind: 'rebuttal',
            role: 'critic',
            pair,
            topic: options.topic,
            ownOpening: criticOpeningText,
            opponentLatest: latestAdvocateStatement,
        });
        const criticRebuttalOutcome = await options.runRound({
            name: options.names.critic,
            systemPrompt: criticSystemPrompt,
            prompt: criticRebuttalPrompt,
            maxTokens: options.maxTokens,
            provider: options.provider,
            model: options.model,
        });
        if (criticRebuttalOutcome.status !== 'ok') {
            return {
                status: 'blocked',
                rounds: completedPairs,
                stage: `rebuttal-pair-${pair}-critic`,
                reason: criticRebuttalOutcome.status,
                text: buildDebateTranscript(record),
            };
        }
        const criticVerdict = parseDebateVerdict(criticRebuttalOutcome.text);
        latestCriticStatement = stripDebateVerdictLine(criticRebuttalOutcome.text);

        record.rebuttals.push({
            pair,
            advocate: latestAdvocateStatement,
            critic: latestCriticStatement,
        });
        completedPairs = pair;

        // Check for consensus: both advocate and critic agreed in this pair
        if (advocateVerdict.kind === 'agree' && criticVerdict.kind === 'agree') {
            break;
        }

        pair += 1;
    }

    if (options.signal?.aborted) {
        return {
            status: 'blocked',
            rounds: completedPairs,
            stage: 'pre-synthesis',
            reason: 'aborted',
            text: buildDebateTranscript(record),
        };
    }

    // Stage 4: Synthesizer gets full transcript
    const transcript = buildDebateTranscript(record);
    const synthesisPrompt = buildDebateRoundPrompt({
        kind: 'synthesis',
        transcript,
    });
    const synthesisOutcome = await options.runRound({
        name: options.names.synthesizer,
        systemPrompt: synthesizerSystemPrompt,
        prompt: synthesisPrompt,
        maxTokens: options.maxTokens,
        provider: options.provider,
        model: options.model,
    });
    if (synthesisOutcome.status !== 'ok') {
        return {
            status: 'synthesis_failed',
            rounds: completedPairs,
            reason: synthesisOutcome.status,
            text: transcript,
        };
    }

    return {
        status: 'synthesis',
        rounds: completedPairs,
        text: synthesisOutcome.text,
    };
};

export const formatDebateResult = (result: DebateSequenceResult): string => {
    let firstLine: string;
    if (result.status === 'synthesis') {
        firstLine = `DEBATE_RESULT: synthesis (rounds ${result.rounds})`;
    } else if (result.status === 'synthesis_failed') {
        firstLine = `DEBATE_RESULT: synthesis_failed (${result.reason ?? 'unknown'})`;
    } else {
        const stagePart = result.stage ? `stage: ${result.stage}: ` : '';
        firstLine = `DEBATE_RESULT: blocked (${stagePart}${result.reason ?? 'unknown'})`;
    }
    return result.text.trim().length > 0 ? `${firstLine}\n\n${result.text}` : firstLine;
};

export const debateInputSchema = z.object({
    topic: z
        .string()
        .min(1)
        .describe(
            'The proposal, design decision, or thesis to debate from orthogonal perspectives.',
        ),
    rounds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'Number of rebuttal pairs between advocate and critic before synthesis. Set to 0 to debate continuously until both sides reach consensus (DEBATE: agree). Default from extension settings.',
        ),
    advocateSystemPrompt: z
        .string()
        .optional()
        .describe(
            'Override system instructions for the advocate agent. Defaults to DEBATE_ADVOCATE_PROMPT.',
        ),
    criticSystemPrompt: z
        .string()
        .optional()
        .describe(
            'Override system instructions for the critic agent. Defaults to DEBATE_CRITIC_PROMPT.',
        ),
    synthesizerSystemPrompt: z
        .string()
        .optional()
        .describe(
            'Override system instructions for the neutral synthesizer. Defaults to DEBATE_SYNTHESIZER_PROMPT.',
        ),
    provider: z.string().optional(),
    model: z.string().optional(),
    maxTokens: z
        .number()
        .int()
        .positive()
        .max(128000)
        .optional()
        .describe(
            'Maximum output tokens for each agent turn. Pass this value when turns write long arguments and hit the token limit.',
        ),
    includeContextFiles: z.boolean().optional(),
    useAiderTools: z
        .boolean()
        .optional()
        .describe('Override the parent useAiderTools for debate agents.'),
    usePowerTools: z
        .boolean()
        .optional()
        .describe('Override the parent usePowerTools for debate agents.'),
    useTodoTools: z
        .boolean()
        .optional()
        .describe('Override the parent useTodoTools for debate agents.'),
    enabledServers: z
        .array(z.string())
        .optional()
        .describe(
            'List of enabled MCP servers for debate agents. Defaults to parent agent servers.',
        ),
    useSkillsTools: z
        .boolean()
        .optional()
        .describe('Override the parent useSkillsTools for debate agents.'),
    useTaskTools: z
        .boolean()
        .optional()
        .describe('Override the parent useTaskTools for debate agents.'),
    useMemoryTools: z
        .boolean()
        .optional()
        .describe('Override the parent useMemoryTools for debate agents.'),
    contextFiles: z
        .array(z.string())
        .optional()
        .describe('List of file paths to load into each debate agent context.'),
    idleTimeoutSeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'Maximum seconds of inactivity before interrupting an agent turn. Applies to each round separately. Defaults to 180 seconds. Set to 0 to disable.',
        ),
    preset: z
        .enum(['reviewer', 'tester', 'architect', 'refactorer', 'researcher'])
        .optional()
        .describe('Preset archetype for specialized system instructions and role.'),
});

export const goalInputSchema = z.object({
    goal: z
        .string()
        .min(1)
        .describe(
            'Verifiable end state for the goal loop, e.g. "npm test passes" or "typecheck is clean".',
        ),
    task: z.string().optional().describe('Initial task instructions. Defaults to the goal itself.'),
    verifyInstructions: z
        .string()
        .optional()
        .describe('How to verify that the goal is achieved, e.g. "run npm test".'),
    maxRounds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'Maximum number of agent rounds, including the round that reports achieved. Set to 0 or leave unset to use extension setting (or unlimited when 0).',
        ),
    name: z.string().optional().describe('Session-scoped name for the goal runner entry.'),
    provider: z.string().optional(),
    model: z.string().optional(),
    maxTokens: z
        .number()
        .int()
        .positive()
        .max(128000)
        .optional()
        .describe(
            'Maximum output tokens for each goal round. Pass this value when rounds write long reports and hit the token limit.',
        ),
    includeContextFiles: z.boolean().optional(),
    useAiderTools: z
        .boolean()
        .optional()
        .describe('Override the parent useAiderTools for this agent.'),
    usePowerTools: z
        .boolean()
        .optional()
        .describe('Override the parent usePowerTools for this agent.'),
    useTodoTools: z
        .boolean()
        .optional()
        .describe('Override the parent useTodoTools for this agent.'),
    enabledServers: z
        .array(z.string())
        .optional()
        .describe('List of enabled MCP servers for this agent. Defaults to parent agent servers.'),
    useSkillsTools: z
        .boolean()
        .optional()
        .describe('Override the parent useSkillsTools for this agent.'),
    useTaskTools: z
        .boolean()
        .optional()
        .describe('Override the parent useTaskTools for this agent.'),
    useMemoryTools: z
        .boolean()
        .optional()
        .describe('Override the parent useMemoryTools for this agent.'),
    contextFiles: z
        .array(z.string())
        .optional()
        .describe('List of file paths to load into the goal runner context.'),
    idleTimeoutSeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            'Maximum seconds of inactivity before interrupting a goal round. Applies to each round separately. Defaults to 180 seconds. Set to 0 to disable.',
        ),
    preset: z
        .enum(['reviewer', 'tester', 'architect', 'refactorer', 'researcher'])
        .optional()
        .describe('Preset archetype for specialized system instructions and role.'),
});

interface DynamicEntry {
    profile: AgentProfile;
    calls: number;
}

interface ActiveSubagentTracker {
    resetTimer: () => void;
    cancelTimer: () => void;
    stepsCount: number;
    toolCallsCount: number;
    startedAt: number;
    streamedText: string;
}

export const resolveEnabledServers = async (
    context: ExtensionContext,
    explicitServers?: string[],
): Promise<string[] | undefined> => {
    if (explicitServers !== undefined) {
        return explicitServers;
    }
    const config = readExtensionConfig();
    if (!config.enableAllMcpServersByDefault) {
        return undefined;
    }
    try {
        if (typeof context.getMcpServers === 'function') {
            const servers = await context.getMcpServers();
            if (servers && typeof servers === 'object') {
                return Object.keys(servers);
            }
        }
    } catch {
        // Fall back to undefined if getMcpServers fails
    }
    return undefined;
};

export const buildProfile = (
    base: AgentProfile,
    taskId: string,
    input: z.infer<typeof runInputSchema>,
    name: string,
): AgentProfile => {
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
    const cleanSlug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const slug = cleanSlug ? `${cleanSlug}-${hash}` : `agent-${hash}`;

    const useTodoTools = input.useTodoTools ?? false;
    const rawSystemPrompt = input.systemPrompt.trim();
    const presetPrompt = input.preset ? AGENT_PRESETS[input.preset] : undefined;
    const combinedSystemPrompt = presetPrompt
        ? `${presetPrompt}\n\n${rawSystemPrompt}`
        : rawSystemPrompt;
    const noTodoNotice =
        'You do not have access to TODO tools. Do not use or call any todo tools (todo_*, todo---*).';
    const systemPrompt = !useTodoTools
        ? `${combinedSystemPrompt}\n\n${noTodoNotice}`
        : combinedSystemPrompt;

    const finalEnabledServers =
        input.enabledServers ??
        (base.enabledServers && base.enabledServers.length > 0 ? base.enabledServers : undefined);

    return {
        ...base,
        id: `dynamic-agents-${taskId}-${slug}`,
        name,
        provider: input.provider ?? base.provider,
        model: input.model ?? base.model,
        // Sub-agents always run without an iteration limit; 0 means unlimited in AiderDesk.
        maxIterations: 0,
        maxTokens: input.maxTokens ?? base.maxTokens,
        includeContextFiles: input.includeContextFiles ?? base.includeContextFiles,
        useAiderTools: input.useAiderTools ?? base.useAiderTools,
        usePowerTools: input.usePowerTools ?? base.usePowerTools,
        useTodoTools,
        useSkillsTools: input.useSkillsTools ?? base.useSkillsTools,
        useTaskTools: input.useTaskTools ?? base.useTaskTools,
        useMemoryTools: input.useMemoryTools ?? base.useMemoryTools,
        enabledServers: finalEnabledServers ?? base.enabledServers,
        isSubagent: true,
        useSubagents: false,
        systemPrompt,
        customInstructions: systemPrompt,
        subagent: {
            ...base.subagent,
            enabled: false,
            contextMemory: ContextMemoryMode.Off,
            systemPrompt,
            description: input.systemPrompt,
        },
    };
};

export default class DynamicAgentsExtension implements Extension {
    static metadata = {
        name: 'Dynamic Agents',
        version: '1.5.0',
        description:
            'Spawns ephemeral session-scoped subagents from inline profiles. Nothing is written to disk.',
        author: 'local',
        capabilities: ['tools', 'modes', 'agents', 'commands'],
    };

    private sessions = new Map<string, Map<string, DynamicEntry>>();

    private results = new Map<string, string>();

    private orchestratorProfileEdits = new Map<string, AgentProfile>();

    private activeSubagents = new Map<string, ActiveSubagentTracker>();

    private pendingContextFiles = new Map<string, string[]>();

    private debateCounters = new Map<string, number>();

    public configPath?: string;

    private profileDepths = new Map<string, number>();

    private getProfileDepth(profile: AgentProfile): number {
        const tracked = this.profileDepths.get(profile.id);
        if (tracked !== undefined) {
            return tracked;
        }
        for (const [id, depth] of this.profileDepths.entries()) {
            if (profile.id.startsWith(id)) {
                return depth;
            }
        }
        return profile.isSubagent ? 1 : 0;
    }

    private getMaxSubagentDepth(): number {
        const config = readExtensionConfig(this.configPath);
        return typeof config.maxSubagentDepth === 'number' && config.maxSubagentDepth >= 1
            ? config.maxSubagentDepth
            : (DEFAULT_CONFIG.maxSubagentDepth ?? 2);
    }

    getModes(_context: ExtensionContext): ModeDefinition[] {
        return [
            {
                name: 'orchestrator',
                label: 'Orchestrator',
                description:
                    'Decomposes the task into subtasks and delegates them to dynamic subagents',
                icon: 'GoStack',
            },
        ];
    }

    getAgents(_context: ExtensionContext): AgentProfile[] {
        return [
            this.orchestratorProfileEdits.get('dynamic-agents-orchestrator') ??
                ORCHESTRATOR_AGENT_PROFILE,
        ];
    }

    getCommands(context: ExtensionContext): CommandDefinition[] {
        return [
            {
                name: 'goal',
                description: 'Run an iterative goal loop toward a verifiable end state',
                arguments: [
                    {
                        description:
                            'The target goal (e.g. "make all tests pass" or "-r 5 run tests")',
                        required: true,
                    },
                ],
                execute: async (args: string[], execContext: ExtensionContext): Promise<void> => {
                    const taskContext =
                        execContext?.getTaskContext?.() ?? context?.getTaskContext?.();
                    if (!taskContext) {
                        context.log('No active task context for /goal command', 'warn');
                        return;
                    }
                    const parsed = parseCommandArgs(args);
                    if (!parsed.text) {
                        taskContext.addLogMessage(
                            'warning',
                            'Usage: /goal [-r <rounds>] [-p <preset>] [-t <timeout>] <verifiable goal>\nExample: /goal -r 5 npm test passes',
                        );
                        return;
                    }

                    const modifiers: string[] = [];
                    if (parsed.rounds !== undefined) {
                        modifiers.push(`maxRounds: ${parsed.rounds}`);
                    }
                    if (parsed.preset) {
                        modifiers.push(`preset: ${parsed.preset}`);
                    }
                    if (parsed.timeoutSeconds !== undefined) {
                        modifiers.push(`idleTimeoutSeconds: ${parsed.timeoutSeconds}`);
                    }

                    const prompt =
                        modifiers.length > 0
                            ? `Achieve this verifiable goal using run_dynamic_agent_goal (${modifiers.join(', ')}):\n${parsed.text}`
                            : `Achieve this verifiable goal using run_dynamic_agent_goal:\n${parsed.text}`;

                    await taskContext.runPrompt(prompt, 'orchestrator');
                },
            },
            {
                name: 'debate',
                description:
                    'Run a structured debate between advocate and critic agents on a topic',
                arguments: [
                    {
                        description:
                            'The topic or design decision to debate (e.g. "-r 2 Monorepo vs Polyrepo")',
                        required: true,
                    },
                ],
                execute: async (args: string[], execContext: ExtensionContext): Promise<void> => {
                    const taskContext =
                        execContext?.getTaskContext?.() ?? context?.getTaskContext?.();
                    if (!taskContext) {
                        context.log('No active task context for /debate command', 'warn');
                        return;
                    }
                    const parsed = parseCommandArgs(args);
                    if (!parsed.text) {
                        taskContext.addLogMessage(
                            'warning',
                            'Usage: /debate [-r <rounds>] [-p <preset>] [-t <timeout>] <topic or decision>\nExample: /debate -r 3 TypeScript vs Rust for backend',
                        );
                        return;
                    }

                    const modifiers: string[] = [];
                    if (parsed.rounds !== undefined) {
                        modifiers.push(`rounds: ${parsed.rounds}`);
                    }
                    if (parsed.preset) {
                        modifiers.push(`preset: ${parsed.preset}`);
                    }
                    if (parsed.timeoutSeconds !== undefined) {
                        modifiers.push(`idleTimeoutSeconds: ${parsed.timeoutSeconds}`);
                    }

                    const prompt =
                        modifiers.length > 0
                            ? `Conduct a structured debate on this topic using run_agent_debate (${modifiers.join(', ')}):\n${parsed.text}`
                            : `Conduct a structured debate on this topic using run_agent_debate:\n${parsed.text}`;

                    await taskContext.runPrompt(prompt, 'orchestrator');
                },
            },
        ];
    }

    getConfigComponent(_context: ExtensionContext): string | undefined {
        try {
            if (existsSync(CONFIG_COMPONENT_PATH)) {
                return readFileSync(CONFIG_COMPONENT_PATH, 'utf-8');
            }
        } catch {
            // Ignore error
        }
        return undefined;
    }

    async getConfigData(_context: ExtensionContext): Promise<unknown> {
        return readExtensionConfig(this.configPath);
    }

    async saveConfigData(configData: unknown, _context: ExtensionContext): Promise<unknown> {
        const data = (configData ?? {}) as Partial<ExtensionConfig>;
        return writeExtensionConfig(data, this.configPath);
    }

    async onAgentProfileUpdated(
        _context: ExtensionContext,
        agentId: string,
        updatedProfile: AgentProfile,
    ): Promise<AgentProfile> {
        this.orchestratorProfileEdits.set(agentId, updatedProfile);
        return updatedProfile;
    }

    onLoad(context: ExtensionContext): void {
        context.addDisposable(() => () => {
            for (const tracker of this.activeSubagents.values()) {
                tracker.cancelTimer();
            }
            this.activeSubagents.clear();
            this.pendingContextFiles.clear();
            this.sessions.clear();
            this.results.clear();
            this.orchestratorProfileEdits.clear();
            this.debateCounters.clear();
            this.profileDepths.clear();
        });
    }

    async onProjectStopped(
        _event: ProjectStoppedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<ProjectStoppedEvent>> {
        for (const tracker of this.activeSubagents.values()) {
            tracker.cancelTimer();
        }
        this.activeSubagents.clear();
        this.pendingContextFiles.clear();
        this.sessions.clear();
        this.results.clear();
        this.orchestratorProfileEdits.clear();
        this.debateCounters.clear();
        this.profileDepths.clear();
        return undefined;
    }

    async onAgentStarted(
        event: AgentStartedEvent,
        context: ExtensionContext,
    ): Promise<undefined | Partial<AgentStartedEvent>> {
        if (event.mode !== 'orchestrator') {
            return undefined;
        }

        const alreadyInjected = event.contextMessages.some(
            (msg) => msg.id === 'dynamic-agents-orchestrator-user',
        );
        if (alreadyInjected) {
            return undefined;
        }

        context.log(
            'Orchestrator mode active - prepending orchestration instructions to context messages',
            'info',
        );

        // Populate enabledServers on the orchestrator profile if needed
        const config = readExtensionConfig(this.configPath);
        if (
            config.enableAllMcpServersByDefault &&
            event.agentProfile &&
            (!event.agentProfile.enabledServers || event.agentProfile.enabledServers.length === 0)
        ) {
            try {
                if (typeof context.getMcpServers === 'function') {
                    const servers = await context.getMcpServers();
                    if (servers && typeof servers === 'object') {
                        event.agentProfile.enabledServers = Object.keys(servers);
                        this.orchestratorProfileEdits.set(
                            event.agentProfile.id,
                            event.agentProfile,
                        );
                    }
                }
            } catch {
                // Ignore MCP lookup error
            }
        }

        const orchestratorUserMessage = {
            id: 'dynamic-agents-orchestrator-user',
            role: 'user' as const,
            content: ORCHESTRATOR_USER_MESSAGE,
        };
        const orchestratorAssistantMessage = {
            id: 'dynamic-agents-orchestrator-assistant',
            role: 'assistant' as const,
            content: ORCHESTRATOR_ASSISTANT_MESSAGE,
        };

        return {
            contextMessages: [
                orchestratorUserMessage,
                orchestratorAssistantMessage,
                ...event.contextMessages,
            ],
        };
    }

    async onSubagentStarted(
        event: SubagentStartedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<SubagentStartedEvent>> {
        const pending = this.pendingContextFiles.get(event.subagentProfile.id);
        if (pending && pending.length > 0) {
            const filesToAdd: ContextFile[] = pending.map((filePath) => ({
                path: filePath,
            }));
            event.contextFiles.push(...filesToAdd);
        }
        this.pendingContextFiles.delete(event.subagentProfile.id);
        return undefined;
    }

    async onSubagentFinished(
        event: SubagentFinishedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<SubagentFinishedEvent>> {
        if (!this.activeSubagents.has(event.subagentProfile.id)) {
            return undefined;
        }
        const text = extractResultText(event.resultMessages);
        this.results.set(event.subagentProfile.id, text);
        return undefined;
    }

    private touchActiveSubagent(agentId?: string): void {
        if (!agentId) {
            return;
        }
        const tracker = this.activeSubagents.get(agentId);
        if (tracker) {
            tracker.resetTimer();
        }
    }

    async onAgentStepStarted(
        event: AgentStepStartedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<AgentStepStartedEvent>> {
        this.touchActiveSubagent(event.agentProfile?.id);
        return undefined;
    }

    async onAgentStepFinished(
        event: AgentStepFinishedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<AgentStepFinishedEvent>> {
        const tracker = this.activeSubagents.get(event.agentProfile?.id);
        if (tracker) {
            tracker.stepsCount += 1;
            tracker.resetTimer();
        }
        return undefined;
    }

    async onToolCalled(
        event: ToolCalledEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<ToolCalledEvent>> {
        this.touchActiveSubagent(event.agentProfile?.id);
        return undefined;
    }

    async onToolFinished(
        event: ToolFinishedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<ToolFinishedEvent>> {
        const tracker = this.activeSubagents.get(event.agentProfile?.id);
        if (tracker) {
            tracker.toolCallsCount += 1;
            tracker.resetTimer();
        }
        return undefined;
    }

    async onResponseChunk(
        event: ResponseChunkEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<ResponseChunkEvent>> {
        const chunk = event.chunk?.chunk;
        if (!chunk) {
            return undefined;
        }
        const targetedEvent = event as unknown as {
            agentId?: string;
            subagentId?: string;
            agentProfile?: { id?: string };
        };
        const targetId =
            targetedEvent.agentId ?? targetedEvent.subagentId ?? targetedEvent.agentProfile?.id;
        if (targetId) {
            const tracker = this.activeSubagents.get(targetId);
            if (tracker) {
                tracker.resetTimer();
                tracker.streamedText = (tracker.streamedText + chunk).slice(-16384);
            }
            return undefined;
        }
        for (const tracker of this.activeSubagents.values()) {
            tracker.resetTimer();
            tracker.streamedText = (tracker.streamedText + chunk).slice(-16384);
        }
        return undefined;
    }

    async onTaskClosed(
        event: TaskClosedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<TaskClosedEvent>> {
        this.dropTask(event.task.id);
        return undefined;
    }

    async onTaskDeleted(
        event: TaskDeletedEvent,
        _context: ExtensionContext,
    ): Promise<undefined | Partial<TaskDeletedEvent>> {
        this.dropTask(event.task.id);
        return undefined;
    }

    getTools(
        context: ExtensionContext,
        mode: string,
        agentProfile: AgentProfile,
    ): ToolDefinition[] {
        const runDynamicAgent: ToolDefinition<typeof runInputSchema> = {
            name: 'run_dynamic_agent',
            description:
                'Runs a dynamic agent with an inline profile. The subagent inherits the current agent tools and model unless useAiderTools or usePowerTools overrides are passed. The run is isolated and returns only the final text. The profile lives in memory for the current task session and never touches disk.',
            inputSchema: runInputSchema,
            execute: async (
                input: z.infer<typeof runInputSchema>,
                _signal: AbortSignal | undefined,
                execContext: ExtensionContext,
            ): Promise<string> => {
                const taskContext = execContext.getTaskContext() ?? context.getTaskContext();
                if (!taskContext) {
                    return 'Error: no active task context found.';
                }
                const taskId = taskContext.data.id;
                const callerDepth = this.getProfileDepth(agentProfile);
                const maxDepth = this.getMaxSubagentDepth();
                if (callerDepth >= maxDepth) {
                    return `Error: maximum subagent depth (${maxDepth}) reached.`;
                }
                if (_signal?.aborted) {
                    return 'Error: operation aborted.';
                }

                const name = input.name?.trim() || 'worker';
                let session = this.sessions.get(taskId);
                if (!session) {
                    session = new Map();
                    this.sessions.set(taskId, session);
                }

                const overridesProfile =
                    input.provider !== undefined ||
                    input.model !== undefined ||
                    input.systemPrompt !== undefined ||
                    input.maxTokens !== undefined ||
                    input.includeContextFiles !== undefined ||
                    input.useAiderTools !== undefined ||
                    input.usePowerTools !== undefined ||
                    input.useTodoTools !== undefined ||
                    input.enabledServers !== undefined ||
                    input.useSkillsTools !== undefined ||
                    input.useTaskTools !== undefined ||
                    input.useMemoryTools !== undefined ||
                    input.preset !== undefined ||
                    input.contextFiles !== undefined;

                const resolvedServers = await resolveEnabledServers(
                    execContext,
                    input.enabledServers,
                );
                const inputWithServers = {
                    ...input,
                    enabledServers: resolvedServers ?? input.enabledServers,
                };

                const childDepth = callerDepth + 1;
                let entry = session.get(name);
                if (!entry) {
                    entry = {
                        profile: buildProfile(agentProfile, taskId, inputWithServers, name),
                        calls: 0,
                    };
                    session.set(name, entry);
                } else if (overridesProfile) {
                    entry.profile = buildProfile(agentProfile, taskId, inputWithServers, name);
                }
                this.profileDepths.set(entry.profile.id, childDepth);

                entry.calls += 1;
                const config = readExtensionConfig(this.configPath);
                const idleTimeoutSeconds =
                    input.idleTimeoutSeconds ?? config.defaultIdleTimeoutSeconds ?? 180;
                const outcome = await this.spawnOnce({
                    execContext,
                    taskContext,
                    baseProfile: entry.profile,
                    prompt: input.prompt,
                    name,
                    contextFiles: input.contextFiles,
                    idleTimeoutSeconds,
                    signal: _signal,
                });
                if (outcome.status === 'timeout') {
                    const partialNote = outcome.text
                        ? `\n\nPartial response:\n${outcome.text}`
                        : '';
                    return `Dynamic agent "${name}" was interrupted after ${idleTimeoutSeconds}s of inactivity (idle timeout).${partialNote}`;
                }
                if (outcome.status === 'error' || outcome.status === 'aborted') {
                    return `Error: dynamic agent "${name}" failed: ${outcome.text}`;
                }
                const seconds = outcome.seconds.toFixed(1);
                const metrics = `[Completed in ${seconds}s | ${outcome.stepsCount} steps | ${outcome.toolCallsCount} tool calls]`;
                if (!outcome.text) {
                    return `Dynamic agent "${name}" finished in ${seconds}s with empty output.\n\n${metrics}`;
                }
                return `${name} (${entry.profile.provider}/${entry.profile.model}, ${seconds}s):\n\n${outcome.text}\n\n${metrics}`;
            },
        };

        const runDynamicAgentGoal: ToolDefinition<typeof goalInputSchema> = {
            name: 'run_dynamic_agent_goal',
            description:
                'Runs a goal loop: repeatedly spawns a dynamic subagent that works toward a verifiable goal. Each round must end with a verdict line (GOAL: achieved | GOAL: continue: <what remains> | GOAL: blocked: <reason>). The loop stops on achieved, on blocked, on a reply without a verdict, or when maxRounds is exhausted, and returns a result whose first line is GOAL_RESULT: <status> (rounds N). Use this tool when the task has a verifiable end state (tests pass, typecheck clean, file exists) and may need several iterations. Use run_dynamic_agent for a single self-contained subtask.',
            inputSchema: goalInputSchema,
            execute: async (
                input: z.infer<typeof goalInputSchema>,
                _signal: AbortSignal | undefined,
                execContext: ExtensionContext,
            ): Promise<string> => {
                const taskContext = execContext.getTaskContext() ?? context.getTaskContext();
                if (!taskContext) {
                    return 'Error: no active task context found.';
                }
                const taskId = taskContext.data.id;
                const callerDepth = this.getProfileDepth(agentProfile);
                const maxDepth = this.getMaxSubagentDepth();
                if (callerDepth >= maxDepth) {
                    return `Error: maximum subagent depth (${maxDepth}) reached.`;
                }
                if (_signal?.aborted) {
                    return 'Error: operation aborted.';
                }

                const name = input.name?.trim() || 'goal-runner';
                let session = this.sessions.get(taskId);
                if (!session) {
                    session = new Map();
                    this.sessions.set(taskId, session);
                }

                const goalBaseInput: z.infer<typeof runInputSchema> = {
                    prompt: input.goal,
                    name,
                    systemPrompt: GOAL_RUNNER_SYSTEM_PROMPT,
                    provider: input.provider,
                    model: input.model,
                    maxTokens: input.maxTokens,
                    includeContextFiles: input.includeContextFiles,
                    useAiderTools: input.useAiderTools,
                    usePowerTools: input.usePowerTools,
                    useTodoTools: input.useTodoTools,
                    enabledServers: input.enabledServers,
                    useSkillsTools: input.useSkillsTools,
                    useTaskTools: input.useTaskTools,
                    useMemoryTools: input.useMemoryTools,
                    preset: input.preset,
                    contextFiles: input.contextFiles,
                    idleTimeoutSeconds: input.idleTimeoutSeconds,
                };
                const resolvedGoalServers = await resolveEnabledServers(
                    execContext,
                    input.enabledServers,
                );
                const goalInputWithServers = {
                    ...goalBaseInput,
                    enabledServers: resolvedGoalServers ?? input.enabledServers,
                };

                const childDepth = callerDepth + 1;
                let entry = session.get(name);
                if (!entry) {
                    entry = {
                        profile: buildProfile(agentProfile, taskId, goalInputWithServers, name),
                        calls: 0,
                    };
                    session.set(name, entry);
                } else {
                    entry.profile = buildProfile(agentProfile, taskId, goalInputWithServers, name);
                }
                this.profileDepths.set(entry.profile.id, childDepth);
                entry.calls += 1;
                const goalEntry: DynamicEntry = entry;

                const config = readExtensionConfig(this.configPath);
                const maxRounds = input.maxRounds ?? config.defaultGoalMaxRounds ?? 3;
                const idleTimeoutSeconds =
                    input.idleTimeoutSeconds ?? config.defaultIdleTimeoutSeconds ?? 180;

                const result = await runGoalLoop({
                    goal: input.goal,
                    task: input.task,
                    verifyInstructions: input.verifyInstructions,
                    maxRounds,
                    systemPrompt: GOAL_RUNNER_SYSTEM_PROMPT,
                    name,
                    signal: _signal,
                    runRound: (req: RoundRequest) =>
                        this.spawnOnce({
                            execContext,
                            taskContext,
                            baseProfile: {
                                ...goalEntry.profile,
                                maxTokens: req.maxTokens ?? goalEntry.profile.maxTokens,
                            },
                            prompt: req.prompt,
                            name: req.name,
                            contextFiles: input.contextFiles,
                            idleTimeoutSeconds,
                            signal: _signal,
                        }),
                });
                return formatGoalResult(result);
            },
        };

        const runAgentDebate: ToolDefinition<typeof debateInputSchema> = {
            name: 'run_agent_debate',
            description:
                'Runs a structured debate between two agents with orthogonal opinions (advocate defending, critic attacking) over N rebuttal pairs, followed by a neutral synthesizer who merges the strongest points into a decision with explicit trade-offs. The first line of the result is DEBATE_RESULT: <status> (rounds N). Use this tool when a design decision or proposal is contested and orthogonal critique before synthesis beats a single perspective. Do not use for routine implementation subtasks.',
            inputSchema: debateInputSchema,
            execute: async (
                input: z.infer<typeof debateInputSchema>,
                _signal: AbortSignal | undefined,
                execContext: ExtensionContext,
            ): Promise<string> => {
                const taskContext = execContext.getTaskContext() ?? context.getTaskContext();
                if (!taskContext) {
                    return 'Error: no active task context found.';
                }
                const taskId = taskContext.data.id;
                const callerDepth = this.getProfileDepth(agentProfile);
                const maxDepth = this.getMaxSubagentDepth();
                if (callerDepth >= maxDepth) {
                    return `Error: maximum subagent depth (${maxDepth}) reached.`;
                }
                if (_signal?.aborted) {
                    return 'Error: operation aborted.';
                }

                let session = this.sessions.get(taskId);
                if (!session) {
                    session = new Map();
                    this.sessions.set(taskId, session);
                }

                const counter = (this.debateCounters.get(taskId) ?? 0) + 1;
                this.debateCounters.set(taskId, counter);
                const names = buildDebateAgentNames(counter);

                const activeSession = session;
                const config = readExtensionConfig(this.configPath);
                const rounds = input.rounds ?? config.defaultDebateRounds ?? 2;
                const idleTimeoutSeconds =
                    input.idleTimeoutSeconds ?? config.defaultIdleTimeoutSeconds ?? 180;
                const resolvedDebateServers = await resolveEnabledServers(
                    execContext,
                    input.enabledServers,
                );
                const debateServers = resolvedDebateServers ?? input.enabledServers;

                const result = await runDebateSequence({
                    topic: input.topic,
                    rounds,
                    names,
                    advocateSystemPrompt: input.advocateSystemPrompt,
                    criticSystemPrompt: input.criticSystemPrompt,
                    synthesizerSystemPrompt: input.synthesizerSystemPrompt,
                    maxTokens: input.maxTokens,
                    provider: input.provider,
                    model: input.model,
                    signal: _signal,
                    runRound: (req: RoundRequest) => {
                        const roundInput: z.infer<typeof runInputSchema> = {
                            prompt: req.prompt,
                            name: req.name,
                            systemPrompt: req.systemPrompt,
                            provider: req.provider ?? input.provider,
                            model: req.model ?? input.model,
                            maxTokens: req.maxTokens ?? input.maxTokens,
                            includeContextFiles: input.includeContextFiles,
                            useAiderTools: input.useAiderTools,
                            usePowerTools: input.usePowerTools,
                            useTodoTools: input.useTodoTools,
                            enabledServers: debateServers,
                            useSkillsTools: input.useSkillsTools,
                            useTaskTools: input.useTaskTools,
                            useMemoryTools: input.useMemoryTools,
                            preset: input.preset,
                            contextFiles: input.contextFiles,
                            idleTimeoutSeconds: input.idleTimeoutSeconds,
                        };
                        const childDepth = callerDepth + 1;
                        let entry = activeSession.get(req.name);
                        if (!entry) {
                            entry = {
                                profile: buildProfile(agentProfile, taskId, roundInput, req.name),
                                calls: 0,
                            };
                            activeSession.set(req.name, entry);
                        } else {
                            entry.profile = buildProfile(
                                agentProfile,
                                taskId,
                                roundInput,
                                req.name,
                            );
                        }
                        this.profileDepths.set(entry.profile.id, childDepth);
                        entry.calls += 1;
                        return this.spawnOnce({
                            execContext,
                            taskContext,
                            baseProfile: entry.profile,
                            prompt: req.prompt,
                            name: req.name,
                            contextFiles: input.contextFiles,
                            idleTimeoutSeconds,
                            signal: _signal,
                        });
                    },
                });
                return formatDebateResult(result);
            },
        };

        const listDynamicSubagents: ToolDefinition<typeof listInputSchema> = {
            name: 'list_dynamic_subagents',
            description: 'Lists dynamic subagents created in the current session.',
            inputSchema: listInputSchema,
            execute: async (
                _input: z.infer<typeof listInputSchema>,
                _signal: AbortSignal | undefined,
                execContext: ExtensionContext,
            ): Promise<string> => {
                const taskContext = execContext.getTaskContext() ?? context.getTaskContext();
                const session = taskContext ? this.sessions.get(taskContext.data.id) : undefined;
                if (!session || session.size === 0) {
                    return 'No dynamic agents in this session.';
                }
                const lines = [...session.entries()].map(
                    ([name, entry]) =>
                        `- ${name}: ${entry.profile.provider}/${entry.profile.model}, calls=${entry.calls}`,
                );
                return lines.join('\n');
            },
        };

        if (mode === 'orchestrator') {
            return [
                {
                    ...runDynamicAgent,
                    description: ORCHESTRATOR_DESCRIPTION,
                } as unknown as ToolDefinition,
                runDynamicAgentGoal,
                runAgentDebate,
                listDynamicSubagents,
            ];
        }

        return [runDynamicAgent, runDynamicAgentGoal, runAgentDebate, listDynamicSubagents];
    }

    private async spawnOnce(params: {
        execContext: ExtensionContext;
        taskContext: TaskContextLike;
        baseProfile: AgentProfile;
        prompt: string;
        name: string;
        contextFiles?: string[];
        idleTimeoutSeconds: number;
        signal: AbortSignal | undefined;
    }): Promise<SpawnOutcome> {
        const { execContext, taskContext, baseProfile, prompt, name, contextFiles } = params;
        const { signal, idleTimeoutSeconds } = params;
        const baseDepth = this.getProfileDepth(baseProfile);
        const runProfile: AgentProfile = {
            ...baseProfile,
            id: `${baseProfile.id}-${randomUUID().slice(0, 8)}`,
        };
        this.profileDepths.set(runProfile.id, baseDepth);
        this.results.delete(runProfile.id);

        if (contextFiles && contextFiles.length > 0) {
            this.pendingContextFiles.set(runProfile.id, contextFiles);
        }

        let isTimedOut = false;
        let idleTimer: NodeJS.Timeout | undefined;

        const cancelTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = undefined;
            }
        };

        const resetTimer = () => {
            cancelTimer();
            if (idleTimeoutSeconds > 0) {
                idleTimer = setTimeout(() => {
                    isTimedOut = true;
                    execContext.log(
                        `Subagent "${name}" (${runProfile.id}) idle timeout after ${idleTimeoutSeconds}s of inactivity.`,
                        'warn',
                    );
                    taskContext.interruptResponse().catch((err: unknown) => {
                        execContext.log(
                            `Failed to interrupt subagent "${name}": ${String(err)}`,
                            'error',
                        );
                    });
                }, idleTimeoutSeconds * 1000);
            }
        };

        const tracker: ActiveSubagentTracker = {
            resetTimer,
            cancelTimer,
            stepsCount: 0,
            toolCallsCount: 0,
            startedAt: 0,
            streamedText: '',
        };
        this.activeSubagents.set(runProfile.id, tracker);

        const onAbort = () => {
            cancelTimer();
            taskContext.interruptResponse().catch((err: unknown) => {
                execContext.log(`Failed to interrupt subagent "${name}": ${String(err)}`, 'error');
            });
        };
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        resetTimer();
        const startedAt = Date.now();
        tracker.startedAt = startedAt;

        const finish = (status: SpawnOutcomeStatus, text: string): SpawnOutcome => ({
            status,
            text,
            seconds: (Date.now() - startedAt) / 1000,
            stepsCount: tracker.stepsCount,
            toolCallsCount: tracker.toolCallsCount,
        });

        try {
            await taskContext.runSubagent(runProfile, prompt);
            if (isTimedOut) {
                return finish('timeout', tracker.streamedText.trim());
            }
            return finish('ok', this.results.get(runProfile.id) ?? '');
        } catch (error) {
            if (isTimedOut) {
                return finish('timeout', tracker.streamedText.trim());
            }
            const message = error instanceof Error ? error.message : String(error);
            return finish(signal?.aborted ? 'aborted' : 'error', message);
        } finally {
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            cancelTimer();
            this.activeSubagents.delete(runProfile.id);
            this.pendingContextFiles.delete(runProfile.id);
            this.results.delete(runProfile.id);
            tracker.streamedText = '';
        }
    }

    private dropTask(taskId: string): void {
        const session = this.sessions.get(taskId);
        if (session) {
            for (const entry of session.values()) {
                this.results.delete(entry.profile.id);
                this.profileDepths.delete(entry.profile.id);
            }
        }
        const prefix = `dynamic-agents-${taskId}-`;
        for (const key of Array.from(this.results.keys())) {
            if (key.startsWith(prefix)) {
                this.results.delete(key);
            }
        }
        for (const key of Array.from(this.profileDepths.keys())) {
            if (key.startsWith(prefix)) {
                this.profileDepths.delete(key);
            }
        }
        for (const [key, tracker] of Array.from(this.activeSubagents.entries())) {
            if (key.startsWith(prefix)) {
                tracker.cancelTimer();
                this.activeSubagents.delete(key);
            }
        }
        for (const key of Array.from(this.pendingContextFiles.keys())) {
            if (key.startsWith(prefix)) {
                this.pendingContextFiles.delete(key);
            }
        }
        this.sessions.delete(taskId);
        this.debateCounters.delete(taskId);
        if (this.sessions.size === 0) {
            this.orchestratorProfileEdits.clear();
        }
    }
}
