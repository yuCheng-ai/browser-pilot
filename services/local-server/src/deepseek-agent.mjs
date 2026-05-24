const fallbackModel = "deepseek-v4-flash";

export async function planBrowserAction({ apiKey, model, message, state }) {
  const targets = state.targets.slice(0, 70).map((target) => ({
    id: target.id,
    label: target.label,
    tag: target.tag,
    type: target.type,
    context: target.context || "",
    risk: target.risk?.level || "none",
  }));
  const pageContent = (state.content || []).slice(0, 35).map((item) => ({
    id: item.id,
    role: item.role,
    text: item.text,
    targetIds: item.targetIds || [],
  }));

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || fallbackModel,
      thinking: {
        type: "disabled",
      },
      temperature: 0.1,
      max_tokens: 900,
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content: [
            "You are BrowserPilot, a local browser agent.",
            "Choose at most one browser action for this turn.",
            "Use DOM target ids to click or type; never invent target ids.",
            "The visible page is already open in a Tauri WebView. You only plan; BrowserPilot executes the action in that live WebView.",
            "Clicks are executed later from DOM bounding boxes by native mouse coordinates.",
            "The page.content list contains readable visible page blocks and feed cards. Use it to understand page content, not just buttons.",
            "When the user refers to a title, card, author, topic, or visible text, match it against page.content first, then choose a related target id from targetIds or a target whose context matches.",
            "If the request depends on visual pixels inside an image and no readable text or alt text describes it, say this version cannot identify that image visually yet and return no action.",
            "For search tasks, choose the best search input target and return a type action with submit:true.",
            "For navigation requests, return navigate with the absolute URL.",
            "For clicking visible page text or buttons, return click with the matching target id.",
            "For destructive, payment, publish, approval, or submit actions, prefer no action unless the user explicitly asked for that exact action.",
            'Return JSON only: {"reply":"short Chinese reply","action":{"type":"none"}}.',
            'Allowed actions: {"type":"navigate","url":"https://..."}, {"type":"click","targetId":"target-1"}, {"type":"type","targetId":"target-2","text":"value","submit":false}, {"type":"none"}.',
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            request: message,
            page: {
              title: state.title,
              url: state.url,
              content: pageContent,
              targets,
            },
          }),
        },
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    const providerMessage =
      payload?.error?.message || payload?.message || "DeepSeek 请求失败。";
    throw new Error(providerMessage);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek 没有返回任务动作。");
  }

  return parsePlan(content);
}

function parsePlan(content) {
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 返回了不可解析的动作。");
  }

  return {
    reply: String(parsed.reply || "已处理。").slice(0, 320),
    action: normalizeAction(parsed.action),
  };
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    return {
      type: "none",
    };
  }

  if (action.type === "navigate" && typeof action.url === "string") {
    return {
      type: "navigate",
      url: action.url,
    };
  }

  if (action.type === "click" && typeof action.targetId === "string") {
    return {
      type: "click",
      targetId: action.targetId,
    };
  }

  if (
    action.type === "type" &&
    typeof action.targetId === "string" &&
    typeof action.text === "string"
  ) {
    return {
      type: "type",
      targetId: action.targetId,
      text: action.text.slice(0, 2000),
      submit: Boolean(action.submit),
    };
  }

  return {
    type: "none",
  };
}
