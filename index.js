import express from "express"
import fetch from "node-fetch"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

const ODDS_API_KEY = process.env.ODDS_API_KEY || ""
const PORT = process.env.PORT || 3000

const CACHE_MS = 30000
const WINDOW_MS = 45000

const cache = {
  odds: null,
  oddsTs: 0,
  live: true,
  bookmaker: "draftkings",
  scores: null,
  scoresTs: 0,
  windowStart: 0,
  windowUsed: false
}

// in-memory line history for today
const history = new Map() // game_id -> [{ ts, y }]

app.use(express.static(path.join(__dirname, "public")))

function withinWindow() {
  const now = Date.now()
  if (!cache.windowStart || now - cache.windowStart > WINDOW_MS) {
    cache.windowStart = now
    cache.windowUsed = false
  }
  return { now, used: cache.windowUsed }
}

// ----------- ODDS (totals) -----------
app.get("/api/odds", async (req, res) => {
  try {
    const live = req.query.live === "false" ? false : true
    const bookmaker = req.query.bookmaker || "draftkings"
    const { now, used } = withinWindow()

    if (
      cache.odds &&
      now - cache.oddsTs < CACHE_MS &&
      cache.live === live &&
      cache.bookmaker === bookmaker
    ) {
      return res.json(cache.odds)
    }
    if (used && cache.odds) return res.json(cache.odds)

    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/odds")
    url.searchParams.set("regions", "us")
    url.searchParams.set("markets", "totals")
    url.searchParams.set("bookmakers", bookmaker)
    url.searchParams.set("oddsFormat", "american")
    url.searchParams.set("dateFormat", "iso")
    url.searchParams.set("apiKey", ODDS_API_KEY)

    const r = await fetch(url.toString())
    if (!r.ok) {
      const detail = await r.text()
      return res.status(422).json({ error: "Upstream error", status: 422, detail })
    }
    const data = await r.json()

    const rows = (data || []).map(g => {
      const bk = (g.bookmakers || []).find(b => b.key === bookmaker)
      const totals = bk?.markets?.find(m => m.key === "totals")
      const over = totals?.outcomes?.find(o => o.name === "Over")
      const under = totals?.outcomes?.find(o => o.name === "Under")
      const point = over?.point ?? under?.point ?? null
      return {
        id: g.id,
        sport_key: g.sport_key,
        commence_time: g.commence_time,
        home_team: g.home_team,
        away_team: g.away_team,
        bookmaker: bk?.title || bookmaker,
        bookmaker_last_update: bk?.last_update || null,
        total_point: typeof point === "number" ? point : null
      }
    })

    // append to in-memory history
    for (const g of rows) {
      if (typeof g.total_point === "number" && g.commence_time) {
        const ts = Date.now()
        if (!history.has(g.id)) history.set(g.id, [])
        const arr = history.get(g.id)
        arr.push({ ts, y: g.total_point })
        if (arr.length > 2000) arr.shift()
      }
    }

    cache.odds = rows
    cache.oddsTs = now
    cache.live = live
    cache.bookmaker = bookmaker
    cache.windowUsed = true

    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e).slice(0, 200) })
  }
})

// ----------- helpers for SCORES -----------
function extractTeamScores(g) {
  // Prefer explicit fields if present
  let away = Number.isFinite(Number(g.away_score)) ? Number(g.away_score) : null
  let home = Number.isFinite(Number(g.home_score)) ? Number(g.home_score) : null

  // Fallback: parse "58-52" style strings from scores[]
  if ((away == null || home == null) && Array.isArray(g.scores)) {
    for (let i = g.scores.length - 1; i >= 0; i--) {
      const s = g.scores[i]?.score
      if (typeof s === "string") {
        const m = s.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/)
        if (m) {
          // API lists as away-home in practice
          away = Number(m[1])
          home = Number(m[2])
          break
        }
      }
    }
  }
  return { away_score: away, home_score: home }
}

function parsePeriodClock(row) {
  let period = null
  let clock = null
  const t = String(row.time || "")
  const tl = t.toLowerCase()

  // Q1 08:23, Q2 01:05
  const m = /q\s*([1-9])\s+(\d{1,2}):(\d{2})/i.exec(t)
  if (m) {
    period = Number(m[1])
    clock = `${m[2]}:${m[3]}`
    return { period, clock }
  }

  // Halftime variants
  if (/half.?time/.test(tl)) {
    period = 3
    clock = "12:00"
    return { period, clock }
  }

  // Final
  if (/final/.test(tl)) {
    period = 4
    clock = "0:00"
    return { period, clock }
  }

  // End of Qx -> next period start approximation
  const endQ = /end\s+of\s+q(?:uarter)?\s*([1-4])/i.exec(t)
  if (endQ) {
    const q = Number(endQ[1])
    period = Math.min(q + 1, 4)
    clock = period === 3 ? "12:00" : "12:00"
    return { period, clock }
  }

  // Fallback: infer from how many quarters have scores
  if (Array.isArray(row.scores)) {
    const hasQuarterName = s => /1st|2nd|3rd|4th/i.test(s?.name || "")
    const qDone = row.scores.filter(s => hasQuarterName(s) && s.score != null).length
    if (row.completed) { period = 4; clock = "0:00" }
    else if (qDone > 0) { period = Math.min(qDone + 1, 4); clock = null }
  }

  return { period, clock }
}

// ----------- SCORES (live + upcoming only) -----------
app.get("/api/scores", async (req, res) => {
  try {
    const now = Date.now()
    if (cache.scores && now - cache.scoresTs < CACHE_MS) {
      return res.json(cache.scores)
    }

    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/scores")
    // no daysFrom here: live + upcoming
    url.searchParams.set("dateFormat", "iso")
    url.searchParams.set("apiKey", ODDS_API_KEY)

    const r = await fetch(url.toString())
    if (!r.ok) {
      const detail = await r.text()
      return res.status(422).json({ error: "Upstream error", status: 422, detail })
    }
    const data = await r.json()

    const out = (data || []).map(g => {
      const { away_score, home_score } = extractTeamScores(g)

      const commenceMs = g.commence_time ? new Date(g.commence_time).getTime() : null
      const nowMs = Date.now()
      const beforeTip = commenceMs != null && nowMs < commenceMs

      const { period, clock } = parsePeriodClock(g)

      return {
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        home_score: beforeTip ? null : home_score,
        away_score: beforeTip ? null : away_score,
        period: beforeTip ? null : period,
        clock: beforeTip ? null : clock,
        completed: !!g.completed
      }
    })

    cache.scores = out
    cache.scoresTs = now
    res.json(out)
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e).slice(0, 200) })
  }
})

// ----------- HISTORY (today only) -----------
app.get("/api/history", (req, res) => {
  const out = {}
  const today = new Date()
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate()
  const start = new Date(y, m, d).getTime()
  const end = start + 24 * 60 * 60 * 1000
  for (const [gameId, arr] of history.entries()) {
    const filtered = arr.filter(p => p.ts >= start && p.ts < end)
    if (filtered.length) out[gameId] = filtered
  }
  res.json(out)
})

app.get("/api/scores_debug", async (req, res) => {
  try {
    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/scores")
    url.searchParams.set("dateFormat", "iso")
    url.searchParams.set("apiKey", process.env.ODDS_API_KEY || "")

    const r = await fetch(url.toString())
    const text = await r.text()

    // Try to parse JSON. If it fails, return the raw text so we see errors.
    let data = null
    try { data = JSON.parse(text) } catch (_) {}

    if (!data || !Array.isArray(data)) {
      return res.json({ ok: false, note: "non-JSON or error", raw: text.slice(0, 2000) })
    }

    // Build a compact view so you can share it safely
    const sample = data.slice(0, 3).map(g => ({
      id: g.id,
      home_team: g.home_team,
      away_team: g.away_team,
      home_score: g.home_score,
      away_score: g.away_score,
      time: g.time,
      completed: g.completed,
      commence_time: g.commence_time,
      scores_sample: Array.isArray(g.scores) ? g.scores.slice(0, 4) : null
    }))

    res.json({
      ok: true,
      count: data.length,
      sample
    })
  } catch (e) {
    res.json({ ok: false, error: String(e).slice(0, 500) })
  }
})


app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`)
})
