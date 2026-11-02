({ config, updateConfig }) => {
    const [localConfig, setLocalConfig] = React.useState(config || {});
    const debounceTimerRef = React.useRef(null);

    React.useEffect(() => {
        setLocalConfig(config || {});
    }, [config]);

    React.useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, []);

    const debouncedUpdate = (newConfig) => {
        setLocalConfig(newConfig);
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = setTimeout(() => {
            updateConfig(newConfig);
        }, 300);
    };

    const defaultGoalMaxRounds =
        localConfig?.defaultGoalMaxRounds !== undefined ? localConfig.defaultGoalMaxRounds : 3;
    const defaultDebateRounds =
        localConfig?.defaultDebateRounds !== undefined ? localConfig.defaultDebateRounds : 2;
    const defaultIdleTimeoutSeconds =
        localConfig?.defaultIdleTimeoutSeconds !== undefined
            ? localConfig.defaultIdleTimeoutSeconds
            : 180;
    const enableAllMcpServersByDefault =
        localConfig?.enableAllMcpServersByDefault !== undefined
            ? localConfig.enableAllMcpServersByDefault
            : true;
    const maxSubagentDepth =
        localConfig?.maxSubagentDepth !== undefined ? localConfig.maxSubagentDepth : 2;

    const handleGoalChange = (e) => {
        const val = e.target.value === '' ? 0 : Number(e.target.value);
        debouncedUpdate({
            ...localConfig,
            defaultGoalMaxRounds: Number.isNaN(val) ? 0 : val,
        });
    };

    const handleDebateChange = (e) => {
        const val = e.target.value === '' ? 0 : Number(e.target.value);
        debouncedUpdate({
            ...localConfig,
            defaultDebateRounds: Number.isNaN(val) ? 0 : val,
        });
    };

    const handleTimeoutChange = (e) => {
        const val = e.target.value === '' ? 0 : Number(e.target.value);
        debouncedUpdate({
            ...localConfig,
            defaultIdleTimeoutSeconds: Number.isNaN(val) ? 0 : val,
        });
    };

    const handleMaxDepthChange = (e) => {
        const parsed = Number(e.target.value);
        const val =
            e.target.value === '' || Number.isNaN(parsed) || parsed < 1 ? 1 : Math.floor(parsed);
        debouncedUpdate({
            ...localConfig,
            maxSubagentDepth: val,
        });
    };

    const handleMcpToggle = (e) => {
        const newConfig = {
            ...localConfig,
            enableAllMcpServersByDefault: e.target.checked,
        };
        setLocalConfig(newConfig);
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }
        updateConfig(newConfig);
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
                <label
                    htmlFor="defaultGoalMaxRounds"
                    className="block text-sm font-medium text-text-primary"
                >
                    Default Goal Max Rounds
                </label>
                <p className="text-xs text-text-secondary">
                    Maximum rounds for goal loops. Set to 0 for unlimited rounds (runs until
                    achieved or blocked).
                </p>
                <input
                    id="defaultGoalMaxRounds"
                    type="number"
                    min="0"
                    value={defaultGoalMaxRounds}
                    onChange={handleGoalChange}
                    className="w-32 p-2 text-sm bg-bg-secondary-light border-2 border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
                />
            </div>

            <div className="flex flex-col gap-1">
                <label
                    htmlFor="defaultDebateRounds"
                    className="block text-sm font-medium text-text-primary"
                >
                    Default Debate Rounds
                </label>
                <p className="text-xs text-text-secondary">
                    Number of rebuttal pairs before synthesis. Set to 0 to debate continuously until
                    consensus.
                </p>
                <input
                    id="defaultDebateRounds"
                    type="number"
                    min="0"
                    value={defaultDebateRounds}
                    onChange={handleDebateChange}
                    className="w-32 p-2 text-sm bg-bg-secondary-light border-2 border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
                />
            </div>

            <div className="flex flex-col gap-1">
                <label
                    htmlFor="defaultIdleTimeoutSeconds"
                    className="block text-sm font-medium text-text-primary"
                >
                    Default Idle Timeout Seconds
                </label>
                <p className="text-xs text-text-secondary">
                    Inactivity timeout in seconds before interrupting a subagent run. Set to 0 to
                    disable.
                </p>
                <input
                    id="defaultIdleTimeoutSeconds"
                    type="number"
                    min="0"
                    value={defaultIdleTimeoutSeconds}
                    onChange={handleTimeoutChange}
                    className="w-32 p-2 text-sm bg-bg-secondary-light border-2 border-border-default rounded focus:outline-none focus:border-border-light text-text-primary"
                />
            </div>

            <div className="flex flex-col gap-1">
                <label
                    htmlFor="maxSubagentDepth"
                    className="block text-sm font-medium text-text-primary"
                >
                    Max Subagent Depth
                </label>
                <p className="text-xs text-text-secondary">
                    Maximum nesting level for dynamic subagents. Set to 1 for flat subagents only,
                    or 2+ to allow subagents to spawn child subagents (e.g. inside goal loops).
                </p>
                <input
                    id="maxSubagentDepth"
                    type="number"
                    min="1"
                    value={maxSubagentDepth}
                    onChange={handleMaxDepthChange}
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
                    <label
                        htmlFor="enableAllMcpServersByDefault"
                        className="text-sm font-medium text-text-primary cursor-pointer"
                    >
                        Enable All MCP Servers by Default
                    </label>
                    <p className="text-xs text-text-secondary">
                        Automatically grant orchestrator and subagents access to all configured MCP
                        tools unless explicitly overridden.
                    </p>
                </div>
            </div>
        </div>
    );
};
