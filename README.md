# X US-Only Feed Filter

Removes posts from your X (Twitter) feed when the author's account is not based in the
United States. A second, optional switch removes posts that read like AI-generated text.

It is one script, `twitter-us-only.user.js`, that installs two ways:

- **Windows PC**: as a Chrome / Edge / Brave extension.
- **iPhone**: as a userscript in Safari. Apple does not allow anything to modify the X app
  itself, so on iPhone the filter works when you use X at **x.com in Safari**, not in the app.

## Install on Windows (Chrome, Edge or Brave)

1. On the GitHub page for this repository, choose **Code → Download ZIP**, then unzip it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).
5. Open or reload x.com.

To update later, replace the folder's files and click the reload icon on the extension card.

## Install on iPhone (Safari)

1. Install the free **Userscripts** app from the App Store.
2. Open the Userscripts app once and choose a folder for it to keep scripts in.
3. In **Settings → Apps → Safari → Extensions → Userscripts**, turn it on and allow it on `x.com`.
4. In Safari, open the raw `twitter-us-only.user.js` file from this repository
   (open the file on GitHub and tap **Raw**).
5. Tap the **puzzle-piece / "aA" button** in the address bar → **Userscripts** → tap the
   install prompt.
6. Open x.com in Safari and sign in.

The same `.user.js` file also works in Tampermonkey or Violentmonkey on any desktop browser.

## Using it

A small **US** button appears at the bottom-left of x.com. The number beside it is how many
posts have been removed this session. Tap it for the settings:

| Setting | What it does |
| --- | --- |
| **US accounts only** | Removes posts from accounts X lists as based outside the United States. |
| **Hide unverified** | Also hides posts while an account is still being checked, and accounts where X shows no country or only a region such as "North America". Turn this off if your feed feels too empty. |
| **Remove AI-sounding text** | Removes posts that match common AI writing patterns. Off by default. |
| **Sensitivity** | Low removes only obvious cases; High removes more but hides more human posts by mistake. |
| **Always show these accounts** | Handles that are never removed, whatever their country. |

A post you open directly (its own page) is always shown, so links still work.

## How it works, and its limits

**Country.** X publishes an "Account based in" country on each profile's *About this account*
page. The script asks X for that value for each author in your feed, using your own signed-in
session, and remembers the answer in your browser for 30 days.

- X limits how many of these lookups it allows (roughly a few dozen per 15 minutes). When the
  limit is reached the panel says so and lookups resume automatically. Until an account has
  been checked, its posts are hidden if **Hide unverified** is on. The feed fills in as more
  accounts are remembered.
- The country is whatever X reports. It can be wrong for people travelling or using a VPN.
- This relies on an internal X endpoint that X may change. The script tries to recover on its
  own; if lookups stop working, the panel shows the error.

**AI text.** There is no reliable way to detect AI-written text, least of all in short posts.
This filter is a pattern score (stock phrases, "it's not X — it's Y" constructions, em dashes,
emoji bullet lists and similar), English only. Expect it to miss plenty of AI posts and to
remove some human ones.

**Privacy.** Everything runs in your browser. The script talks only to x.com, needs no extension
permissions, and sends nothing anywhere else. Settings and the country cache are kept in the
browser's local storage for x.com.
