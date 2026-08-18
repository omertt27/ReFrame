(function () {
  var KNOWN = [];
  var SECTIONS = []; // ordered top-level section names for the current route
  var sectionEls = []; // parallel array of DOM elements, same order as SECTIONS
  var draggedIndex = -1;
  var draggedName = null;

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

  // Index of `fiber` among its parent's element-producing children — the
  // same index space as pageSectionOrder/moveChild/resolveElementPath.
  function siblingIndex(fiber) {
    var parent = fiber.return;
    if (!parent) return -1;
    var index = 0;
    var cursor = parent.child;
    while (cursor) {
      if (cursor === fiber) return index;
      if (isElementProducing(cursor)) index++;
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
    for (var i = 0; i < chain.length; i++) {
      var fnName = fnMatchName(chain[i], KNOWN);
      if (fnName) {
        anchorIndex = i;
        matchedName = fnName;
        break;
      }
      var dbName = debugInfoMatchName(chain[i], KNOWN);
      if (dbName) {
        anchorIndex = i;
        matchedName = dbName;
        var j = i + 1;
        while (j < chain.length && debugInfoMatchName(chain[j], KNOWN) === matchedName) {
          anchorIndex = j;
          j++;
        }
        break;
      }
    }
    if (anchorIndex === -1) return null;

    var path = [];
    for (var k = 0; k < anchorIndex; k++) {
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
        },
        "*",
      );
    },
    true,
  );
})();
