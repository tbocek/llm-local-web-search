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

  function performSearch(queries) {
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

      window.postMessage({ type: "llm-open-search", queries, searchId: id }, "*");
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
    // Normalize url: fetch() accepts a string, URL, or Request object
    const urlStr = typeof url === "string" ? url : url instanceof Request ? url.url : String(url);

    //openwebui does not work yet: https://github.com/open-webui/open-webui/issues/20548
    if (!urlStr.includes("/v1/chat/completions") && !urlStr.includes("/api/chat/completions")) {
    //if (!url.includes("/v1/chat/completions")) {
      return originalFetch.apply(this, arguments);
    }

    if (options?.body) {
      await toolsReady;
      const body = JSON.parse(options.body);

      // Keep the frontend's own tools (e.g. current_time, runtime_info):
      // merge ours in, and drop duplicates of our tool from re-requests
      // that already carry it.
      const ownToolNames = tools.map((t) => t.function?.name);
      body.tools = [
        ...(Array.isArray(body.tools) ? body.tools : []).filter(
          (t) => !ownToolNames.includes(t?.function?.name),
        ),
        ...tools,
      ];

      options.body = JSON.stringify(body);
      console.log("[Injected] REQUEST:", urlStr);
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

    // Streaming response: pipe chunks through to the UI in real-time
    // while watching for tool calls. A detected search is performed and
    // its follow-up response is streamed through the same watch, so
    // chained searches stay inside the extension instead of leaking a
    // tool call the frontend cannot execute.
    const sourceReader = response.body.getReader();

    const outputStream = new ReadableStream({
      async pull(controller) {
        await streamWithSearchWatch(sourceReader, url, options, controller);
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
    console.log("[Injected] Web search:", args.narrow);
    const { results, userNote } = await performSearch({
      narrow: args.narrow,
      medium: args.medium,
      broad: args.broad,
    });
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
    const followOptions = { ...originalOptions, body: JSON.stringify(body) };
    return {
      response: await originalFetch(url, followOptions),
      options: followOptions,
    };
  }

  // Stream a response to `controller` while watching for client_web_search
  // calls. On detection the search runs and the follow-up response is
  // streamed through this same watch, so chained searches keep working
  // instead of reaching the frontend as an unknown tool.
  async function streamWithSearchWatch(
    reader,
    requestUrl,
    requestOptions,
    controller,
  ) {
    const decoder = new TextDecoder();
    let sseBuffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      sseBuffer += decoder.decode(value, { stream: true });
      const searchCall = parseSSE(sseBuffer).toolCalls.find(
        (tc) => tc.function.name === "client_web_search",
      );
      if (searchCall) {
        // Drain remaining chunks so the buffer holds the fully-streamed call
        while (true) {
          const { done: d, value: dv } = await reader.read();
          if (d) break;
          sseBuffer += decoder.decode(dv, { stream: true });
        }
        const completeCall = parseSSE(sseBuffer).toolCalls.find(
          (tc) => tc.function.name === "client_web_search",
        );
        const args = JSON.parse(completeCall.function.arguments);
        console.log("[Injected] Web search:", args.narrow);
        const { results, userNote } = await performSearch({
          narrow: args.narrow,
          medium: args.medium,
          broad: args.broad,
        });
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
        const followUp = await sendToolResponseRaw(
          requestUrl,
          requestOptions,
          completeCall,
          resultText,
        );
        if (followUp.response.body) {
          await streamWithSearchWatch(
            followUp.response.body.getReader(),
            requestUrl,
            followUp.options,
            controller,
          );
        } else {
          controller.close();
        }
        return;
      }
      controller.enqueue(value);
    }
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
