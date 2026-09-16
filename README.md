# Microsoft Rewards Script — Lite Local Observer Runtime

> [!IMPORTANT]
> **Lite Version Architecture:**
> `Microsoft-Rewards-Script-Lite` serves as a **local technical readiness observer and dashboard**.
> - **Zero browser automation**: Does not launch Patchright, Chromium, or Edge.
> - **Zero point claims**: Does not claim points, complete activities, or scrape Microsoft servers.
> - **Zero outbound internet calls**: Strictly passive toward external Microsoft services; serves local loopback dashboard at `http://127.0.0.1:4100`.
> - **Zero credential handling**: Observer reads `identities.json` containing only explicit UUIDs and safe display labels (no passwords, tokens, or cookies).
> - **Bridge Intake**: Ingests sanitized observation snapshots exported from the Main execution engine via `bridge/incoming/`.

---

## Quick Setup (Observer Runtime)

### 1. Configure Observer & Identities
```bash
# Copy example observer configuration
cp config.observer.example.json config.observer.json

# Copy example identities file (add your account UUIDs; no passwords required)
cp identities.example.json identities.json
```

### 2. Build and Start Observer
```bash
# Build TypeScript and copy dashboard assets
npm run build

# Start production observer runtime
npm start

# Or run in development mode directly via ts-node
npm run dev
```

Open your browser at **`http://127.0.0.1:4100`** to access:
- **Technical Readiness Dashboard**: View technical readiness status, session freshness, and ground-truth evidence.
- **Manual Action Center**: Review tasks requiring manual interaction (puzzles, official app activities). Operators can mark actions as reported (`action-reported`) while awaiting server verification from Main.

> [!NOTE]
> Legacy automation runners remain accessible via `npm run start:legacy` and `npm run dev:legacy`.

---

## Table of Contents

* [Quick Setup](#quick-setup)
* [Nix Setup](#nix-setup)
* [Configuration Options](#configuration-options)
* [Account Setup](#account-setup)
* [Farming & Warming SOPs (OpSec)](#farming--warming-sops-opsec)
* [Troubleshooting](#troubleshooting)
* [Disclaimer](#disclaimer)

---

## Quick Setup

### Bare metal

**Requirements:** Node.js >= 24 and Git
Works on Windows, Linux, macOS, and WSL.

#### Get the script

```bash
git clone https://github.com/rayyeieiei/Microsoft-Rewards-Script.git
cd Microsoft-Rewards-Script
```

Or, download the latest release ZIP and extract it.

#### Create an account.json and config.json

Copy, rename, and edit your account and configuration files before deploying the script.

* Copy or rename `src/accounts.example.json` to `src/accounts.json` and add your credentials.
* Copy or rename `src/config.example.json` to `src/config.json` and customize your preferences.

> [!CAUTION]
> Do not skip this step.
> Prior versions of accounts.json and config.json are not compatible with current release.

> [!WARNING]
> You must rebuild your script after making any changes to accounts.json and config.json.

#### Build and run the script (bare metal version)

```bash
npm run pre-build
npm run build
npm run start
```

### Docker

* Copy the sample `compose.yaml`.
* Copy and rename `env.example` to `.env` and add your account credentials:

```env
ACCOUNT_1_EMAIL=you@example.com
ACCOUNT_1_PASSWORD=your_password
```

> [!NOTE]
> A valid `accounts.json` is automatically created based on these values, and saved locally to `./config/`.

* Review `compose.yaml` to adjust scheduling, timezone, and config options.

> [!NOTE]
> A valid `config.json` is auto-generated on first run using default values, and saved locally to `./config/`.
>
> Optionally, use `CONFIG_*` variables in the `environment:` section of the `compose.yaml` to customise your options (e.g., clusters, webhook).
>
> Commonly changed values are included in the sample `compose.yaml`, and a full list of configuration options are in the table below.
>
> Custom config values set in the `compose.yaml` are applied on every startup and always take precedence over `./config/config.json`.

> [!TIP]
> If a new image adds config options you're missing, a warning will appear in the container logs.
>
> To update, delete `./config/config.json` and restart. A fresh one will be generated from the latest example, with your `compose.yaml` overrides re-applied.

* Start the container:

```bash
docker compose up -d
```

> [!TIP]
> Monitor logs with:
>
> ```bash
> docker logs microsoft-rewards-script
> ```
>
> Useful for viewing passwordless login codes or diagnosing issues.
>
> You can also enable a webhook in `compose.yaml` for notifications.

---

## Nix Setup

If using Nix:

```bash
bash scripts/nix/run.sh
```

---

## Configuration Options

Edit `config.json` to customize behavior, or set `CONFIG_*` environment variables in `compose.yaml` (Docker).

Below are all currently available options.

> [!WARNING]
> Rebuild the script (bare metal), or recreate the container (Docker) after all config changes.

### Core

| Setting                    | Type    | Default                      | Description                           | Docker environment variable   |
| -------------------------- | ------- | ---------------------------- | ------------------------------------- | ----------------------------- |
| `baseURL`                  | string  | `"https://rewards.bing.com"` | Microsoft Rewards base URL            |                               |
| `sessionPath`              | string  | `"sessions"`                 | Directory to store browser sessions   |                               |
| `headless`                 | boolean | `false`                      | Run browser invisibly                 | Always `true` in Docker       |
| `clusters`                 | number  | `1`                          | Number of concurrent account clusters | `CONFIG_CLUSTERS`             |
| `errorDiagnostics`         | boolean | `false`                      | Enable error diagnostics              | `CONFIG_ERROR_DIAGNOSTICS`    |
| `searchOnBingLocalQueries` | boolean | `false`                      | Use local query list                  | `CONFIG_SEARCH_ON_BING_LOCAL` |
| `globalTimeout`            | string  | `"30sec"`                    | Timeout for all actions               | `CONFIG_GLOBAL_TIMEOUT`       |

### Workers

| Setting                       | Type    | Default | Description                 | Docker environment variable        |
| ----------------------------- | ------- | ------- | --------------------------- | ---------------------------------- |
| `workers.doDailySet`          | boolean | `true`  | Complete daily set          | `CONFIG_WORKER_DAILY_SET`          |
| `workers.doSpecialPromotions` | boolean | `true`  | Complete special promotions | `CONFIG_WORKER_SPECIAL_PROMOTIONS` |
| `workers.doMorePromotions`    | boolean | `true`  | Complete more promotions    | `CONFIG_WORKER_MORE_PROMOTIONS`    |
| `workers.doPunchCards`        | boolean | `true`  | Complete punchcards         | `CONFIG_WORKER_PUNCH_CARDS`        |
| `workers.doAppPromotions`     | boolean | `true`  | Complete app promotions     | `CONFIG_WORKER_APP_PROMOTIONS`     |
| `workers.doDesktopSearch`     | boolean | `true`  | Perform desktop searches    | `CONFIG_WORKER_DESKTOP_SEARCH`     |
| `workers.doMobileSearch`      | boolean | `true`  | Perform mobile searches     | `CONFIG_WORKER_MOBILE_SEARCH`      |
| `workers.doDailyCheckIn`      | boolean | `true`  | Complete daily check-in     | `CONFIG_WORKER_DAILY_CHECKIN`      |
| `workers.doReadToEarn`        | boolean | `true`  | Complete Read-to-Earn       | `CONFIG_WORKER_READ_TO_EARN`       |

### Search Settings

| Setting                                | Type     | Default                                      | Description                         | Docker environment variable    |
| -------------------------------------- | -------- | -------------------------------------------- | ----------------------------------- | ------------------------------ |
| `searchSettings.scrollRandomResults`   | boolean  | `false`                                      | Scroll randomly on results          | `CONFIG_SEARCH_SCROLL_RANDOM`  |
| `searchSettings.clickRandomResults`    | boolean  | `false`                                      | Click random links                  | `CONFIG_SEARCH_CLICK_RANDOM`   |
| `searchSettings.parallelSearching`     | boolean  | `true`                                       | Run searches in parallel            | `CONFIG_SEARCH_PARALLEL`       |
| `searchSettings.queryEngines`          | string[] | `["google", "wikipedia", "reddit", "local"]` | Query engines to use                |                                |
| `searchSettings.searchResultVisitTime` | string   | `"10sec"`                                    | Time to spend on each search result | `CONFIG_SEARCH_VISIT_TIME`     |
| `searchSettings.searchDelay.min`       | string   | `"30sec"`                                    | Minimum delay between searches      | `CONFIG_SEARCH_DELAY_MIN`      |
| `searchSettings.searchDelay.max`       | string   | `"1min"`                                     | Maximum delay between searches      | `CONFIG_SEARCH_DELAY_MAX`      |
| `searchSettings.readDelay.min`         | string   | `"30sec"`                                    | Minimum delay for reading           | `CONFIG_SEARCH_READ_DELAY_MIN` |
| `searchSettings.readDelay.max`         | string   | `"1min"`                                     | Maximum delay for reading           | `CONFIG_SEARCH_READ_DELAY_MAX` |

### Logging

| Setting                          | Type     | Default                | Description                       | Docker environment variable   |
| -------------------------------- | -------- | ---------------------- | --------------------------------- | ----------------------------- |
| `debugLogs`                      | boolean  | `false`                | Enable debug logging              | `CONFIG_DEBUG_LOGS`           |
| `consoleLogFilter.enabled`       | boolean  | `false`                | Enable console log filtering      | `CONFIG_LOG_FILTER_ENABLED`   |
| `consoleLogFilter.mode`          | string   | `"whitelist"`          | Filter mode (whitelist/blacklist) | `CONFIG_LOG_FILTER_MODE`      |
| `consoleLogFilter.levels`        | string[] | `["error", "warn"]`    | Log levels to filter              | `CONFIG_LOG_FILTER_LEVELS`*   |
| `consoleLogFilter.keywords`      | string[] | `["starting account"]` | Keywords to filter                | `CONFIG_LOG_FILTER_KEYWORDS`* |
| `consoleLogFilter.regexPatterns` | string[] | `[]`                   | Regex patterns for filtering      |                               |

> [!NOTE]
> Docker `CONFIG_*` array values are comma-separated strings, e.g. `"error,warn"`.
>
> Regex patterns must be entered directly in the `config.yaml`.

---

## Account Setup

Edit `src/accounts.json`.

> [!TIP]
> Docker users can set account details directly in the `compose.yaml`; using a `.env` is recommended for sensitive information.
>
> Docker will automatically create a valid `accounts.json` on container creation, and save the file in `./config/`.

> [!WARNING]
> The file is a **flat array** of accounts, not `{ "accounts": [ ... ] }`.
>
> Rebuild the script after all changes.

```json
[
  {
    "email": "email_1",
    "password": "password_1",
    "totpSecret": "",
    "recoveryEmail": "",
    "geoLocale": "auto",
    "langCode": "en",
    "proxy": {
      "proxyAxios": false,
      "url": "",
      "port": 0,
      "username": "",
      "password": ""
    },
    "saveFingerprint": {
      "mobile": false,
      "desktop": false
    }
  }
]
```

> [!NOTE]
> `geoLocale` uses the default locale of your Microsoft profile.
>
> You can overwrite it here with a custom locale.

> [!TIP]
> When using 2FA login, adding your `totpSecret` will enable the script to automatically generate and enter the timed 6-digit code to login.
>
> To get your `totpSecret` in your Microsoft Security settings, click **Manage how you sign in**.
>
> Add Authenticator app, when shown the QR code, select **Enter code manually**.
>
> Use this code in the `accounts.json`.

---

## Farming & Warming SOPs (OpSec)

To maintain the longevity of your accounts and avoid AI detection, strictly adhere to the following Standard Operating Procedures (SOPs).

### 1. New Account Creation SOP (Anti-Ban)

* **Network Segregation:** NEVER create new accounts on your primary Home ISP (Wi-Fi). Always use a **Mobile Data Hotspot**.
* **IP Rotation:** Toggle **Airplane Mode** on your mobile device for 5–10 seconds after creating 1–2 accounts to obtain a fresh cellular IP Address.
* **Browser Hygiene:** Use a clean, cache-free browser profile for every new account creation.
* **Initial Warming:** Do not run the script immediately after creation. Perform 2–3 manual, organic searches and log out.

### 2. Account Warming SOP (Lite Mode)

Accounts younger than 1 month must be run using a restricted configuration to build a healthy "Trust Score."

* Disable high-risk workers in `config.json` (`doDailySet`, `doPunchCards`, etc.).
* Increase `searchDelay` significantly (e.g., 45 seconds to 2 minutes between searches).
* Process a maximum of **3 accounts per batch**, followed by a strict IP Rotation (Airplane Mode toggle) before starting the next batch.

### 3. Daily Farming SOP (Elite Mode)

For aged, trusted accounts targeting maximum point yields.

* **The Rule of 6:** Never execute more than **6 accounts per day** on a single Home ISP connection.
* If managing larger farms, process the remaining accounts via Mobile Hotspot, ensuring IP rotation occurs between each cluster of 6.
* **Redemption:** Do not use the same physical phone number to redeem SMS OTPs for multiple accounts in a short timeframe.

---

## Troubleshooting

> [!TIP]
> Most login issues can be fixed by deleting your `/sessions` folder and redeploying the script.

---

## Disclaimer

Use at your own risk.

Automation of Microsoft Rewards may lead to account suspension or bans.

This software is provided for educational purposes only.

The authors are not responsible for any actions taken by Microsoft.
