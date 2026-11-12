# Hiding denied MCP server names from the model

**Decision:** Not planned.
**Reason:** A deny rule blocks calls; it does not hide what is denied. A denied server's tools stay in the model's tool list (and in tool search and codemode namespaces) under names that contain the server's name, and the block reason quotes the rule. Rewriting one pi error message to drop the name would hide nothing. Hiding denied servers would mean un-declaring their tools, a separate feature no one has asked for.
**Prior requests:**
- #384: pi's resource error names a denied MCP server
