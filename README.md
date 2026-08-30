# RiftLauncherWebsite

The website for [RiftLauncher](https://github.com/StratumServer/RiftLauncher), which doubles as its
rendered documentation. Published at
[stratumserver.github.io/RiftLauncherWebsite](https://stratumserver.github.io/RiftLauncherWebsite/).

## Where the content comes from

Nothing in this repository is a copy of the launcher's documentation. `build.mjs` reads the `docs/`
tree and `PRIVACY.md` from the launcher's `dev` branch, and the background scenes from its
`backgrounds` branch, both fetched fresh on every run. `docs/SUMMARY.md` alone decides the sidebar,
so adding a page there is all it takes to see it here. The site rebuilds on every push and once a
day, which is how a documentation merge reaches the published pages without anyone editing this
repository.

The landing page's releases section comes from the GitHub API, read once at build time rather than
from the reader's browser, so a visit does not reach a third party. If that request fails the section
is skipped with a warning and the build still finishes; the daily run picks it up again the next
morning.

The API reports how many downloads a release has had, never when they happened, so the workflow keeps
one total a day in `data/downloads-history.json` and commits it back. The bar chart is drawn from
today's snapshot; the curve above it appears on its own once that file holds a week of points.

The only other things this repository holds are the build script, the stylesheet and the landing page
copy.

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

## Design notes

The site borrows the launcher's own surface: a background scene from the shared catalog, near-black
scrims over it, and the same `#7e501e` / `#d49754` / `#4f3110` brand ramp. Text never sits on the
background scrim alone, because the scenes are photographs and the worst case has to be treated as a
white image. The scrim opacities and the ratios they produce are worked through at the top of
`assets/site.css`. Links are always underlined; colour on its own does not distinguish them from the
prose around them.
