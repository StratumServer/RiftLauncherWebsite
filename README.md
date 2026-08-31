# RiftLauncherWebsite

The website for [RiftLauncher](https://github.com/StratumServer/RiftLauncher), which doubles as its
rendered documentation. Published at
[stratumserver.github.io/RiftLauncherWebsite](https://stratumserver.github.io/RiftLauncherWebsite/).

## Where the content comes from

Nothing in this repository is a copy of the launcher's documentation. `build.mjs` reads the `docs/`
tree and `PRIVACY.md` from the launcher's `dev` branch, and the background scenes from its
`backgrounds` branch, both fetched fresh on every run. `docs/SUMMARY.md` alone decides the sidebar,
so adding a page there is all it takes to see it here. Nothing rebuilds on a schedule. The site
builds on a push to this repository, and on the `source-updated` event the launcher repository
dispatches when it publishes a release, changes the docs on `dev` or moves `backgrounds`, which is
how a documentation merge reaches the published pages without anyone editing this repository.

The landing page's releases section is built from the GitHub API, and `assets/live.js` makes that
same call again from the reader's browser to refresh the download counts on the page. What the build
renders is the whole section for a reader with scripting off, for a crawler and for anyone GitHub
rate-limits, so the script only ever replaces numbers that are already there. That call is the one
third party this site reaches on its own. Either end can fail without consequence: the build skips
the section with a warning and finishes, and the script leaves the page exactly as it found it and
says nothing to the reader. When GitHub has a release newer than the built one, the script updates
the header and puts a line above the notes linking the new ones on GitHub, since it renders no
markdown of its own.

The API reports how many downloads a release has had, never when they happened, so the workflow keeps
one total a day in `data/downloads-history.json` and commits it back. The bar chart is drawn from
today's snapshot; the curve above it appears on its own once that file holds a week of points.

The only other things this repository holds are the build script, the stylesheet, the script that
refreshes the counts, and the landing page copy.

## Languages

The landing page is translated; the documentation, the privacy policy and the release notes are not.
Every string the landing shows lives in `locales/<code>.json`, one file per language. English is the
default and is served from the root, and each other language gets a folder of its own, so French is
at `/fr/`. The pages point at each other with `hreflang` links and with the globe in the header,
which lists every language by its own name and grows as files are added.

### Adding one

1. Copy `locales/en.json` to `locales/<code>.json`, where `<code>` is the language's ISO code.
2. Translate every value. `name` is the language's name in that language, since that is what the
   header lists it as, and `short` is the code shown on the button. `dateLocale` is the tag release
   dates are formatted with, `fr-FR` style. A few strings carry `{name}` holes that are filled with
   numbers and dates at build time; they have to survive the translation. Say in `docsNote`, in the
   language you are adding, that the documentation is in English.
3. Add the code to the `LOCALES` list at the top of `build.mjs`, then `npm run build` and open a
   pull request. The build writes the new landing, adds it to every other language's `hreflang` list
   and to the header, and fails if anything it points at does not resolve.

A translation should come from somebody who speaks the language, not from a machine: this is the
first thing a player reads about the launcher, and a translation that is merely understandable reads
worse than English does. The documentation stays English for now, which every translated landing
says under the docs link rather than letting a reader find out by clicking.

## Building

```sh
npm ci
npm run build
```

The result lands in `dist/`, ready for any static host. The first build clones two shallow copies of
the launcher repository into `.cache/`; delete that folder to force a fresh fetch. To build against
checkouts you already have, point the build at them:

```sh
RIFT_SOURCE=../RiftLauncher RIFT_BACKGROUNDS=../RiftLauncher-backgrounds npm run build
```

To look at the result, serve `dist/` with any static file server. Every link and asset reference in
the output is relative, so the site works under the repository path GitHub Pages serves a project
site from, under a custom domain, or opened straight from disk. The one absolute address is the
OpenGraph image, which a preview card cannot resolve relatively; the workflow passes the real base
URL in `SITE_URL`.

## The link check

The build resolves every internal link, image and heading anchor in the generated site, and exits
non-zero listing anything that does not resolve. A page renamed or moved in the launcher's docs
therefore fails the build here rather than quietly publishing a dead link. Links pointing at
repository files that are not documentation, such as the source files the privacy policy references,
are rewritten to GitHub so they keep working.

Translated pages go through the same check, which is what catches a locale folder reaching for an
asset at the wrong depth: their links, their stylesheet, icon and background paths, and the
`hreflang` addresses they point at each other with all have to resolve to a file the build produced.

## Design notes

The site borrows the launcher's own surface: a background scene from the shared catalog, near-black
scrims over it, and the same `#7e501e` / `#d49754` / `#4f3110` brand ramp. Text never sits on the
background scrim alone, because the scenes are photographs and the worst case has to be treated as a
white image. The scrim opacities and the ratios they produce are worked through at the top of
`assets/site.css`. Links are always underlined; colour on its own does not distinguish them from the
prose around them.
