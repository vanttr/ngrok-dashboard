# Ngrok Browser Warning (ERR_NGROK_6024)

Ngrok free-tier tunnels show an interstitial warning page
("You are about to visit... served for free through ngrok.com")
to first-time browser visitors. This page can be bypassed.

## How ngrok decides

Ngrok classifies every incoming request by User-Agent:

| User-Agent | Result |
|---|---|
| Browser-like (Chrome, Firefox, Safari, Edge) | Interstitial warning page |
| Non-browser (curl, custom string, scripts) | Passes through to upstream |
| Any UA + `ngrok-skip-browser-warning` request header | Passes through |

## Verified bypass methods (tested 2026-06-14)

1. **`ngrok-skip-browser-warning` request header** — send as a client _request_ header
   with any value:
   ```
   curl -H "ngrok-skip-browser-warning: true" https://xxx.ngrok-free.dev/
   ```

2. **Custom / non-browser User-Agent** — any UA string that doesn't match a
   known browser:
   ```
   curl -H "User-Agent: ngrok-dashboard/1.0" https://xxx.ngrok-free.dev/
   ```
   curl's default UA (`curl/8.x.x`) already qualifies.

3. **Paid ngrok account** — removes the interstitial entirely.

## What does NOT work

- **Response headers** — setting `ngrok-skip-browser-warning` on the HTTP
  _response_ (e.g., `res.setHeader(...)`) has no effect. Ngrok inspects the
  _request_ before it reaches the upstream; the response arrives too late.

- **Chrome/Firefox/Safari/Edge User-Agent + no skip header** — always gets
  the interstitial on the first visit from a new IP/browser session.

## The chicken-and-egg problem for web apps

The dashboard's JavaScript runs inside a browser, which sends a browser-like
User-Agent. The interstitial blocks the initial HTML page load, so the JS never
gets a chance to set the request header on subsequent `fetch()` calls.

Ngrok mitigates this with a cookie: visitors see the interstitial _only once_
per browser session. After clicking "Visit Site", subsequent requests bypass
the interstitial via a cookie ngrok sets.

For automated / script clients, use method (1) or (2) above.

## Current code

- `server.js` line 1452: **removed** — was incorrectly setting the header as a
  response header (no-op).
- `server.js` lines 1804-1807: still sets the header on proxied responses to
  upstream targets. Equally ineffective for the same reason, but harmless.
- `server.js` line 1652: `/ngrok-skip-browser-warning` endpoint returns 204.
  Public route (no auth). Potentially useful for client-side preflight but
  currently unused by the dashboard JS.
