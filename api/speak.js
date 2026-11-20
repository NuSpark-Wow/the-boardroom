// The Boardroom voices — ElevenLabs text-to-speech with word timing (for the read-along caption)
// Env: ELEVENLABS_API_KEY (required for real voices; without it the page uses the browser voice)
// Optional voice swaps in Vercel: VOICE_CEO_M, VOICE_CEO_F, VOICE_CFO_M, VOICE_CFO_F, VOICE_COO_M, VOICE_COO_F,
//   VOICE_GROWTH_M, VOICE_GROWTH_F, VOICE_EXIT_M, VOICE_EXIT_F, VOICE_PFA_M, VOICE_PFA_F, VOICE_CHAIR, ELEVENLABS_MODEL
// Only the executives' own words are sent here. No visitor audio ever reaches this server.

const env = k => process.env[k];
const VOICES = {
  "ceo-m": env("VOICE_CEO_M") || "nPczCjzI2devNBz1zQrb",       // Brian - deep, resonant
  "ceo-f": env("VOICE_CEO_F") || "h2OBoQqre8SPfGehinER",       // Melanie - confident, trustworthy
  "cfo-m": env("VOICE_CFO_M") || "fIoDqeVKE9jI9AGvEvZU",       // CJ - articulate, precise
  "cfo-f": env("VOICE_CFO_F") || "bmAn0TLASQN7ctGBMHgN",       // Bennett - clear, warm, reliable
  "coo-m": env("VOICE_COO_M") || "iP95p4xoKVk53GoZ742B",       // Chris - down-to-earth
  "coo-f": env("VOICE_COO_F") || "5MxhuJFpo9hpzbxa88y6",       // Megan - crisp, clean
  "growth-m": env("VOICE_GROWTH_M") || "bPMKpgEe88vKSwusXTMU", // Bryan - charismatic
  "growth-f": env("VOICE_GROWTH_F") || "hpp4J3VqNfWAUOO0d1Us", // Bella - bright, warm
  "exit-m": env("VOICE_EXIT_M") || "pqHfZKP75CvOlQylNhV4",     // Bill - wise, mature
  "exit-f": env("VOICE_EXIT_F") || "rCuVrCHOUMY3OwyJBJym",     // Maryanne - clear, smooth
  "pfa-m": env("VOICE_PFA_M") || "HKFOb9iktHA85uKXydRT",       // Russ - deep, calm authority
  "pfa-f": env("VOICE_PFA_F") || "Nhs7eitvQWFTQBsf0yiT",       // Sarah - approachable
  "chair": env("VOICE_CHAIR") || "x8EpqJ1pKzP4vo35tTCm"        // David - clear, friendly (Mr. Paul, the Chair)
};
// Each personality gets its own delivery: lower stability = more expressive.
const STYLE = {
  steady:     { stability: 0.62, style: 0.15, speed: 0.96 },
  bold:       { stability: 0.35, style: 0.6,  speed: 1.06 },
  numbers:    { stability: 0.55, style: 0.25, speed: 1.02 },
  bigpicture: { stability: 0.48, style: 0.45, speed: 0.98 },
  chair:      { stability: 0.5,  style: 0.35, speed: 1.0 }
};
const cache = new Map();

module.exports = async (req, res) => {
  if (!(await require("./_lwgate")(req, res, "the-boardroom"))) return;
  if (!allowedRequest(req)) return blockRequest(res);
  const key = process.env.ELEVENLABS_API_KEY;
  if (req.method === "GET") {
    const out = { api_key_set: !!key, voices: VOICES };
    if (key) {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES.chair}?output_format=mp3_22050_32`, {
          method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ text: "Hi.", model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" })
        });
        out.voice = r.ok ? "working" : `error ${r.status}: ${(await r.text()).slice(0, 200)}`;
      } catch (e) { out.voice = "error: " + e.message; }
    }
    return res.json(out);
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!key) return res.status(501).json({ error: "voice_off" });
  const b = req.body || {};
  const voice = VOICES[b.voice] ? b.voice : "chair";
  const persona = voice === "chair" ? "chair" : (STYLE[b.persona] ? b.persona : "steady");
  const text = String(b.text || "").trim().slice(0, 1500);
  if (!text) return res.status(400).json({ error: "empty" });
  const st = STYLE[persona];
  const ck = voice + "|" + persona + "|" + text;
  if (cache.has(ck)) return res.json(cache.get(ck));
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICES[voice]}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text: speakable(text).out,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        voice_settings: { stability: st.stability, similarity_boost: 0.8, style: st.style, speed: st.speed, use_speaker_boost: true }
      })
    });
    if (!r.ok) return res.status(502).json({ error: "voice_failed" });
    const d = await r.json();
    const out = { audio: d.audio_base64, alignment: remapAlign(d.alignment || d.normalized_alignment || null, text) };
    if (cache.size > 150) cache.clear();
    cache.set(ck, out);
    return res.json(out);
  } catch (e) {
    return res.status(502).json({ error: "voice_failed" });
  }
};

// ---------- read symbols out loud ----------
// "$40" stays as is (the voice reads it right); "x" between numbers -> "times", "÷" -> "divided by", "%" stays.
// The read-along timing is mapped back to the original letters, so the word highlighting on screen still lines up.
const SAY_SYMBOL = { "x": "times", "×": "times", "÷": "divided by", "²": "squared", "√": "the square root of", "−": "minus" };
function speakable(text) {
  const re = /(\d[\d.,]*(?:\s?(?:%|units|days))?|\))(\s*)(x)(\s*)(?=\d|\()|([×÷²√−])/g;
  let out = "", last = 0, m;
  const map = new Array(text.length);
  while ((m = re.exec(text))) {
    const xPos = m[5] ? m.index : m.index + m[1].length + m[2].length;
    for (let i = last; i < xPos; i++) { map[i] = out.length; out += text[i]; }
    const prev = xPos > 0 ? text[xPos - 1] : "", next = xPos + 1 < text.length ? text[xPos + 1] : "";
    const padL = (!prev || /[\s(]/.test(prev)) ? "" : " ";
    const padR = (!next || /[\s.,;:!?)]/.test(next)) ? "" : " ";
    map[xPos] = out.length + padL.length;
    out += padL + SAY_SYMBOL[text[xPos]] + padR;
    last = xPos + 1;
    re.lastIndex = last;
  }
  for (let i = last; i < text.length; i++) { map[i] = out.length; out += text[i]; }
  return { out, map };
}
function remapAlign(al, text) {
  const { out, map } = speakable(text);
  if (!al || out === text || !Array.isArray(al.character_start_times_seconds) || al.character_start_times_seconds.length !== out.length) return al;
  const s = al.character_start_times_seconds, e = al.character_end_times_seconds || s;
  return { characters: text.split(""), character_start_times_seconds: map.map(j => s[j]), character_end_times_seconds: map.map(j => e[j]) };
}

// ---------- website lock ----------
function allowedRequest(req) {
  if (String(process.env.LOCK_OFF || "") === "1") return true;
  const sites = ["nusparkpublishing.com", "nusparkmarketing.com", "nusparklearnwow.com"]
    .concat(String(process.env.ALLOWED_SITES || "").split(",").map(s => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean));
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase().split(":")[0];
  const ok = u => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return h === host || h === "localhost" || h === "127.0.0.1" || sites.some(d => h === d || h.endsWith("." + d));
    } catch (e) { return false; }
  };
  const origin = req.headers.origin, ref = req.headers.referer || req.headers.referrer;
  if (origin && origin !== "null") return ok(origin);
  if (ref) return ok(ref);
  return req.method === "GET";
}
function blockRequest(res) {
  res.statusCode = 403;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "not_allowed", message: "This tool only works on NuSpark websites." }));
}
