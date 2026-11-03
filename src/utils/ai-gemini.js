// Adaptador de Gemini por su capa compatible con OpenAI (fetch directo: groq-sdk cambia la ruta y no sirve).
// Diferencias con Groq que cubre: la capa rechaza frequency/presence_penalty, 'none' no vale en Flash Lite,
// Gemma no admite reasoning_effort y devuelve su razonamiento dentro de <thought>…</thought>.

const GEMINI_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const REASONING_HEADROOM = 64;   // el razonamiento 'low' se come parte de max_tokens
const GEMMA_HEADROOM = 700;      // Gemma razona ~700 tokens sí o sí
const COPIED = ['temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'response_format'];
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

const isGemma = model => /^gemma/i.test(model || '');

// Los campos propios de Groq (reasoning, executed_tools) no los acepta Gemini; un assistant sin texto lleva ''
function cleanMessages(messages) {
  return (messages || []).map(m => {
    const c = { ...m };
    delete c.reasoning; delete c.executed_tools;
    if (c.role === 'assistant' && c.content == null) c.content = '';
    return c;
  });
}

function buildBody(params, model) {
  const body = { model, messages: cleanMessages(params.messages) };
  if (params.max_tokens) body.max_tokens = params.max_tokens + (isGemma(model) ? GEMMA_HEADROOM : REASONING_HEADROOM);
  for (const k of COPIED) if (params[k] != null) body[k] = params[k];
  if (!isGemma(model)) body.reasoning_effort = EFFORTS.has(params.reasoning_effort) ? params.reasoning_effort : 'low';
  return body;
}

function stripThought(result) {
  for (const c of result?.choices || []) {
    if (typeof c?.message?.content === 'string' && /<\/?thought>/i.test(c.message.content)) {
      c.message.content = c.message.content.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/^[\s\S]*<\/thought>/i, '').trim();
    }
  }
  return result;
}

function httpError(status, body, retryAfter) {
  const msg = (Array.isArray(body) ? body[0]?.error?.message : body?.error?.message) || (typeof body === 'string' ? body : '') || `HTTP ${status}`;
  return Object.assign(new Error(`Gemini ${status}: ${String(msg).slice(0, 300)}`), { status, headers: { 'retry-after': retryAfter || '' } });
}

async function create(body, { timeoutMs = 15000, apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(GEMINI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw Object.assign(new Error(`Gemini: timeout a los ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
    throw err;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* cuerpo no JSON */ }
  if (!res.ok) throw httpError(res.status, json ?? text, res.headers.get('retry-after'));
  if (!json) throw Object.assign(new Error('Gemini: respuesta no JSON'), { status: 502 });
  return stripThought(json);
}

module.exports = { buildBody, cleanMessages, stripThought, create, isGemma, httpError, GEMINI_URL };
