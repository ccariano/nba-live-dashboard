import express from "express"

const app = express()
const PORT = process.env.PORT || 3000
const ODDS_API_KEY = process.env.ODDS_API_KEY
if (!ODDS_API_KEY) {
  console.error("Missing ODDS_API_KEY secret")
  process.exit(1)
}

app.use(express.static("public"))

let cache = { odds: null, oddsTs: 0, scores: null, scoresTs: 0, live: true, bookmaker: "draftkings" }
const CACHE_MS = 60_000
// --- Game hour window control ---
function inGameWindow() {
  const now = new Date()
  const hourET = now.getUTCHours() - 4 // adjust for Eastern Time (UTC-4)
  // Game window: 7 PM to 11 PM ET
  return hourET >= 19 || hourET < 23
}


app.get("/api/odds", async (req, res) => {
  try {
    const live = true
    const bookmaker = req.query.bookmaker || "draftkings"

    // Outside game window. Do not hit upstream. Serve cache if available.
    if (!inGameWindow()) {
      console.log("Outside game window. Serving cached odds.")
      return res.json(cache.odds || [])
    }

    const now = Date.now()

    // Within window. Use cache if still fresh.
    if (cache.odds && now - cache.oddsTs < CACHE_MS && cache.live === live && cache.bookmaker === bookmaker) {
      return res.json(cache.odds)
    }

    const base = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds"
    const url = new URL(base)

    url.searchParams.set("regions", "us")
    url.searchParams.set("markets", "totals")
    url.searchParams.set("bookmakers", bookmaker)
    if (live) url.searchParams.set("live", "true")
    url.searchParams.set("apiKey", ODDS_API_KEY)

    const r = await fetch(url, { headers: { "accept": "application/json" } })
    const status = r.status
    const text = await r.text()
    if (status !== 200) {
      return res.status(status).json({ error: "Upstream error", status, detail: text.slice(0, 500) })
    }
    const raw = JSON.parse(text)

    const trimmed = raw.map(g => {
      const bm = (g.bookmakers || []).find(b => b.key === bookmaker)
      const mk = bm?.markets?.find(m => m.key === "totals")
      const over = mk?.outcomes?.find(o => o.name === "Over")
      const under = mk?.outcomes?.find(o => o.name === "Under")
      const total_point = over?.point ?? under?.point ?? null
      return {
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        commence_time: g.commence_time,
        bookmaker_last_update: bm?.last_update || null,
        total_point,
        over_price: over?.price ?? null,
        under_price: under?.price ?? null
      }
    })

    cache = { ...cache, odds: trimmed, oddsTs: now, live, bookmaker }
    res.json(trimmed)
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err).slice(0, 500) })
  }
})

function parsePeriodClock(status) {
  if (!status) return { period: null, clock: null }
  const m = status.match(/(\d+)(st|nd|rd|th) Quarter\s*-\s*(\d{1,2}:\d{2})/i)
  if (m) return { period: parseInt(m[1], 10), clock: m[3] }
  if (/Halftime/i.test(status)) return { period: 3, clock: "12:00" }
  if (/End of \d/i.test(status)) {
    const m2 = status.match(/End of\s*(\d+)/i)
    if (m2) return { period: parseInt(m2[1], 10) + 1, clock: "12:00" }
  }
  const ot = status.match(/(\d*)\s*OT\s*-\s*(\d{1,2}:\d{2})/i)
  if (ot) {
    const n = ot[1] ? parseInt(ot[1], 10) : 1
    return { period: 4 + n, clock: ot[2] }
  }
  return { period: null, clock: null }
}

app.get("/api/scores", async (req, res) => {
  try {
    const now = Date.now()
    if (cache.scores && now - cache.scoresTs < CACHE_MS) {
      return res.json(cache.scores)
    }
    const base = "https://api.the-odds-api.com/v4/sports/basketball_nba/scores"
    const url = new URL(base)
    url.searchParams.set("daysFrom", "0")
    url.searchParams.set("apiKey", ODDS_API_KEY)
    const r = await fetch(url, { headers: { "accept": "application/json" } })
    const status = r.status
    const text = await r.text()
    if (status !== 200) {
      return res.status(status).json({ error: "Upstream error", status, detail: text.slice(0, 500) })
    }
    const raw = JSON.parse(text)
    const mapped = raw.map(g => {
      const homeName = g.home_team || (g.teams && g.teams.home) || null
      const awayName = g.away_team || (g.teams && g.teams.away) || null
      let home_score = null, away_score = null
      if (Array.isArray(g.scores)) {
        for (const s of g.scores) {
          if (!s) continue
          if (s.name && homeName && s.name.toLowerCase().includes(homeName.toLowerCase())) home_score = Number(s.score)
          if (s.name && awayName && s.name.toLowerCase().includes(awayName.toLowerCase())) away_score = Number(s.score)
        }
      }
      if (home_score === null && typeof g.home_score !== "undefined") home_score = Number(g.home_score)
      if (away_score === null && typeof g.away_score !== "undefined") away_score = Number(g.away_score)
      const statusStr = g.time || g.status || ""
      const pc = parsePeriodClock(statusStr)
      return {
        id: g.id || g.event_id || null,
        commence_time: g.commence_time || g.commenceTime || null,
        completed: !!g.completed,
        status: statusStr || null,
        home_team: homeName,
        away_team: awayName,
        home_score,
        away_score,
        period: pc.period,
        clock: pc.clock
      }
    })
    cache = { ...cache, scores: mapped, scoresTs: now }
    res.json(mapped)
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err).slice(0, 500) })
  }
})

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
