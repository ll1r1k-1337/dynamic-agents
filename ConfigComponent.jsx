({ config, updateConfig, ui }) => {
  const defaultGoalMaxRounds =
    config?.defaultGoalMaxRounds !== undefined
      ? config.defaultGoalMaxRounds
      : 3;
  const defaultDebateRounds =
    config?.defaultDebateRounds !== undefined
      ? config.defaultDebateRounds
      : 2;
  const defaultIdleTimeoutSeconds =
    config?.defaultIdleTimeoutSeconds !== undefined
      ? config.defaultIdleTimeoutSeconds
      : 180;
  const enableAllMcpServersByDefault =
    config?.enableAllMcpServersByDefault !== undefined
      ? config.enableAllMcpServersByDefault
      : true;

  const handleGoalChange = (e) => {
    const val = e.target.value === '' ? 0 : Number(e.target.value);
    updateConfig({
      ...config,
      defaultGoalMaxRounds: Number.isNaN(val) ? 0 : val,
    });
  };

  const handleDebateChange = (e) => {
    const val = e.target.value === '' ? 0 : Number(e.target.value);
    updateConfig({
      ...config,
      defaultDebateRounds: Number.isNaN(val) ? 0 : val,
    });
  };

  const handleTimeoutChange = (e) => {
    const val = e.target.value === '' ? 0 : Number(e.target.value);
    updateConfig({
      ...config,
      defaultIdleTimeoutSeconds: Number.isNaN(val) ? 0 : val,
    });
  };

  const handleMcpToggle = (e) => {
    updateConfig({
      ...config,
      enableAllMcpServersByDefault: e.target.checked,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label className="block text-sm font-medium text-text-primary">
          Default Goal Max Rounds
        </label>
        <p className="text-xs text-text-secondary">
          Maximum rounds for goal loops. Set to 0 for unlimited rounds (runs until achieved or blocked).
        </p>
        <input
          type="number"
          min="0"
          value={defaultGoalMaxRounds}
          onChange={handleGoalChange}
          className="w-32 p-2 text-sm bg-bg-secondary-light border-2 border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-sm font-medium text-text-primary">
          Default Debate Rebuttal Pairs
        </label>
        <p className="text-xs text-text-secondary">
          Number of rebuttal pairs before synthesis. Set to 0 to debate continuously until both sides reach consensus (DEBATE: agree).
        </p>
        <input
          type="number"
          min="0"
          value={defaultDebateRounds}
          onChange={handleDebateChange}
          className="w-32 p-2 text-sm bg-bg-secondary-light border-2 border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="block text-sm font-medium text-text-primary">
          Default Idle Timeout (seconds)
        </label>
        <p className="text-xs text-text-secondary">
          Inactivity timeout per subagent turn in seconds. Set to 0 to disable.
        </p>
        <input
          type="number"
          min="0"
          value={defaultIdleTimeoutSeconds}
          onChange={handleTimeoutChange}
          className="w-32 p-2 text-sm bg-bg-secondary-light border-2 border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
        />
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-border-default">
        <input
          type="checkbox"
          id="enableAllMcpServersByDefault"
          checked={enableAllMcpServersByDefault}
          onChange={handleMcpToggle}
          className="h-4 w-4 rounded border-border-default text-primary focus:ring-primary"
        />
        <div>
          <label htmlFor="enableAllMcpServersByDefault" className="text-sm font-medium text-text-primary cursor-pointer">
            Enable All MCP Servers by Default
          </label>
          <p className="text-xs text-text-secondary">
            Automatically grant orchestrator and subagents access to all configured MCP tools unless explicitly overridden.
          </p>
        </div>
      </div>
    </div>
  );
};
