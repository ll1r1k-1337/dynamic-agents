# Dynamic Agents

AiderDesk extension that spawns ephemeral subagents from inline profiles. Profiles live in memory for one task session. Nothing is written to disk.

## Tools

### run_dynamic_agent

Runs one task in a temporary subagent and returns the final text only.

| Name                | Type     | Required | Default               | Description                                                                                               |
| ------------------- | -------- | -------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| prompt              | string   | yes      | —                     | Task for the subagent. Give complete, self-contained instructions.                                        |
| name                | string   | no       | session counter       | Session-scoped name. Reusing the same name with no other overrides reuses the same profile.               |
| systemPrompt        | string   | yes      | —                     | Instructions for the subagent. Required. Also used as its description.                                    |
| provider            | string   | no       | parent agent provider | LLM provider. Defaults to the parent agent provider.                                                      |
| model               | string   | no       | parent agent model    | Model. Defaults to the parent agent model.                                                                |
| maxTokens           | integer  | no       | parent agent limit    | Maximum output tokens for the subagent (positive integer, up to 128000).                                  |
| idleTimeoutSeconds  | integer  | no       | 180                   | Inactivity timeout in seconds before interrupting a subagent run. Set to 0 to disable.                    |
| preset              | string   | no       | —                     | Preset archetype for system instructions (`reviewer`, `tester`, `architect`, `refactorer`, `researcher`). |
| contextFiles        | string[] | no       | —                     | List of file paths to add into subagent context.                                                          |
| includeContextFiles | boolean  | no       | parent profile        | Add task context files to the subagent run.                                                               |
| useAiderTools       | boolean  | no       | parent profile        | Override parent `useAiderTools` for this agent.                                                           |
| usePowerTools       | boolean  | no       | parent profile        | Override parent `usePowerTools` for this agent.                                                           |
| useTodoTools        | boolean  | no       | parent profile        | Override parent `useTodoTools` for this agent.                                                            |
| useSkillsTools      | boolean  | no       | parent profile        | Override parent `useSkillsTools` for this agent.                                                          |
| useTaskTools        | boolean  | no       | parent profile        | Override parent `useTaskTools` for this agent.                                                            |
| useMemoryTools      | boolean  | no       | parent profile        | Override parent `useMemoryTools` for this agent.                                                          |
| enabledServers      | string[] | no       | parent servers        | List of enabled MCP servers for this agent.                                                               |

#### Example

```json
{
    "prompt": "Find all unused exports in src/utils.ts and list their line numbers.",
    "systemPrompt": "You are a code reviewer. Inspect files and report findings concisely.",
    "preset": "reviewer"
}
```

Result text is cut at 20000 characters. The tail shows the count of removed characters.

---

### list_dynamic_subagents

Lists ephemeral subagents registered in the current task session, with their call counts and profile settings.

| Name   | Type   | Required | Default | Description                                         |
| ------ | ------ | -------- | ------- | --------------------------------------------------- |
| reason | string | yes      | —       | Brief explanation of why you are calling this tool. |

---

### run_dynamic_agent_goal

Runs a goal loop: repeatedly spawns a dynamic subagent that works toward a verifiable goal. Each round must end with a verdict line (`GOAL: achieved` | `GOAL: continue: <what remains>` | `GOAL: blocked: <reason>`). The loop stops on achieved, on blocked, on a reply without a verdict, or when maxRounds is exhausted, and returns a result whose first line is `GOAL_RESULT: <status> (rounds N)`. Use this tool when the task has a verifiable end state (tests pass, typecheck clean, file exists) and may need several iterations. Use `run_dynamic_agent` for a single self-contained subtask.

| Name                | Type     | Required | Default        | Description                                                                                                                                |
| ------------------- | -------- | -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| goal                | string   | yes      | —              | Verifiable end state for the goal loop, e.g. "npm test passes" or "typecheck is clean".                                                    |
| task                | string   | no       | goal           | Initial task instructions. Defaults to the goal itself.                                                                                    |
| verifyInstructions  | string   | no       | —              | How to verify that the goal is achieved, e.g. "run npm test".                                                                              |
| maxRounds           | integer  | no       | 3 (or config)  | Maximum number of agent rounds, including the round that reports achieved. Set to 0 for unlimited rounds (runs until achieved or blocked). |
| maxTokens           | integer  | no       | —              | Maximum output tokens for each goal round. Pass this value when rounds write long reports and hit the token limit.                         |
| idleTimeoutSeconds  | integer  | no       | —              | Maximum seconds of inactivity before interrupting a goal round. Applies to each round separately.                                          |
| provider            | string   | no       | —              | Override provider for the goal agent.                                                                                                      |
| model               | string   | no       | —              | Override model for the goal agent.                                                                                                         |
| contextFiles        | string[] | no       | —              | List of file paths to load into the goal runner context.                                                                                   |
| includeContextFiles | boolean  | no       | parent profile | Add task context files to each round.                                                                                                      |
| useAiderTools       | boolean  | no       | parent profile | Override parent `useAiderTools` for goal rounds.                                                                                           |
| usePowerTools       | boolean  | no       | parent profile | Override parent `usePowerTools` for goal rounds.                                                                                           |
| useTodoTools        | boolean  | no       | parent profile | Override parent `useTodoTools` for goal rounds.                                                                                            |
| useSkillsTools      | boolean  | no       | parent profile | Override parent `useSkillsTools` for goal rounds.                                                                                          |
| useTaskTools        | boolean  | no       | parent profile | Override parent `useTaskTools` for goal rounds.                                                                                            |
| useMemoryTools      | boolean  | no       | parent profile | Override parent `useMemoryTools` for goal rounds.                                                                                          |
| enabledServers      | string[] | no       | parent servers | List of enabled MCP servers for goal rounds.                                                                                               |

#### Example

```json
{
    "goal": "npm test passes and typecheck is clean",
    "task": "Fix type errors in index.ts and update test assertions",
    "verifyInstructions": "run npm run typecheck && npm test",
    "maxRounds": 4
}
```

---

### run_agent_debate

Runs a structured debate between an advocate agent and a critic agent with orthogonal positions, followed by a neutral synthesizer. Use for contested decisions where orthogonal critique before synthesis beats a single opinion.

| Name                    | Type     | Required | Default        | Description                                                                                                                                                |
| ----------------------- | -------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| topic                   | string   | yes      | —              | The topic or proposal to debate.                                                                                                                           |
| rounds                  | integer  | no       | 2 (or config)  | Number of rebuttal pairs between advocate and critic before synthesis. Set to 0 to debate continuously until both sides reach consensus (`DEBATE: agree`). |
| advocateSystemPrompt    | string   | no       | built-in       | Override system prompt for the advocate.                                                                                                                   |
| criticSystemPrompt      | string   | no       | built-in       | Override system prompt for the critic.                                                                                                                     |
| synthesizerSystemPrompt | string   | no       | built-in       | Override system prompt for the synthesizer.                                                                                                                |
| maxTokens               | integer  | no       | —              | Maximum output tokens per spawn.                                                                                                                           |
| idleTimeoutSeconds      | integer  | no       | —              | Maximum seconds of inactivity per spawn.                                                                                                                   |
| provider                | string   | no       | —              | Override provider.                                                                                                                                         |
| model                   | string   | no       | —              | Override model.                                                                                                                                            |
| contextFiles            | string[] | no       | —              | List of file paths to load into each debate agent context.                                                                                                 |
| includeContextFiles     | boolean  | no       | parent profile | Add task context files to each turn.                                                                                                                       |
| useAiderTools           | boolean  | no       | parent profile | Override parent `useAiderTools` for debate agents.                                                                                                         |
| usePowerTools           | boolean  | no       | parent profile | Override parent `usePowerTools` for debate agents.                                                                                                         |
| useTodoTools            | boolean  | no       | parent profile | Override parent `useTodoTools` for debate agents.                                                                                                          |
| useSkillsTools          | boolean  | no       | parent profile | Override parent `useSkillsTools` for debate agents.                                                                                                        |
| useTaskTools            | boolean  | no       | parent profile | Override parent `useTaskTools` for debate agents.                                                                                                          |
| useMemoryTools          | boolean  | no       | parent profile | Override parent `useMemoryTools` for debate agents.                                                                                                        |
| enabledServers          | string[] | no       | parent servers | List of enabled MCP servers for debate agents.                                                                                                             |

First line of result is `DEBATE_RESULT: <status> (rounds N)`.

#### Example

```json
{
    "topic": "Should dynamic-agents store session state in SQLite instead of in-memory Maps?",
    "rounds": 2
}
```

---

## Extension Settings

Configure global defaults in the AiderDesk extension settings dialog:

- **defaultGoalMaxRounds**: default max rounds for goal loops (default: 3). Set to `0` for unlimited rounds.
- **defaultDebateRounds**: default rebuttal pairs for debates (default: 2). Set to `0` for continuous debate until consensus.
- **defaultIdleTimeoutSeconds**: default inactivity timeout per subagent turn in seconds (default: 180). Set to `0` to disable.
- **maxSubagentDepth**: maximum nesting level for dynamic subagents (default: 2). Set to 1 for flat subagents only, or 2+ to allow subagents to spawn child subagents (e.g. inside goal loops).

These settings are stored in `config.json` inside the extension folder and can be configured through the AiderDesk UI.

---

## Commands

### /goal

Run an iterative goal loop toward a verifiable end state using dynamic subagents.

```text
/goal [-r <rounds>] [-p <preset>] [-t <timeout>] <verifiable goal>
```

Options:
- `-r`, `--rounds <number>`: Maximum number of agent rounds (e.g. `-r 5`).
- `-p`, `--preset <name>`: Agent preset (`reviewer`, `tester`, `architect`, `refactorer`, `researcher`).
- `-t`, `--timeout <seconds>`: Inactivity timeout per turn in seconds.

Examples:
- `/goal npm test passes`
- `/goal -r 5 npm run typecheck is clean`
- `/goal -r 3 -p tester fix failing unit tests in test/auth.test.ts`

### /debate

Run a structured debate between advocate and critic agents on a contested topic, followed by neutral synthesis.

```text
/debate [-r <rounds>] [-p <preset>] [-t <timeout>] <topic or decision>
```

Options:
- `-r`, `--rounds <number>`: Number of rebuttal pairs between advocate and critic (e.g. `-r 2`).
- `-p`, `--preset <name>`: Synthesizer and debate archetype preset.
- `-t`, `--timeout <seconds>`: Inactivity timeout per turn in seconds.

Examples:
- `/debate Monorepo vs Polyrepo for multi-package architecture`
- `/debate -r 3 REST vs GraphQL for mobile clients`

---

## Orchestrator agent

Select the **Orchestrator** agent profile. The orchestrator decomposes tasks into focused subtasks and delegates them to dynamic subagents, goal loops, or debate sequences.

The orchestrator is a manager. It has no file reading, file writing, or shell execution tools. Every task runs inside a delegated subagent.

For tool selection: use `run_dynamic_agent` for single self-contained subtasks, `run_dynamic_agent_goal` for tasks with a verifiable end state that may require multiple iterations, and `run_agent_debate` for contested design or architectural decisions.

## Install

1. Clone into `~/.aider-desk/extensions/dynamic-agents`
2. Run `npm install`
3. Restart AiderDesk

## Limitations

- No persistence. Closing or deleting a task drops its profiles and results.
- No nesting. A subagent cannot spawn temporary subagents.
- Multi-subagent sequencing. Multi-agent tools (`run_dynamic_agent_goal`, `run_agent_debate`) run multi-subagent sequences within a single tool call sequentially (or concurrently across parallel orchestrator calls), without writing profiles to disk.
- Text only. A profile with no assistant text returns a "no text output" message.
