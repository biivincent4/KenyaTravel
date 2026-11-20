import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";

type Day = {
  day: number;
  date: string;
  destinationName: string;
  activities: string[];
  travelOnly: boolean;
  transferHours: number;
};
type Plan = {
  packageId: string;
  journeyName: string;
  route: string;
  image?: string;
  preferences: {
    startDate: string;
    endDate: string;
    partySize: number;
    budget: number;
    currency: "USD" | "KES";
    interests: string[];
  };
  itinerary: {
    title: string;
    summary: string;
    days: Day[];
    estimate: {
      amount: number;
      currency: string;
      withinBudget: boolean;
      rateNote: string;
    };
  };
};
type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
};

const root = document.getElementById("root")!;
const app = new App({ name: "Sanaa Kenya itinerary", version: "1.0.0" });
let plan: Plan | null = null;
let planId: string | null = null;
let quoteRequested = false;
let busy = false;
let notice: { tone: "ok" | "error"; text: string } | null = null;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: (Node | string | null | false)[]
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children)
    if (child)
      node.append(
        typeof child === "string" ? document.createTextNode(child) : child,
      );
  return node;
}
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
const longDate = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const resultText = (result: ToolResult) =>
  result.content?.find((item) => item.type === "text")?.text ?? "";

function button(label: string, onClick: () => void) {
  const node = h("button", "btn", label);
  node.type = "button";
  node.disabled = busy;
  node.addEventListener("click", onClick);
  return node;
}

async function call(name: string, args: Record<string, unknown>) {
  busy = true;
  notice = null;
  render();
  try {
    const result = (await app.callServerTool({
      name,
      arguments: args,
    })) as ToolResult;
    if (result.isError) {
      notice = {
        tone: "error",
        text: resultText(result) || "That did not work.",
      };
      return null;
    }
    return result.structuredContent ?? {};
  } catch {
    notice = {
      tone: "error",
      text: "The connection failed. Please try again.",
    };
    return null;
  } finally {
    busy = false;
    render();
  }
}

async function save() {
  if (!plan) return;
  const { startDate, partySize, budget, currency, interests } =
    plan.preferences;
  const saved = await call("save_journey", {
    packageId: plan.packageId,
    startDate,
    partySize,
    budget,
    currency,
    interests,
  });
  if (!saved || typeof saved.planId !== "string") return;
  planId = saved.planId;
  notice = {
    tone: "ok",
    text: "Saved to My trips. Nothing has been booked or charged.",
  };
  render();
  await app
    .updateModelContext({
      content: [
        {
          type: "text",
          text: `The user saved "${plan.itinerary.title}" from the itinerary card as plan ${planId}.`,
        },
      ],
    })
    .catch(() => undefined);
}

async function requestQuote() {
  if (!planId) return;
  const booking = await call("request_quote", { planId });
  if (!booking) return;
  quoteRequested = true;
  notice = {
    tone: "ok",
    text: "Quote requested. The agency confirms availability and sends the quote to My trips.",
  };
  render();
}

function render() {
  root.replaceChildren();
  if (!plan) {
    root.append(h("p", "muted pad", "Preparing your itinerary…"));
    return;
  }
  const { itinerary, preferences } = plan;
  const { estimate } = itinerary;
  const hero = h("div", "hero");
  if (plan.image?.startsWith("https://images.unsplash.com/")) {
    const image = h("img");
    image.src = plan.image;
    image.alt = "";
    hero.append(image);
  }
  hero.append(
    h(
      "div",
      "hero-text",
      h("span", "eyebrow", plan.route),
      h("h1", "", itinerary.title),
      h(
        "span",
        "meta",
        `${longDate(preferences.startDate)} – ${longDate(preferences.endDate)} · ${preferences.partySize} ${preferences.partySize === 1 ? "traveller" : "travellers"}`,
      ),
    ),
  );
  const days = h("ol", "days");
  for (const day of itinerary.days)
    days.append(
      h(
        "li",
        "",
        h("span", "day-num", `Day ${day.day}`),
        h(
          "div",
          "",
          h("strong", "", day.destinationName),
          h("span", "muted", ` · ${longDate(day.date)}`),
          h(
            "div",
            "muted small",
            day.travelOnly
              ? `Travel day, about ${day.transferHours} hours by road`
              : day.activities.join(" · "),
          ),
        ),
      ),
    );
  const actions = h("div", "actions");
  if (!planId)
    actions.append(button(busy ? "Saving…" : "Save to My trips", save));
  else if (!quoteRequested)
    actions.append(
      button(busy ? "Requesting…" : "Request agency quote", requestQuote),
    );
  root.append(
    hero,
    h("p", "summary", itinerary.summary),
    days,
    h(
      "div",
      "estimate",
      h("span", "muted small", "Illustrative estimate"),
      h("strong", "amount", money(estimate.amount, estimate.currency)),
      h(
        "span",
        estimate.withinBudget ? "badge ok" : "badge warn",
        estimate.withinBudget ? "Within budget" : "Over budget",
      ),
    ),
    actions,
    notice ? h("p", `notice ${notice.tone}`, notice.text) : "",
    h("p", "muted tiny", estimate.rateNote),
  );
}

function applyTheme(theme: unknown) {
  if (theme === "dark" || theme === "light")
    document.documentElement.dataset.theme = theme;
}
app.ontoolresult = (result) => {
  const toolResult = result as ToolResult;
  const data = toolResult.structuredContent as Plan | undefined;
  if (data?.itinerary?.days) {
    plan = data;
    planId = null;
    quoteRequested = false;
    notice = null;
  } else if (toolResult.isError) {
    notice = { tone: "error", text: resultText(toolResult) };
  }
  render();
};
app.onhostcontextchanged = (context) => applyTheme(context.theme);

render();
await app.connect();
applyTheme(app.getHostContext()?.theme);
