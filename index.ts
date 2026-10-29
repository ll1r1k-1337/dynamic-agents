import { randomUUID } from 'crypto';
import { z } from 'zod';

import { ContextMemoryMode, InvocationMode } from '@aiderdesk/extensions';
import type {
    AgentProfile,
    AgentStartedEvent,
    ContextMessage,
    Extension,
    ExtensionContext,
    ModeDefinition,
    SubagentFinishedEvent,
    TaskClosedEvent,
    TaskDeletedEvent,
    ToolDefinition,
} from '@aiderdesk/extensions';

const ORCHESTRATOR_USER_MESSAGE = `You are in orchestrator mode. Your primary tool is run_dynamic_agent.

Work in these steps:
1. Decompose the user's task into small, focused subtasks. Each subtask must have a clear scope and a verifiable outcome.
2. Delegate each subtask to run_dynamic_agent with an inline profile: a short name, a role description, and a precise task prompt that includes all needed context (file paths, constraints, expected output).
3. Run independent subtasks in parallel when possible.
4. Verify each returned result against the subtask outcome. Re-run a subtask with a refined prompt when the result is incomplete or wrong.
5. Do not implement subtasks yourself. Do the work yourself only when delegation is impossible or failed twice.
6. Aggregate the verified results and give the user a final summary: what was done, which files changed, and any open issues.`;

const ORCHESTRATOR_ASSISTANT_MESSAGE = `OK, I will decompose the task, delegate subtasks to dynamic agents, and aggregate their results.`;

const MAX_RESULT_CHARS = 20000;

const textFromContent = (content: unknown): string => {
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

const lastAssistantText = (messages: readonly ContextMessage[]): string => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'assistant') {
            continue;
        }
        const text = textFromContent(message.content).trim();
        if (text.length > 0) {
            return text;
        }
    }
    return '';
};

const truncate = (value: string): string => {
    if (value.length <= MAX_RESULT_CHARS) {
        return value;
    }
    const removed = value.length - MAX_RESULT_CHARS;
    return `${value.slice(0, MAX_RESULT_CHARS)}\n\n[...truncated ${removed} chars]`;
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
    '- Do not write code or answer questions yourself — delegate everything to dynamic agents.',
].join('\n');

const ORCHESTRATOR_AGENT_PROFILE: AgentProfile = {
    id: 'dynamic-agents-orchestrator',
    name: 'Orchestrator',
    provider: 'openai-compatible',
    model: 'non-stop',
    maxIterations: 50,
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
    useSkillsTools: false,
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

const runInputSchema = z.object({
    prompt: z.string().min(1).describe('Task for the dynamic agent. Give complete, self-contained instructions.'),
    name: z.string().optional().describe('Session-scoped name. Reusing the same name reuses the same profile.'),
    systemPrompt: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    maxIterations: z.number().int().min(0).optional(),
    includeContextFiles: z.boolean().optional(),
    useAiderTools: z.boolean().optional().describe('Override the parent useAiderTools for this agent.'),
    usePowerTools: z.boolean().optional().describe('Override the parent usePowerTools for this agent.'),
});

const listInputSchema = z.object({});

interface DynamicEntry {
    profile: AgentProfile;
    calls: number;
}

export default class DynamicAgentsExtension implements Extension {
    static metadata = {
        name: 'Dynamic Agents',
        version: '1.3.0',
        description: 'Spawns ephemeral session-scoped subagents from inline profiles. Nothing is written to disk.',
        author: 'local',
        capabilities: ['tools', 'modes', 'agents'],
    };

    private sessions = new Map<string, Map<string, DynamicEntry>>();

    private results = new Map<string, string>();

    private orchestratorProfileEdits = new Map<string, AgentProfile>();

    getModes(_context: ExtensionContext): ModeDefinition[] {
        return [
            {
                name: 'orchestrator',
                label: 'Orchestrator',
                description: 'Decomposes the task into subtasks and delegates them to dynamic subagents',
                icon: 'GoStack',
            },
        ];
    }

    getAgents(_context: ExtensionContext): AgentProfile[] {
        return [this.orchestratorProfileEdits.get('dynamic-agents-orchestrator') ?? ORCHESTRATOR_AGENT_PROFILE];
    }

    async onAgentProfileUpdated(
        _context: ExtensionContext,
        agentId: string,
        updatedProfile: AgentProfile,
    ): Promise<AgentProfile> {
        // Profile edits are kept for the session only; the extension stores nothing on disk.
        this.orchestratorProfileEdits.set(agentId, updatedProfile);
        return updatedProfile;
    }

    onLoad(context: ExtensionContext): void {
        context.addDisposable(() => () => {
            this.sessions.clear();
            this.results.clear();
        });
    }

    async onAgentStarted(event: AgentStartedEvent, context: ExtensionContext): Promise<void | Partial<AgentStartedEvent>> {
        if (event.mode !== 'orchestrator') {
            return undefined;
        }
        context.log('Orchestrator mode active - prepending orchestration instructions to context messages', 'info');
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
        return { contextMessages: [orchestratorUserMessage, orchestratorAssistantMessage, ...event.contextMessages] };
    }

    async onSubagentFinished(event: SubagentFinishedEvent): Promise<void> {
        const profileId = event.subagentProfile.id;
        if (!profileId.startsWith('dynamic-agents-')) {
            return;
        }
        this.results.set(profileId, lastAssistantText(event.resultMessages));
    }

    async onTaskClosed(event: TaskClosedEvent): Promise<void> {
        this.dropTask(event.task.id);
    }

    async onTaskDeleted(event: TaskDeletedEvent): Promise<void> {
        this.dropTask(event.task.id);
    }

    getTools(context: ExtensionContext, mode: string, agentProfile: AgentProfile): ToolDefinition[] {
        const runDynamicAgent: ToolDefinition<typeof runInputSchema> = {
            name: 'run_dynamic_agent',
            description: [
                'Runs a dynamic agent with an inline profile.',
                'The subagent inherits the current agent tools and model unless useAiderTools or usePowerTools overrides are passed.',
                'The run is isolated and returns only the final text.',
                'The profile lives in memory for the current task session and never touches disk.',
            ].join(' '),
            inputSchema: runInputSchema,
            execute: async (input) => {
                const taskContext = context.getTaskContext();
                if (!taskContext) {
                    return 'Error: no active task context.';
                }
                if (agentProfile.isSubagent) {
                    return 'Error: a subagent cannot spawn dynamic agents.';
                }

                const taskId = taskContext.data.id;
                const name = input.name?.trim() || `Dynamic ${randomUUID().slice(0, 8)}`;

                let session = this.sessions.get(taskId);
                if (!session) {
                    session = new Map<string, DynamicEntry>();
                    this.sessions.set(taskId, session);
                }

                const overridesProfile =
                    input.systemPrompt !== undefined ||
                    input.provider !== undefined ||
                    input.model !== undefined ||
                    input.maxIterations !== undefined ||
                    input.includeContextFiles !== undefined ||
                    input.useAiderTools !== undefined ||
                    input.usePowerTools !== undefined;

                let entry = session.get(name);
                if (!entry) {
                    entry = { profile: this.buildProfile(agentProfile, taskId, input, name), calls: 0 };
                    session.set(name, entry);
                } else if (overridesProfile) {
                    entry.profile = this.buildProfile(agentProfile, taskId, input, name);
                }

                entry.calls += 1;
                this.results.delete(entry.profile.id);
                const startedAt = Date.now();

                try {
                    await taskContext.runSubagent(entry.profile, input.prompt);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return `Error: dynamic agent "${name}" failed: ${message}`;
                }

                const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
                const text = this.results.get(entry.profile.id) ?? '';
                if (!text) {
                    return `Dynamic agent "${name}" finished in ${seconds}s with no text output.`;
                }

                return `${name} (${entry.profile.provider}/${entry.profile.model}, ${seconds}s):\n\n${truncate(text)}`;
            },
        };

        const listDynamicSubagents: ToolDefinition<typeof listInputSchema> = {
            name: 'list_dynamic_subagents',
            description: 'Lists dynamic subagents created in the current session.',
            inputSchema: listInputSchema,
            execute: async () => {
                const taskContext = context.getTaskContext();
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
            return [{ ...runDynamicAgent, description: ORCHESTRATOR_DESCRIPTION } as unknown as ToolDefinition];
        }

        return [runDynamicAgent, listDynamicSubagents];
    }

    private buildProfile(
        base: AgentProfile,
        taskId: string,
        input: z.infer<typeof runInputSchema>,
        name: string,
    ): AgentProfile {
        const slug =
            name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'agent';
        const systemPrompt = input.systemPrompt?.trim() ?? '';

        return {
            ...base,
            id: `dynamic-agents-${taskId}-${slug}`,
            name,
            provider: input.provider ?? base.provider,
            model: input.model ?? base.model,
            maxIterations: input.maxIterations ?? base.maxIterations,
            includeContextFiles: input.includeContextFiles ?? base.includeContextFiles,
            useAiderTools: input.useAiderTools ?? base.useAiderTools,
            usePowerTools: input.usePowerTools ?? base.usePowerTools,
            isSubagent: true,
            useSubagents: false,
            useTodoTools: false,
            customInstructions: systemPrompt,
            subagent: {
                ...base.subagent,
                enabled: true,
                invocationMode: InvocationMode.OnDemand,
                systemPrompt,
                description: systemPrompt || `Dynamic agent ${name}`,
                contextMemory: ContextMemoryMode.Off,
            },
        };
    }

    private dropTask(taskId: string): void {
        const session = this.sessions.get(taskId);
        if (session) {
            for (const entry of session.values()) {
                this.results.delete(entry.profile.id);
            }
            this.sessions.delete(taskId);
        }
    }
}
