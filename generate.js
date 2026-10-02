// TweetGen API for Vercel. GET = free uses left, POST = generate tweets.
// TweetGen core: the agent (Groq + optional Tavily research) + free-quota logic. Shared by Vercel (api/) and Railway (server.js).

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const FREE_PER_USER = Number(process.env.FREE_GENERATIONS || 2);     // free generations per visitor
const QUOTA_DAYS = Number(process.env.QUOTA_RESET_DAYS || 30);        // when a visitor's free uses reset
const DAILY_CAP = Number(process.env.DAILY_SITE_CAP || 200);          // max generations per day for the whole site

// ---------- Storage: Upstash Redis if configured (needed on Vercel), else memory (fine on Railway) ----------
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = new Map();

async function redis(cmd) {
  const r = await fetch(UP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  return j.result;
}
async function getCount(key) {
  if (UP_URL) return Number(await redis(["GET", key])) || 0;
  const e = mem.get(key); if (!e || e.exp < Date.now()) return 0; return e.n;
}
async function addCount(key, ttlSec) {
  if (UP_URL) {
    const n = await redis(["INCR", key]);
    if (n === 1) await redis(["EXPIRE", key, String(ttlSec)]);
    return n;
  }
  const e = mem.get(key);
  if (!e || e.exp < Date.now()) { mem.set(key, { n: 1, exp: Date.now() + ttlSec * 1000 }); return 1; }
  e.n++; return e.n;
}

const today = () => new Date().toISOString().slice(0, 10);
const userKey = id => `tg:user:${id}`;
const siteKey = () => `tg:site:${today()}`;

function visitorId(headers) {
  const ip = String(headers["x-forwarded-for"] || headers["x-real-ip"] || "").split(",")[0].trim() || "unknown";
  return ip;
}

async function quota(headers) {
  const used = await getCount(userKey(visitorId(headers)));
  return { free: FREE_PER_USER, used: Math.min(used, FREE_PER_USER), left: Math.max(0, FREE_PER_USER - used), research: !!process.env.TAVILY_API_KEY };
}

// ---------- The agent ----------
const clip = (v, n) => String(v || "").trim().slice(0, n);

function buildPrompt(b) {
  return `You are TweetGen, an expert X (Twitter) copywriter agent.

Write 3 distinct, ready-to-post tweet drafts for this brief.

Brief
Topic: ${b.topic}
Genre: ${b.genre}
Tone: ${b.tone}
Audience: ${b.audience || "general audience"}
Hashtags per tweet: exactly ${b.hashtags}
Include a source link: ${b.includeUrl ? "yes, one real URL from the research results below (skip the link if there are none)" : "no"}
Call to action: ${b.cta || "none"}
Voice samples to imitate: ${b.voice ? "\n" + b.voice : "none provided"}

Rules
1. If research results are provided below, build the tweets on those facts and never invent numbers, quotes or events. If none are provided, do not state specific recent numbers or events you cannot be sure of; write evergreen angles instead.
2. Every draft is 280 characters or fewer, counting hashtags and the link (a link counts as 23 characters on X).
3. Match the tone and genre exactly. If voice samples are given, mirror their sentence length, vocabulary, punctuation and emoji use.
4. Hashtags must be specific to the topic, never generic like #News or #Tips.
5. Make the 3 drafts genuinely different: different hook and angle each, not rewordings.
6. Never use em dashes.

Your final message must be only this JSON, nothing else:
{"drafts":[{"angle":"2 to 4 word label for the hook","text":"the tweet"}]}`;
}

// Live research: Tavily search (optional, free plan at tavily.com)
async function research(topic) {
  if (!process.env.TAVILY_API_KEY) return [];
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: topic, max_results: 5, search_depth: "basic" })
    });
    if (!r.ok) { console.error("Tavily error", r.status, await r.text()); return []; }
    const j = await r.json();
    return (j.results || []).map(x => ({ title: x.title, url: x.url, date: x.published_date || "", content: String(x.content || "").slice(0, 600) }));
  } catch (e) { console.error("Tavily failed", e); return []; }
}

async function runAgent(b, apiKey) {
  const found = b.research ? await research(b.topic) : [];
  let prompt = buildPrompt({ ...b, research: false });
  if (found.length) {
    prompt += "\n\nFresh research results (use these facts, cite only these URLs):\n" +
      found.map((x, i) => `[${i + 1}] ${x.title} (${x.url})${x.date ? " " + x.date : ""}\n${x.content}`).join("\n\n");
  }
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.8,
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: "You are TweetGen, an expert X (Twitter) copywriter. You always reply with valid JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("Groq error", r.status, JSON.stringify(data));
    const msg = r.status === 401 ? "That Groq API key was rejected. Check it and try again."
      : r.status === 429 ? "TweetGen is busy right now. Wait a minute and try again."
      : "The AI service had a problem. Try again in a minute.";
    const e = new Error(msg); e.status = r.status === 401 ? 401 : r.status === 429 ? 429 : 502; throw e;
  }
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  const m = text.match(/\{[\s\S]*\}/);
  let parsed = {}; try { parsed = m ? JSON.parse(m[0]) : {}; } catch (e) {}
  const drafts = (parsed.drafts || [])
    .map(d => ({ angle: clip(d.angle, 40), text: clip(d.text, 600).replace(/\s*\u2014\s*/g, ", ") }))
    .filter(d => d.text).slice(0, 3);
  if (!drafts.length) { const e = new Error("The agent's reply came back in the wrong shape. Generate again."); e.status = 502; throw e; }
  return { drafts, sources: found.map(({ title, url, date }) => ({ title, url, date })) };
}

// ---------- Request handler (framework-agnostic) ----------
async function handleGenerate(body, headers) {
  const tones = ["Viral", "Witty", "Professional", "Emotional", "Casual"];
  const b = {
    topic: clip(body.topic, 200), genre: clip(body.genre, 30) || "Insight",
    tone: tones.includes(body.tone) ? body.tone : "Professional",
    audience: clip(body.audience, 120), cta: clip(body.cta, 120), voice: clip(body.voice, 1500),
    hashtags: Math.max(0, Math.min(5, Number(body.hashtags) || 0)),
    includeUrl: !!body.includeUrl, research: body.research !== false
  };
  if (!b.topic) return [400, { error: "Add a topic first." }];

  // Visitors who bring their own key are not limited and do not spend yours
  const ownKey = clip(body.apiKey, 200);
  if (ownKey) {
    if (!ownKey.startsWith("gsk_")) return [400, { error: "That doesn't look like a Groq API key (it starts with gsk_)." }];
    try { return [200, { ...(await runAgent(b, ownKey)), ownKey: true }]; }
    catch (e) { return [e.status || 500, { error: e.message }]; }
  }

  if (!process.env.GROQ_API_KEY) return [500, { error: "The site is missing its API key." }];
  const id = visitorId(headers);
  const used = await getCount(userKey(id));
  if (used >= FREE_PER_USER) return [402, { error: "limit", quota: { free: FREE_PER_USER, used: FREE_PER_USER, left: 0 } }];
  if ((await getCount(siteKey())) >= DAILY_CAP) return [503, { error: "TweetGen has hit today's free limit for everyone. Come back tomorrow, or use your own API key." }];

  try {
    const out = await runAgent(b, process.env.GROQ_API_KEY);
    const n = await addCount(userKey(id), QUOTA_DAYS * 86400); // only successful runs count
    await addCount(siteKey(), 2 * 86400);
    return [200, { ...out, quota: { free: FREE_PER_USER, used: Math.min(n, FREE_PER_USER), left: Math.max(0, FREE_PER_USER - n) } }];
  } catch (e) {
    return [e.status || 500, { error: e.message || "Something went wrong while generating. Try again." }];
  }
}



module.exports = async (req, res) => {
  try {
    if (req.method === "GET") return res.status(200).json(await quota(req.headers));
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const [status, data] = await handleGenerate(body, req.headers);
    res.status(status).json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
};
