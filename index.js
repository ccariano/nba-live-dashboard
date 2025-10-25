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

  espn: null,
  espnTs: 0,

  windowStart: 0,
  windowUsed: false
}

const history = new Map()

app.use(express.static(path.join(__dirname, "public")))

function withinWindow() {
  const now = Date.now()
  if (!cache.windowStart || now - cache.windowStart > WINDOW_MS) {
    cache.windowStart = now
    cache.windowUsed = false
  }
  return { now, used: cache.windowUsed }
}

function normTeam(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim()
}

function extractTeamTotals(g) {
  let home = null
  let away = null
  if (Array.isArray(g.scores)) {
    const map = new Map()
    for (const s of g.scores) {
      const name = normTeam(s?.name)
      const val = Number(s?.score)
      if (Number.isFinite(val)) map.set(name, val)
    }
    const homeKey = normTeam(g.home_team)
    const awayKey = normTeam(g.away_team)
    if (map.has(homeKey)) home = map.get(homeKey)
    if (map.has(awayKey)) away = map.get(awayKey)
  }
  return { home_score: home, away_score: away }
}

// ESPN helper that tries multiple URLs
async function getEspnClockMap() {
  const now = Date.now()
  if (cache.espn && now - cache.espnTs < CACHE_MS) return cache.espn

  const url = "https://site.web.api.espn.com/apis/v2/sports/basketball/nba/scoreboard"
  let json
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`ESPN status ${r.status}`)
    json = await r.json()
  } catch (err) {
    console.error("ESPN fetch failed", err)
    cache.espn = new Map()
    cache.espnTs = now
    return cache.espn
  }

  const out = new Map()
  const events = Array.isArray(json?.events) ? json.events : []
  for (const ev of events) {
    const comp = ev?.competitions?.[0]
    const homeObj = comp?.competitors?.find(c => c.homeAway === "home")
    const awayObj = comp?.competitors?.find(c => c.homeAway === "away")

    const home = normTeam(homeObj?.team?.shortDisplayName || homeObj?.team?.displayName)
    const away = normTeam(awayObj?.team?.shortDisplayName || awayObj?.team?.displayName)

    const status = comp?.status || {}
    const period = Number(status?.period) || null
    const clock = String(status?.displayClock || "").trim() || null
    const state = (status?.type?.state || "").toLowerCase()

    if (!home || !away) continue

    let per = period
    let clk = clock
    if (/half/i.test(clock)) { per = 3; clk = "12:00" }
    if (/final/i.test(clock) || state === "post") { per = 4; clk = "0:00" }

    const valid = ["in", "post"].includes(state) || per != null
    if (valid) out.set(`${away}__${home}`, { period: per, clock: clk })
  }

  cache.espn = out
  cache.espnTs = now
  return out
}

  if (!json || !Array.isArray(json.events)) throw new Error(lastErr || "ESPN unknown")

  const out = new Map()
  const events = json.events
  for (const ev of events) {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null
    if (!comp) continue
    const comps = Array.isArray(comp.competitors) ? comp.competitors : []
    const homeObj = comps.find(c => c.homeAway === "home")
    const awayObj = comps.find(c => c.homeAway === "away")
    const homeName = normTeam(homeObj?.team?.name || homeObj?.team?.displayName)
    const awayName = normTeam(awayObj?.team?.name || awayObj?.team?.displayName)

    const status = comp.status || ev.status || {}
    const periodNum = Number(status.period)
    const clockStr = String(status.displayClock || "")
    const state = String(status.type?.state || "").toLowerCase()

    let per = Number.isFinite(periodNum) ? periodNum : null
    let clk = clockStr || null

    if (/half/i.test(clockStr)) { per = 3; clk = "12:00" }
    if (/final/i.test(clockStr) || state === "post") { per = 4; clk = "0:00" }

    if (!homeName || !awayName) continue

    // Only keep if in progress, halftime, or finished
    const valid = state === "in" || state === "post" || per != null
    if (!valid) continue

    out.set(`${awayName}__${homeName}`, { period: per, clock: clk })
  }

  cache.espn = out
  cache.espnTs = now

// ODDS
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

// SCORES
app.get("/api/scores", async (req, res) => {
  try {
    const now = Date.now()
    if (cache.scores && now - cache.scoresTs < CACHE_MS) {
      return res.json(cache.scores)
    }

    const url = new URL("https://api.the-odds-api.com/v4/sports/basketball_nba/scores")
    url.searchParams.set("dateFormat", "iso")
    url.searchParams.set("apiKey", ODDS_API_KEY)
    const r = await fetch(url.toString())
    if (!r.ok) {
      const detail = await r.text()
      return res.status(422).json({ error: "Upstream error", status: 422, detail })
    }
    const data = await r.json()

    const espnMap = await getEspnClockMap()

    const out = (data || []).map(g => {
      const { home_score, away_score } = extractTeamTotals(g)
      const commenceMs = g.commence_time ? new Date(g.commence_time).getTime() : null
      const beforeTip = commenceMs != null && Date.now() < commenceMs

      let period = null
      let clock = null
      const key = `${normTeam(g.away_team)}__${normTeam(g.home_team)}`
      if (espnMap.has(key)) {
        const e = espnMap.get(key)
        period = e.period ?? null
        clock = e.clock ?? null
      }

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

// HISTORY
app.get("/api/history", (req, res) => {
  const out = {}
  const today = new Date()
  const y = today.getFullYear()
  const m = today.getMonth()
  const d = today.getDate()
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
