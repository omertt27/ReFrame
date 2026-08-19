(function () {
  var KNOWN = [];
  var SECTIONS = []; // ordered top-level section names for the current route
  var sectionEls = []; // parallel array of DOM elements, same order as SECTIONS
  var draggedIndex = -1;
  var draggedName = null;
  var lastSelectedElement = null; // re-queried after a write to verify it actually applied

  // Mirrors packages/core's EDITABLE_PROPERTIES cssProperty values — kept
  // as a plain list here since this script has no access to that module
  // (a static file injected into someone else's page, not bundled).
  // "padding" specifically reads computed paddingTop, not the shorthand
  // `padding` property (which can read back as "16px 20px" when sides
  // differ) — matches this model's existing "padding is one uniform
  // number" simplification, same one readProperty's Tailwind path makes.
  var COMPUTED_STYLE_KEYS = {
    height: "height",
    width: "width",
    padding: "paddingTop",
    textColor: "color",
    backgroundColor: "backgroundColor",
    fontSize: "fontSize",
    fontWeight: "fontWeight",
    lineHeight: "lineHeight",
    letterSpacing: "letterSpacing",
  };

  function computedStyleFor(el) {
    var computed = getComputedStyle(el);
    var out = {};
    for (var key in COMPUTED_STYLE_KEYS) {
      out[key] = computed[COMPUTED_STYLE_KEYS[key]];
    }
    return out;
  }

  // "#3B82F6" -> "rgb(59, 130, 246)", matching getComputedStyle's own
  // output format exactly (browsers always normalize computed color to
  // rgb()/rgba(), regardless of source syntax) — plain arithmetic, no DOM
  // needed, so this works the same server-side and client-side. Named
  // colors and var() references are deliberately NOT normalized here (no
  // DOM/canvas available server-side to resolve them reliably) — callers
  // skip the cross-check for those rather than risk a false mismatch.
  function hexToRgb(hex) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return "rgb(" + r + ", " + g + ", " + b + ")";
  }

  // Shared by the initial selection cross-check and post-write
  // verification — same tolerance/skip rules in both places (see
  // apps/dev/host.ts's crossCheckAgainstComputed, which intentionally
  // duplicates this rather than sharing code across the Node/browser
  // boundary). Dimensions: parseFloat within half a pixel (rounding);
  // "normal"/unparseable counts as a mismatch when a value was predicted.
  // Colors: only cross-checked when the predicted value is a plain hex
  // string; anything else (named, rgb(), var()) can't be normalized
  // without a browser DOM, so it's skipped (returns null: "can't verify",
  // not "mismatch") rather than risking a false refusal.
  // `property` is optional (dimension checks only) — needed for the
  // lineHeight special case below; color checks never pass it.
  function computedMatches(kind, predicted, computedRaw, property, el) {
    if (kind === "color") {
      var predictedRgb = hexToRgb(predicted);
      if (!predictedRgb) return null; // can't normalize this form — don't guess
      return predictedRgb === computedRaw;
    }
    var actual = parseFloat(computedRaw);
    if (Number.isNaN(actual)) return false; // e.g. "normal" when a value was predicted
    if (Math.abs(actual - predicted) < 0.5) return true;
    // lineHeight has a genuinely dual CSS meaning: a unitless number (React's
    // default form for a plain JS number) is a MULTIPLIER of the element's
    // own font-size, not an absolute pixel value — computed style always
    // resolves it to px regardless. Verified live against PrivaPDF's real
    // about-summary paragraph (lineHeight: 1.6, fontSize: 17px -> computed
    // "27.2px") as a false-positive mismatch warning before this fix — the
    // server-side pre-write cross-check in host.ts hit the identical bug
    // first; this is the same fix applied to this separate, client-side
    // post-write comparison path.
    if (property === "lineHeight" && el) {
      var fontSizePx = parseFloat(getComputedStyle(el).fontSize);
      if (!Number.isNaN(fontSizePx) && Math.abs(predicted * fontSizePx - actual) < 0.5) return true;
    }
    return false;
  }

  var style = document.createElement("style");
  style.textContent =
    "[data-reframe-section]{transition:outline-color .1s ease;outline:2px solid transparent;outline-offset:-2px;cursor:grab;}" +
    "[data-reframe-section]:hover{outline-color:rgba(244,163,64,0.55);}" +
    "[data-reframe-section].reframe-dragging{opacity:0.35;cursor:grabbing;}" +
    "[data-reframe-section].reframe-drop-target{outline-color:#f4a340;outline-width:3px;background-color:rgba(244,163,64,0.06);}";
  document.head.appendChild(style);

  function getFiber(node) {
    var key = Object.keys(node).find(function (k) {
      return k.indexOf("__reactFiber$") === 0;
    });
    return key ? node[key] : null;
  }

  function matchName(fiber, names) {
    var fn = fnMatchName(fiber, names);
    if (fn) return fn;
    return debugInfoMatchName(fiber, names);
  }

  // A component fiber's own type.name/displayName — only real for actual
  // client-rendered function components. This match is exact and final: the
  // fiber it fires on already IS the correct anchor (findSectionElements and
  // the pre-existing component-only click resolution both rely on that), so
  // resolveClick below never extends past it.
  function fnMatchName(fiber, names) {
    if (fiber.type && typeof fiber.type === "function") {
      var n = fiber.type.name || fiber.type.displayName;
      if (n && names.indexOf(n) !== -1) return n;
    }
    return null;
  }

  // Server Components leave no fiber of their own — _debugInfo is how the
  // client tree remembers which server component produced a piece of JSX.
  // Verified empirically against a real, unmodified production page
  // (PrivaPDF's AboutPage, a plain `<>{scripts}<nav/><main>...</main></>`
  // with zero nested components): this debugInfo is NOT confined to the
  // single literal return value the way it was on the synthetic fixture
  // used to design this — it also shows up on `main` itself, an immediate
  // host child of the returned Fragment, one level short of the actual
  // root. See resolveClick's chain-extension for how the true anchor is
  // recovered from that.
  function debugInfoMatchName(fiber, names) {
    if (fiber._debugInfo) {
      for (var i = 0; i < fiber._debugInfo.length; i++) {
        var d = fiber._debugInfo[i];
        if (d && d.env === "Server" && d.name && names.indexOf(d.name) !== -1) return d.name;
      }
    }
    return null;
  }

  // Element-producing = would appear as a t.isJSXElement in the AST (host
  // tags and component invocations) — deliberately excludes Fragment/
  // Context/Suspense/memo-wrapper fibers, matching jsxChildren's filter on
  // the server side. Both sides MUST agree on this or indices drift.
  function isElementProducing(fiber) {
    return typeof fiber.type === "string" || typeof fiber.type === "function";
  }

  // Name of the function component whose OWN JSX literally created this
  // fiber — React's dev-mode "owner" pointer, distinct from fiber.return
  // (the render tree parent). Only meaningful for client-rendered fibers;
  // Server Component output (reached via _debugInfo, not real client
  // fibers) never sets it, in which case this returns null and every
  // caller below treats that as "no constraint, don't filter" — a graceful
  // no-op for the Server Component case this was originally verified
  // against, and the reason it was safe to bolt on afterward without
  // re-touching that path.
  function ownerName(fiber) {
    var owner = fiber._debugOwner;
    if (!owner || typeof owner.type !== "function") return null;
    return owner.type.name || owner.type.displayName || null;
  }

  // Index of `fiber` among its parent's element-producing children — the
  // same index space as pageSectionOrder/moveChild/resolveElementPath.
  // Verified live against PrivaPDF's real /convert page: a plain
  // `<Link>Priva<span>PDF</span></Link>` (one JSXElement in the source)
  // expands, on the client, into several extra fiber layers for Link's own
  // implementation (an inner <a>, a context provider) that don't exist in
  // the AST at all. Left unfiltered, those inflate the sibling count and
  // drift `path` off the intended element. Restricting the count to
  // siblings that share `fiber`'s own owner (when it has one) collapses
  // that whole foreign subtree back down to the single slot it actually
  // occupies in the JSX that was literally written.
  //
  // `cursor === fiber` alone isn't enough: verified live on PrivaPDF's real
  // homepage (more interactive/complex than every page tested before it —
  // this never surfaced against simpler pages) that React can hand back the
  // *alternate* buffer copy of a node when walking down via `.child`/
  // `.sibling`, while the walk up to get here used the *current* copy (or
  // vice versa) — React keeps two fiber objects per position for
  // reconciliation (`fiber.alternate` links them), and `.return`/`.child`
  // don't always agree on which copy they hand back for the very same JSX
  // position. Left unhandled, the position is never found, its index is
  // silently dropped (not merely wrong), and every level above it in the
  // path collapses by one. Treating `fiber` and `fiber.alternate` as the
  // same position fixes it without touching the counting logic itself: a
  // fiber's type/owner are identical between its two copies, so whichever
  // copy `cursor` happens to be, the isElementProducing/ownerName checks
  // below are unaffected.
  function siblingIndex(fiber) {
    var parent = fiber.return;
    if (!parent) return -1;
    var wantOwner = ownerName(fiber);
    var index = 0;
    var cursor = parent.child;
    while (cursor) {
      if (cursor === fiber || cursor === fiber.alternate) return index;
      if (isElementProducing(cursor) && (wantOwner === null || ownerName(cursor) === wantOwner)) index++;
      cursor = cursor.sibling;
    }
    return -1;
  }

  // Walks fiber.return from the clicked leaf, same direction as the
  // original component-only resolveClick, but also accumulates an
  // ElementPath: the sequence of sibling indices from the matched
  // component's AST root (packages/core's ComponentDef.rootElement) down
  // to the clicked leaf. path: [] means the component's own root was
  // clicked (identical to the old behavior).
  //
  // Finding that root fiber takes two passes, not one:
  //  1. Walk up collecting the whole ancestor chain, and find the FIRST
  //     fiber (closest to the leaf) that matches a known component, either
  //     by fn identity (a real client-component fiber — exact and final,
  //     no further walking needed) or by _debugInfo (a Server Component
  //     boundary marker).
  //  2. For a debugInfo match specifically, keep extending outward through
  //     any consecutive ancestors that carry the SAME debugInfo name. This
  //     is required because that marker is not confined to the literal
  //     return value the way it looked on the synthetic fixture this was
  //     first designed against — verified on a real, unmodified production
  //     page (PrivaPDF's AboutPage) it also lands on `main`, an immediate
  //     host child of the returned Fragment, one level short of the actual
  //     root; only the Fragment fiber above it is the true anchor. Fn
  //     matches don't get this treatment: extending past a real component
  //     fiber would walk into its *caller*, not deeper into its own render.
  //
  // The fiber that directly corresponds to the matched component's own
  // rootElement differs by match kind: a debugInfo match (after extension)
  // already lands ON that fiber. An fn match lands on the component's own
  // invocation fiber instead — its RENDER OUTPUT, one level further down
  // the chain (chain[anchorIndex - 1]), is the actual root. That fiber
  // itself is never indexed (nothing "above" it, within the component's own
  // JSX, that it's a child of) — verified live against PrivaPDF's real
  // /convert page, where skipping this produced a spurious leading index
  // otherwise (path: [0,0,0,0,0] instead of the correct [0,0,0]).
  function resolveClick(target) {
    var fiber = getFiber(target);
    if (!fiber) return null;

    var chain = [];
    var depth = 0;
    while (fiber && depth < 60) {
      chain.push(fiber);
      fiber = fiber.return;
      depth++;
    }

    var anchorIndex = -1;
    var matchedName = null;
    var matchedVia = null;
    for (var i = 0; i < chain.length; i++) {
      var fnName = fnMatchName(chain[i], KNOWN);
      if (fnName) {
        anchorIndex = i;
        matchedName = fnName;
        matchedVia = "fn";
        break;
      }
      var dbName = debugInfoMatchName(chain[i], KNOWN);
      if (dbName) {
        anchorIndex = i;
        matchedName = dbName;
        matchedVia = "debugInfo";
        var j = i + 1;
        while (j < chain.length && debugInfoMatchName(chain[j], KNOWN) === matchedName) {
          anchorIndex = j;
          j++;
        }
        break;
      }
    }
    if (anchorIndex === -1) return null;

    var rootFiberIndex = matchedVia === "fn" ? anchorIndex - 1 : anchorIndex;
    var path = [];
    for (var k = 0; k < rootFiberIndex; k++) {
      var owner = ownerName(chain[k]);
      if (owner !== null && owner !== matchedName) continue; // foreign component's own internals, not literal JSX here
      if (isElementProducing(chain[k])) {
        var idx = siblingIndex(chain[k]);
        if (idx >= 0) path.push(idx);
      }
    }
    path.reverse();
    return { component: matchedName, path: path };
  }

  // Finds the outermost DOM element for each name in `names`, walking the
  // tree top-down and never descending into an already-matched section —
  // this is what makes it "top-level only": a name nested two components
  // deep inside another section is never returned as a separate hit.
  function findSectionElements(names) {
    var found = {};
    var remaining = names.length;

    function walk(node) {
      if (remaining === 0 || node.nodeType !== 1) return;
      var fiber = getFiber(node);
      if (fiber) {
        var name = matchName(fiber, names);
        if (name && !found[name]) {
          found[name] = node;
          remaining--;
          return; // don't descend into a matched section's own subtree
        }
      }
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
    walk(document.body);
    return found;
  }

  function clearDropTargets() {
    for (var i = 0; i < sectionEls.length; i++) {
      sectionEls[i].classList.remove("reframe-drop-target");
    }
  }

  function setupDragAndDrop() {
    fetch("/__reframe/sections?route=" + encodeURIComponent(window.location.pathname))
      .then(function (r) {
        return r.json();
      })
      .then(function (sections) {
        // sections: [{name, index}], where `index` is the REAL position
        // among ALL the page's JSX element children (moveChild's index
        // space) — NOT the position within this sections-only array. A page
        // can have other, non-component elements interspersed, so those two
        // spaces differ; always use section.index, never the array position.
        SECTIONS = sections;
        var names = sections.map(function (s) {
          return s.name;
        });

        // React attaches fiber pointers to DOM nodes during hydration, which
        // happens asynchronously after this script runs — retry until every
        // section is found rather than racing it with a single attempt.
        var attempts = 0;
        var timer = setInterval(function () {
          attempts++;
          var found = findSectionElements(names);
          var all = names.every(function (n) {
            return found[n];
          });
          if (all || attempts > 40) {
            clearInterval(timer);
            wireUpSections(
              sections.map(function (s) {
                return found[s.name];
              }),
            );
          }
        }, 150);
      });
  }

  function wireUpSections(elements) {
    sectionEls = elements;
    sectionEls.forEach(function (el, i) {
      if (!el) return;
      var realIndex = SECTIONS[i].index;
      el.setAttribute("data-reframe-section", SECTIONS[i].name);
      el.draggable = true;

      el.addEventListener("dragstart", function (event) {
        draggedIndex = realIndex;
        draggedName = SECTIONS[i].name;
        el.classList.add("reframe-dragging");
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", function () {
        el.classList.remove("reframe-dragging");
        clearDropTargets();
        draggedIndex = -1;
      });
      el.addEventListener("dragover", function (event) {
        if (draggedIndex === -1) return;
        event.preventDefault();
        if (realIndex !== draggedIndex) {
          clearDropTargets();
          el.classList.add("reframe-drop-target");
        }
      });
      el.addEventListener("drop", function (event) {
        event.preventDefault();
        clearDropTargets();
        if (draggedIndex === -1 || realIndex === draggedIndex) return;
        window.parent.postMessage(
          {
            source: "reframe-preload",
            type: "reorder",
            route: window.location.pathname,
            fromIndex: draggedIndex,
            toIndex: realIndex,
            fromName: draggedName,
            toName: SECTIONS[i].name,
          },
          "*",
        );
      });
    });
  }

  fetch("/__reframe/components")
    .then(function (r) {
      return r.json();
    })
    .then(function (list) {
      KNOWN = list;
      setupDragAndDrop();
    });

  document.addEventListener(
    "click",
    function (event) {
      var resolved = resolveClick(event.target);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      lastSelectedElement = event.target;
      var rect = event.target.getBoundingClientRect();
      window.parent.postMessage(
        {
          source: "reframe-preload",
          type: "select",
          component: resolved.component,
          path: resolved.path,
          elementTag: event.target.tagName ? event.target.tagName.toLowerCase() : null,
          route: window.location.pathname,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          computedStyle: computedStyleFor(event.target),
        },
        "*",
      );
    },
    true,
  );

  // Post-write verification: the host page asks (after giving HMR a moment
  // to settle) whether the element it edited actually changed the way the
  // edit intended. Re-reads the SAME DOM node kept from the original click
  // — React Fast Refresh preserves node identity for a plain style/prop
  // change, so this doesn't need to re-run fiber resolution. `matches:
  // null` means "couldn't verify this value form" (e.g. a named/var()
  // color) — the caller should treat that as "unknown", not as a failure.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "reframe-verify-computed-style") return;
    if (!lastSelectedElement || !lastSelectedElement.isConnected) {
      window.parent.postMessage({ source: "reframe-preload", type: "computed-style-result", requestId: data.requestId, matches: null, actual: null }, "*");
      return;
    }
    var computed = getComputedStyle(lastSelectedElement);
    var actual = computed[COMPUTED_STYLE_KEYS[data.property]];
    var matches = computedMatches(data.kind, data.expected, actual, data.property, lastSelectedElement);
    window.parent.postMessage(
      { source: "reframe-preload", type: "computed-style-result", requestId: data.requestId, matches: matches, actual: actual },
      "*",
    );
  });
})();
