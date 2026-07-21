# TravelPlan

A small, self-hostable web app to plan trips with friends: build day-by-day
itineraries out of typed items (hotel, flight, train, ticket, restaurant,
activity, transport), attach images/links, drag-and-drop items across days,
manage members with per-plan sharing, and split expenses per item across
currencies (you supply the exchange rates at settlement).

- **Backend:** Python / Flask + stdlib `sqlite3` (no ORM, no separate DB server).
- **Frontend:** vanilla HTML/CSS/JS (ES modules, no build step).
- **Data & config:** everything lives under `data/` (SQLite DB, uploaded images,
  session secret, app settings) — the whole folder is your "database".

## Layout

```
backend/      Python: Flask app factory, DB, auth, expense engine, blueprints
frontend/     HTML/CSS/JS: Jinja2 templates + static JS modules
data/         SQLite DB, uploads, config (secret key + settings.json)
```

## Run

```bash
./start.sh              # http://0.0.0.0:5050
./start.sh 8080         # listen on a custom port
PORT=9000 ./start.sh    # or set it via the PORT env var
./start.sh --help       # full usage / help message
```

`start.sh` creates `.venv/`, installs Flask, runs the expense-engine self-tests,
then serves the app. Set the port with a positional arg (`./start.sh 8080`) or
the `PORT` env var (the arg wins); `HOST` defaults to `0.0.0.0` so friends on the
same network can reach your machine at that port. Debug/auto-reload is **off**
by default (the Werkzeug debugger is unsafe to expose on a shared network) — use
`DEBUG=1 ./start.sh` while developing locally. `./backend/run.sh` still works as
an alias for `./start.sh`.

On first run there is no admin yet — open the app and create the admin account
at the setup page. The admin then creates member accounts (for friends) and can
share each plan with chosen members.

## Try it with fake data

```bash
./seed.sh            # wipe & populate a realistic test dataset
```

Seeds three trips (**Japan 2026** base JPY, **Iceland Ring Road** base EUR,
**Beijing 2026** base CNY) with full itineraries, per-day hotels, image + link
attachments, expenses in five currencies (JPY / USD / EUR / ISK / CNY) using
all four split methods, exchange rates, and recorded payments. All seeded
accounts use the password **`password`**:

| username | role |
|---|---|
| `admin` | admin, owns all three trips |
| `alice` | editor on all three trips |
| `bob` | editor on Japan 2026 |
| `carol` | viewer on Iceland Ring Road |

`./seed.sh` wipes the DB first by default (it's a test fixture); use
`./seed.sh --no-reset` to seed only when no admin exists yet.

## Expenses & multi-currency

Each expense keeps its own currency. When you open a plan's **Settlement** view,
the app lists every currency that appears in the trip and asks you to enter an
exchange rate from each to the plan's *base currency*. The app never fetches or
assumes rates — you provide them, they are saved, and settlement is computed in
the base currency using a greedy min-cash-flow ("who owes whom") algorithm.

## Development

```bash
.venv/bin/python -m flask --app backend.app run --debug
.venv/bin/python -m backend.expense        # backend engine self-tests
bash frontend/tests/run.sh                  # frontend tests (needs node)
```

The frontend fixtures under `frontend/tests/` run the staging engine's unit
tests and execute `initItinerary()` end-to-end against a DOM shim + stubbed
fetch (no browser, no npm install — plain node ES modules). `start.sh` runs
them automatically before serving (skipped if node is not installed).