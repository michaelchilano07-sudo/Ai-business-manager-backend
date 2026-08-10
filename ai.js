const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

async function callClaude(system, userText, maxTokens = 500) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const data = await res.json();
  return data?.content?.find((b) => b.type === "text")?.text || "";
}

const PARSE_SYSTEM = `You convert a small shop owner's plain sentence about a business event into JSON.
Output ONLY valid JSON, no markdown fences, no commentary. Schema:
{
  "type": "sale" | "expense" | "purchase" | "unknown",
  "item": string or null,
  "quantity": number or null,
  "unit_price": number or null,
  "total": number,
  "amount_paid": number,
  "customer_name": string or null
}
Rules:
- "sale" = the owner sold something to a customer.
- "purchase" = the owner bought stock/inventory to resell later.
- "expense" = money spent on anything that is not inventory (rent, transport, etc).
- If quantity and unit_price are both given but total isn't stated, compute total = quantity * unit_price.
- If payment amount isn't mentioned, assume amount_paid = total (paid in full).
- If the owner says a customer "paid" a smaller amount than the total, that's a partial payment — set amount_paid to what was actually paid.
- If no customer name is given, set customer_name to null (don't invent one).
- If the sentence doesn't describe a business transaction, set type to "unknown".`;

export async function parseEntry(text) {
  const raw = await callClaude(PARSE_SYSTEM, text, 400);
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (parsed.total == null && parsed.quantity != null && parsed.unit_price != null) {
      parsed.total = parsed.quantity * parsed.unit_price;
    }
    if (parsed.amount_paid == null) parsed.amount_paid = parsed.total || 0;
    return parsed;
  } catch {
    return { type: "unknown", item: null, quantity: null, unit_price: null, total: 0, amount_paid: 0, customer_name: null };
  }
}

const ASK_SYSTEM = `You are a small business's bookkeeping assistant. You will be given a JSON
snapshot of REAL, already-computed numbers for this business (weekly/monthly sales, expenses,
profit, top products, customer debts, inventory, estimated cash on hand), plus the owner's
question in their own words. Answer using ONLY the numbers in the snapshot — never invent or
estimate a number that isn't there. If the snapshot doesn't contain what's needed to answer
(e.g. they ask about something with no data), say so plainly. Keep answers short — 2-4 sentences,
plain language, no jargon. Currency symbol to use: `;

export async function answerQuestion(question, snapshot, currency = "K") {
  const prompt = `Snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nQuestion: ${question}`;
  return callClaude(ASK_SYSTEM + currency, prompt, 400);
}
