# A run's shell confirms its processes ended by sandbox identity, not a VM

ADR-0001 held that only a VM per command can contain process lifetime on macOS, so the orchestrator's shell relies on a best-effort reaper. That isn't enough for a run's shell: a Stop, a capacity slot or an Integration may only proceed once a run's processes have actually ended (ADR-0010). So each run's shell gets its own Seatbelt profile, which alone may look up the Mach name `bluclawd.run.<runId>`. Any sandboxed process allowed that name, and refused a control name, belongs to the run, however it detached, double-forked, called setsid or scrubbed its environment. A native helper stops and kills every member, and reports success only when a scan finds none. It fails closed on any process it can't identify.

The orchestrator's interactive shell keeps ADR-0001's best-effort reaper. Linux and WSL get no run shell until their containment is shown to hold. The approach relies on private SPI (`sandbox_check`, `proc_pidinfo` flavor 17), so a macOS update that breaks it makes the self-test refuse run shells rather than run them uncontained.

Decided 2026-11-11 with #302 of spec #290; a VM per command stays rejected for ADR-0001's reasons.
