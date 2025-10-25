import express from "express"
import fetch from "node-fetch"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// config
const ODDS_API_KEY = process.env.ODDS_API_KEY || ""
const PORT = process.env.PORT || 3000

// cache + request window
const CACHE_MS = 30_000
const WINDOW_MS = 45_000

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

app.use(express.static(path.join(__dirname, "public")))

// odds helper
function withinWindow() {
  const now = Date.now()
  if (!cache.windowStart || now - cache.windowStart > WINDOW_MS) {
    cache.windowStart = now
    cache.windowUsed = false
  }
  return { now, used: cache.windowUsed }
}

app.get("/api/odds", async (req, res) => {
  try {
    const live = req.query.live === "false" ? false : true
    const bookmaker = req.query.bookmaker || "draftkings"
    const { now, used } = withinWindow()

    // serve cache while inside window
    if (
      cache.odds &&
      now - cache.oddsTs < CACHE_MS &&
      cache.live === live &&
      cache.bookmaker === bookmaker
    ) {
      return res.json(cache.odds)
    }

    // hit API once per window
    if (used && cache.odds) {
      return res.json(cache.odds)
    }

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

    // normalize to rows
    const rows = (data || []).map(g => {
      const dk = (g.bookmakers || []).find(b => b.key === bookmaker)
      const totals = dk?.markets?.find(m => m.key === "totals")
      const over = totals?.outcomes?.find(o => o.name === "Over")
      const under = totals?.outcomes?.find(o => o.name === "Under")
      const point = over?.point ?? under?.point ?? null
      return {
        id: g.id,
        sport_key: g.sport_key,
        commence_time: g.commence_time,
        home_team: g.home_team,
        away_team: g.away_team,
        bookmaker: dk?.title || bookmaker,
        bookmaker_last_update: dk?.last_update || null,
        total_point: typeof point === "number" ? point : null
      }
    })

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

// scores route with robust period/clock parsing
app.get("/api/scores", async (req, res) => {
  try {
    const now = Date.now()
    if (cache.scores && now - cache.scoresTs < CACHE_MS) {
      return res.json(cache.scores)
    }

    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/scores")
    url.searchParams.set("daysFrom", "0")
    url.searchParams.set("apiKey", ODDS_API_KEY)

    const r = await fetch(url.toString())
    if (!r.ok) {
      const detail = await r.text()
      return res.status(422).json({ error: "Upstream error", status: 422, detail })
    }
    const data = await r.json()

    function parsePeriodClock(row) {
      let period = null
      let clock = null

      if (row.time && typeof row.time === "string") {
        const m = /Q([1-9])\s+(\d{1,2}):(\d{2})/i.exec(row.time)
        if (m) {
          period = Number(m[1])
          clock = `${m[2]}:${m[3]}`
        } else if (/halftime/i.test(row.time)) {
          period = 3
          clock = "12:00"
        } else if (/final/i.test(row.time)) {
          period = 4
          clock = "0:00"
        }
      }

      if (!period && Array.isArray(row.scores)) {
        const qNames = new Set(["1st Quarter", "2nd Quarter", "3rd Quarter", "4th Quarter"])
        const qDone = row.scores.filter(s => qNames.has(s.name) && s.score != null).length
        if (row.completed) {
          period = 4
          clock = "0:00"
        } else {
          period = Math.min(qDone + 1, 4) || null
          clock = null
        }
      }

      return { period, clock }
    }

    const out = (data || []).map(g => {
      const homeTotal = Number(g.home_score ?? 0)
      const awayTotal = Number(g.away_score ?? 0)
      let home_score = Number.isFinite(homeTotal) && homeTotal > 0 ? homeTotal : null
      let away_score = Number.isFinite(awayTotal) && awayTotal > 0 ? awayTotal : null

      if ((home_score == null || away_score == null) && Array.isArray(g.scores)) {
        // leave null until API fills; client shows n/a
      }

      const { period, clock } = parsePeriodClock(g)

      return {
        id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        home_score,
        away_score,
        period,
        clock,
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

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`)
})
