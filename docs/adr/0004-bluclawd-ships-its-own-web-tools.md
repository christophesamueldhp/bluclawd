# bluclawd ships its own web tools, replacing pi-web-access

bluclawd registers two web tools, `websearch` and `webfetch`, and the user drops the pi-web-access package. Their names are the ones bluclawd's permission rules already govern (`WebSearch(...)`, `WebFetch(...)`), so the user's deny rules apply to them; pi-web-access's `web_search` and `fetch_content` escaped those rules. Search goes to one of two search providers: Exa, with the user's API key, or OpenAI, through the ChatGPT/Codex login pi already holds. That login works whatever model the session chats with. Fetching always goes through Exa's contents endpoint.

Decided 2026-10-30; the spec is GitHub issue #102.

## Considered Options

- **Keep pi-web-access and configure Exa as its provider**: rejected. The user wants Exa and OpenAI only, and a much smaller surface than its dozens of providers and its GitHub, PDF and video extraction.
- **Fetch pages locally** (HTML to markdown in-process): rejected. It needs new dependencies and SSRF protection, and it cannot read pages that render with JavaScript.
- **Fetch through OpenAI**: rejected. OpenAI has no fetch endpoint; its search's `open_page` only opens pages from search results and hands back the model's rewrite, not the page text.
- **OpenAI with a Platform API key**: deferred. The Codex login covers the need without separate billing.

## Consequences

- OpenAI search calls `chatgpt.com/backend-api/codex/responses`, which OpenAI does not document for third-party use, and each search spends the user's Codex quota.
- `webfetch` needs `EXA_API_KEY` even when search uses OpenAI.
- GitHub cloning, PDF, YouTube and video extraction go away with pi-web-access; agents use `git` and `gh` from the shell instead.
- The README's "bluclawd ships no web or MCP tools" no longer holds.
