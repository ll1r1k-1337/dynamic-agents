# Dynamic Agents

AiderDesk extension that spawns ephemeral subagents from inline profiles. Profiles live in memory for one task session. Nothing is written to disk.

## Tools

### `run_dynamic_agent`

Runs one task in a temporary subagent and returns the final text only.

| Argument | Type | Required | Purpose |
| --- | --- | --- | --- |
| `prompt` | string | yes | Task for the subagent. Give complete, self-contained instructions. |
| `name` | string | no | Session-scoped name. Reusing the same name with no other overrides reuses the same profile; any new override (systemPrompt, provider, model, maxIterations, includeContextFiles) rebuilds the profile. |
| `systemPrompt` | string | no | Instructions for the subagent. Also used as its description. |
| `provider` | string | no | LLM provider. Defaults to the parent agent provider. |
| `model` | string | no | Model. Defaults to the parent agent model. |
| `maxIterations` | integer | no | Iteration limit. Defaults to the parent agent limit. |
| `includeContextFiles` | boolean | no | Add the task context files to the subagent run. |

Result text is cut at 20000 characters. The tail shows the count of removed characters.

### `list_dynamic_subagents`

Lists temporary subagents of the current task session as `- name: provider/model, calls=N`.

## Orchestrator mode

Orchestrator mode turns the agent into a coordinator. It does not solve the task itself. It decomposes the request into subtasks and delegates each subtask to `run_dynamic_agent` with an inline profile. It runs independent subtasks in parallel and aggregates the results into a final summary.

## Install

```
mkdir -p ~/.aider-desk/extensions
cp -r dynamic-agents ~/.aider-desk/extensions/dynamic-agents
cd ~/.aider-desk/extensions/dynamic-agents
npm install
```

Restart AiderDesk to load the extension.

## Limitations

- No persistence. Closing or deleting a task drops its profiles and results.
- No nesting. A subagent cannot spawn temporary subagents.
- Sequential. One call runs one subagent and waits for the final text.
- Text only. A profile with no assistant text returns a "no text output" message.
