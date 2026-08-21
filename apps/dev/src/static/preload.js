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
    fontFamily: "fontFamily",
    // Not an EDITABLE_PROPERTIES key — element metadata, not a property
    // value — but computedStyleFor's loop is generic over whatever's in
    // this map, and this is the cheapest way to get it to the server: CSS
    // ignores width/height entirely on an inline element, so the server
    // needs to know the computed display to refuse those two up front
    // rather than let a doomed-to-fail write happen at all.
    display: "display",
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
    "[data-reframe-section].reframe-drop-target{outline-color:#f4a340;outline-width:3px;background-color:rgba(244,163,64,0.06);}" +
    ".reframe-hover-outline{outline:1.5px dashed rgba(99,102,241,0.55) !important;outline-offset:-1.5px !important;cursor:pointer !important;}" +
    "#reframe-insertion-line{position:fixed;height:3px;background:#f4a340;border-radius:2px;box-shadow:0 0 0 3px rgba(244,163,64,0.18);pointer-events:none;z-index:2147483647;display:none;}";
  document.head.appendChild(style);

  // The precise "it will land HERE" affordance — a thin line at the exact
  // edge (top or bottom half, whichever the pointer is over) of the hovered
  // section, replacing "which section glowed" as the thing a user reads to
  // predict the drop outcome. The whole-section outline above stays too
  // (still useful to see WHICH section is being considered at a glance) but
  // the line is what answers "before or after it, exactly."
  var insertionLine = document.createElement("div");
  insertionLine.id = "reframe-insertion-line";
  document.body.appendChild(insertionLine);
  function showInsertionLine(rect, before) {
    insertionLine.style.left = rect.left + "px";
    insertionLine.style.width = rect.width + "px";
    insertionLine.style.top = (before ? rect.top : rect.bottom) - 1.5 + "px";
    insertionLine.style.display = "block";
  }
  function hideInsertionLine() {
    insertionLine.style.display = "none";
  }

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

  // React's internal fiber WorkTag numbers for a real, invocable component
  // (FunctionComponent, ClassComponent, ForwardRef, MemoComponent,
  // SimpleMemoComponent) — as opposed to a host tag (5), Fragment (7), or a
  // Context Provider/Consumer (9/10), which a wrapper's OWN implementation
  // commonly interposes without ever appearing as a literal JSXElement
  // anywhere. Undocumented, unstable-in-principle React internals, same
  // trust level this whole file already runs on (_debugOwner/_debugInfo
  // are no more "public API" than this) — verified against the React
  // version this session's real test projects (PrivaPDF on React 19,
  // Excalidraw) both ship. Used only where ownerType has nothing to say
  // (see the path loop below) — client-owned fibers keep using ownerType,
  // which needs no version-fragile tag numbers at all.
  var REAL_COMPONENT_TAGS = { 0: true, 1: true, 11: true, 14: true, 15: true };
  function isRealComponentFiber(fiber) {
    return !!REAL_COMPONENT_TAGS[fiber.tag];
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

  // The raw `_debugOwner.type` reference for a fiber — identifies which
  // component's render call literally created this JSX, by object identity
  // rather than by name. Needed alongside ownerName (not instead of it):
  // ownerName is required wherever a match has to be checked against KNOWN
  // (a list of source-derived string names), but for just testing "is this
  // fiber part of the SAME owner as that other fiber," reference identity
  // is both sufficient and strictly more robust — a `forwardRef`'s own
  // inner render function is often anonymous with no discoverable name at
  // all (verified live on Excalidraw's real Island: its inner function has
  // no name and no displayName, not even one assigned by Fast Refresh's own
  // wrapping, which renames it to a meaningless "_c"), so a name-based
  // owner check silently falls back to "no constraint" for every fiber
  // Island itself authors — wrongly letting Island's own internal wrapper
  // elements leak into a path meant only for a component ONE LEVEL OUT
  // (e.g. Toolbar, which authors `<Island>` itself but not what's inside
  // Island's own render). Reference identity never depends on a name
  // existing at all.
  function ownerType(fiber) {
    var owner = fiber._debugOwner;
    // Not just `owner ? ... : null` — a Server-Component-authored element
    // (verified live: PrivaPDF's Home page, a plain Next.js App Router
    // page/layout) DOES carry a truthy _debugOwner, but shaped like a
    // debugInfo record ({name, env: "Server", ...}) instead of a real
    // fiber — `.type` is simply undefined there, not present at all. Only
    // a REAL client fiber owner has a usable `.type` (function or
    // forwardRef/memo object); treat anything else as "no owner info",
    // same as no _debugOwner at all, so callers fall through to the
    // dedicated Server-Component handling instead of misreading `undefined
    // !== null` as a real, distinct owner identity.
    return owner && owner.type ? owner.type : null;
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
    var wantOwner = ownerType(fiber);
    var index = 0;
    var cursor = parent.child;
    while (cursor) {
      if (cursor === fiber || cursor === fiber.alternate) return index;
      if (isElementProducing(cursor) && (wantOwner === null || ownerType(cursor) === wantOwner)) index++;
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
  // Finding that root fiber takes three passes, not one:
  //  0. Check the clicked leaf's own owner (who authored ITS literal JSX,
  //     not which ancestor fiber is nearest) against known components
  //     first. This must run before the nearest-ancestor pass below: a
  //     children-forwarding wrapper (Island, Card, anything rendering
  //     `{children}`) can be the nearest ancestor fiber by identity while
  //     having no literal JSX of its own to resolve a path against — the
  //     leaf's actual owner is the component whose path CAN be resolved.
  //  1. Walk up collecting the whole ancestor chain, and find the FIRST
  //     fiber (closest to the leaf) that matches a known component, either
  //     by fn identity (a real client-component fiber — exact and final,
  //     no further walking needed) or by _debugInfo (a Server Component
  //     boundary marker). Only reached when pass 0 finds no owner match.
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

    // Prefer the OWNER of the clicked leaf itself — the component whose own
    // JSX literally created this element — over the nearest ancestor fiber
    // by identity. A children-forwarding wrapper (e.g. Island: renders
    // `{children}` from its props) can sit closer to the leaf in the render
    // tree than the component that actually authored the clicked JSX, but
    // the wrapper's own source has no literal representation of what was
    // passed to it — anchoring there can never resolve a path past it.
    // ownerName follows React's dev-mode owner stack, which is set at the
    // JSX-creation call site and so already skips over any number of such
    // wrappers regardless of nesting depth. Verified live against
    // Excalidraw's real Island wrapper: clicks nested inside it always
    // refused ("can't be edited safely") without this — the actual owning
    // component (Toolbar) and its literal JSX for the clicked element both
    // exist, they just weren't the fiber this used to anchor on.
    var leafOwner = ownerName(chain[0]);
    if (leafOwner && KNOWN.indexOf(leafOwner) !== -1) {
      for (var o = 0; o < chain.length; o++) {
        if (fnMatchName(chain[o], [leafOwner])) {
          anchorIndex = o;
          matchedName = leafOwner;
          matchedVia = "fn";
          break;
        }
      }
    }

    if (anchorIndex === -1) {
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
    }
    if (anchorIndex === -1) return null;

    var rootFiberIndex = matchedVia === "fn" ? anchorIndex - 1 : anchorIndex;
    // Reference identity, not name — see ownerType's own comment. Only
    // meaningful for "fn" matches (a real fiber whose .type IS the matched
    // component); for "debugInfo" matches this is null for every fiber in
    // that range anyway (ownerType already normalizes a Server-Component
    // owner record to null), so the comparison below is always a no-op
    // there — the dedicated "no owner info" branch is what actually
    // matters for that case.
    var matchedOwnerType = matchedVia === "fn" ? chain[anchorIndex].type : null;
    var path = [];
    // Set true the moment the path is redirected to stop at a component
    // invocation boundary (see below) rather than the exact clicked DOM
    // leaf — the caller's `elementTag` tag-mismatch safety check compares
    // against the ORIGINAL clicked DOM tag (e.g. "a"), which is legitimately
    // different from a component's own JSX source tag name once this
    // happens (e.g. `<Link>`) and can't be reliably re-derived client-side
    // (the JSX tag is whatever LOCAL name the source imported it under —
    // "Link" here — which has no reliable relationship to the component
    // function's own internal name, e.g. next/link's actual implementation
    // isn't necessarily named "Link" internally). Skip that check entirely
    // rather than compare against a guess.
    var pathHitBoundary = false;
    for (var k = 0; k < rootFiberIndex; k++) {
      var oType = ownerType(chain[k]);
      if (oType !== null) {
        // Client-owned fiber — trust ownership fully, same as before.
        if (oType !== matchedOwnerType) continue; // foreign component's own internals, not literal JSX here
        if (isElementProducing(chain[k])) {
          var idxOwned = siblingIndex(chain[k]);
          if (idxOwned >= 0) path.push(idxOwned);
        }
        continue;
      }
      // No owner info at all — the common case for anything inside a
      // Server Component's own render (e.g. a Next.js App Router
      // page/layout: nothing below its debugInfo boundary carries
      // _debugOwner). Ownership can't answer "is this really part of the
      // matched component's own JSX" here, but a REAL component
      // invocation marks the identical kind of boundary: everything BELOW
      // it (closer to the leaf, walked already) is that component's OWN
      // internal render — e.g. next/link's `<a>` plus the context
      // provider it wraps that around — not literal JSX the page wrote.
      // The component invocation itself (e.g. `<Link style={{...}}>`) IS
      // real JSX the page wrote directly, so it becomes the new deepest
      // path point: discard everything collected so far and restart from
      // here. Verified live against PrivaPDF's real `/` page and its
      // `<Link href="/convert">` — without this, `<a>` and Link's own
      // invocation fiber both got indexed as if they were two separate,
      // literal JSXElements in Home's source, corrupting the path and
      // making the click resolve to the page's own root instead.
      if (isRealComponentFiber(chain[k])) {
        path = [];
        pathHitBoundary = true;
        var idxBoundary = siblingIndex(chain[k]);
        if (idxBoundary >= 0) path.push(idxBoundary);
        continue;
      }
      if (isElementProducing(chain[k])) {
        var idx = siblingIndex(chain[k]);
        if (idx >= 0) path.push(idx);
      }
    }
    path.reverse();
    return { component: matchedName, path: path, skipTagCheck: pathHitBoundary };
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

  var dropBefore = false; // which half of the current drop-target section the pointer is over

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
        hideInsertionLine();
        draggedIndex = -1;
      });
      el.addEventListener("dragover", function (event) {
        if (draggedIndex === -1) return;
        event.preventDefault();
        if (realIndex !== draggedIndex) {
          clearDropTargets();
          el.classList.add("reframe-drop-target");
          var rect = el.getBoundingClientRect();
          dropBefore = event.clientY - rect.top < rect.height / 2;
          showInsertionLine(rect, dropBefore);
        } else {
          hideInsertionLine();
        }
      });
      el.addEventListener("drop", function (event) {
        event.preventDefault();
        clearDropTargets();
        hideInsertionLine();
        if (draggedIndex === -1 || realIndex === draggedIndex) return;
        window.parent.postMessage(
          {
            source: "reframe-preload",
            type: "reorder",
            route: window.location.pathname,
            fromIndex: draggedIndex,
            toIndex: realIndex,
            insertBefore: dropBefore,
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

  // Hover affordance — matching Wix/Canva's "you can see what's clickable
  // before you click it," which this editor lacked entirely outside the
  // page-section drag targets above. Reuses resolveClick itself (not a
  // separate lighter check) so the outline only ever appears where a click
  // would actually do something — an outline over dead space would be
  // exactly the "fake affordance" this project's whole philosophy refuses
  // to ship (see the inline-display resize-handle fix for the same
  // principle applied elsewhere). Gated on event.target identity so it
  // only recomputes resolveClick when the hovered DOM node actually
  // changes, not on every pixel of mousemove within the same element.
  var lastHoverElement = null;
  function clearHover() {
    if (lastHoverElement) {
      lastHoverElement.classList.remove("reframe-hover-outline");
      lastHoverElement = null;
    }
  }
  document.addEventListener("mouseover", function (event) {
    if (event.target === lastHoverElement) return;
    var resolved = resolveClick(event.target);
    clearHover();
    if (resolved) {
      event.target.classList.add("reframe-hover-outline");
      lastHoverElement = event.target;
    }
  });
  document.addEventListener("mouseout", function (event) {
    if (event.target === lastHoverElement) clearHover();
  });
  document.documentElement.addEventListener("mouseleave", clearHover);

  // `lastSelection` tracks the resolved {component, path} alongside
  // `lastSelectedElement`'s DOM node — the keyboard-navigation helpers below
  // need to know when a candidate ancestor/sibling resolves to something
  // DIFFERENT from what's already selected (see climbToParent), not just
  // "resolves to anything."
  var lastSelection = null;
  function selectElement(el, resolved) {
    lastSelectedElement = el;
    lastSelection = { component: resolved.component, path: resolved.path };
    var rect = el.getBoundingClientRect();
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    window.parent.postMessage(
      {
        source: "reframe-preload",
        type: "select",
        component: resolved.component,
        path: resolved.path,
        elementTag: resolved.skipTagCheck ? null : el.tagName ? el.tagName.toLowerCase() : null,
        route: window.location.pathname,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        computedStyle: computedStyleFor(el),
      },
      "*",
    );
  }

  document.addEventListener(
    "click",
    function (event) {
      var resolved = resolveClick(event.target);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      selectElement(event.target, resolved);
    },
    true,
  );

  // Selection-navigation keyboard shortcuts (Escape/Tab/Shift+Tab), reusing
  // resolveClick itself rather than any separate path-arithmetic — same "no
  // fake affordance" principle as the hover outline above: a shortcut only
  // ever lands somewhere a real click could also have landed. Escape climbs
  // DOM ancestors until one resolves to a DIFFERENT element than what's
  // already selected (the immediate parentElement usually resolves back to
  // the SAME meaningful element resolveClick would have anchored on anyway
  // — that's not "no parent," it's "keep climbing"). Tab/Shift+Tab only walk
  // real DOM siblings at the current level — crossing up into a different
  // parent isn't attempted, so hitting the end of a sibling list is a no-op
  // rather than a guess about what "next" should mean up a level.
  function climbToParent(el) {
    var node = el.parentElement;
    var depth = 0;
    while (node && depth < 60) {
      var resolved = resolveClick(node);
      if (resolved && (!lastSelection || resolved.component !== lastSelection.component || JSON.stringify(resolved.path) !== JSON.stringify(lastSelection.path))) {
        return { el: node, resolved: resolved };
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }
  function siblingTarget(el, direction) {
    var node = direction === "next" ? el.nextElementSibling : el.previousElementSibling;
    while (node) {
      var resolved = resolveClick(node);
      if (resolved) return { el: node, resolved: resolved };
      node = direction === "next" ? node.nextElementSibling : node.previousElementSibling;
    }
    return null;
  }
  document.addEventListener("keydown", function (event) {
    if (!lastSelectedElement || !lastSelectedElement.isConnected) return;
    var t = event.target;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    if (event.key === "Escape") {
      var parent = climbToParent(lastSelectedElement);
      if (parent) {
        event.preventDefault();
        selectElement(parent.el, parent.resolved);
      }
    } else if (event.key === "Tab") {
      var sib = siblingTarget(lastSelectedElement, event.shiftKey ? "prev" : "next");
      if (sib) {
        event.preventDefault();
        selectElement(sib.el, sib.resolved);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      enterInlineTextEdit(lastSelectedElement);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      window.parent.postMessage({ source: "reframe-preload", type: "delete-key" }, "*");
    }
  });

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

  // Device-viewport switch: resizing the iframe moves/reflows whatever was
  // selected, so the host asks for a fresh getBoundingClientRect() on the
  // SAME DOM node (identity preserved — this isn't a navigation or remount)
  // rather than re-running fiber resolution from scratch.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "reframe-get-rect") return;
    if (!lastSelectedElement || !lastSelectedElement.isConnected) {
      window.parent.postMessage({ source: "reframe-preload", type: "rect-result", requestId: data.requestId, rect: null }, "*");
      return;
    }
    var r = lastSelectedElement.getBoundingClientRect();
    window.parent.postMessage(
      { source: "reframe-preload", type: "rect-result", requestId: data.requestId, rect: { x: r.x, y: r.y, width: r.width, height: r.height } },
      "*",
    );
  });

  // The toolbar's steppers (font size, etc.) need a real starting value
  // when a property isn't explicitly set on the element at all yet
  // (inherited from a parent or the browser default) — verified live that
  // defaulting to 0 there produces exactly the bug this exists to prevent
  // (a user's real fontSize stepper click wrote `fontSize: 2` to an
  // element that was actually rendering at 16px, inherited — 0 + 1 + 1,
  // never what anyone wanted). Reuses computedStyleFor, the SAME reader
  // already used at selection time, so the reported baseline always
  // matches what's actually on screen right now.
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "reframe-get-computed") return;
    if (!lastSelectedElement || !lastSelectedElement.isConnected) {
      window.parent.postMessage({ source: "reframe-preload", type: "computed-result", requestId: data.requestId, computed: null }, "*");
      return;
    }
    window.parent.postMessage(
      { source: "reframe-preload", type: "computed-result", requestId: data.requestId, computed: computedStyleFor(lastSelectedElement) },
      "*",
    );
  });

  // Live drag-resize preview: the host page drags a handle on its own
  // overlay (drawn from the `rect` sent above) and streams the in-progress
  // size here on every pointermove, purely visual — nothing is written to
  // source until the drag ends and the host's own mutate() call fires,
  // exactly the same write path a manually-typed number in the sidebar
  // uses. `!important` makes the preview win regardless of whatever
  // backend (Tailwind class or inline style) actually controls this
  // property, matching this model's "browser is ground truth, don't guess
  // why a value applies" stance elsewhere. The pre-drag inline value (which
  // may be empty, if this property isn't set inline at all yet) is
  // captured on the FIRST preview of a given drag and restored verbatim on
  // clear — never a blind `removeProperty`, which would erase a real
  // author-set inline value that just happened to already be there.
  var previewOriginal = {};
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || !lastSelectedElement) return;
    if (data.type === "reframe-preview-style") {
      var cssProp = COMPUTED_STYLE_KEYS[data.property] || data.property;
      if (!(data.property in previewOriginal)) {
        previewOriginal[data.property] = lastSelectedElement.style.getPropertyValue(cssProp);
      }
      lastSelectedElement.style.setProperty(cssProp, data.px + "px", "important");
    } else if (data.type === "reframe-preview-clear") {
      Object.keys(previewOriginal).forEach(function (property) {
        var cssProp = COMPUTED_STYLE_KEYS[property] || property;
        var original = previewOriginal[property];
        if (original) {
          lastSelectedElement.style.setProperty(cssProp, original);
        } else {
          lastSelectedElement.style.removeProperty(cssProp);
        }
      });
      previewOriginal = {};
    }
  });

  // Direct on-canvas text editing: type directly into the real rendered
  // text instead of only through a separate textarea popup. Gated to a
  // plain single text-node leaf (mirrors text-ir.ts's own "single
  // text-leaf elements" boundary) — contentEditable lets a user insert
  // arbitrary markup, which would corrupt the JSX/DOM relationship for
  // anything with nested elements; refusing silently here (never entering
  // edit mode) is consistent with "unsupported is acceptable" rather than
  // letting them edit something the write path would just reject anyway.
  // Two triggers share this: double-clicking the element directly, and the
  // host's own toolbar "Edit text" button (a postMessage — the toolbar
  // lives in the PARENT document, it has no direct DOM access to reach in
  // here and call this itself).
  function enterInlineTextEdit(el) {
    if (el.childNodes.length !== 1 || el.childNodes[0].nodeType !== 3) return false;

    var originalText = el.textContent;
    el.setAttribute("contenteditable", "true");
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    function cleanup() {
      el.removeAttribute("contenteditable");
      el.removeEventListener("blur", commit);
      el.removeEventListener("keydown", onKeydown);
    }
    function commit() {
      var changed = el.textContent !== originalText;
      cleanup();
      if (changed) {
        window.parent.postMessage({ source: "reframe-preload", type: "inline-text-committed", value: el.textContent }, "*");
      }
    }
    function onKeydown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        el.blur(); // fires commit via the blur listener below
      } else if (e.key === "Escape") {
        e.preventDefault();
        el.textContent = originalText;
        cleanup();
      }
    }
    el.addEventListener("blur", commit);
    el.addEventListener("keydown", onKeydown);
    return true;
  }

  // Server-confirmed answer to "is the CURRENT selection's text actually
  // safe to rewrite" (host.html's renderProperties posts this right after
  // every resolve) — the DOM-shape check in enterInlineTextEdit alone can't
  // tell a real single-string JSX text child from something like
  // `{loading ? "..." : "Drop your PDF..."}`, which also renders as one
  // plain text node at any given moment but would silently fail to save.
  var textEditableForSelection = false;
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "reframe-text-editable") return;
    textEditableForSelection = !!data.editable;
  });

  document.addEventListener("dblclick", function (event) {
    if (event.target !== lastSelectedElement) return;
    if (!textEditableForSelection) return;
    event.preventDefault();
    enterInlineTextEdit(event.target);
  });

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== "reframe-enter-text-edit") return;
    if (!lastSelectedElement || !lastSelectedElement.isConnected) return;
    enterInlineTextEdit(lastSelectedElement);
  });
})();
