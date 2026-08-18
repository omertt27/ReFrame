(function () {
  var KNOWN = [];
  var SECTIONS = []; // ordered top-level section names for the current route
  var sectionEls = []; // parallel array of DOM elements, same order as SECTIONS
  var draggedIndex = -1;

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
    if (fiber.type && typeof fiber.type === "function") {
      var n = fiber.type.name || fiber.type.displayName;
      if (n && names.indexOf(n) !== -1) return n;
    }
    if (fiber._debugInfo) {
      for (var i = 0; i < fiber._debugInfo.length; i++) {
        var d = fiber._debugInfo[i];
        if (d && d.env === "Server" && d.name && names.indexOf(d.name) !== -1) return d.name;
      }
    }
    return null;
  }

  function resolveClick(target) {
    var fiber = getFiber(target);
    var depth = 0;
    while (fiber && depth < 60) {
      var name = matchName(fiber, KNOWN);
      if (name) return name;
      fiber = fiber.return;
      depth++;
    }
    return null;
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
      var name = resolveClick(event.target);
      if (!name) return;
      event.preventDefault();
      event.stopPropagation();
      var rect = event.target.getBoundingClientRect();
      window.parent.postMessage(
        {
          source: "reframe-preload",
          type: "select",
          component: name,
          route: window.location.pathname,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        },
        "*",
      );
    },
    true,
  );
})();
