(function () {
  console.log("[Injected] Script starting");
  const toolsUrl = document.currentScript.dataset.toolsUrl;
  console.log("[Injected] Tools URL:", toolsUrl);

  // Load tools lazily so we can patch fetch synchronously
  let tools = null;
  const toolsReady = fetch(toolsUrl)
    .then((r) => r.json())
    .then((t) => {
      tools = t;
      console.log("[Injected] Loaded tools:", tools);
    });

  const SEARCH_TIMEOUT = 600000;

  let searchId = 0;
  const pendingSearches = new Map();

  function performSearch(query) {
    return new Promise((resolve) => {
      const id = ++searchId;

      const timeout = setTimeout(() => {
        pendingSearches.delete(id);
        resolve({
          results: [{ title: "Timeout", url: "", content: "Search timed out" }],
          userNote: "",
        });
      }, SEARCH_TIMEOUT);

      pendingSearches.set(id, { resolve, timeout });

      window.postMessage({ type: "llm-open-search", query, searchId: id }, "*");
    });
  }

  window.addEventListener("message", (event) => {
    if (event.data?.type === "llm-search-complete") {
      const id = event.data.searchId;
      const pending = pendingSearches.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingSearches.delete(id);
        pending.resolve({
          results: event.data.results,
          userNote: event.data.userNote,
        });
      }
    }
  });

  const originalFetch = window.fetch;

  window.fetch = async function (url, options) {
    //openwebui does not work yet: https://github.com/open-webui/open-webui/issues/20548
    if (!url.includes("/v1/chat/completions") && !url.includes("/api/chat/completions")) {
    //if (!url.includes("/v1/chat/completions")) {
      return originalFetch.apply(this, arguments);
    }

    if (options?.body) {
      await toolsReady;
      const body = JSON.parse(options.body);

      if (!body.messages?.some((m) => m.role === "tool")) {
        body.tools = tools;
      }

      options.body = JSON.stringify(body);
      console.log("[Injected] REQUEST:", url);
    }

    const response = await originalFetch.apply(this, arguments);

    // If not a streaming response, use the original buffered approach
    if (!response.body) {
      const text = await response.text();
      const parsed = parseSSE(text);
      if (parsed.toolCalls.length > 0) {
        const call = parsed.toolCalls.find(
          (tc) => tc.function.name === "client_web_search",
        );
        if (call) {
          return handleToolCall(url, options, call);
        }
      }
      return new Response(text, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    // Streaming response: pipe chunks through to the UI in real-time,
    // while also parsing for tool calls. If a tool call is detected,
    // we handle the search and pipe the follow-up response into the
    // same stream so the UI sees it as one continuous flow.
    const sourceReader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    const outputStream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await sourceReader.read();

          if (done) {
            controller.close();
            return;
          }

          sseBuffer += decoder.decode(value, { stream: true });

          // Check for tool calls as data arrives
          const parsed = parseSSE(sseBuffer);
          const searchCall = parsed.toolCalls.find(
            (tc) => tc.function.name === "client_web_search",
          );

          if (searchCall) {
            // Tool call detected — drain remaining chunks silently
            while (true) {
              const { done: d, value: dv } = await sourceReader.read();
              if (d) break;
              sseBuffer += decoder.decode(dv, { stream: true });
            }

            // Re-parse the complete buffer to get fully-streamed arguments
            const complete = parseSSE(sseBuffer);
            const completeCall = complete.toolCalls.find(
              (tc) => tc.function.name === "client_web_search",
            );

            // Perform the search
            const args = JSON.parse(completeCall.function.arguments);
            console.log("[Injected] Web search:", args.query);
            const { results, userNote } = await performSearch(args.query);
            const prefix = userNote ? `User note: ${userNote}\n\n` : "";
            const resultText =
              prefix +
              results
                .map(
                  (r, i) =>
                    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}\n`,
                )
                .join("\n---\n");

            console.log("[Injected] Sending results to LLM");
            // Make follow-up request with tool results
            const followUp = await sendToolResponseRaw(
              url,
              options,
              completeCall,
              resultText,
            );

            // Pipe the follow-up response stream into our output
            if (followUp.body) {
              const followReader = followUp.body.getReader();
              while (true) {
                const { done: fd, value: fv } = await followReader.read();
                if (fd) break;
                controller.enqueue(fv);
              }
            }

            controller.close();
            return;
          }

          // No tool call yet — forward chunk to the UI immediately
          controller.enqueue(value);
          return; // yield control back so the UI can render this chunk
        }
      },
    });

    return new Response(outputStream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

  async function handleToolCall(url, options, call) {
    const args = JSON.parse(call.function.arguments);
    console.log("[Injected] Web search:", args.query);
    const { results, userNote } = await performSearch(args.query);
    const prefix = userNote ? `User note: ${userNote}\n\n` : "";
    const resultText =
      prefix +
      results
        .map(
          (r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}\n`,
        )
        .join("\n---\n");
    console.log("[Injected] Sending results to LLM");
    return sendToolResponse(url, options, call, resultText);
  }

  // sendToolResponseRaw uses originalFetch to avoid re-entering the patched fetch
  async function sendToolResponseRaw(url, originalOptions, toolCall, result) {
    const originalBody = JSON.parse(originalOptions.body);
    const messages = [
      ...originalBody.messages,
      {
        role: "assistant",
        tool_calls: [
          {
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      },
    ];
    const body = { ...originalBody, messages };
    delete body.tools;
    return originalFetch(url, {
      ...originalOptions,
      body: JSON.stringify(body),
    });
  }

  async function sendToolResponse(url, originalOptions, toolCall, result) {
    const originalBody = JSON.parse(originalOptions.body);

    console.log("[Injected] Original messages:", originalBody.messages.length);

    const messages = [
      ...originalBody.messages,
      {
        role: "assistant",
        tool_calls: [
          {
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      },
    ];

    const body = {
      ...originalBody,
      messages,
    };
    delete body.tools;

    console.log(
      "[Injected] Sending tool response, messages:",
      body.messages.length,
    );
    console.log(
      "[Injected] Tool response body:",
      JSON.stringify(body, null, 2),
    );

    return window.fetch(url, {
      ...originalOptions,
      body: JSON.stringify(body),
    });
  }

  function parseSSE(sseData) {
    let content = "";
    const toolCalls = [];
    const lines = sseData.split("\n");

    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta;
          const message = json.choices?.[0]?.message;

          if (delta?.content) content += delta.content;
          if (message?.content) content += message.content;

          if (message?.tool_calls) {
            toolCalls.push(...message.tool_calls);
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: "",
                  function: { name: "", arguments: "" },
                };
              }
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name)
                toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments)
                toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch (e) {}
      }
    }

    return {
      content,
      toolCalls: toolCalls.filter((tc) => tc.function.name),
    };
  }

  console.log("[Injected] Fetch interceptor installed");
})();
