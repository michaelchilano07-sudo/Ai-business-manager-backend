const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function callGemini(system, userText, maxTokens = 500) {
  const res = await fetch(
    `${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: system }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userText }],
          },
        ],
        generationConfig: {
          maxOutputTokens: maxTokens,
        },
      }),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    console.error("Gemini API error:", data);
    throw new Error(
      data?.error?.message || "Gemini API request failed"
    );
  }

  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || ""
  );
}

const PARSE_SYSTEM = `You convert a small shop owner's plain sentence about a business event into JSON.

Output ONLY valid JSON, no markdown fences, no commentary.

Schema:
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
  const raw = await callGemini(PARSE_SYSTEM, text, 400);

  try {
    const clean = raw.replace(/```json|```/g, "").trim();

    const parsed = JSON.parse(clean);

    if (
      parsed.total == null &&
      parsed.quantity != null &&
      parsed.unit_price != null
    ) {
      parsed.total = parsed.quantity * parsed.unit_price;
    }

    if (parsed.amount_paid == null) {
      parsed.amount_paid = parsed.total || 0;
    }

    return parsed;
  } catch (error) {
    console.error("AI parsing error:", error);

    return {
      type: "unknown",
      item: null,
      quantity: null,
      unit_price: null,
      total: 0,
      amount_paid: 0,
      customer_name: null,
    };
  }
}

const ASK_SYSTEM = `You are a small business's bookkeeping assistant.

You will be given a JSON snapshot of REAL, already-computed numbers for this business, including weekly/monthly sales, expenses, profit, top products, customer debts, inventory, and estimated cash on hand.

Answer using ONLY the numbers in the snapshot.

Never invent or estimate a number that isn't there.

If the snapshot doesn't contain what's needed to answer the question, say so plainly.

Keep answers short — 2-4 sentences.

Use plain language and no unnecessary jargon.

Currency symbol to use: `;

export async function answerQuestion(
  question,
  snapshot,
  currency = "K"
) {
  const prompt = `Snapshot:
${JSON.stringify(snapshot, null, 2)}

Question: ${question}`;

  return callGemini(
    ASK_SYSTEM + currency,
    prompt,
    400
  );
}
