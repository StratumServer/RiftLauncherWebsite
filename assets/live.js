/*
 * Live download counts, over the releases section the build already rendered.
 *
 * The page is complete before this runs: the bars, the notes and the dates are all built from the
 * same API, read when the site was last built. This repeats that one call from the reader's browser
 * and refreshes what has moved since, which is the counts and, when a release was published after
 * the last build, the header of the newest one.
 *
 * Anything unexpected, a blocked request, a rate limit, an answer that is not the shape it should
 * be, leaves the built section exactly as it stands and says nothing to the reader. There is no
 * retry: one call per page view, or none.
 *
 * The strings and the numbers this needs are on the section as data-live-config, written by the
 * build in the language of the page, so one file serves every locale.
 */
;(function () {
  var section = document.getElementById("releases")
  if (!section) return
  var cfg
  try {
    cfg = JSON.parse(section.getAttribute("data-live-config"))
  } catch (e) {
    return
  }

  var esc = function (text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }

  var fill = function (template, values) {
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return values[key]
    })
  }

  /** The installers, without the update feed and patch files that ship beside them. Same rule as the build. */
  var totalOf = function (release) {
    return release.assets
      .filter(function (asset) {
        return !/\.(ya?ml|blockmap)$/i.test(asset.name)
      })
      .reduce(function (sum, asset) {
        return sum + asset.download_count
      }, 0)
  }

  var day = function (iso) {
    return new Date(iso).toLocaleDateString(cfg.dateLocale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
  }

  /*
   * One bar, in the markup build.mjs writes for it, so a redrawn chart is the built one with other
   * numbers in it. The two have to move together.
   */
  var bar = function (row, most, i) {
    var width = Math.max((row.count / most) * 100, 1).toFixed(2)
    var number =
      width >= 22
        ? '<text class="bar-count-in" x="' + width + '%" dx="-10" y="34" text-anchor="end">' + row.count + "</text>"
        : '<text class="bar-count" x="' + width + '%" dx="10" y="34">' + row.count + "</text>"
    return (
      '<g class="bar-row" data-release-id="' +
      esc(row.id) +
      '" transform="translate(0,' +
      i * cfg.rowHeight +
      ')"><text class="bar-tag" x="0" y="13">' +
      esc(row.tag) +
      '</text><rect class="bar-track" x="0" y="21" width="100%" height="18" rx="9"/><rect class="bar-fill" x="0" y="21" width="' +
      width +
      '%" height="18" rx="9"/>' +
      number +
      "</g>"
    )
  }

  function update(list) {
    // Read everything the answer has to carry before touching the page, so a bad one changes nothing.
    var rows = list.map(function (release) {
      if (!release || !Array.isArray(release.assets) || typeof release.tag_name !== "string") throw new Error("unexpected release")
      return { id: release.id, tag: release.tag_name, count: totalOf(release) }
    })
    var most = rows.reduce(function (top, row) {
      return Math.max(top, row.count)
    }, 1)

    // Every width is a percentage of the tallest bar, so a new release means redrawing all of them.
    var chart = section.querySelector(".chart")
    if (chart) {
      chart.innerHTML = rows
        .map(function (row, i) {
          return bar(row, most, i)
        })
        .join("")
      chart.setAttribute("height", rows.length * cfg.rowHeight)
      chart.setAttribute(
        "aria-label",
        fill(cfg.downloadsLabel, {
          rows: rows
            .map(function (row) {
              return row.tag + ", " + row.count
            })
            .join(". ")
        })
      )
    }

    var latest = list[0]
    var card = section.querySelector(".release-latest")
    var head = card && card.querySelector("h3")
    if (head && latest.id !== cfg.latestId) {
      head.querySelector(".release-tag").textContent = latest.tag_name
      var date = head.querySelector(".release-date")
      date.textContent = day(latest.published_at)
      var chip = head.querySelector(".chip")
      if (latest.prerelease && !chip) {
        chip = document.createElement("span")
        chip.className = "chip"
        chip.textContent = cfg.prerelease
        head.insertBefore(chip, date)
        head.insertBefore(document.createTextNode(" "), date)
      } else if (!latest.prerelease && chip) {
        chip.remove()
      }
    }

    /*
     * The notes under that header are still the ones the build rendered, and turning markdown into
     * HTML in the browser to replace them is not worth the code or the bytes. So when the newest
     * release is newer than the built one, the page says so in a line of its own and sends the
     * reader to the notes on GitHub rather than pretending it has them.
     */
    if (card && Date.parse(latest.published_at) > Date.parse(cfg.latestAt) && typeof latest.html_url === "string") {
      var banner = document.createElement("p")
      banner.className = "live-banner"
      var link = document.createElement("a")
      link.href = latest.html_url
      link.textContent = fill(cfg.newRelease, { tag: latest.tag_name })
      banner.appendChild(link)
      section.insertBefore(banner, card)
    }

    section.setAttribute("data-live", "1")
  }

  fetch("https://api.github.com/repos/StratumServer/RiftLauncher/releases?per_page=100", {
    headers: { accept: "application/vnd.github+json" }
  })
    .then(function (response) {
      if (!response.ok) throw new Error("GitHub answered " + response.status)
      return response.json()
    })
    .then(function (list) {
      if (!Array.isArray(list) || list.length === 0) throw new Error("no releases in the answer")
      update(list)
    })
    .catch(function (error) {
      console.debug("Live release counts skipped:", error && error.message)
    })
})()
