// Theme toggle for the about page (the advisor page wires its own in app.js).
(function () {
  var btn = document.getElementById("theme-toggle");
  var root = document.documentElement;
  function current() {
    return root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function label() {
    btn.textContent = current() === "dark" ? "Light mode" : "Dark mode";
  }
  label();
  btn.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("asa-theme", next);
    } catch (e) {
      /* ignore */
    }
    label();
  });
})();
