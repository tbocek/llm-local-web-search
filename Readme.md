# LLM Web Search Extension

Firefox extension that intercepts OpenAI-compatible API calls and adds client-side web search capability.

## Motivation

Server-side web search in LLMs sometimes fails with "could not fetch" errors due to rate limiting, captchas, or blocked requests. This extension moves search to the client browser where:

- You see and solve captchas yourself
- You control which pages load
- No server-side fetching issues
- Works offline with local LLMs

Tested with [llama.cpp](https://github.com/ggml-org/llama.cpp). Other backends untested.

## How It Works

1. Extension intercepts requests to `/v1/chat/completions`
2. Injects `web_search` tool into the request
3. When LLM calls the tool, opens DuckDuckGo in a new window
4. Extracts search results and page content via Readability
5. Returns results to LLM as tool response

When a search is triggered, the extension opens a new window with DuckDuckGo. Once results load, it opens each result URL in a separate tab within that window (up to 10 tabs by default). Each tab runs the Readability extractor to pull article content. After all tabs finish loading or the timeout expires, the window closes automatically and results are sent back to the LLM. If a site requires a captcha or login, you can interact with it directly in the browser before the timeout completes.

If you navigate within a tab (e.g., click a link), the new page content replaces the previous one. Only the last visited page per tab is sent to the LLM.

To use private windows, enable it in extension settings. You must also allow the extension to run in private mode: about:addons -> Extension -> Permissions -> "Run in Private Windows".

## Components

**injected.js**: Patches `window.fetch` to intercept `/v1/chat/completions` requests. Parses SSE streaming responses to detect `tool_calls`. When `web_search` is called, triggers the search flow and sends results back as a tool message. This must be injected into the page context because content scripts run in an isolated environment and cannot access or modify the page's `window.fetch`.

**content.js**: Runs on matched URL patterns. Injects `injected.js` into the page context and relays messages between the page and background script via `postMessage`/`sendMessage` bridge.

**background.js**: Orchestrates the search. Creates browser windows, tracks tabs, collects extracted content, and manages state. Handles timeouts and partial results.

**duckduckgo.js**: Content script for DuckDuckGo. Extracts search result links using `[data-testid="result-title-a"]` selector. Uses MutationObserver to handle dynamic loading.

**extractor.js**: Runs on all pages opened by the extension. Uses Readability to extract article content. Reports back to background with title, URL, and text content.

**sidebar.js/html**: Optional UI showing search progress, loaded sites, and manual submit/cancel controls.

## Installation

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json`

For persistent install, package as `.xpi` and sign via Mozilla.

## Configuration

Settings available in extension options:

| Setting | Default | Description |
|---------|---------|-------------|
| URL Patterns | `localhost`, `127.0.0.1` | Which URLs to intercept |
| Max Results | 10 | Search results to fetch (1-10) |
| Auto-close | true | Close search window when done |
| Extract Timeout | 10s | Seconds before auto-submit |
| Extract Delay | 3000ms | Wait time before extracting page content |
| Incognito Mode | false | Run searches in private windows |

## Dependencies

- [Readability.js](https://github.com/mozilla/readability) (Apache-2.0)

## Acknowledgments
Built with assistance from Qwen3-next and Claude.ai.