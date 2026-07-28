# Mobile apps — RemoveCarBackground

## Option A — PWA (ready now)

1. Deploy site to HTTPS (`removecarbackground.com`)
2. Phone: open site → **Add to Home Screen** / **Install app**
3. Works like a native app icon; uses same live API

## Option B — Native WebView shells (store-ready wrappers)

These wrappers load your live URL in a full-screen WebView. Change `BASE_URL` before building.

### Android (`mobile/android/`)

1. Install [Android Studio](https://developer.android.com/studio)
2. Open folder `mobile/android`
3. Edit `app/src/main/java/.../MainActivity.kt` → set `BASE_URL`
4. Build → Generate Signed Bundle → upload to Google Play Console

### iOS (`mobile/ios/`)

1. Open `mobile/ios/App/App.swift` in Xcode (Mac required)
2. Set `BASE_URL` to your HTTPS domain
3. Archive → Upload to App Store Connect

> Apple/Google require developer accounts ($99 / $25) to publish. The code shells are included; store review is your client’s account step.

## Option C — Capacitor (when npm available)

```bash
npm create @capacitor/app
npx cap add android ios
# set webDir to built static site
```
