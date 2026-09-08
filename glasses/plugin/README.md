# Packaging this plugin

## How the display actually works — settled on device

The Even app's WebView runs this page's JS and renders its DOM, but **only on the
phone**. The lenses are a separate display, driven over BLE, and they show only what is
pushed to them as positioned containers — "no CSS, no flexbox, no DOM"
(`even-g2-notes/docs/display.md`). The two are not mirrored.

Confirmed by loading the page on real hardware: it rendered in the app and the lenses
stayed blank.

`../lens.js` is what reaches the lenses. It pushes the same card the DOM shows as text
containers via the vendored SDK (`../vendor/`), using `createStartUpPageContainer` once
per launch and `rebuildPageContainer` for each change. `../index.html` remains the
phone-side preview and the desktop debugging path, laid out on the same 576x288 frame so
the two agree.

Firmware limits worth knowing before changing the layout: at most **8** text containers,
`containerTotalNum` **1..12**, text brightness **0..4**.

## The bridge

`window.EvenAppBridge` does **not** exist until the SDK initialises it — probing for it
beforehand finds nothing, which is what an earlier version of this code did. The host
injects `window.flutter_inappwebview` (the app is Flutter) and `__EVEN_HUB_APP_ID__`;
everything else comes from `waitForEvenAppBridge()`.

`?debug=1` on the page URL reports what the WebView exposes to
`POST /api/glasses/probe`, which writes it to `~/.config/lumbergh/glasses-probe.json` —
the WebView has no console, so that is the way to inspect it.

## Testing without packaging

    evenhub qr --url 'https://<your-lumbergh-host>/glasses/' -e

Scan it from the Even app's **Developer Center** — not the phone camera, which just opens
the URL. The scanner only appears once Developer Mode is unlocked: sign in at
hub.evenrealities.com/login with the same account as the phone app, then force-quit and
reopen the app.

Loading from a URL this way keeps the page same-origin with Lumbergh, so the board fetch
and the dictation socket resolve without extra configuration.

## Packaging

    evenhub login -e <email>
    evenhub pack app.json .. -c          # -c checks the package id is free
    evenhub pack app.json .. -o lumbergh-hud.ehpk

`pack` stamps `min_app_version` from the SDK floor, so the value in `app.json` is
advisory unless `--enforce-manual-version` is passed.
