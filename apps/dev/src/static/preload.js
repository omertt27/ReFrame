(function () {
  var KNOWN = [];

  fetch("/__reframe/components")
    .then(function (r) {
      return r.json();
    })
    .then(function (list) {
      KNOWN = list;
    });

  function getFiber(node) {
    var key = Object.keys(node).find(function (k) {
      return k.indexOf("__reactFiber$") === 0;
    });
    return key ? node[key] : null;
  }

  // Checks both mechanisms: fiber.type.name for real Client Components, and
  // fiber._debugInfo (env: "Server") for Server Components — App Router's
  // default, where the component function never runs in the browser at all.
  function matchName(fiber) {
    if (fiber.type && typeof fiber.type === "function") {
      var n = fiber.type.name || fiber.type.displayName;
      if (n && KNOWN.indexOf(n) !== -1) return n;
    }
    if (fiber._debugInfo) {
      for (var i = 0; i < fiber._debugInfo.length; i++) {
        var d = fiber._debugInfo[i];
        if (d && d.env === "Server" && d.name && KNOWN.indexOf(d.name) !== -1) return d.name;
      }
    }
    return null;
  }

  function resolveClick(target) {
    var fiber = getFiber(target);
    var depth = 0;
    while (fiber && depth < 60) {
      var name = matchName(fiber);
      if (name) return name;
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

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
