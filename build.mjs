/*
 * Builds the RiftLauncher site from the launcher repository.
 *
 * Nothing here is a copy of the launcher's documentation. The docs/ tree and PRIVACY.md are pulled
 * from the dev branch every time this runs, and the background scenes come from the backgrounds
 * branch, so a merge over there shows up here on the next build with nobody moving files around.
 *
 * Set RIFT_SOURCE and RIFT_BACKGROUNDS to local checkouts to build without network access.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, posix, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { marked } from "marked"

/**
 * The docs carry GitBook-style emoji in their titles and headings; the site renders them plain.
 * Strips pictographs, dingbats, variation selectors and the whitespace they leave behind.
 */
const deEmoji = (text) =>
  text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/ {2,}/g, " ")
    .replace(/^ +| +$/gm, "")

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, "dist")
const CACHE = join(ROOT, ".cache")
const REPO = "https://github.com/StratumServer/RiftLauncher"
const BLOB = `${REPO}/blob/dev/`
const RELEASES = `${REPO}/releases`
const DISCORD = "https://discord.gg/vQm6z2urZs"
const MODDB = "https://mods.vintagestory.at/riftlauncher"
/*
 * Only the OpenGraph tags need an absolute address, since a preview card cannot resolve a relative
 * one. Every link and asset on the page is relative, so the site works unchanged under the repository
 * path a project Pages site is served from, at a custom domain, or opened straight from disk.
 */
// Pages reports the site URL with an http scheme until its own HTTPS enforcement is on, which it
// never is behind the Cloudflare proxy that actually serves the TLS, so the scheme is forced here.
const SITE_URL = (process.env.SITE_URL || "https://stratumserver.github.io/RiftLauncherWebsite/").replace(/^http:/, "https:").replace(/\/?$/, "/")

/** A shallow checkout of one branch of the launcher repository, or a local path when one is given. */
function checkout(branch, override) {
  if (override) return override
  const dir = join(CACHE, branch)
  if (existsSync(dir)) return dir
  mkdirSync(CACHE, { recursive: true })
  execFileSync("git", ["clone", "--depth", "1", "--single-branch", "--branch", branch, `${REPO}.git`, dir], { stdio: "inherit" })
  return dir
}

const source = checkout("dev", process.env.RIFT_SOURCE)
const scenes = checkout("backgrounds", process.env.RIFT_BACKGROUNDS)

const read = (...parts) => readFileSync(join(...parts), "utf8")

// ---------------------------------------------------------------- locales

/**
 * Every string the landing page shows lives in locales/<code>.json, one file per language. The first
 * one in this list is the default and is served from the root; the rest get a folder of their own.
 * Only the landing is translated: the documentation, the privacy policy and the release notes are
 * English wherever you read them, which the localized pages say out loud rather than hiding.
 */
const LOCALES = ["en", "fr"].map((code) => ({ code, ...JSON.parse(read(ROOT, "locales", `${code}.json`)) }))
const [EN] = LOCALES

/** Where a locale's landing page lands in the output. */
const landingOut = (locale) => (locale === EN ? "index.html" : `${locale.code}/index.html`)

/** Fills `{name}` holes in a locale string, which is what a translated sentence with numbers in it needs. */
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key])

// ---------------------------------------------------------------- navigation

/**
 * SUMMARY.md is GitBook's table of contents: `## HEADING` opens a section and each `- [title](path)`
 * is a page, nested by two spaces per level. It is the only thing that decides the sidebar, so a
 * page added there appears here with no other change.
 */
function parseSummary(text) {
  const sections = [{ title: null, items: [] }]
  let stack = []
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      sections.push({ title: heading[1], items: [] })
      stack = []
      continue
    }
    const entry = /^(\s*)-\s+\[(.+?)\]\((.+?)\)\s*$/.exec(line)
    if (!entry) continue
    const depth = Math.floor(entry[1].length / 2)
    const item = { title: deEmoji(entry[2]), path: posix.normalize(entry[3]), children: [] }
    const parent = stack[depth - 1]
    if (depth > 0 && parent) parent.children.push(item)
    else sections[sections.length - 1].items.push(item)
    stack.length = depth
    stack.push(item)
  }
  return sections.filter((section) => section.items.length > 0)
}

const summary = parseSummary(read(source, "docs", "SUMMARY.md"))

/** Every markdown file under docs/, so a page reachable by a link but absent from SUMMARY still renders. */
function markdownFiles(dir, prefix = "") {
  const found = []
  for (const entry of readdirSync(join(source, "docs", dir), { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.isDirectory()) {
      if (entry.name !== ".gitbook") found.push(...markdownFiles(join(dir, entry.name), `${rel}/`))
    } else if (entry.name.endsWith(".md") && rel !== "SUMMARY.md") found.push(rel)
  }
  return found
}

/** Where a source file lands in the output. A README becomes the index of its folder, as GitBook serves it. */
const outputFor = (repoPath) =>
  repoPath === "PRIVACY.md" ? "privacy.html" : `docs/${repoPath.replace(/README\.md$/, "index.html").replace(/\.md$/, ".html")}`

const pages = new Map()
for (const rel of markdownFiles(".")) pages.set(`docs/${rel}`, { repoPath: `docs/${rel}`, out: outputFor(rel) })
pages.set("PRIVACY.md", { repoPath: "PRIVACY.md", out: "privacy.html" })

/** SUMMARY paths are relative to docs/, and one of them reaches back out of it to the privacy policy. */
const repoPathOf = (summaryPath) => posix.normalize(posix.join("docs", summaryPath))

const titles = new Map()
for (const section of summary) {
  const walk = (items) => {
    for (const item of items) {
      titles.set(repoPathOf(item.path), item.title)
      walk(item.children)
    }
  }
  walk(section.items)
}

// ---------------------------------------------------------------- markdown

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const slug = (text) =>
  text
    .replace(/<[^>]*>/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")

/**
 * GitBook's block syntax, turned into plain HTML wrappers the stylesheet knows.
 *
 * The blank lines around each wrapper matter: without them the markdown inside a block would be
 * swallowed as raw HTML and never rendered, which is how bold text and code spans inside a hint
 * would silently come out as literal asterisks and backticks.
 */
function gitbook(markdown, repoPath) {
  const link = (url, text) => `\n\n<div class="card">\n\n[${text}](${url})\n\n</div>\n\n`
  const body = markdown
    .replace(/\{%\s*hint\s+style="(\w+)"\s*%\}/g, (_, style) => `\n\n<div class="callout callout-${style}">\n\n`)
    .replace(/\{%\s*endhint\s*%\}/g, "\n\n</div>\n\n")
    .replace(/\{%\s*stepper\s*%\}/g, '\n\n<div class="stepper">\n\n')
    .replace(/\{%\s*endstepper\s*%\}/g, "\n\n</div>\n\n")
    .replace(/\{%\s*step\s*%\}/g, '\n\n<div class="step">\n\n')
    .replace(/\{%\s*endstep\s*%\}/g, "\n\n</div>\n\n")
    .replace(/\{%\s*content-ref\s+url="([^"]+)"\s*%\}[\s\S]*?\{%\s*endcontent-ref\s*%\}/g, (_, url) => {
      const target = posix.normalize(posix.join(posix.dirname(repoPath), url))
      return link(url, titles.get(target) ?? url)
    })
    // The docs' YouTube embeds are the original project's guide videos, screencasts of an interface
    // this launcher no longer has, so they are dropped from the rendered pages entirely rather than
    // linked. When guides for this launcher exist they can come back through the same block.
    .replace(/\{%\s*embed\s+url="[^"]*(?:youtube\.com|youtu\.be)[^"]*"\s*%\}\n[\s\S]*?\n\{%\s*endembed\s*%\}\n?/g, "")
    .replace(/\{%\s*embed\s+url="[^"]*(?:youtube\.com|youtu\.be)[^"]*"\s*%\}\n?/g, "")
    // Other embeds stay links rather than embedded players: an iframe would hand every reader's visit to a
    // third party before they asked for it, which is not what the privacy policy on this same site says.
    .replace(/\{%\s*embed\s+url="([^"]+)"\s*%\}\n([\s\S]*?)\n\{%\s*endembed\s*%\}/g, (_, url, caption) => link(url, caption.trim() || url))
    .replace(/\{%\s*embed\s+url="([^"]+)"\s*%\}/g, (_, url) => link(url, url))
  const leftover = /\{%[\s\S]*?%\}/.exec(body)
  if (leftover) throw new Error(`${repoPath} uses a GitBook block this build does not handle: ${leftover[0]}`)
  return body
}

/** A relative link from one output file to another, so the site works at any base path. */
function linkTo(fromOut, toOut) {
  const href = posix.relative(posix.dirname(fromOut), toOut)
  return href.replace(/(^|\/)index\.html$/, "$1") || "./"
}

/**
 * Rewrites one href written for the repository into one that works on the site. A link to a page we
 * render points at the rendered page; anything else in the repository points at the file on GitHub,
 * which is where a reader following a link to source code wants to end up anyway.
 */
function rewrite(href, repoPath, out) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) return href
  const [path, anchor] = href.split("#")
  if (!path) return href
  const target = posix.normalize(posix.join(posix.dirname(repoPath), path))
  const page = pages.get(target)
  if (page) return linkTo(out, page.out) + (anchor ? `#${anchor}` : "")
  // The GitBook asset folder ships with the site, so a link into it stays relative. Everything else
  // in the repository, source files the privacy policy points at included, goes to GitHub.
  if (target.startsWith("docs/.gitbook/")) return href
  return BLOB + target + (anchor ? `#${anchor}` : "")
}

/** Renders one markdown file, returning its HTML, its title, its description and the anchors it defines. */
function render(repoPath) {
  const raw = read(source, repoPath)
  const front = /^---\n([\s\S]*?)\n---\n/.exec(raw)
  const description = front ? /^description:\s*(.+)$/m.exec(front[1])?.[1]?.trim() : undefined
  const markdown = front ? raw.slice(front[0].length) : raw
  const out = pages.get(repoPath).out

  let html = marked.parse(gitbook(deEmoji(markdown), repoPath), { gfm: true, async: false })

  const anchors = new Set(["main"]) // the skip link's target, which the shell puts on every page
  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    let id = slug(inner) || `section-${anchors.size + 1}`
    while (anchors.has(id)) id += "-x"
    anchors.add(id)
    return `<h${level} id="${id}">${inner}</h${level}>`
  })
  html = html.replace(/(<a\b[^>]*\shref=")([^"]*)(")/g, (_, open, href, close) => open + escape(rewrite(href.replace(/&amp;/g, "&"), repoPath, out)) + close)
  html = html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>")

  html = html.replace(/\n{3,}/g, "\n\n")

  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]
  const title = (heading ? heading.replace(/<[^>]*>/g, "") : (titles.get(repoPath) ?? repoPath)).replace(/[^\p{L}\p{N}\p{P}\s]/gu, "").trim()
  return { html, title, description: description ?? `${title}. Documentation for RiftLauncher, an independent launcher for Vintage Story.`, anchors }
}

// ---------------------------------------------------------------- page shell

const catalog = JSON.parse(read(scenes, "manifest.json"))

function sidebar(out, current) {
  /** True when the current page is this item or anything below it, which is what keeps a group open. */
  const holds = (item) => pages.get(repoPathOf(item.path))?.out === current || item.children.some(holds)
  const entry = (item) => {
    const page = pages.get(repoPathOf(item.path))
    const href = page ? linkTo(out, page.out) : BLOB + repoPathOf(item.path)
    const here = page?.out === current
    const link = `<a href="${escape(href)}"${here ? ' aria-current="page"' : ""}>${escape(item.title)}</a>`
    if (item.children.length === 0) return `<li>${link}</li>`
    // The group's own page stays a link inside the disclosure heading, so a section that is both a
    // page and a parent is still reachable without opening it first.
    return `<li><details${holds(item) ? " open" : ""}><summary>${link}</summary><ul>${item.children.map(entry).join("")}</ul></details></li>`
  }
  const groups = summary
    .map(
      (section) =>
        `${section.title ? `<h2 class="nav-heading">${escape(section.title)}</h2>` : ""}<ul>${section.items.map(entry).join("")}</ul>`
    )
    .join("")
  return `<details class="nav-shell" open><summary class="nav-summary">Documentation</summary><nav class="nav" aria-label="Documentation">${groups}</nav></details>`
}

/*
 * Icons drawn inline, so nothing is fetched from anywhere and every glyph takes its colour from the
 * link it sits in. The GitHub and Discord marks are the services' own monochrome ones, which is what
 * a link to a service is meant to carry. The ModDB has no mark to borrow, so its link gets the cube
 * that stands for a mod package everywhere else in this ecosystem.
 */
const line = (paths) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`

const ICON = {
  docs: line('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  download: line('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
  privacy: line('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  moddb: line('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 12l9-5"/><path d="M12 12v10"/><path d="M12 12L3 7"/>'),
  scene: line('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-4-4 3-3-2-6 5"/>'),
  globe: line('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.4 3.9 5.6 3.9 9s-1.4 6.6-3.9 9c-2.5-2.4-3.9-5.6-3.9-9s1.4-6.6 3.9-9z"/>'),
  versions: line('<rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/>'),
  installations: line('<rect x="2" y="5" width="9" height="15" rx="2"/><rect x="13" y="5" width="9" height="15" rx="2"/><path d="M4.5 9.5h4"/><path d="M15.5 9.5h4"/>'),
  backup: line('<path d="M3.5 12a8.5 8.5 0 1 0 2.9-6.4L3 8"/><path d="M3 3.5V8h4.5"/><path d="M12 8v4.3l3 1.7"/>'),
  health: line('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9"/>'),
  servers: line('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01"/><path d="M7 16.5h.01"/><path d="M11 7.5h6"/><path d="M11 16.5h6"/>'),
  sessions: line('<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>'),
  accounts: line('<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20.5v-1.5a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v1.5"/><path d="M16.5 4.3a3.5 3.5 0 0 1 0 6.9"/><path d="M18 15.2a4 4 0 0 1 3.5 4v1.3"/>'),
  windows: line('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>'),
  linux: line('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3"/><path d="M12 15h6"/>'),
  macos: line('<rect x="4" y="4" width="16" height="11" rx="2"/><path d="M2 19h20"/>'),
  checked: line('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15l2 2 4-4"/>'),
  review: line('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  modpack: line('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17.5l9 5 9-5"/>'),
  github:
    '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
  discord:
    '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M19.54 5.34A16.4 16.4 0 0 0 15.44 4l-.28.57a12.6 12.6 0 0 1 3.6 1.72 13.9 13.9 0 0 0-12.5 0 12.6 12.6 0 0 1 3.6-1.72L9.56 4a16.4 16.4 0 0 0-4.1 1.34C2.9 9.2 2.2 12.96 2.55 16.66a16.6 16.6 0 0 0 5.03 2.54l1.1-1.55a10.8 10.8 0 0 1-1.72-.83l.42-.33a11.9 11.9 0 0 0 10.24 0l.42.33c-.55.33-1.12.6-1.72.83l1.1 1.55a16.6 16.6 0 0 0 5.03-2.54c.41-4.3-.69-8.02-2.91-11.32zM9.1 14.5c-.99 0-1.8-.9-1.8-2.02 0-1.11.79-2.02 1.8-2.02s1.82.91 1.8 2.02c0 1.11-.79 2.02-1.8 2.02zm5.8 0c-.99 0-1.8-.9-1.8-2.02 0-1.11.79-2.02 1.8-2.02s1.81.91 1.8 2.02c0 1.11-.79 2.02-1.8 2.02z"/></svg>'
}

/** An icon and its word, the word carrying the underline. */
const iconLink = (href, icon, label) => `<a href="${escape(href)}">${icon}<span>${escape(label)}</span></a>`

/*
 * The emblem everywhere it is drawn small. The branding PNG in the launcher repository is 1254px
 * and over a megabyte, which is right for a preview card and far too much for a 30px mark in the
 * header, so the page uses a 320px copy kept in assets/ and the full file is only the og:image.
 */
const EMBLEM = "emblem.webp"
const VSL_LOGO = "vsl-logo.webp"

function footer(out, t) {
  const link = (href, text) => `<a href="${href}">${text}</a>`
  return `<footer class="footer">
<div class="footer-inner">
<div class="footer-brand"><img src="${escape(linkTo(out, EMBLEM))}" alt="" width="320" height="320" loading="lazy"><div><strong>RiftLauncher</strong><span>${escape(t.kicker)}</span></div></div>
<nav class="icon-row" aria-label="Site">${iconLink(REPO, ICON.github, "GitHub")}${iconLink(DISCORD, ICON.discord, "Discord")}${iconLink(MODDB, ICON.moddb, "ModDB")}${iconLink(linkTo(out, "privacy.html"), ICON.privacy, t.privacy)}</nav>
<p>${fill(escape(t.unofficial), { vintageStory: link("https://www.vintagestory.at", "Vintage Story") })}</p>
<p>${fill(escape(t.fork), { vsLauncher: link("https://github.com/XurxoMF/vs-launcher", "VS Launcher"), author: link("https://github.com/XurxoMF", "XurxoMF") })}</p>
</div>
</footer>`
}

/*
 * The language control, top right of the bar beside the scene picker and built the same way: a
 * details/summary disclosure, the button showing a globe and the code of the language you are
 * reading, the panel listing every language by its own name in its own language. This is
 * navigation, so it is a plain list of links inside a native disclosure and needs no script at all;
 * the Escape key at the bottom of the page is a convenience on top, not what makes it work.
 *
 * It grows on its own as locales are added, and disappears entirely when there is only one.
 */
function languages(out, t) {
  if (LOCALES.length < 2) return ""
  const item = (locale) =>
    locale === t
      ? `<span aria-current="true" lang="${locale.code}">${escape(locale.name)}</span>`
      : `<a href="${escape(linkTo(out, landingOut(locale)))}" hreflang="${locale.code}" lang="${locale.code}">${escape(locale.name)}</a>`
  return `<details class="picker lang" id="lang">
<summary aria-label="${escape(t.changeLanguage)}" title="${escape(t.changeLanguage)}">${ICON.globe}<span>${escape(t.short)}</span></summary>
<nav class="picker-panel" aria-label="${escape(t.changeLanguage)}">${LOCALES.map(item).join("")}</nav>
</details>`
}

/** Tells search engines which page is which language, and which one to serve when it cannot tell. */
const alternates = (out) =>
  [...LOCALES.map((locale) => [locale.code, landingOut(locale)]), ["x-default", "index.html"]]
    .map(([code, target]) => `<link rel="alternate" hreflang="${code}" href="${escape(linkTo(out, target))}">`)
    .join("\n")

/*
 * The scene a first visit opens on. Lava Springs is the one the ModDB page is dressed in, so the two
 * read as the same place; after that the reader's own pick is kept for the session.
 */
const DEFAULT_SCENE = Math.max(
  catalog.findIndex((scene) => scene.id === "lava-springs"),
  0
)

/**
 * `sections` is the landing's own table of contents, [id, label] pairs shown in the bar where there
 * is room; the docs pages pass none and keep the bar to the brand and the icons.
 */
function shell({ out, title, description, body, wide, t = EN, localized = false, sections = [] }) {
  const home = linkTo(out, localized ? landingOut(t) : "index.html")
  const docs = linkTo(out, "docs/index.html")
  const asset = (name) => escape(linkTo(out, name))
  const sceneUrls = catalog.map((scene) => linkTo(out, `backgrounds/${scene.file}`))
  /*
   * The launcher's background picker, in the site's header: a button that opens the catalogue as a
   * panel of thumbnails and swaps the scene behind the page. It ships hidden and the script at the
   * bottom reveals it, so with scripting off there is no control that cannot do anything.
   */
  const picker = `<details class="picker" id="picker" hidden>
<summary aria-label="${escape(t.scene)}" title="${escape(t.scene)}">${ICON.scene}<span class="picker-name">${escape(catalog[DEFAULT_SCENE].name)}</span></summary>
<div class="picker-panel" role="group" aria-label="${escape(t.scene)}">${catalog
    .map(
      (scene, i) =>
        `<button class="tile" type="button" aria-pressed="${i === DEFAULT_SCENE}"><img src="${escape(linkTo(out, `backgrounds/${scene.thumbnail}`))}" alt="" width="320" height="180" loading="lazy"><span>${escape(scene.name)}</span></button>`
    )
    .join("")}</div>
</details>`
  const sectionNav = sections.length
    ? `<nav class="sections" aria-label="${escape(t.navLabel)}">${sections.map(([id, label]) => `<a href="#${id}">${escape(label)}</a>`).join("")}</nav>`
    : ""
  return `<!doctype html>
<html lang="${t.code}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(description)}">
<meta name="theme-color" content="#09090b">
<meta property="og:type" content="website">
<meta property="og:site_name" content="RiftLauncher">
<meta property="og:title" content="${escape(title)}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:image" content="${SITE_URL}branding/riftlauncher-full.png">
<meta property="og:url" content="${SITE_URL}${out.replace(/(^|\/)index\.html$/, "$1")}">
${out === "index.html" ? `<meta name="build-sources" content="dev:${SOURCE_REFS.dev} bg:${SOURCE_REFS.bg} rel:${SOURCE_REFS.rel} at:${SOURCE_REFS.at}">` : ""}
<meta property="og:locale" content="${t.code}">${localized ? `\n${alternates(out)}` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${asset("icon.png")}">
<link rel="stylesheet" href="${asset("site.css")}">
<style>.scene{background-image:url("${escape(sceneUrls[DEFAULT_SCENE])}")}</style>
<script>document.documentElement.className += " js"</script>
</head>
<body>
<div class="scene" id="scene"></div>
<div class="scrim"></div>
<a class="skip" href="#main">${escape(t.skip)}</a>
<header class="topbar">
<a class="brand" href="${escape(home)}"><img src="${asset(EMBLEM)}" alt="" width="320" height="320"><span>RiftLauncher</span></a>
${sectionNav}
<div class="topbar-end">
<nav class="icon-only" aria-label="Main"><a href="${escape(docs)}" aria-label="${escape(t.docsLink)}" title="${escape(t.docsLink)}">${ICON.docs}</a><a href="${RELEASES}" aria-label="${escape(t.download)}" title="${escape(t.download)}">${ICON.download}</a><a href="${REPO}" aria-label="GitHub" title="GitHub">${ICON.github}</a></nav>
${localized ? languages(out, t) : ""}
${picker}
</div>
<div class="progress" aria-hidden="true"></div>
</header>
<div class="layout${wide ? " layout-wide" : ""}">
${body}
</div>
${footer(out, t)}
<script>
(function () {
  // Scroll reveals first, so that nothing below can leave a block hidden: the stylesheet only hides
  // .reveal under the .js class the head adds, and every block gets .in as it comes into view, or
  // at once where the browser has no IntersectionObserver.
  var reveals = document.querySelectorAll(".reveal")
  var shown = function (el) { el.classList.add("in") }
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return
        shown(e.target)
        io.unobserve(e.target)
      })
    }, { rootMargin: "0px 0px -6% 0px" })
    Array.prototype.forEach.call(reveals, function (el) { io.observe(el) })

    // The bar's section links follow the reader down the landing.
    var links = document.querySelectorAll(".sections a")
    if (links.length) {
      var byId = {}
      Array.prototype.forEach.call(links, function (a) { byId[a.getAttribute("href").slice(1)] = a })
      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return
          Array.prototype.forEach.call(links, function (a) { a.removeAttribute("aria-current") })
          byId[e.target.id].setAttribute("aria-current", "location")
        })
      }, { rootMargin: "-45% 0px -50% 0px" })
      Object.keys(byId).forEach(function (id) {
        var target = document.getElementById(id)
        if (target) spy.observe(target)
      })
    }
  } else Array.prototype.forEach.call(reveals, shown)

  // One scene per visit, kept for the whole session after that, so moving between pages neither
  // reshuffles the backdrop nor reloads it. Picking a scene in the header keeps it too. The
  // stylesheet already names the default, so a reader with scripting off still gets a background.
  var s = ${JSON.stringify(sceneUrls)}
  var names = ${JSON.stringify(catalog.map((scene) => scene.name))}
  var scene = document.getElementById("scene")
  var picker = document.getElementById("picker")
  var label = picker.querySelector(".picker-name")
  var summary = picker.querySelector("summary")
  var tiles = picker.querySelectorAll(".tile")
  var remember = function (i) {
    try { sessionStorage.setItem("scene", String(i)) } catch (e) {}
  }
  function show(i) {
    scene.style.backgroundImage = 'url("' + s[i] + '")'
    label.textContent = names[i]
    for (var t = 0; t < tiles.length; t++) tiles[t].setAttribute("aria-pressed", t === i ? "true" : "false")
  }
  var kept = null
  try { kept = parseInt(sessionStorage.getItem("scene"), 10) } catch (e) {}
  if (kept === null || isNaN(kept) || kept < 0 || kept >= s.length) {
    kept = ${DEFAULT_SCENE}
    remember(kept)
  }
  show(kept)
  picker.hidden = false
  for (var i = 0; i < tiles.length; i++)
    (function (index, tile) {
      tile.addEventListener("click", function () {
        show(index)
        remember(index)
        picker.open = false
        summary.focus()
      })
      // The full scene is a great deal larger than its thumbnail, so it starts loading on hover
      // rather than on the click, and the swap looks instant.
      tile.addEventListener("pointerenter", function () { new Image().src = s[index] })
    })(i, tiles[i])
  var pops = [picker, document.getElementById("lang")].filter(Boolean)
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return
    pops.forEach(function (p) {
      if (!p.open) return
      p.open = false
      p.querySelector("summary").focus()
    })
  })
  document.addEventListener("click", function (e) {
    pops.forEach(function (p) {
      if (p.open && !p.contains(e.target)) p.open = false
    })
  })

  // The download button starts on the release page, which is right for every system. On Windows
  // and on a Linux desktop it points straight at that system's installer instead; a phone, a
  // Chromebook or a Mac keeps the release page, since there is no build for them to fetch.
  var download = document.getElementById("download")
  if (download) {
    var ua = navigator.userAgent
    var os = /Windows|Win64|Win32/.test(ua) ? "windows" : /Android|CrOS/.test(ua) ? null : /Linux|X11/.test(ua) ? "linux" : null
    var osNames = { windows: ${JSON.stringify(t.windows)}, linux: ${JSON.stringify(t.linux)} }
    if (os && download.getAttribute("data-" + os)) {
      download.href = download.getAttribute("data-" + os)
      download.querySelector("span").textContent = ${JSON.stringify(t.downloadFor)} + osNames[os]
    }
  }
})()
</script>
</body>
</html>
`
}

// ---------------------------------------------------------------- releases

/*
 * The releases come from the GitHub API here, at build time, and the section this renders is the
 * whole of it for a reader with scripting off, for a crawler, and for anyone GitHub rate-limits.
 * assets/live.js then repeats the same call from the browser and refreshes the counts in place, so
 * the numbers are current between two dispatched rebuilds. That call is the one third party this
 * site reaches on its own; everything else here still waits to be asked.
 *
 * A GitHub hiccup must not take the site down, so a failed or unreadable answer skips the section
 * with a warning and the build carries on. The link check stays strict either way.
 */
async function fetchReleases() {
  try {
    /*
     * Actions runners share their addresses, so an unauthenticated call from one is rate-limited
     * against everyone else's and answers 403 often enough to drop the section from a deploy. The
     * workflow's own token raises that limit and needs no permission beyond reading this repository.
     * A local build without one still works: it is the same anonymous call, from one address.
     */
    const token = process.env.GITHUB_TOKEN
    const response = await fetch(`https://api.github.com/repos/StratumServer/RiftLauncher/releases?per_page=100`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "RiftLauncherWebsite build",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const list = await response.json()
    if (!Array.isArray(list) || list.length === 0) throw new Error("no releases in the answer")
    return list
  } catch (error) {
    console.warn(`Releases section skipped: ${error.message}`)
    return null
  }
}

const releases = await fetchReleases()

/**
 * What the published page was built from, readable off the page itself: which commit of each source
 * branch, which release was newest, and the day it ran. Nothing polls it now that the launcher
 * repository dispatches an event when a source moves, but it is what says whether a deploy landed.
 */
const SOURCE_REFS = {
  dev: execSync("git -C .cache/dev rev-parse HEAD").toString().trim().slice(0, 12),
  bg: execSync("git -C .cache/backgrounds rev-parse HEAD").toString().trim().slice(0, 12),
  rel: releases ? String(releases[0]?.id ?? "none") : "unavailable",
  at: new Date().toISOString().slice(0, 10)
}



/** The installers, without the update feed and patch files that ship beside them. */
const installers = (release) => release.assets.filter((asset) => !/\.(ya?ml|blockmap)$/i.test(asset.name))

const totalOf = (release) => installers(release).reduce((sum, asset) => sum + asset.download_count, 0)

/**
 * The updater feed files: every installed launcher fetches its feed at each start to check for an
 * update, so their counts on the newest release approximate launcher starts since it published.
 * One per start, not unique users. latest.yml answers Windows installs, latest-linux.yml Linux.
 */
const feedChecks = (release) => ({
  windows: release.assets.find((a) => a.name === "latest.yml")?.download_count ?? 0,
  linux: release.assets.find((a) => a.name === "latest-linux.yml")?.download_count ?? 0
})

const day = (iso, t) => new Date(iso).toLocaleDateString(t.dateLocale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })

/**
 * Release notes as GitHub holds them, in the house style they were written in. Headings drop two
 * levels so the note's own `##` sits under the tag it belongs to, and any link written for the
 * repository points at the repository, since nothing in a release note resolves on this site.
 */
function notes(markdown) {
  return marked
    .parse(markdown || "", { gfm: true, async: false })
    .replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
      const demoted = Math.min(Number(level) + 2, 6)
      return `<h${demoted}>${inner}</h${demoted}>`
    })
    .replace(/\s(href|src)="([^"]*)"/g, (_, attribute, value) => ` ${attribute}="${escape(/^(?:[a-z]+:|\/\/)/i.test(value) ? value : REPO)}"`)
    .replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>")
}

/*
 * A build-time bar chart, drawn as plain SVG with no script and no library. There is no viewBox: the
 * bars are widths in percent and everything else is a fixed number of pixels, so the chart fills the
 * panel at any width while the labels stay the size they were authored at, phone included.
 *
 * Each bar is one group, translated down the chart and carrying the id of the release it counts, so
 * assets/live.js can redraw the rows from fresher counts without guessing which bar is which. That
 * script writes the same markup this does; the two have to move together.
 */
const ROW = 46

function bar(row, most, i) {
  const width = Math.max((row.count / most) * 100, 1).toFixed(2)
  // The number sits inside the bar when there is room for it, and just past the end when there is not.
  const number =
    width >= 22
      ? `<text class="bar-count-in" x="${width}%" dx="-10" y="34" text-anchor="end">${row.count}</text>`
      : `<text class="bar-count" x="${width}%" dx="10" y="34">${row.count}</text>`
  return `<g class="bar-row" data-release-id="${escape(String(row.id))}" transform="translate(0,${i * ROW})"><text class="bar-tag" x="0" y="13">${escape(row.tag)}</text><rect class="bar-track" x="0" y="21" width="100%" height="18" rx="9"/><rect class="bar-fill" x="0" y="21" width="${width}%" height="18" rx="9"/>${number}</g>`
}

const chartLabel = (rows, t) => fill(t.downloadsLabel, { rows: rows.map((row) => `${row.tag}, ${row.count}`).join(". ") })

function barChart(rows, t) {
  const most = Math.max(...rows.map((row) => row.count), 1)
  const body = rows.map((row, i) => bar(row, most, i)).join("")
  return `<svg class="chart" width="100%" height="${rows.length * ROW}" role="img" aria-label="${escape(chartLabel(rows, t))}">${body}</svg>`
}

/*
 * The GitHub API only ever reports what has been downloaded so far, never when. The workflow appends
 * one total a day to data/downloads-history.json, and this draws the curve once there is a week of
 * points to draw. Below that it draws nothing rather than an empty axis.
 */
function history() {
  const file = join(ROOT, "data", "downloads-history.json")
  const points = existsSync(file) ? JSON.parse(read(file)) : []
  if (releases) {
    const today = new Date().toISOString().slice(0, 10)
    const total = releases.reduce((sum, release) => sum + totalOf(release), 0)
    if (points[points.length - 1]?.date !== today) {
      points.push({ date: today, total, perRelease: Object.fromEntries(releases.map((release) => [release.tag_name, totalOf(release)])), feed: feedChecks(releases[0]) })
      // Only the workflow keeps the point; a local build reads the file and leaves it alone.
      if (process.env.RECORD_DOWNLOADS) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(points, null, 2)}\n`)
      }
    }
  }
  return points
}

/** Read once, since every locale's landing draws the same curve. */
const points = history()

/** The curve, or nothing at all until there are two points at least a week apart. */
function lineChart(points, t) {
  const span = (Date.parse(points[points.length - 1]?.date) - Date.parse(points[0]?.date)) / 86400000
  if (points.length < 2 || !(span >= 7)) return ""
  const totals = points.map((point) => point.total)
  const low = Math.min(...totals)
  const high = Math.max(...totals)
  const line = points
    .map((point, i) => `${(i / (points.length - 1)) * 100},${40 - ((point.total - low) / Math.max(high - low, 1)) * 36 - 2}`)
    .join(" ")
  const [first, last] = [points[0], points[points.length - 1]]
  const note = fill(t.overTimeNote, {
    firstTotal: first.total,
    firstDate: day(first.date, t),
    lastTotal: last.total,
    lastDate: day(last.date, t)
  })
  return `<h3>${escape(t.overTime)}</h3>
<svg class="curve" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points="${line}" fill="none" vector-effect="non-scaling-stroke"/></svg>
<p class="chart-note">${escape(note)}</p>`
}

/** A numbered section heading, the ModDB page's: a counter and a label above the title. */
const sectionHead = (n, id, eyebrow, title, intro = "") =>
  `<header class="section-head"><p class="eyebrow"><span class="num">${String(n).padStart(2, "0")}</span>${escape(eyebrow)}</p><h2 id="${id}-heading">${escape(title)}</h2>${intro ? `<p class="section-intro">${intro}</p>` : ""}</header>`

function releasesSection(t, n) {
  if (!releases) return ""
  const chip = `<span class="chip">${escape(t.prerelease)}</span>`
  const head = (release) => `<span class="release-tag">${escape(release.tag_name)}</span>${release.prerelease ? ` ${chip}` : ""}`
  const [latest, ...rest] = releases.slice(0, 3)
  const older = rest
    .map(
      (release) =>
        `<details class="release prose"><summary>${head(release)} <span class="release-date">${escape(day(release.published_at, t))}</span></summary>${notes(release.body)}</details>`
    )
    .join("")
  const rows = releases.map((release) => ({ id: release.id, tag: release.tag_name, count: totalOf(release) }))
  /*
   * What assets/live.js needs to redraw this section from the reader's own call to the API: the
   * strings in the language of the page it is on, and the release the notes below were rendered
   * from. One file serves every locale because everything locale-shaped is here.
   */
  const config = {
    rowHeight: ROW,
    latestId: latest.id,
    latestAt: latest.published_at,
    dateLocale: t.dateLocale,
    prerelease: t.prerelease,
    downloadsLabel: t.downloadsLabel,
    newRelease: t.newRelease
  }
  return `<section id="releases" class="panel section reveal" aria-labelledby="releases-heading" data-live-config="${escape(JSON.stringify(config))}">
${sectionHead(n, "releases", t.releases, t.releasesTitle)}
<article class="release release-latest prose">
<h3>${head(latest)} <span class="release-date">${escape(day(latest.published_at, t))}</span></h3>
${notes(latest.body)}
</article>
${older}
<div class="release chart-block prose">
${lineChart(points, t)}
<h3>${escape(t.downloads)}</h3>
${barChart(rows, t)}
<p class="chart-note">${escape(t.downloadsNote)}</p>
</div>
<p class="more"><a href="${RELEASES}">${escape(t.allReleases)}</a></p>
<script src="${escape(linkTo(landingOut(t), "live.js"))}" defer></script>
</section>`
}

// ---------------------------------------------------------------- landing

/*
 * Screenshots of the launcher itself, in the order the section shows them. The files sit in
 * assets/shots and reach the output at /shots like everything else in that folder, so a new set
 * is a file swap plus its caption in every locale. Each entry pairs with the locale's `shots`
 * list at the same index: alt text first, then the caption under the picture.
 */
const SHOTS = [
  "01-home",
  "12-installations",
  "13-servers",
  "02-mods-browse",
  "05-manage-mods-selection",
  "15-mod-health",
  "07-detail-panel",
  "14-session-report",
  "16-session-chart",
  "10-accent-teal"
]

/*
 * The animated clips recorded for the ModDB page, each with the still screenshot that stands in for
 * it when the reader asks for reduced motion. Pairs with the locale's `clips` list at the same index.
 */
const CLIPS = [
  ["mods", "02-mods-browse"],
  ["select", "05-manage-mods-selection"],
  ["check", "15-mod-health"],
  ["session", "16-session-chart"],
  ["accent", "10-accent-teal"]
]

/** Addresses the landing's prose links to, by the key a locale string names them with. */
const WEBLATE = "https://hosted.weblate.org/projects/riftlauncher/"
const urlsFor = (out) => ({
  vsLauncher: "https://github.com/XurxoMF/vs-launcher",
  xurxo: "https://github.com/XurxoMF",
  stratum: "https://github.com/StratumServer",
  contributors: linkTo(out, "docs/important-info/contributors.html"),
  privacy: linkTo(out, "privacy.html"),
  prs: `${REPO}/pulls?q=is%3Apr+is%3Amerged`,
  issues: `${REPO}/issues`,
  releases: RELEASES,
  discord: DISCORD,
  docs: linkTo(out, "docs/index.html"),
  weblate: WEBLATE,
  kofi: "https://ko-fi.com/zaldaryon",
  opencollective: "https://opencollective.com/stratum"
})

/**
 * Locale prose with links in it. `{key:label}` becomes a link to the address `urls` holds under that
 * key, the label translated in place with the rest of the sentence; a key nobody defined fails the
 * build rather than publishing a dead link.
 */
const rich = (text, urls) =>
  escape(text).replace(/\{(\w+):([^}]+)\}/g, (_, key, label) => {
    if (!(key in urls)) throw new Error(`Unknown link key {${key}:} in "${text}"`)
    return `<a href="${escape(urls[key])}">${label}</a>`
  })

/*
 * The installers on a release, by the system they are for. Anything the release does not carry
 * falls back to the release page, so a renamed file sends the reader somewhere that works.
 */
const FILES = [
  ["windows", /-setup\.exe$/i],
  ["appimage", /\.AppImage$/i],
  ["deb", /\.deb$/i],
  ["rpm", /\.rpm$/i],
  ["pacman", /\.pacman$/i]
]

function filesOf(release, t) {
  const mb = new Intl.NumberFormat(t.dateLocale, { style: "unit", unit: "megabyte", maximumFractionDigits: 0 })
  return Object.fromEntries(
    FILES.map(([key, pattern]) => {
      const asset = release?.assets.find((a) => pattern.test(a.name))
      return [key, asset ? { url: asset.browser_download_url, name: asset.name, size: mb.format(asset.size / 1048576) } : { url: release?.html_url ?? RELEASES, name: "", size: "" }]
    })
  )
}

/** Deterministic embers, so two builds of the same page are byte for byte the same. */
const embers = Array.from({ length: 14 }, (_, i) => {
  const x = (i * 37 + 11) % 100
  const size = 2 + (i % 3)
  return `<span style="--x:${x}%;--s:${size}px;--d:${6 + (i % 5) * 1.3}s;--t:${((i * 0.9) % 7).toFixed(1)}s;--dx:${((i % 7) - 3) * 12}px"></span>`
}).join("")

/**
 * One landing per locale. Every path here is worked out from the page's own depth, so the French
 * page at fr/index.html reaches the same assets one level up without a base path anywhere.
 */
function landing(t) {
  const out = landingOut(t)
  const urls = urlsFor(out)
  const at = (name) => escape(linkTo(out, name))
  const latest = releases?.[0]
  const files = filesOf(latest, t)
  const card = ([icon, title, ...texts]) =>
    `<li class="feature">${ICON[icon]}<h3>${escape(title)}</h3>${texts.map((text) => `<p>${rich(text, urls)}</p>`).join("")}</li>`
  const fileLink = (key) =>
    `<li><a class="file" href="${escape(files[key].url)}">${ICON.download}<span class="file-label">${escape(t.fileLabels[key])}</span><span class="file-size">${escape(files[key].size)}</span>${files[key].name ? `<span class="file-name">${escape(files[key].name)}</span>` : ""}</a></li>`

  const sections = [
    ["about", t.navAbout, (n) => `<section id="about" class="panel section reveal" aria-labelledby="about-heading">
${sectionHead(n, "about", t.aboutEyebrow, t.aboutTitle)}
<div class="story">
<div class="lineage"><div class="node"><img src="${at(VSL_LOGO)}" alt="VS Launcher logo" width="112" height="112" loading="lazy"><span><strong>VS Launcher</strong>${escape(t.lineage[0])}</span></div><div class="link-line"></div><div class="node"><img src="${at(EMBLEM)}" alt="" width="320" height="320" loading="lazy"><span><strong>RiftLauncher</strong>${escape(t.lineage[1])}</span></div></div>
<div>${t.about.map((text) => `<p>${rich(text, urls)}</p>`).join("")}</div>
</div>
</section>`],
    ["motion", null, (n) => `<section id="motion" class="panel section reveal" aria-labelledby="motion-heading">
${sectionHead(n, "motion", t.motionEyebrow, t.motionTitle, escape(t.motionIntro))}
<ol class="clips">${CLIPS.map(([clip, still], i) => {
      const [tag, title, first, second, alt] = t.clips[i]
      return `<li class="clip reveal"><div class="clip-media"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${at(`shots/${still}.webp`)}"><img src="${at(`moddb/${clip}.webp`)}" alt="${escape(alt)}" width="960" height="540" loading="lazy" decoding="async"></picture></div><div class="clip-text"><p class="tag">${escape(tag)}</p><h3>${escape(title)}</h3><p>${rich(first, urls)}</p><p>${rich(second, urls)}</p></div></li>`
    }).join("")}</ol>
</section>`],
    ["features", t.navFeatures, (n) => `<section id="features" class="panel section reveal" aria-labelledby="features-heading">
${sectionHead(n, "features", t.featuresEyebrow, t.features, escape(t.featuresIntro))}
<ul class="cards cards-3">${t.cards.map(card).join("")}</ul>
</section>`],
    ["shots", null, (n) => `<section id="shots" class="panel section reveal" aria-labelledby="shots-heading">
${sectionHead(n, "shots", t.shotsEyebrow, t.screenshots, escape(t.shotsIntro))}
<ul class="shots">${SHOTS.map((name, i) => {
      const [alt, caption] = t.shots[i]
      return `<li><figure class="shot"><div class="shot-frame"><img src="${at(`shots/${name}.webp`)}" alt="${escape(alt)}" width="1280" height="720" loading="lazy" decoding="async"></div><figcaption>${escape(caption)}</figcaption></figure></li>`
    }).join("")}</ul>
</section>`],
    ["trust", null, (n) => `<section id="trust" class="panel section reveal" aria-labelledby="trust-heading">
${sectionHead(n, "trust", t.trustEyebrow, t.trustTitle)}
<ul class="cards">${t.trust.map(card).join("")}</ul>
</section>`],
    ["install", t.navInstall, (n) => `<section id="install" class="panel section reveal" aria-labelledby="install-heading">
${sectionHead(n, "install", t.installEyebrow, t.installTitle, rich(t.installIntro, urls))}
<div class="os-grid">
<div class="os"><h3>${ICON.windows}${escape(t.windows)}</h3><p>${rich(t.installWindows, urls)}</p><ul class="files">${fileLink("windows")}</ul><a class="guide" href="${at("docs/get-started/installation/windows.html")}">${escape(t.guideWindows)}</a></div>
<div class="os"><h3>${ICON.linux}${escape(t.linux)}</h3><p>${rich(t.installLinux, urls)}</p><ul class="files">${["appimage", "deb", "rpm", "pacman"].map(fileLink).join("")}</ul><a class="guide" href="${at("docs/get-started/installation/linux.html")}">${escape(t.guideLinux)}</a></div>
<div class="os os-muted"><h3>${ICON.macos}macOS</h3><p>${rich(t.installMac, urls)}</p><a class="guide" href="${at("docs/get-started/installation/macos.html")}">${escape(t.guideMac)}</a></div>
</div>
<div class="notes">${t.installNotes.map(([title, text]) => `<div class="note"><h3>${escape(title)}</h3><p>${rich(text, urls)}</p></div>`).join("")}</div>
</section>`],
    ...(releases ? [["releases", t.navReleases, (n) => releasesSection(t, n)]] : []),
    ["help", t.navHelp, (n) => `<section id="help" class="panel section reveal" aria-labelledby="help-heading">
${sectionHead(n, "help", t.helpEyebrow, t.helpTitle)}
<ul class="cards cards-4">${t.help.map(card).join("")}</ul>
<p class="support">${rich(t.support, urls)}</p>
</section>`]
  ]

  const releaseLine = latest
    ? `${fill(escape(t.releaseLine), { tag: `<span class="mono">${escape(latest.tag_name)}</span>`, date: escape(day(latest.published_at, t)) })} <a href="#install">${escape(t.otherFiles)}</a>`
    : `<a href="#install">${escape(t.otherFiles)}</a>`

  const body = `<main id="main" class="landing">
<section class="hero" aria-labelledby="hero-heading">
<div class="hero-copy panel">
<p class="kicker"><span class="kicker-dot" aria-hidden="true"></span>${escape(t.kicker)}</p>
<h1 id="hero-heading">${escape(t.headline)}</h1>
<p class="lead">${escape(t.lead)}</p>
<ul class="chips">${latest ? `<li class="chip-accent">${escape(latest.tag_name)}</li>` : ""}${t.heroChips.map((chip) => `<li>${escape(chip)}</li>`).join("")}</ul>
<div class="cta"><a class="button button-primary" id="download" href="${escape(latest?.html_url ?? RELEASES)}" data-windows="${escape(files.windows.url)}" data-linux="${escape(files.appimage.url)}">${ICON.download}<span>${escape(t.download)}</span></a><a class="button button-ghost" href="${at("docs/index.html")}">${ICON.docs}<span>${escape(t.docs)}</span></a></div>
<p class="release-line">${releaseLine}</p>
${t.docsNote ? `<p class="docs-note">${escape(t.docsNote)}</p>\n` : ""}<p class="ribbon">${escape(t.beta)}</p>
</div>
<div class="hero-visual">
<div class="embers" aria-hidden="true">${embers}</div>
<div class="window"><div class="window-bar" aria-hidden="true"><span></span><span></span><span></span></div><img src="${at("shots/01-home.webp")}" alt="${escape(t.shots[0][0])}" width="1280" height="720" fetchpriority="high"></div>
<img class="hero-emblem" src="${at(EMBLEM)}" alt="" width="320" height="320">
</div>
</section>
<a class="scroll-cue" href="#motion">${escape(t.seeFeatures)}${line('<path d="M6 9l6 6 6-6"/>')}</a>
<img class="divider" src="${at("moddb/divider.webp")}" alt="" width="960" height="24" loading="lazy">
${sections.map(([, , render], i) => render(i + 1)).join("\n")}
</main>`
  const nav = sections.filter(([, label]) => label).map(([id, label]) => [id, label])
  return shell({ out, title: t.title, description: t.description, body, wide: true, t, localized: true, sections: nav })
}

/** The ids the landing defines, which is what the link check holds its anchors to. */
const LANDING_ANCHORS = ["main", "hero-heading", "about", "motion", "features", "shots", "trust", "install", "help", ...(releases ? ["releases"] : [])]

// ---------------------------------------------------------------- build

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const write = (out, content) => {
  mkdirSync(join(OUT, dirname(out)), { recursive: true })
  writeFileSync(join(OUT, out), content)
}

const anchorsByPage = new Map()

for (const page of pages.values()) {
  const { html, title, description, anchors } = render(page.repoPath)
  anchorsByPage.set(page.out, anchors)
  const body = `${sidebar(page.out, page.out)}<main id="main" class="panel prose">${html}</main>`
  write(page.out, shell({ out: page.out, title: `${title} | RiftLauncher`, description, body }))
}

for (const locale of LOCALES) {
  write(landingOut(locale), landing(locale))
  anchorsByPage.set(landingOut(locale), new Set(LANDING_ANCHORS))
}

cpSync(join(ROOT, "assets"), OUT, { recursive: true })
cpSync(join(source, "docs", ".gitbook", "assets"), join(OUT, "docs", ".gitbook", "assets"), { recursive: true })
cpSync(join(source, "branding", "riftlauncher-full.png"), join(OUT, "branding", "riftlauncher-full.png"))
cpSync(join(source, "resources", "icon.png"), join(OUT, "icon.png"))
for (const scene of catalog) {
  cpSync(join(scenes, scene.file), join(OUT, "backgrounds", scene.file))
  cpSync(join(scenes, scene.thumbnail), join(OUT, "backgrounds", scene.thumbnail))
}

// ---------------------------------------------------------------- link check

/**
 * Every internal link and image in the output has to resolve to something that exists, and every
 * anchor to a heading that exists. A docs merge that moves a file breaks links here long before
 * anyone notices in a browser, so the build refuses to finish rather than publishing them.
 */
const broken = []
const files = []
const collect = (dir) => {
  for (const entry of readdirSync(join(OUT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) collect(rel)
    else if (entry.name.endsWith(".html")) files.push(rel)
  }
}
collect("")

for (const file of files) {
  const html = readFileSync(join(OUT, file), "utf8")
  for (const [, attribute, value] of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const raw = value.replace(/&amp;/g, "&")
    if (/^(?:[a-z]+:|\/\/)/i.test(raw)) continue
    const [path, anchor] = raw.split("#")
    let target = path ? posix.normalize(posix.join(posix.dirname(file), decodeURI(path))) : file
    if (target.endsWith("/")) target += "index.html"
    if (!existsSync(join(OUT, target))) {
      broken.push(`${file}: ${attribute}="${value}" points at ${target}, which the build did not produce`)
      continue
    }
    if (anchor && target.endsWith(".html") && !anchorsByPage.get(target)?.has(anchor)) {
      broken.push(`${file}: ${attribute}="${value}" points at an anchor ${target} does not define`)
    }
  }
}

if (broken.length > 0) {
  console.error(`\n${broken.length} broken internal link${broken.length === 1 ? "" : "s"}:`)
  for (const problem of broken) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`Built ${files.length} pages into ${relative(ROOT, OUT)}, every internal link resolved.`)
