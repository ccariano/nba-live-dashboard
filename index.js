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

// ----------- helper to read scores[] by team name -----------
function extractTeamTotals(g) {
  let home = null
  let away = null
  if (Array.isArray(g.scores)) {
    const map = new Map()
    for (const s of g.scores) {
      const name = String(s?.name || "").toLowerCase()
      const val = Number(s?.score)
      if (Number.isFinite(val)) map.set(name, val)
    }
    const homeKey = String(g.home_team || "").toLowerCase()
    const awayKey = String(g.away_team || "").toLowerCase()
    if (map.has(homeKey)) home = map.get(homeKey)
    if (map.has(awayKey)) away = map.get(awayKey)
  }
  return { home_score: home, away_score: away }
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
      const { home_score, away_score } = extractTeamTotals(g)

      const commenceMs = g.commence_time ? new Date(g.commence_time).getTime() : null
      const beforeTip = commenceMs != null && Date.now() < commenceMs

      // API payload you have does not include period/clock. Leave null.
      // Projection in the UI will be n/a until we add a time source.

      return {
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        home_score: beforeTip ? null : home_score,
        away_score: beforeTip ? null : away_score,
        period: beforeTip ? null : null,
        clock: beforeTip ? null : null,
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

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`)
})
