/**
 * Minimal example: talk to a Qwen3 model from TypeScript through an
 * OpenAI-compatible API (POST /chat/completions).
 *
 * Run (Node >= 18, no dependency needed):
 *   export AI_API_URL=https://<server>/v1 AI_MODEL=<model> AI_API_KEY=<key>
 *   npx tsx examples/qwen-chat.ts
 *
 * Environment:
 *   AI_API_URL  API base URL, ending with /v1 (required)
 *   AI_MODEL    model name (required), e.g. qwen3:8b on Ollama
 *   AI_API_KEY  API key, sent as a Bearer token (if the server requires one)
 *
 * Works with any OpenAI-compatible server, e.g. a local Ollama:
 *   AI_API_URL=http://localhost:11434/v1 AI_MODEL=qwen3:8b
 */

const API_URL = process.env.AI_API_URL;
const API_KEY = process.env.AI_API_KEY;
const MODEL = process.env.AI_MODEL;
if (!API_URL || !MODEL) {
  console.error('Set AI_API_URL and AI_MODEL (and AI_API_KEY if needed)');
  process.exit(1);
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Send a conversation to the model and return its answer.
// With `schema`, the answer is valid JSON following this JSON schema.
async function chat(messages: Message[], schema?: object): Promise<string> {
  const response = await fetch(`${API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(schema
        ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } }
        : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    choices: { message: { content: string; reasoning_content?: string } }[];
  };
  // Qwen3 "thinks" before answering: the reasoning is returned separately in
  // `reasoning_content`, the answer itself in `content`.
  return data.choices[0].message.content.trim();
}

async function main() {
  // 1. Free text answer
  const answer = await chat([
    { role: 'system', content: 'You are a security analyst. Answer briefly.' },
    { role: 'user', content: 'What is an SSH brute-force attack?' },
  ]);
  console.log(answer);

  // 2. Structured answer, e.g. to turn the model's opinion into a decision
  const verdictSchema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['ban', 'watch', 'ignore'] },
      reason: { type: 'string' },
    },
    required: ['decision', 'reason'],
    additionalProperties: false,
  };

  const verdict = JSON.parse(
    await chat(
      [
        {
          role: 'system',
          content:
            'You are a security analyst. Given the alerts raised by a source IP, decide ' +
            'whether to ban it, watch it or ignore it, and explain why.',
        },
        {
          role: 'user',
          content:
            'Source IP 203.0.113.7, last hour: crowdsecurity/ssh-bf on 3 different servers, ' +
            'llng/http-sensitive-files on the SSO portal.',
        },
      ],
      verdictSchema
    )
  ) as { decision: 'ban' | 'watch' | 'ignore'; reason: string };

  console.log(verdict);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
