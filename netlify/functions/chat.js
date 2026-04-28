// ============================================================
// Document Intelligence Tool — Netlify Function (API proxy)
// Proxies requests to the Anthropic Claude API and keeps the
// API key off the client. Two modes: 'analyze' and 'chat'.
// ============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_DOC_CHARS = 150000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ============================================================
// System prompts
// ============================================================

const ANALYZE_SYSTEM_PROMPT = `You are a senior document analyst. You read business, legal, financial, HR and policy documents and produce a precise, structured briefing.

You MUST respond with a single valid JSON object — no prose, no markdown fences, no commentary. The schema:

{
  "documentType": "Concise label, e.g. 'Service Agreement', 'Tax Invoice', 'Remote Work Policy', 'Annual Report'",
  "summary": "5 to 7 plain-English sentences. Lead with what the document is and what it does. Reference specific parties, dates and amounts where they exist. No legal jargon. No bullet points.",
  "parties": ["Each party, signatory, company or counterparty named in the document"],
  "keyDates": [
    { "label": "Effective date | Due date | Termination notice | etc.", "date": "Exact date string as it appears" }
  ],
  "amounts": [
    { "label": "Total fee | Invoice total | GST | Late fee | etc.", "value": "Amount with currency, e.g. 'AUD 84,000'" }
  ],
  "obligations": ["Each material obligation or responsibility, one sentence each"],
  "clauses": [
    { "name": "Clause name", "summary": "One-sentence summary of what the clause does" }
  ],
  "confidence": "high" | "medium" | "low",
  "suggestions": ["4 follow-up questions a real user would ask about THIS document"]
}

EXTRACTION RULES:
- Only extract facts present in the document. Never invent parties, dates, or amounts.
- If a category genuinely doesn't apply (e.g. an invoice has no obligations / a policy has no amounts), return an empty array — do not pad with filler.
- Keep every list item short and self-contained — a reader scanning a card should understand each entry without context.
- For amounts, preserve the currency exactly as it appears. Do not convert.
- For dates, preserve the date format the document uses.

CONFIDENCE RULES:
- "high": clear text, well-structured document, all major fields populated.
- "medium": some fields ambiguous or thin; document type is clear but extraction is partial.
- "low": text is sparse, garbled, or appears to be a scanned image with little extractable content. If confidence is "low", say so explicitly in the first sentence of the summary.

SUGGESTIONS RULES:
- Document-specific. Reference real entities, dates, or amounts from THIS document.
- Each under 14 words. Phrased as a question a user would actually type.

Return ONLY the JSON object. No code fences. No commentary before or after.`;

const CHAT_SYSTEM_PROMPT = `You are a senior document analyst answering follow-up questions about a specific document the user has uploaded. The full document text is provided as context.

Rules:
- Answer ONLY from information present in the document. If the document does not address the question, say so directly — do not guess.
- 2-4 sentences in plain English unless the question genuinely demands more.
- Quote exact figures, dates and party names from the document where relevant.
- Do not invent clauses, parties, dates, or amounts that are not in the text.
- No markdown headers. Conversational tone. Use bullet points only when the answer is genuinely a list.`;

// ============================================================
// Handler
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'Server misconfigured: ANTHROPIC_API_KEY is not set.');
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonError(400, 'Invalid JSON in request body.');
  }

  const { mode, documentText, fileName, history } = payload;
  if (!mode) return jsonError(400, 'Missing required field: mode.');
  if (!documentText || typeof documentText !== 'string') {
    return jsonError(400, 'Missing required field: documentText.');
  }

  const { text, truncated } = capDocument(documentText);

  try {
    if (mode === 'analyze') {
      return await runAnalyze(apiKey, text, fileName, truncated);
    }
    if (mode === 'chat') {
      if (!Array.isArray(history) || history.length === 0) {
        return jsonError(400, 'Chat mode requires a non-empty history array.');
      }
      return await runChat(apiKey, text, truncated, history);
    }
    return jsonError(400, `Unknown mode: ${mode}`);
  } catch (err) {
    console.error('Handler error:', err);
    return jsonError(500, err.message || 'Unexpected server error.');
  }
};

// ============================================================
// Mode: analyze
// ============================================================

async function runAnalyze(apiKey, text, fileName, truncated) {
  const userMessage = buildDocumentContextMessage(text, fileName, truncated) +
    '\n\nProduce the structured briefing now. Return ONLY the JSON object described in your instructions.';

  const response = await callClaude(apiKey, {
    system: ANALYZE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 3000,
    temperature: 0.2,
  });

  const out = extractText(response);
  const parsed = parseJsonOutput(out);

  if (!parsed) {
    return jsonError(502, 'The AI returned an unexpected format. Please try again.');
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      documentType: parsed.documentType || 'Unknown document type',
      summary: parsed.summary || '',
      parties: arr(parsed.parties),
      keyDates: arr(parsed.keyDates),
      amounts: arr(parsed.amounts),
      obligations: arr(parsed.obligations),
      clauses: arr(parsed.clauses),
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      suggestions: arr(parsed.suggestions),
      truncated,
    }),
  };
}

// ============================================================
// Mode: chat — document text injected as cached prefix on turn 1
// ============================================================

async function runChat(apiKey, text, truncated, history) {
  const docContext = buildDocumentContextMessage(text, null, truncated);

  const messages = history.map((m, i) => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (i === 0 && role === 'user') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: docContext,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `\n\nQuestion: ${m.content}`,
          },
        ],
      };
    }
    return { role, content: m.content };
  });

  const response = await callClaude(apiKey, {
    system: CHAT_SYSTEM_PROMPT,
    messages,
    max_tokens: 1024,
    temperature: 0.3,
  });

  const reply = extractText(response).trim();

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ reply }),
  };
}

// ============================================================
// Helpers
// ============================================================

function capDocument(text) {
  if (text.length <= MAX_DOC_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_DOC_CHARS) + '\n\n[Document truncated at 150,000 characters due to length]',
    truncated: true,
  };
}

function buildDocumentContextMessage(text, fileName, truncated) {
  const header = [
    'DOCUMENT CONTEXT',
    fileName ? `File name: ${fileName}` : null,
    `Length: ${text.length.toLocaleString()} characters`,
    truncated ? 'Note: the document was truncated to fit the context window.' : null,
  ].filter(Boolean).join('\n');

  return `${header}\n\nDocument text:\n"""\n${text}\n"""`;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

async function callClaude(apiKey, body) {
  const requestBody = { model: MODEL, ...body };
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    let parsedErr;
    try { parsedErr = JSON.parse(errText); } catch (e) {}
    const message = parsedErr?.error?.message || errText || `Anthropic API error ${res.status}`;
    throw new Error(`Claude API: ${message}`);
  }

  return res.json();
}

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function parseJsonOutput(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonSlice);
  } catch (e) {
    console.error('JSON parse failed:', e.message, '\nText was:', cleaned.slice(0, 500));
    return null;
  }
}

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify({ error: message }),
  };
}
