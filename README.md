# beachcheck

Minimalist conditions for Toronto's supervised beaches — water quality, water temperature, waves and wind. Built for swimmers and SUP riders who want one glance, not a dashboard.

**Live site:** https://anderskravis.github.io/beachcheck/

## How it works

Plain HTML/CSS/JS, no build step, no servers.

- A scheduled GitHub Action (`.github/workflows/data.yml`) pulls the City of Toronto open datasets — [beach water quality](https://open.toronto.ca/dataset/toronto-beaches-water-quality/) (daily E. coli samples) and [beach observations](https://open.toronto.ca/dataset/toronto-beaches-observations/) (water temp, wave action, etc.) — and commits the normalized result to `data/conditions.json`.
- The browser loads that JSON and fetches live wind (and wave height where available) straight from [Open-Meteo](https://open-meteo.com/), so wind is real-time even though city data is daily.
- Every push to `main` redeploys to GitHub Pages.

A beach reads **swim** when its latest E. coli geometric mean is under Toronto's posting limit (100 / 100 mL), **no swim** at or above it, and **no data** outside the June–September sampling season.

## Development

```sh
node scripts/fetch-conditions.mjs --fixtures   # build conditions.json from canned data
node scripts/fetch-conditions.mjs              # hit the real city APIs
python3 -m http.server 8000                    # then open http://localhost:8000
```

Beaches are registered in `beaches.js`; deep-link any of them with a hash, e.g. [`#kew-balmy`](https://anderskravis.github.io/beachcheck/#kew-balmy).

Not official safety advice — check the city's [SwimSafe](https://www.toronto.ca/community-people/health-wellness-care/health-inspections-monitoring/swimsafe/) page before you swim.
