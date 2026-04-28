# Document Intelligence Tool

Browser-based tool that turns any PDF into structured intelligence using the Anthropic Claude API. Upload a contract, invoice, policy or report (or try one of the bundled samples) and get a plain-English executive summary, the key fields extracted (parties, dates, amounts, obligations, clauses), a confidence rating, and a chat interface to ask follow-up questions about the document.

**Portfolio Project 2 of 5** — built by Cenred (Cj), April 2026.

## What it does

1. Drag-and-drop a PDF (up to 10MB).
2. Client-side text extraction with PDF.js — no server-side parsing.
3. Sends the document text to Claude via a Netlify serverless proxy.
4. Returns: document type, 5–7 sentence summary, parties, key dates, amounts, obligations, key clauses, confidence rating, and 4 suggested follow-up questions.
5. Conversational Q&A grounded strictly in the document content, with prompt caching on the document text.

## Stack

- **Frontend:** Vanilla JS + HTML + CSS, single file (`index.html`). No build step.
- **PDF parsing:** [PDF.js v4](https://mozilla.github.io/pdf.js/) via cdnjs (ES module + worker).
- **AI:** Anthropic Claude (`claude-sonnet-4-6`) — strict JSON output for analyze, conversational text for chat.
- **API proxy:** Netlify serverless function (`netlify/functions/chat.js`).
- **Static hosting:** Hostinger (planned: `docintel.bizguro.net`).

## Local development

```bash
# install Netlify CLI once
npm install -g netlify-cli

# run dev server with the function emulated
ANTHROPIC_API_KEY=sk-ant-... netlify dev
```

Open http://localhost:8888 and drop a PDF or click one of the three sample buttons.

## Deployment

1. Push to GitHub.
2. Connect the repo to Netlify (auto-deploy on push).
3. In Netlify site settings → Environment variables, set `ANTHROPIC_API_KEY`.
4. Update the production `API_ENDPOINT` in `index.html` to the deployed Netlify function URL.
5. Upload `index.html` and the `data/` folder to Hostinger if hosting the static page on a subdomain (e.g. `docintel.bizguro.net`).

## File structure

```
doc-intelligence/
  index.html                  ← entire frontend (HTML + CSS + JS)
  netlify.toml                ← Netlify config
  netlify/functions/chat.js   ← serverless API proxy (analyze + chat modes)
  data/sample-contract.pdf    ← fictional service agreement
  data/sample-invoice.pdf     ← fictional tax invoice
  data/sample-policy.pdf      ← fictional remote work policy
  package.json                ← Node version pin for the function
  README.md
  .gitignore
```

## Sample documents

Three text-based PDFs, each engineered to exercise different extraction surfaces:

- `sample-contract.pdf` — 2-page Professional Services Agreement between Northwind Consulting and Bizguro Holdings (parties, effective date, milestones, termination, IP, governing law).
- `sample-invoice.pdf` — 1-page tax invoice with line items, subtotal/GST/total, payment terms, due date.
- `sample-policy.pdf` — 2-page Remote Work Policy with eligibility, obligations, allowances, review cadence.

## Architecture notes

- The Anthropic API key never reaches the browser — it is read from `process.env.ANTHROPIC_API_KEY` inside the Netlify function.
- Document text is capped at 150,000 characters before being sent to Claude; longer documents are truncated server-side and the UI surfaces a "Document truncated" pill.
- The chat handler injects the document text as a `cache_control: ephemeral` block on the first turn, so subsequent questions reuse the cached document and pay only for the new question + reply.
- Claude is instructed to ground all chat answers strictly in the document text; missing answers are reported honestly rather than fabricated.

## Security

- API key stays server-side.
- CORS is `*` so the static page can be hosted on a different origin (e.g. Hostinger) and still call the Netlify function.
- File-type and 10MB size validation runs client-side before any network call.
