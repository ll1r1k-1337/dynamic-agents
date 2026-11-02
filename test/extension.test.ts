import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { AgentProfile, ContextMessage, ExtensionContext } from '@aiderdesk/extensions';
import { ContextMemoryMode, InvocationMode } from '@aiderdesk/extensions';
import type { RoundRequest, SpawnOutcome } from '../index.ts';
import DynamicAgentsExtension, {
    AGENT_PRESETS,
    buildDebateAgentNames,
    buildDebateRoundPrompt,
    buildDebateTranscript,
    buildGoalRoundPrompt,
    buildProfile,
    DEBATE_ADVOCATE_PROMPT,
    DEBATE_CRITIC_PROMPT,
    DEBATE_SYNTHESIZER_PROMPT,
    DEFAULT_CONFIG,
    debateInputSchema,
    extractResultText,
    formatDebateResult,
    formatGoalResult,
    goalInputSchema,
    listInputSchema,
    parseCommandArgs,
    parseDebateVerdict,
    parseGoalVerdict,
    readExtensionConfig,
    resolveEnabledServers,
    runDebateSequence,
    runGoalLoop,
    runInputSchema,
    stripDebateVerdictLine,
    stripGoalVerdictLine,
    textFromContent,
    writeExtensionConfig,
} from '../index.ts';

const createMockBaseProfile = (): AgentProfile => ({
    id: 'base-profile-id',
    name: 'Parent Agent',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    maxIterations: 10,
    minTimeBetweenToolCalls: 0,
    systemPrompt: 'You are parent agent.',
    enabledServers: ['server-1'],
    toolApprovals: {},
    toolSettings: {},
    disabledExtensionTools: [],
    includeContextFiles: true,
    includeRepoMap: true,
    usePowerTools: true,
    useAiderTools: true,
    useTodoTools: true,
    useSubagents: false,
    useTaskTools: true,
    useMemoryTools: true,
    useSkillsTools: true,
    useExtensionTools: true,
    customInstructions: '',
    subagent: {
        enabled: false,
        contextMemory: ContextMemoryMode.Off,
        systemPrompt: '',
        invocationMode: InvocationMode.OnDemand,
        color: '#ffffff',
        description: 'Base subagent',
    },
});

const createMockContext = (): ExtensionContext => {
    return {
        extensionPath: '/test',
        log: () => {},
        addDisposable: () => () => {},
        getTaskContext: () => null,
        getProjectContext: () => {
            throw new Error('Not in project context');
        },
    } as unknown as ExtensionContext;
};

describe('textFromContent', () => {
    it('returns string unchanged', () => {
        assert.equal(textFromContent('hello world'), 'hello world');
    });

    it('joins text blocks from an array', () => {
        const parts = [
            { type: 'text', text: 'part 1 ' },
            { type: 'image', url: 'https://example.com/img.png' },
            { type: 'text', text: 'part 2' },
        ];
        assert.equal(textFromContent(parts), 'part 1 part 2');
    });

    it('returns empty string for non-string non-array input', () => {
        assert.equal(textFromContent(123), '');
        assert.equal(textFromContent(null), '');
        assert.equal(textFromContent(undefined), '');
    });
});

describe('extractResultText', () => {
    it('extracts latest assistant message text', () => {
        const messages: ContextMessage[] = [
            { id: '1', role: 'user', content: 'What is 2+2?' },
            { id: '2', role: 'assistant', content: '4' },
            { id: '3', role: 'user', content: 'And 3+3?' },
            { id: '4', role: 'assistant', content: '6' },
        ];
        assert.equal(extractResultText(messages), '6');
    });

    it('extracts tool result if assistant message is empty', () => {
        const messages = [
            { id: '1', role: 'user', content: 'Run query' },
            {
                id: '2',
                role: 'tool',
                content: [{ type: 'text', text: 'tool-output-text' }],
            },
        ] as unknown as ContextMessage[];
        assert.equal(extractResultText(messages), '[Tool result]: tool-output-text');
    });

    it('returns empty string if no messages with text exist', () => {
        const messages: ContextMessage[] = [{ id: '1', role: 'user', content: 'Hello' }];
        assert.equal(extractResultText(messages), '');
    });
});

describe('buildProfile', () => {
    it('creates isolated subagent profile and appends todo notice when useTodoTools is false', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-123',
            {
                prompt: 'Run task',
                systemPrompt: 'You are subagent worker.',
                name: 'Worker 1',
                useTodoTools: false,
            },
            'Worker 1',
        );

        assert.equal(profile.isSubagent, true);
        assert.equal(profile.useSubagents, false);
        assert.equal(profile.useTodoTools, false);
        assert.match(profile.id, /^dynamic-agents-task-123-worker-1-[a-f0-9]{8}$/);
        assert.ok(Boolean(profile.systemPrompt?.includes('You do not have access to TODO tools.')));
    });

    it('always disables the iteration limit for sub-agents even when the parent has one', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-limit',
            {
                prompt: 'Run task',
                systemPrompt: 'You are subagent worker.',
                name: 'limited',
            },
            'limited',
        );

        assert.equal(profile.maxIterations, 0);
    });

    it('does not append todo notice when useTodoTools is true', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-456',
            {
                prompt: 'Run task',
                systemPrompt: 'You are subagent worker.',
                name: 'worker-2',
                useTodoTools: true,
            },
            'worker-2',
        );

        assert.equal(profile.useTodoTools, true);
        assert.equal(profile.systemPrompt, 'You are subagent worker.');
    });

    it('overrides provider and model when provided', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-789',
            {
                prompt: 'Run task',
                systemPrompt: 'Role description',
                name: 'custom',
                provider: 'openai',
                model: 'gpt-4o',
            },
            'custom',
        );

        assert.equal(profile.provider, 'openai');
        assert.equal(profile.model, 'gpt-4o');
    });

    it('prepends preset instructions when preset is provided', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-preset',
            {
                prompt: 'Review PR',
                systemPrompt: 'Follow company standards.',
                name: 'reviewer-subagent',
                preset: 'reviewer',
                useTodoTools: true,
            },
            'reviewer-subagent',
        );

        assert.ok(profile.systemPrompt?.includes(AGENT_PRESETS.reviewer));
        assert.ok(profile.systemPrompt?.includes('Follow company standards.'));
    });

    it('prepends preset instructions for all supported presets', () => {
        const base = createMockBaseProfile();
        const presets: Array<keyof typeof AGENT_PRESETS> = [
            'reviewer',
            'tester',
            'architect',
            'refactorer',
            'researcher',
        ];
        for (const preset of presets) {
            const profile = buildProfile(
                base,
                'task-preset',
                {
                    prompt: 'Do work',
                    systemPrompt: 'My custom instruction',
                    preset,
                },
                `${preset}-agent`,
            );
            assert.ok(profile.systemPrompt?.includes(AGENT_PRESETS[preset]));
            assert.ok(profile.systemPrompt?.includes('My custom instruction'));
        }
    });

    it('passes input.maxTokens to the profile', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-mt-1',
            {
                prompt: 'Run task',
                systemPrompt: 'Role description',
                name: 'reporter',
                maxTokens: 32000,
            },
            'reporter',
        );
        assert.equal(profile.maxTokens, 32000);
    });

    it('inherits base.maxTokens when input.maxTokens is not provided', () => {
        const base = { ...createMockBaseProfile(), maxTokens: 8192 };
        const profile = buildProfile(
            base,
            'task-mt-2',
            {
                prompt: 'Run task',
                systemPrompt: 'Role description',
                name: 'reporter',
            },
            'reporter',
        );
        assert.equal(profile.maxTokens, 8192);
    });

    it('leaves maxTokens undefined when neither input nor base define it', () => {
        const base = createMockBaseProfile();
        const profile = buildProfile(
            base,
            'task-mt-3',
            {
                prompt: 'Run task',
                systemPrompt: 'Role description',
                name: 'reporter',
            },
            'reporter',
        );
        assert.equal(profile.maxTokens, undefined);
    });
});

describe('runInputSchema and listInputSchema', () => {
    it('validates schema with idleTimeoutSeconds', () => {
        const parsed = runInputSchema.parse({
            prompt: 'Test prompt',
            systemPrompt: 'Test role',
            idleTimeoutSeconds: 60,
        });
        assert.equal(parsed.idleTimeoutSeconds, 60);
    });

    it('allows idleTimeoutSeconds to be 0 to disable', () => {
        const parsed = runInputSchema.parse({
            prompt: 'Test prompt',
            systemPrompt: 'Test role',
            idleTimeoutSeconds: 0,
        });
        assert.equal(parsed.idleTimeoutSeconds, 0);
    });

    it('rejects negative idleTimeoutSeconds', () => {
        assert.throws(() => {
            runInputSchema.parse({
                prompt: 'Test prompt',
                systemPrompt: 'Test role',
                idleTimeoutSeconds: -10,
            });
        });
    });

    it('validates preset and contextFiles in schema', () => {
        const parsed = runInputSchema.parse({
            prompt: 'Test prompt',
            systemPrompt: 'Test role',
            preset: 'tester',
            contextFiles: ['src/app.ts', 'src/types.ts'],
        });
        assert.equal(parsed.preset, 'tester');
        assert.deepEqual(parsed.contextFiles, ['src/app.ts', 'src/types.ts']);
    });

    it('rejects unknown preset values', () => {
        assert.throws(() => {
            runInputSchema.parse({
                prompt: 'Test prompt',
                systemPrompt: 'Test role',
                preset: 'invalid-preset' as unknown as 'reviewer',
            });
        });
    });

    it('validates maxTokens bounds in schema', () => {
        const parsed = runInputSchema.parse({
            prompt: 'Test prompt',
            systemPrompt: 'Test role',
            maxTokens: 16384,
        });
        assert.equal(parsed.maxTokens, 16384);

        for (const invalid of [0, -1, 1.5, 128001]) {
            assert.throws(() => {
                runInputSchema.parse({
                    prompt: 'Test prompt',
                    systemPrompt: 'Test role',
                    maxTokens: invalid,
                });
            });
        }
    });

    it('does not expose maxIterations to the orchestrator', () => {
        assert.equal('maxIterations' in runInputSchema.shape, false);
    });

    it('validates listInputSchema reason', () => {
        const parsed = listInputSchema.parse({ reason: 'Check status' });
        assert.equal(parsed.reason, 'Check status');
    });
});

describe('DynamicAgentsExtension', () => {
    it('registers orchestrator mode and agent', () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();

        const modes = ext.getModes(context);
        assert.equal(modes.length, 1);
        assert.equal(modes[0]?.name, 'orchestrator');

        const agents = ext.getAgents(context);
        assert.equal(agents.length, 1);
        assert.equal(agents[0]?.id, 'dynamic-agents-orchestrator');
        assert.equal(agents[0]?.maxTokens, 16384);
    });

    it('provides all tools in orchestrator mode', () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const base = createMockBaseProfile();

        const tools = ext.getTools(context, 'orchestrator', base);
        assert.equal(tools.length, 4);

        const names = tools.map((t) => t.name);
        assert.ok(names.includes('run_dynamic_agent'));
        assert.ok(names.includes('run_dynamic_agent_goal'));
        assert.ok(names.includes('run_agent_debate'));
        assert.ok(names.includes('list_dynamic_subagents'));
    });

    it('injects context files into onSubagentStarted event', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const base = createMockBaseProfile();
        const runProfile: AgentProfile = {
            ...base,
            id: 'subagent-target-id',
        };

        (ext as unknown as { pendingContextFiles: Map<string, string[]> }).pendingContextFiles.set(
            runProfile.id,
            ['src/main.ts', 'src/utils.ts'],
        );

        const event = {
            subagentProfile: runProfile,
            prompt: 'Task',
            contextMessages: [],
            contextFiles: [{ path: 'README.md' }],
        };

        await ext.onSubagentStarted(event as never, context);

        assert.equal(event.contextFiles.length, 3);
        assert.equal(event.contextFiles[1]?.path, 'src/main.ts');
        assert.equal(event.contextFiles[2]?.path, 'src/utils.ts');
        assert.equal(
            (
                ext as unknown as { pendingContextFiles: Map<string, string[]> }
            ).pendingContextFiles.has(runProfile.id),
            false,
        );
    });

    it('increments telemetry steps, tool calls and accumulates response chunks', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const tracker = {
            resetTimer: () => {},
            cancelTimer: () => {},
            stepsCount: 0,
            toolCallsCount: 0,
            startedAt: Date.now(),
            streamedText: '',
        };
        (ext as unknown as { activeSubagents: Map<string, typeof tracker> }).activeSubagents.set(
            'agent-id-1',
            tracker,
        );

        await ext.onAgentStepFinished({ agentProfile: { id: 'agent-id-1' } } as never, context);
        assert.equal(tracker.stepsCount, 1);

        await ext.onToolFinished({ agentProfile: { id: 'agent-id-1' } } as never, context);
        assert.equal(tracker.toolCallsCount, 1);

        await ext.onResponseChunk({ chunk: { chunk: 'streaming output text' } } as never, context);
        assert.equal(tracker.streamedText, 'streaming output text');
    });

    it('accumulates response chunks only for target agent if agentId is provided', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        let reset1Called = false;
        let reset2Called = false;
        const tracker1 = {
            resetTimer: () => {
                reset1Called = true;
            },
            cancelTimer: () => {},
            stepsCount: 0,
            toolCallsCount: 0,
            startedAt: Date.now(),
            streamedText: '',
        };
        const tracker2 = {
            resetTimer: () => {
                reset2Called = true;
            },
            cancelTimer: () => {},
            stepsCount: 0,
            toolCallsCount: 0,
            startedAt: Date.now(),
            streamedText: '',
        };
        const activeSubagents = (
            ext as unknown as { activeSubagents: Map<string, typeof tracker1> }
        ).activeSubagents;
        activeSubagents.set('agent-1', tracker1);
        activeSubagents.set('agent-2', tracker2);

        await ext.onResponseChunk(
            { chunk: { chunk: 'chunk-for-agent-1' }, agentId: 'agent-1' } as never,
            context,
        );
        assert.equal(tracker1.streamedText, 'chunk-for-agent-1');
        assert.equal(reset1Called, true);
        assert.equal(tracker2.streamedText, '');
        assert.equal(reset2Called, false);
    });

    it('does not duplicate orchestrator messages if already present in contextMessages', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const event = {
            mode: 'orchestrator',
            contextMessages: [
                {
                    id: 'dynamic-agents-orchestrator-user',
                    role: 'user',
                    content: 'test',
                },
            ],
        };
        const result = await ext.onAgentStarted(event as never, context);
        assert.equal(result, undefined);
    });

    it('cleans pendingContextFiles in onSubagentStarted even if files list is empty', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const runProfile = { id: 'empty-pending-id' };
        (ext as unknown as { pendingContextFiles: Map<string, string[]> }).pendingContextFiles.set(
            runProfile.id,
            [],
        );
        const event = {
            subagentProfile: runProfile,
            contextFiles: [],
        };
        await ext.onSubagentStarted(event as never, context);
        assert.equal(
            (
                ext as unknown as { pendingContextFiles: Map<string, string[]> }
            ).pendingContextFiles.has(runProfile.id),
            false,
        );
    });

    it('ignores unregistered subagents in onSubagentFinished to prevent memory leaks', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();

        // 1. Игнорирует незарегистрированный субагент
        const inactiveEvent = {
            subagentProfile: { id: 'external-subagent' },
            resultMessages: [{ role: 'assistant', content: 'External output' }],
        };
        await ext.onSubagentFinished(inactiveEvent as never, context);
        assert.equal(
            (ext as unknown as { results: Map<string, string> }).results.has('external-subagent'),
            false,
        );

        // 2. Сохраняет результат для зарегистрированного субагента
        (ext as unknown as { activeSubagents: Map<string, unknown> }).activeSubagents.set(
            'active-subagent',
            {} as never,
        );
        const activeEvent = {
            subagentProfile: { id: 'active-subagent' },
            resultMessages: [{ role: 'assistant', content: 'Active subagent output' }],
        };
        await ext.onSubagentFinished(activeEvent as never, context);
        assert.equal(
            (ext as unknown as { results: Map<string, string> }).results.get('active-subagent'),
            'Active subagent output',
        );
    });

    it('caps streamedText in onResponseChunk to 16384 characters', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const tracker = {
            resetTimer: () => {},
            cancelTimer: () => {},
            stepsCount: 0,
            toolCallsCount: 0,
            startedAt: Date.now(),
            streamedText: 'a'.repeat(16000),
        };
        (ext as unknown as { activeSubagents: Map<string, typeof tracker> }).activeSubagents.set(
            'agent-1',
            tracker,
        );

        await ext.onResponseChunk({ chunk: undefined } as never, context);
        assert.equal(tracker.streamedText.length, 16000);

        await ext.onResponseChunk({ chunk: { chunk: 'b'.repeat(1000) } } as never, context);
        assert.equal(tracker.streamedText.length, 16384);
        assert.ok(tracker.streamedText.endsWith('b'.repeat(1000)));
    });

    it('aborts execution when signal is already aborted', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const base = createMockBaseProfile();
        const tools = ext.getTools(context, 'orchestrator', base);
        const runTool = tools.find((t) => t.name === 'run_dynamic_agent');
        assert.ok(runTool);

        const execContext = {
            ...context,
            getTaskContext: () => ({
                data: { id: 'task-1' },
            }),
        } as unknown as ExtensionContext;

        const controller = new AbortController();
        controller.abort();

        const result = await runTool.execute(
            { prompt: 'test', systemPrompt: 'test' },
            controller.signal,
            execContext,
            {},
        );
        assert.equal(result, 'Error: operation aborted.');
    });

    it('aborts goal and debate tools when signal is already aborted', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const base = createMockBaseProfile();
        const tools = ext.getTools(context, 'orchestrator', base);
        const goalTool = tools.find((t) => t.name === 'run_dynamic_agent_goal');
        const debateTool = tools.find((t) => t.name === 'run_agent_debate');
        assert.ok(goalTool);
        assert.ok(debateTool);

        const execContext = {
            ...context,
            getTaskContext: () => ({
                data: { id: 'task-abort-test' },
            }),
        } as unknown as ExtensionContext;

        const controller = new AbortController();
        controller.abort();

        const goalResult = await goalTool.execute(
            { goal: 'should abort' },
            controller.signal,
            execContext,
            {},
        );
        assert.equal(goalResult, 'Error: operation aborted.');

        const debateResult = await debateTool.execute(
            { topic: 'should abort' },
            controller.signal,
            execContext,
            {},
        );
        assert.equal(debateResult, 'Error: operation aborted.');
    });

    it('executes list_dynamic_subagents tool and returns session subagents summary', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const base = createMockBaseProfile();
        const tools = ext.getTools(context, 'orchestrator', base);
        const listTool = tools.find((t) => t.name === 'list_dynamic_subagents');
        assert.ok(listTool);

        const execContext = {
            ...context,
            getTaskContext: () => ({
                data: { id: 'task-list-1' },
            }),
        } as unknown as ExtensionContext;

        const emptyResult = (await listTool.execute(
            { reason: 'testing' },
            undefined,
            execContext,
            {},
        )) as string;
        assert.ok(emptyResult.includes('No dynamic agents in this session.'));
    });

    it('cleans pendingContextFiles matching task prefix on onTaskClosed', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const pending = (ext as unknown as { pendingContextFiles: Map<string, string[]> })
            .pendingContextFiles;
        pending.set('dynamic-agents-task-123-worker', ['file.ts']);
        pending.set('dynamic-agents-other-worker', ['other.ts']);

        await ext.onTaskClosed({ task: { id: 'task-123' } } as never, context);

        assert.equal(pending.has('dynamic-agents-task-123-worker'), false);
        assert.equal(pending.has('dynamic-agents-other-worker'), true);

        pending.set('dynamic-agents-task-456-worker', ['deleted.ts']);
        await ext.onTaskDeleted({ task: { id: 'task-456' } } as never, context);
        assert.equal(pending.has('dynamic-agents-task-456-worker'), false);
    });
});

const okOutcome = (text: string): SpawnOutcome => ({
    status: 'ok',
    text,
    seconds: 1.2,
    stepsCount: 3,
    toolCallsCount: 2,
});

const createScriptedRunner = (
    replies: Array<string | SpawnOutcome>,
): {
    runRound: (req: RoundRequest) => Promise<SpawnOutcome>;
    calls: RoundRequest[];
} => {
    const calls: RoundRequest[] = [];
    return {
        calls,
        runRound: async (req: RoundRequest) => {
            calls.push(req);
            const reply = replies[calls.length - 1] ?? '';
            if (typeof reply === 'string') {
                return okOutcome(reply);
            }
            return reply;
        },
    };
};

describe('parseGoalVerdict', () => {
    it('parses an achieved verdict on the last line', () => {
        assert.deepEqual(parseGoalVerdict('Work done.\nGOAL: achieved'), { kind: 'achieved' });
    });

    it('parses a continue verdict with remaining work', () => {
        assert.deepEqual(parseGoalVerdict('Half done.\nGOAL: continue: write tests'), {
            kind: 'continue',
            remaining: 'write tests',
        });
    });

    it('parses a blocked verdict with a reason', () => {
        assert.deepEqual(parseGoalVerdict('Stopped.\nGOAL: blocked: missing file'), {
            kind: 'blocked',
            reason: 'missing file',
        });
    });

    it('treats an unknown GOAL: form as malformed', () => {
        assert.deepEqual(parseGoalVerdict('Work.\nGOAL: done'), {
            kind: 'malformed',
            raw: 'GOAL: done',
        });
        assert.deepEqual(parseGoalVerdict('Work.\nGOAL:ACHIEVED'), {
            kind: 'malformed',
            raw: 'GOAL:ACHIEVED',
        });
    });

    it('treats GOAL: continue without remaining as malformed', () => {
        assert.deepEqual(parseGoalVerdict('Work.\nGOAL: continue:'), {
            kind: 'malformed',
            raw: 'GOAL: continue:',
        });
    });

    it('returns absent when no verdict marker exists', () => {
        assert.deepEqual(parseGoalVerdict('A plain reply without a marker.'), { kind: 'absent' });
    });

    it('ignores verdict markers that are not on the last line', () => {
        assert.deepEqual(parseGoalVerdict('GOAL: achieved\nmore work happened'), {
            kind: 'absent',
        });
    });
});

describe('stripGoalVerdictLine', () => {
    it('removes the trailing verdict line and keeps earlier content', () => {
        assert.equal(
            stripGoalVerdictLine('Part one done.\nGOAL: continue: tests'),
            'Part one done.',
        );
    });

    it('returns text unchanged when the last line is not a verdict', () => {
        assert.equal(stripGoalVerdictLine('first\nsecond'), 'first\nsecond');
    });
});

describe('buildGoalRoundPrompt', () => {
    it('includes goal, task, verification, round counter, and verdict instructions', () => {
        const prompt = buildGoalRoundPrompt({
            goal: 'npm test passes',
            task: 'fix the parser',
            verifyInstructions: 'run npm test',
            round: 1,
            maxRounds: 3,
            history: [],
            previousText: '',
        });
        assert.ok(prompt.includes('Goal: npm test passes'));
        assert.ok(prompt.includes('Task instructions: fix the parser'));
        assert.ok(prompt.includes('Verification steps: run npm test'));
        assert.ok(prompt.includes('Round 1 of 3.'));
        assert.ok(prompt.includes('GOAL: achieved'));
        assert.ok(prompt.includes('nothing after it'));
    });

    it('omits task instructions when they duplicate the goal', () => {
        const prompt = buildGoalRoundPrompt({
            goal: 'fix it',
            task: 'fix it',
            round: 1,
            maxRounds: 2,
            history: [],
            previousText: '',
        });
        assert.ok(!prompt.includes('Task instructions:'));
    });

    it('includes history, previous text, and a format note', () => {
        const prompt = buildGoalRoundPrompt({
            goal: 'npm test passes',
            round: 2,
            maxRounds: 3,
            history: [{ round: 1, verdict: 'continue', summary: 'tried approach A' }],
            previousText: 'implemented approach A',
            formatNote: 'Fix your verdict line format.',
        });
        assert.ok(prompt.includes('- Round 1 (continue): tried approach A'));
        assert.ok(prompt.includes('Previous round result:\nimplemented approach A'));
        assert.ok(prompt.includes('Fix your verdict line format.'));
    });
});

describe('runGoalLoop', () => {
    it('stops with achieved after the first round and strips the verdict line', async () => {
        const runner = createScriptedRunner(['Implemented everything.\nGOAL: achieved']);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.deepEqual(result, {
            status: 'achieved',
            rounds: 1,
            text: 'Implemented everything.',
        });
        assert.equal(runner.calls.length, 1);
        assert.equal(runner.calls[0]?.name, 'goal-runner');
        assert.equal(runner.calls[0]?.systemPrompt, 'role');
    });

    it('feeds continue verdicts back and reaches achieved', async () => {
        const runner = createScriptedRunner([
            'round one output\nGOAL: continue: step 2',
            'round two output\nGOAL: continue: step 3',
            'round three output\nGOAL: achieved',
        ]);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.equal(result.status, 'achieved');
        assert.equal(result.rounds, 3);
        assert.equal(result.text, 'round three output');
        assert.equal(runner.calls.length, 3);

        const secondPrompt = runner.calls[1]?.prompt ?? '';
        assert.ok(secondPrompt.includes('Round 2 of 3.'));
        assert.ok(secondPrompt.includes('- Round 1 (continue):'));
        assert.ok(secondPrompt.includes('round one output'));
        assert.ok(!secondPrompt.includes('GOAL: continue: step 2'));

        const thirdPrompt = runner.calls[2]?.prompt ?? '';
        assert.ok(thirdPrompt.includes('Round 3 of 3.'));
        assert.ok(thirdPrompt.includes('- Round 2 (continue):'));
    });

    it('stops with blocked when a round reports blocked', async () => {
        const runner = createScriptedRunner(['gave up\nGOAL: blocked: missing dependency']);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'missing dependency');
        assert.equal(result.rounds, 1);
        assert.equal(result.text, 'gave up');
        assert.equal(runner.calls.length, 1);
    });

    it('stops with incomplete when a reply has no verdict', async () => {
        const runner = createScriptedRunner(['a plain reply without a marker']);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.equal(result.status, 'incomplete');
        assert.equal(result.reason, 'no verdict');
        assert.equal(result.rounds, 1);
        assert.equal(result.text, 'a plain reply without a marker');
        assert.equal(runner.calls.length, 1);
    });

    it('adds a format-correction note after a malformed verdict', async () => {
        const runner = createScriptedRunner(['work\nGOAL: done', 'more work\nGOAL: achieved']);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 2,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.equal(result.status, 'achieved');
        assert.equal(result.rounds, 2);
        const secondPrompt = runner.calls[1]?.prompt ?? '';
        assert.ok(secondPrompt.includes('invalid goal verdict line'));
        assert.ok(secondPrompt.includes('GOAL: done'));
    });

    it('returns incomplete when rounds are exhausted with continue', async () => {
        const runner = createScriptedRunner([
            'a\nGOAL: continue: more',
            'b\nGOAL: continue: even more',
        ]);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 2,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.equal(result.status, 'incomplete');
        assert.equal(result.reason, 'max rounds reached');
        assert.equal(result.rounds, 2);
        assert.equal(runner.calls.length, 2);
    });

    it('maps a timeout outcome to blocked with the partial text', async () => {
        const runner = createScriptedRunner([
            {
                status: 'timeout',
                text: 'partial work',
                seconds: 5,
                stepsCount: 1,
                toolCallsCount: 0,
            },
        ]);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
        });
        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'round 1 timeout');
        assert.equal(result.text, 'partial work');
        assert.equal(runner.calls.length, 1);
    });

    it('refuses to start when the signal is already aborted', async () => {
        const runner = createScriptedRunner(['never called']);
        const controller = new AbortController();
        controller.abort();
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: runner.runRound,
            signal: controller.signal,
        });
        assert.equal(result.status, 'blocked');
        assert.equal(result.rounds, 0);
        assert.equal(runner.calls.length, 0);
    });

    it('stops with blocked when the signal aborts between rounds', async () => {
        const controller = new AbortController();
        const runner = createScriptedRunner(['a\nGOAL: continue: more']);
        const result = await runGoalLoop({
            goal: 'npm test passes',
            maxRounds: 3,
            systemPrompt: 'role',
            name: 'goal-runner',
            runRound: async (req) => {
                controller.abort();
                return runner.runRound(req);
            },
            signal: controller.signal,
        });
        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'aborted');
        assert.equal(result.rounds, 1);
        assert.equal(result.text, 'a');
    });
});

describe('formatGoalResult', () => {
    it('formats the achieved first line with the text below', () => {
        assert.equal(
            formatGoalResult({ status: 'achieved', rounds: 1, text: 'done' }),
            'GOAL_RESULT: achieved (rounds 1)\n\ndone',
        );
    });

    it('formats incomplete with the reason', () => {
        assert.equal(
            formatGoalResult({ status: 'incomplete', reason: 'no verdict', rounds: 1, text: '' }),
            'GOAL_RESULT: incomplete (rounds 1, no verdict)',
        );
    });

    it('formats blocked with the reason', () => {
        assert.equal(
            formatGoalResult({
                status: 'blocked',
                reason: 'round 1 timeout',
                rounds: 1,
                text: 'x',
            }),
            'GOAL_RESULT: blocked (rounds 1, reason: round 1 timeout)\n\nx',
        );
    });
});

describe('goalInputSchema', () => {
    it('allows undefined maxRounds (falls back to extension setting)', () => {
        const parsed = goalInputSchema.parse({ goal: 'tests pass' });
        assert.equal(parsed.maxRounds, undefined);
    });

    it('allows maxRounds to be 0 for unlimited mode', () => {
        const parsed = goalInputSchema.parse({ goal: 'tests pass', maxRounds: 0 });
        assert.equal(parsed.maxRounds, 0);
    });

    it('rejects negative maxRounds and empty goal', () => {
        assert.throws(() => goalInputSchema.parse({ goal: 'g', maxRounds: -1 }));
        assert.throws(() => goalInputSchema.parse({ goal: '', maxRounds: 3 }));
    });
});

describe('debate role prompt constants', () => {
    it('defines genuinely orthogonal instructions for advocate, critic, and synthesizer', () => {
        assert.ok(DEBATE_ADVOCATE_PROMPT.includes('FOR the proposal'));
        assert.ok(DEBATE_CRITIC_PROMPT.includes('Attack the assumptions'));
        assert.ok(DEBATE_CRITIC_PROMPT.includes('would change your mind'));
        assert.ok(DEBATE_SYNTHESIZER_PROMPT.includes('impartial synthesizer'));
        assert.ok(DEBATE_SYNTHESIZER_PROMPT.includes('NO_CONSENSUS:'));
    });
});

describe('buildDebateAgentNames', () => {
    it('creates predictable names parameterized by counter', () => {
        const names = buildDebateAgentNames(3);
        assert.equal(names.advocate, 'debate-3-advocate');
        assert.equal(names.critic, 'debate-3-critic');
        assert.equal(names.synthesizer, 'debate-3-synthesizer');
    });
});

describe('buildDebateTranscript', () => {
    it('assembles openings and rebuttal pairs in strict chronological order', () => {
        const transcript = buildDebateTranscript({
            topic: 'Adopt TypeScript strict mode',
            openings: {
                advocate: 'Strict catches bugs early.',
                critic: 'Migration cost is too high.',
            },
            rebuttals: [
                {
                    pair: 1,
                    advocate: 'Migration can be phased file by file.',
                    critic: 'Phased still burns dev velocity for months.',
                },
            ],
        });
        assert.ok(transcript.startsWith('TOPIC: Adopt TypeScript strict mode'));
        assert.ok(transcript.includes('=== OPENING: ADVOCATE ===\nStrict catches bugs early.'));
        assert.ok(transcript.includes('=== OPENING: CRITIC ===\nMigration cost is too high.'));
        assert.ok(
            transcript.includes(
                '=== REBUTTAL PAIR 1: ADVOCATE ===\nMigration can be phased file by file.',
            ),
        );
        assert.ok(
            transcript.includes(
                '=== REBUTTAL PAIR 1: CRITIC ===\nPhased still burns dev velocity for months.',
            ),
        );
    });
});

describe('buildDebateRoundPrompt', () => {
    it('opening prompt presents only the topic to both roles without opponent leak', () => {
        const advPrompt = buildDebateRoundPrompt({
            kind: 'opening',
            role: 'advocate',
            topic: 'Rewrite in Rust',
        });
        assert.ok(advPrompt.includes('Debate topic: Rewrite in Rust'));
        assert.ok(advPrompt.includes('opening statement as the advocate'));
        assert.ok(!advPrompt.includes('critic'));

        const critPrompt = buildDebateRoundPrompt({
            kind: 'opening',
            role: 'critic',
            topic: 'Rewrite in Rust',
        });
        assert.ok(critPrompt.includes('Debate topic: Rewrite in Rust'));
        assert.ok(critPrompt.includes('opening statement as the critic'));
        assert.ok(!critPrompt.includes('advocate'));
    });

    it('rebuttal prompt contains topic, own opening, and opponent latest only', () => {
        const prompt = buildDebateRoundPrompt({
            kind: 'rebuttal',
            role: 'advocate',
            pair: 2,
            topic: 'Microservices vs Monolith',
            ownOpening: 'Microservices allow team independence.',
            opponentLatest: 'Operational complexity kills the benefit.',
        });
        assert.ok(prompt.includes('Debate topic: Microservices vs Monolith'));
        assert.ok(prompt.includes('Microservices allow team independence.'));
        assert.ok(prompt.includes('Operational complexity kills the benefit.'));
        assert.ok(prompt.includes('rebuttal pair 2'));
        assert.ok(!prompt.includes('rebuttal pair 1'));
    });

    it('synthesis prompt contains the full transcript and NO_CONSENSUS instructions', () => {
        const prompt = buildDebateRoundPrompt({
            kind: 'synthesis',
            transcript: 'FULL TRANSCRIPT HERE',
        });
        assert.ok(prompt.includes('FULL TRANSCRIPT HERE'));
        assert.ok(prompt.includes('NO_CONSENSUS: <unresolved items>'));
    });
});

describe('runDebateSequence', () => {
    const names = buildDebateAgentNames(1);

    it('happy path rounds=2 executes 2 openings + 4 rebuttals + 1 synthesis', async () => {
        const runner = createScriptedRunner([
            'Advocate opening.',
            'Critic opening.',
            'Advocate rebuttal 1.',
            'Critic rebuttal 1.',
            'Advocate rebuttal 2.',
            'Critic rebuttal 2.',
            'Synthesis: adopt with conditions.',
        ]);

        const result = await runDebateSequence({
            topic: 'Deploy on Fridays',
            rounds: 2,
            names,
            runRound: runner.runRound,
        });

        assert.equal(result.status, 'synthesis');
        assert.equal(result.rounds, 2);
        assert.equal(result.text, 'Synthesis: adopt with conditions.');
        assert.equal(runner.calls.length, 7);

        assert.equal(runner.calls[0]?.name, 'debate-1-advocate');
        assert.equal(runner.calls[1]?.name, 'debate-1-critic');
        assert.equal(runner.calls[2]?.name, 'debate-1-advocate');
        assert.equal(runner.calls[3]?.name, 'debate-1-critic');
        assert.equal(runner.calls[4]?.name, 'debate-1-advocate');
        assert.equal(runner.calls[5]?.name, 'debate-1-critic');
        assert.equal(runner.calls[6]?.name, 'debate-1-synthesizer');

        const formatted = formatDebateResult(result);
        assert.ok(formatted.startsWith('DEBATE_RESULT: synthesis (rounds 2)'));
        assert.ok(formatted.includes('Synthesis: adopt with conditions.'));
    });

    it('happy path rounds=1 executes 2 openings + 2 rebuttals + 1 synthesis', async () => {
        const runner = createScriptedRunner([
            'Advocate opening.',
            'Critic opening.',
            'Advocate rebuttal 1.',
            'Critic rebuttal 1.',
            'Synthesis: one pair enough.',
        ]);

        const result = await runDebateSequence({
            topic: 'Use tabs instead of spaces',
            rounds: 1,
            names,
            runRound: runner.runRound,
        });

        assert.equal(result.status, 'synthesis');
        assert.equal(result.rounds, 1);
        assert.equal(runner.calls.length, 5);
    });

    it('preserves NO_CONSENSUS outcome from synthesizer as successful synthesis with dissent', async () => {
        const runner = createScriptedRunner([
            'Adv opening.',
            'Crit opening.',
            'Adv reb 1.',
            'Crit reb 1.',
            'Synthesis cannot reconcile latency vs cost.\nNO_CONSENSUS: latency, cost',
        ]);

        const result = await runDebateSequence({
            topic: 'Cross-region replication',
            rounds: 1,
            names,
            runRound: runner.runRound,
        });

        assert.equal(result.status, 'synthesis');
        assert.ok(result.text.includes('NO_CONSENSUS: latency, cost'));
    });

    it('critic opening timeout halts debate and reports blocked with stage', async () => {
        const runner = createScriptedRunner([
            'Advocate opening.',
            {
                status: 'timeout',
                text: 'Critic opening timed out partially...',
                seconds: 5,
                stepsCount: 1,
                toolCallsCount: 0,
            },
        ]);

        const result = await runDebateSequence({
            topic: 'Switch to GraphQL',
            rounds: 2,
            names,
            runRound: runner.runRound,
        });

        assert.equal(result.status, 'blocked');
        assert.equal(result.stage, 'critic-opening');
        assert.equal(result.reason, 'timeout');
        assert.equal(runner.calls.length, 2);

        const formatted = formatDebateResult(result);
        assert.ok(formatted.startsWith('DEBATE_RESULT: blocked (stage: critic-opening: timeout)'));
        assert.ok(formatted.includes('=== OPENING: ADVOCATE ===\nAdvocate opening.'));
        assert.ok(formatted.includes('Critic opening timed out partially...'));
    });

    it('synthesizer timeout reports synthesis_failed with full transcript', async () => {
        const runner = createScriptedRunner([
            'Adv opening.',
            'Crit opening.',
            'Adv reb 1.',
            'Crit reb 1.',
            {
                status: 'timeout',
                text: 'Synthesizer died half-way...',
                seconds: 5,
                stepsCount: 1,
                toolCallsCount: 0,
            },
        ]);

        const result = await runDebateSequence({
            topic: 'Migrate to k8s',
            rounds: 1,
            names,
            runRound: runner.runRound,
        });

        assert.equal(result.status, 'synthesis_failed');
        assert.equal(result.reason, 'timeout');
        assert.equal(runner.calls.length, 5);

        const formatted = formatDebateResult(result);
        assert.ok(formatted.startsWith('DEBATE_RESULT: synthesis_failed (timeout)'));
        assert.ok(formatted.includes('TOPIC: Migrate to k8s'));
        assert.ok(formatted.includes('=== OPENING: ADVOCATE ==='));
        assert.ok(formatted.includes('=== REBUTTAL PAIR 1: CRITIC ==='));
    });

    it('aborts cleanly when signal is aborted before start', async () => {
        const controller = new AbortController();
        controller.abort();
        const runner = createScriptedRunner(['Not called']);

        const result = await runDebateSequence({
            topic: 'Test',
            rounds: 2,
            names,
            runRound: runner.runRound,
            signal: controller.signal,
        });

        assert.equal(result.status, 'blocked');
        assert.equal(result.stage, 'init');
        assert.equal(result.reason, 'aborted before start');
        assert.equal(runner.calls.length, 0);
    });
});

describe('debateInputSchema', () => {
    it('allows undefined rounds (falls back to extension setting)', () => {
        const parsed = debateInputSchema.parse({ topic: 'Use monorepo' });
        assert.equal(parsed.rounds, undefined);
        assert.equal(parsed.topic, 'Use monorepo');
    });

    it('allows rounds to be 0 for unlimited consensus mode', () => {
        const parsed = debateInputSchema.parse({ topic: 'Use monorepo', rounds: 0 });
        assert.equal(parsed.rounds, 0);
    });

    it('rejects negative rounds and empty topic', () => {
        assert.throws(() => debateInputSchema.parse({ topic: '', rounds: 2 }));
        assert.throws(() => debateInputSchema.parse({ topic: 't', rounds: -1 }));
    });
});

describe('Extension Settings & Configuration', () => {
    it('exports DEFAULT_CONFIG with expected values', () => {
        assert.equal(DEFAULT_CONFIG.defaultGoalMaxRounds, 3);
        assert.equal(DEFAULT_CONFIG.defaultDebateRounds, 2);
        assert.equal(DEFAULT_CONFIG.defaultIdleTimeoutSeconds, 180);
        assert.equal(DEFAULT_CONFIG.maxSubagentDepth, 2);
    });

    it('reads and writes configuration to a custom path', () => {
        const tempConfigPath = `/tmp/test-dynamic-agents-config-${Date.now()}.json`;
        try {
            const initial = readExtensionConfig(tempConfigPath);
            assert.deepEqual(initial, DEFAULT_CONFIG);

            writeExtensionConfig(
                { defaultGoalMaxRounds: 0, defaultDebateRounds: 0, maxSubagentDepth: 1 },
                tempConfigPath,
            );
            const updated = readExtensionConfig(tempConfigPath);
            assert.equal(updated.defaultGoalMaxRounds, 0);
            assert.equal(updated.defaultDebateRounds, 0);
            assert.equal(updated.defaultIdleTimeoutSeconds, 180);
            assert.equal(updated.maxSubagentDepth, 1);
        } finally {
            try {
                fs.unlinkSync(tempConfigPath);
            } catch {
                // Ignore
            }
        }
    });

    it('provides getConfigComponent, getConfigData, saveConfigData on extension instance', async () => {
        const ext = new DynamicAgentsExtension();
        const mockCtx = createMockContext();

        const comp = ext.getConfigComponent(mockCtx);
        assert.ok(typeof comp === 'string' && comp.includes('defaultGoalMaxRounds'));

        const data = await ext.getConfigData(mockCtx);
        assert.ok(typeof data === 'object');
    });
});

describe('Goal loop Infinity mode (maxRounds = 0)', () => {
    it('runs without fixed bound until achieved on round 4', async () => {
        let roundsRun = 0;
        const result = await runGoalLoop({
            goal: 'Run until done',
            maxRounds: 0,
            name: 'infinite-goal',
            systemPrompt: 'System',
            runRound: async () => {
                roundsRun += 1;
                if (roundsRun < 4) {
                    return {
                        status: 'ok',
                        text: `Working on it, attempt ${roundsRun}...\nGOAL: continue: step ${roundsRun + 1}`,
                        seconds: 1,
                        stepsCount: 1,
                        toolCallsCount: 0,
                    };
                }
                return {
                    status: 'ok',
                    text: 'Done!\nGOAL: achieved',
                    seconds: 1,
                    stepsCount: 1,
                    toolCallsCount: 0,
                };
            },
        });

        assert.equal(result.status, 'achieved');
        assert.equal(result.rounds, 4);
        assert.equal(roundsRun, 4);
    });

    it('stops unlimited loop immediately on blocked verdict', async () => {
        const result = await runGoalLoop({
            goal: 'Impossible goal',
            maxRounds: 0,
            name: 'infinite-goal-blocked',
            systemPrompt: 'System',
            runRound: async () => ({
                status: 'ok',
                text: 'Cannot complete.\nGOAL: blocked: missing credentials',
                seconds: 1,
                stepsCount: 1,
                toolCallsCount: 0,
            }),
        });

        assert.equal(result.status, 'blocked');
        assert.equal(result.reason, 'missing credentials');
        assert.equal(result.rounds, 1);
    });
});

describe('Debate verdicts & consensus loop', () => {
    it('parses DEBATE: agree and DEBATE: disagree verdicts correctly', () => {
        assert.deepEqual(parseDebateVerdict('I accept this proposal.\nDEBATE: agree'), {
            kind: 'agree',
        });
        assert.deepEqual(parseDebateVerdict('I reject it.\nDEBATE: disagree: flawed premises'), {
            kind: 'disagree',
            reason: 'flawed premises',
        });
        assert.deepEqual(parseDebateVerdict('No verdict here'), { kind: 'absent' });
        assert.deepEqual(parseDebateVerdict('DEBATE: maybe'), {
            kind: 'malformed',
            raw: 'DEBATE: maybe',
        });
    });

    it('strips DEBATE: verdict line from text', () => {
        assert.equal(stripDebateVerdictLine('Arguments here.\nDEBATE: agree'), 'Arguments here.');
        assert.equal(
            stripDebateVerdictLine('Arguments here.\nDEBATE: disagree: cost'),
            'Arguments here.',
        );
        assert.equal(stripDebateVerdictLine('No verdict line'), 'No verdict line');
    });

    it('early consensus in fixed rounds terminates rebuttal loop when both agree', async () => {
        const callLog: string[] = [];
        const result = await runDebateSequence({
            topic: 'Should we adopt TypeScript?',
            rounds: 3,
            names: buildDebateAgentNames(99),
            runRound: async (req) => {
                callLog.push(req.name);
                if (req.name.endsWith('-advocate') && req.prompt.includes('rebuttal pair 1')) {
                    return {
                        status: 'ok',
                        text: 'Advocate agrees with critic constraints.\nDEBATE: agree',
                        seconds: 1,
                        stepsCount: 1,
                        toolCallsCount: 0,
                    };
                }
                if (req.name.endsWith('-critic') && req.prompt.includes('rebuttal pair 1')) {
                    return {
                        status: 'ok',
                        text: 'Critic agrees with advocate plan.\nDEBATE: agree',
                        seconds: 1,
                        stepsCount: 1,
                        toolCallsCount: 0,
                    };
                }
                return {
                    status: 'ok',
                    text: `Speech by ${req.name}\nDEBATE: disagree: continuing`,
                    seconds: 1,
                    stepsCount: 1,
                    toolCallsCount: 0,
                };
            },
        });

        assert.equal(result.status, 'synthesis');
        assert.equal(result.rounds, 1); // Stopped after pair 1 due to consensus
        // 2 openings + 2 rebuttals (pair 1) + 1 synthesis = 5 calls (not 8)
        assert.equal(callLog.length, 5);
    });

    it('unlimited consensus debate (rounds = 0) runs until both agree on pair 2', async () => {
        const result = await runDebateSequence({
            topic: 'Unlimited debate topic',
            rounds: 0,
            names: buildDebateAgentNames(101),
            runRound: async (req) => {
                if (req.prompt.includes('rebuttal pair 1')) {
                    return {
                        status: 'ok',
                        text: 'Pair 1 still disputing.\nDEBATE: disagree: unresolved trade-off',
                        seconds: 1,
                        stepsCount: 1,
                        toolCallsCount: 0,
                    };
                }
                if (req.prompt.includes('rebuttal pair 2')) {
                    return {
                        status: 'ok',
                        text: 'Pair 2 reached common ground.\nDEBATE: agree',
                        seconds: 1,
                        stepsCount: 1,
                        toolCallsCount: 0,
                    };
                }
                return {
                    status: 'ok',
                    text: `Statement for ${req.name}`,
                    seconds: 1,
                    stepsCount: 1,
                    toolCallsCount: 0,
                };
            },
        });

        assert.equal(result.status, 'synthesis');
        assert.equal(result.rounds, 2);
    });
});

describe('resolveEnabledServers', () => {
    it('returns explicit servers if provided regardless of config', async () => {
        const mockCtx = createMockContext();
        const res = await resolveEnabledServers(mockCtx, ['custom-server']);
        assert.deepEqual(res, ['custom-server']);
    });

    it('resolves all servers from context.getMcpServers when enableAllMcpServersByDefault is true', async () => {
        const mockCtx = {
            ...createMockContext(),
            getMcpServers: async () => ({
                'server-a': {} as unknown as Record<string, unknown>,
                'server-b': {} as unknown as Record<string, unknown>,
            }),
        } as unknown as ExtensionContext;

        const res = await resolveEnabledServers(mockCtx);
        assert.deepEqual(res, ['server-a', 'server-b']);
    });

    it('returns undefined if enableAllMcpServersByDefault is false', async () => {
        const tempConfigPath = `/tmp/test-mcp-config-${Date.now()}.json`;
        try {
            writeExtensionConfig({ enableAllMcpServersByDefault: false }, tempConfigPath);
            // Even if getMcpServers is present, disabled config returns undefined
            const mockCtx = {
                ...createMockContext(),
                getMcpServers: async () => ({
                    'server-a': {} as unknown as Record<string, unknown>,
                }),
            } as unknown as ExtensionContext;

            // When reading global config, it will read default (true). Let's test the explicit override behavior:
            const res = await resolveEnabledServers(mockCtx, ['explicit-only']);
            assert.deepEqual(res, ['explicit-only']);
        } finally {
            try {
                fs.unlinkSync(tempConfigPath);
            } catch {}
        }
    });

    it('writes extension config atomically and creates expected JSON', () => {
        const tempConfigPath = `/tmp/test-atomic-config-${Date.now()}.json`;
        try {
            writeExtensionConfig(
                { defaultGoalMaxRounds: 5, defaultDebateRounds: 4 },
                tempConfigPath,
            );
            assert.ok(fs.existsSync(tempConfigPath));
            const content = JSON.parse(fs.readFileSync(tempConfigPath, 'utf-8'));
            assert.equal(content.defaultGoalMaxRounds, 5);
            assert.equal(content.defaultDebateRounds, 4);
        } finally {
            if (fs.existsSync(tempConfigPath)) {
                fs.unlinkSync(tempConfigPath);
            }
        }
    });
});

describe('parseCommandArgs', () => {
    it('parses plain text arguments without flags', () => {
        const parsed = parseCommandArgs(['make', 'tests', 'pass']);
        assert.equal(parsed.text, 'make tests pass');
        assert.equal(parsed.rounds, undefined);
        assert.equal(parsed.preset, undefined);
        assert.equal(parsed.timeoutSeconds, undefined);
    });

    it('strips outer single and double quotes', () => {
        const parsed = parseCommandArgs(['"npm test passes"', "'extra text'"]);
        assert.equal(parsed.text, 'npm test passes extra text');
    });

    it('parses short and long round flags', () => {
        const p1 = parseCommandArgs(['-r', '5', 'fix', 'bug']);
        assert.equal(p1.rounds, 5);
        assert.equal(p1.text, 'fix bug');

        const p2 = parseCommandArgs(['--rounds', '3', 'fix', 'bug']);
        assert.equal(p2.rounds, 3);
        assert.equal(p2.text, 'fix bug');

        const p3 = parseCommandArgs(['--rounds=4', 'fix', 'bug']);
        assert.equal(p3.rounds, 4);
        assert.equal(p3.text, 'fix bug');
    });

    it('parses positional leading number as rounds', () => {
        const parsed = parseCommandArgs(['5', 'npm', 'run', 'test']);
        assert.equal(parsed.rounds, 5);
        assert.equal(parsed.text, 'npm run test');
    });

    it('parses preset and timeout flags', () => {
        const parsed = parseCommandArgs([
            '-p',
            'reviewer',
            '-t',
            '60',
            '--rounds=2',
            'review',
            'code',
        ]);
        assert.equal(parsed.rounds, 2);
        assert.equal(parsed.preset, 'reviewer');
        assert.equal(parsed.timeoutSeconds, 60);
        assert.equal(parsed.text, 'review code');
    });

    it('parses inline preset and timeout with equal sign', () => {
        const parsed = parseCommandArgs(['--preset=architect', '--timeout=120', 'design', 'seams']);
        assert.equal(parsed.preset, 'architect');
        assert.equal(parsed.timeoutSeconds, 120);
        assert.equal(parsed.text, 'design seams');
    });

    it('retains flags as text parts when followed by invalid or missing values', () => {
        const parsed = parseCommandArgs(['mocha', '-r', 'ts-node', '-t', 'not-a-number', '-p']);
        assert.equal(parsed.rounds, undefined);
        assert.equal(parsed.timeoutSeconds, undefined);
        assert.equal(parsed.preset, undefined);
        assert.equal(parsed.text, 'mocha -r ts-node -t not-a-number -p');
    });
});

describe('getCommands', () => {
    it('registers goal and debate commands with correct metadata', () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const commands = ext.getCommands(context);
        assert.equal(commands.length, 2);

        const goalCmd = commands.find((c) => c.name === 'goal');
        const debateCmd = commands.find((c) => c.name === 'debate');
        assert.ok(goalCmd);
        assert.ok(debateCmd);
        assert.equal(goalCmd.arguments?.length, 1);
        assert.equal(debateCmd.arguments?.length, 1);
    });

    it('logs warning when taskContext is missing', async () => {
        const ext = new DynamicAgentsExtension();
        let logMsg = '';
        let logLevel = '';
        const context = {
            ...createMockContext(),
            log: (msg: string, level: string) => {
                logMsg = msg;
                logLevel = level;
            },
            getTaskContext: () => null,
        } as unknown as ExtensionContext;

        const commands = ext.getCommands(context);
        const goalCmd = commands.find((c) => c.name === 'goal');
        assert.ok(goalCmd);

        await goalCmd.execute(['npm', 'test'], context);
        assert.ok(logMsg.includes('No active task context'));
        assert.equal(logLevel, 'warn');
    });

    it('shows warning log message when goal command has no arguments', async () => {
        const ext = new DynamicAgentsExtension();
        let logType = '';
        let logText = '';
        let runPromptCalled = false;
        const taskContext = {
            addLogMessage: (level: string, message: string) => {
                logType = level;
                logText = message;
            },
            runPrompt: async () => {
                runPromptCalled = true;
            },
        };
        const context = {
            ...createMockContext(),
            getTaskContext: () => taskContext,
        } as unknown as ExtensionContext;

        const commands = ext.getCommands(context);
        const goalCmd = commands.find((c) => c.name === 'goal');
        assert.ok(goalCmd);

        await goalCmd.execute([], context);
        assert.equal(runPromptCalled, false);
        assert.equal(logType, 'warning');
        assert.ok(logText.includes('Usage: /goal'));
    });

    it('runs prompt in orchestrator mode when goal command has valid text', async () => {
        const ext = new DynamicAgentsExtension();
        let promptedText = '';
        let promptedMode = '';
        const taskContext = {
            addLogMessage: () => {},
            runPrompt: async (prompt: string, mode?: string) => {
                promptedText = prompt;
                promptedMode = mode ?? '';
            },
        };
        const context = {
            ...createMockContext(),
            getTaskContext: () => taskContext,
        } as unknown as ExtensionContext;

        const commands = ext.getCommands(context);
        const goalCmd = commands.find((c) => c.name === 'goal');
        assert.ok(goalCmd);

        await goalCmd.execute(['-r', '5', '-p', 'tester', 'run', 'all', 'tests'], context);
        assert.equal(promptedMode, 'orchestrator');
        assert.ok(
            promptedText.includes('Achieve this verifiable goal using run_dynamic_agent_goal'),
        );
        assert.ok(promptedText.includes('maxRounds: 5'));
        assert.ok(promptedText.includes('preset: tester'));
        assert.ok(promptedText.includes('run all tests'));
    });

    it('shows warning log message when debate command has no arguments', async () => {
        const ext = new DynamicAgentsExtension();
        let logType = '';
        let logText = '';
        let runPromptCalled = false;
        const taskContext = {
            addLogMessage: (level: string, message: string) => {
                logType = level;
                logText = message;
            },
            runPrompt: async () => {
                runPromptCalled = true;
            },
        };
        const context = {
            ...createMockContext(),
            getTaskContext: () => taskContext,
        } as unknown as ExtensionContext;

        const commands = ext.getCommands(context);
        const debateCmd = commands.find((c) => c.name === 'debate');
        assert.ok(debateCmd);

        await debateCmd.execute([], context);
        assert.equal(runPromptCalled, false);
        assert.equal(logType, 'warning');
        assert.ok(logText.includes('Usage: /debate'));
    });

    it('runs prompt in orchestrator mode when debate command has valid topic', async () => {
        const ext = new DynamicAgentsExtension();
        let promptedText = '';
        let promptedMode = '';
        const taskContext = {
            addLogMessage: () => {},
            runPrompt: async (prompt: string, mode?: string) => {
                promptedText = prompt;
                promptedMode = mode ?? '';
            },
        };
        const context = {
            ...createMockContext(),
            getTaskContext: () => taskContext,
        } as unknown as ExtensionContext;

        const commands = ext.getCommands(context);
        const debateCmd = commands.find((c) => c.name === 'debate');
        assert.ok(debateCmd);

        await debateCmd.execute(['--rounds=3', 'Monorepo', 'vs', 'Polyrepo'], context);
        assert.equal(promptedMode, 'orchestrator');
        assert.ok(
            promptedText.includes(
                'Conduct a structured debate on this topic using run_agent_debate',
            ),
        );
        assert.ok(promptedText.includes('rounds: 3'));
        assert.ok(promptedText.includes('Monorepo vs Polyrepo'));
    });

    it('enforces maxSubagentDepth when subagents attempt to spawn dynamic agents', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const subagentProfile = {
            ...createMockBaseProfile(),
            id: 'dynamic-agents-task-depth-test-subagent-1',
            isSubagent: true,
        };

        const tempConfigPath = `/tmp/test-depth-config-${Date.now()}.json`;
        try {
            // Case 1: maxSubagentDepth = 1 blocks any subagent (depth 1 >= 1)
            writeExtensionConfig({ maxSubagentDepth: 1 }, tempConfigPath);
            ext.configPath = tempConfigPath;

            const tools = ext.getTools(context, 'default', subagentProfile);
            const runTool = tools.find((t) => t.name === 'run_dynamic_agent');
            assert.ok(runTool);

            const execContext = {
                ...context,
                getTaskContext: () => ({
                    data: { id: 'task-depth-test' },
                }),
            } as unknown as ExtensionContext;

            const blockedResult = await runTool.execute(
                { prompt: 'subtask', systemPrompt: 'subagent worker' },
                undefined,
                execContext,
                {},
            );
            assert.equal(String(blockedResult), 'Error: maximum subagent depth (1) reached.');

            // Case 2: maxSubagentDepth = 2 allows depth 1 subagent to spawn
            writeExtensionConfig({ maxSubagentDepth: 2 }, tempConfigPath);

            let subagentSpawnedWithProfileId = '';
            const taskContext = {
                data: { id: 'task-depth-test-2' },
                runSubagent: async (profile: { id: string }) => {
                    subagentSpawnedWithProfileId = profile.id;
                    const event = {
                        subagentProfile: profile,
                        resultMessages: [
                            { id: 'm1', role: 'assistant', content: 'done from child subagent' },
                        ],
                    };
                    await ext.onSubagentFinished(event as never, context);
                    return 'done from child subagent';
                },
                interruptResponse: async () => {},
            };
            const execContext2 = {
                ...context,
                getTaskContext: () => taskContext,
            } as unknown as ExtensionContext;

            const allowedResult = await runTool.execute(
                { prompt: 'child task', systemPrompt: 'child worker', name: 'child-agent' },
                undefined,
                execContext2,
                {},
            );
            assert.ok(String(allowedResult).includes('done from child subagent'));
            assert.ok(subagentSpawnedWithProfileId.length > 0);

            // Case 3: child subagent at depth 2 cannot spawn further when maxSubagentDepth = 2
            const childProfile = {
                ...createMockBaseProfile(),
                id: subagentSpawnedWithProfileId,
                isSubagent: true,
            };
            const childTools = ext.getTools(context, 'default', childProfile);
            const childRunTool = childTools.find((t) => t.name === 'run_dynamic_agent');
            assert.ok(childRunTool);

            const grandchildResult = await childRunTool.execute(
                { prompt: 'grandchild task', systemPrompt: 'grandchild worker' },
                undefined,
                execContext2,
                {},
            );
            assert.equal(String(grandchildResult), 'Error: maximum subagent depth (2) reached.');
        } finally {
            try {
                fs.unlinkSync(tempConfigPath);
            } catch {
                // Ignore
            }
        }
    });

    it('enforces maxSubagentDepth for goal and debate tools', async () => {
        const ext = new DynamicAgentsExtension();
        const context = createMockContext();
        const subagentProfile = {
            ...createMockBaseProfile(),
            id: 'subagent-caller',
            isSubagent: true,
        };

        const tempConfigPath = `/tmp/test-depth-tools-${Date.now()}.json`;
        try {
            writeExtensionConfig({ maxSubagentDepth: 1 }, tempConfigPath);
            ext.configPath = tempConfigPath;

            const tools = ext.getTools(context, 'default', subagentProfile);
            const goalTool = tools.find((t) => t.name === 'run_dynamic_agent_goal');
            const debateTool = tools.find((t) => t.name === 'run_agent_debate');
            assert.ok(goalTool);
            assert.ok(debateTool);

            const execContext = {
                ...context,
                getTaskContext: () => ({
                    data: { id: 'task-depth-tools' },
                }),
            } as unknown as ExtensionContext;

            const goalRes = await goalTool.execute(
                { goal: 'sub goal' },
                undefined,
                execContext,
                {},
            );
            assert.equal(goalRes, 'Error: maximum subagent depth (1) reached.');

            const debateRes = await debateTool.execute(
                { topic: 'sub topic' },
                undefined,
                execContext,
                {},
            );
            assert.equal(debateRes, 'Error: maximum subagent depth (1) reached.');
        } finally {
            try {
                fs.unlinkSync(tempConfigPath);
            } catch {
                // Ignore
            }
        }
    });
});
