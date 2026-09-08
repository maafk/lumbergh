# Vendored: `@evenrealities/even_hub_sdk`

`even_hub_sdk-0.0.15.js` is `dist/index.js` from the npm package, copied verbatim.

Vendored rather than installed because it can be: the package has **zero dependencies**,
is `type: module`, and its ESM build contains no bare imports — so it loads directly in
the browser and the HUD keeps its no-build-step property. The `.d.ts` is kept alongside
purely as readable documentation; the shipped code is obfuscated.

This is the only way to reach the glasses. The Even app's WebView renders the DOM page on
the phone, but the lenses display only what is pushed through this SDK's container API.

## Updating

    npm view @evenrealities/even_hub_sdk version
    curl -sL "$(npm view @evenrealities/even_hub_sdk dist.tarball | tr -d "'")" -o sdk.tgz
    tar xzf sdk.tgz
    cp package/dist/index.js   glasses/vendor/even_hub_sdk-<version>.js
    cp package/dist/index.d.ts glasses/vendor/even_hub_sdk-<version>.d.ts

Then update the import in `glasses/lens.js` and delete the old pair. The filename carries
the version so an update is a visible change rather than a silent swap, and
`plugin/app.json`'s `min_sdk_version` should be checked against the new floor.

---

# Vendored: `@evenrealities/pretext`

`pretext-0.1.4.js` is `dist/font_measure.js`, copied verbatim. Same reason as the SDK:
zero dependencies, `type: module`, no bare imports.

It reproduces the LVGL font metrics the G2 firmware itself uses, which is why the reader
measures instead of counting characters. The font is proportional, so a character count
is wrong by roughly 60% — about 52 average glyphs fit a 576px line, not 32 — and the
measured line height of 27px means ten lines fit the 288px frame, not six. Both numbers
were guessed before this was vendored, and both were wrong.

    npm view @evenrealities/pretext version
    curl -sL "$(npm view @evenrealities/pretext dist.tarball | tr -d "'")" -o p.tgz
    tar xzf p.tgz
    cp package/dist/font_measure.js   glasses/vendor/pretext-<version>.js
    cp package/dist/font_measure.d.ts glasses/vendor/pretext-<version>.d.ts

Then update the import in `glasses/detail.js`.
