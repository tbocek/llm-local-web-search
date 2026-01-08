(async function () {
  const toolsUrl = document.currentScript.dataset.toolsUrl;

  const toolsResponse = await fetch(toolsUrl);
  const tools = await toolsResponse.json();

  console.log("[Injected] Loaded tools:", tools);

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
    if (!url.includes("/v1/chat/completions")) {
      return originalFetch.apply(this, arguments);
    }

    if (options?.body) {
      const body = JSON.parse(options.body);

      if (!body.messages?.some((m) => m.role === "tool")) {
        body.tools = tools;
      }

      options.body = JSON.stringify(body);
      console.log("[Injected] REQUEST:", url);
    }

    const response = await originalFetch.apply(this, arguments);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullResponse += decoder.decode(value, { stream: true });
    }

    const parsed = parseSSE(fullResponse);

    console.log("[Injected] RESPONSE parsed:", parsed);
    console.log("[Injected] toolCalls found:", parsed.toolCalls.length);

    if (parsed.toolCalls.length > 0) {
      for (const call of parsed.toolCalls) {
        if (call.function.name === "web_search") {
          const args = JSON.parse(call.function.arguments);
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
          const finalResponse = await sendToolResponse(
            url,
            options,
            call,
            resultText,
          );
          return finalResponse;
        }
      }
    }

    return new Response(fullResponse, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

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
