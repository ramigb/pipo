// Pipo docs: the mobile menu, copy buttons, the on-this-page highlight and search over search.json. No innerHTML.
(() => {
  const menu = document.querySelector(".menu");
  menu?.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    menu.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
  // Keep the current page in view in a long sidebar, without scrolling the page itself.
  const sidebar = document.querySelector(".sidebar");
  const current = sidebar?.querySelector("a[aria-current]");
  if (sidebar && current) sidebar.scrollTop = current.offsetTop - sidebar.clientHeight / 2;

  for (const button of document.querySelectorAll(".copy")) {
    button.addEventListener("click", async () => {
      const code = button.parentElement?.querySelector("code");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        button.textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        button.textContent = "Selected";
      }
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    });
  }

  // Highlight the section being read in the on-this-page list.
  const tocLinks = [...document.querySelectorAll(".toc a")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const visible = new Set();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
        const first = [...byId.keys()].find((id) => visible.has(id));
        if (!first) return;
        for (const a of tocLinks) a.classList.toggle("current", a === byId.get(first));
      },
      { rootMargin: "-60px 0px -65% 0px" },
    );
    for (const id of byId.keys()) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
  }

  // Search: titles, headings and section text, loaded on first use.
  const input = document.getElementById("search");
  const list = document.getElementById("search-results");
  if (!input || !list) return;
  let index = null;
  let selected = -1;
  const load = async () => {
    if (index) return index;
    try {
      index = await (await fetch("search.json")).json();
    } catch {
      index = [];
    }
    return index;
  };

  const terms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (entry, words) => {
    const title = entry.t.toLowerCase();
    const heading = entry.h.toLowerCase();
    const text = entry.x.toLowerCase();
    let total = 0;
    for (const w of words) {
      const s = (heading.includes(w) ? 6 : 0) + (title.includes(w) ? 4 : 0) + (text.includes(w) ? 1 : 0);
      if (!s) return 0;
      total += s;
    }
    return total + (heading === words.join(" ") ? 10 : 0);
  };

  /** `text` with the first match of any word marked, around a short excerpt. */
  const excerpt = (text, words) => {
    const lower = text.toLowerCase();
    const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)));
    const start = Math.max(0, at - 40);
    const piece = (start ? "…" : "") + text.slice(start, start + 140) + (text.length > start + 140 ? "…" : "");
    const span = document.createElement("span");
    span.className = "r-text";
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    for (const part of piece.split(re)) {
      if (!part) continue;
      if (re.test(part)) {
        const mark = document.createElement("mark");
        mark.textContent = part;
        span.append(mark);
      } else span.append(part);
      re.lastIndex = 0;
    }
    return span;
  };

  const show = async () => {
    const words = terms(input.value);
    list.replaceChildren();
    selected = -1;
    if (!words.length) {
      list.hidden = true;
      return;
    }
    const entries = await load();
    const hits = entries
      .map((e) => ({ e, s: score(e, words) }))
      .filter((h) => h.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12);
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "r-text";
      li.textContent = "No results";
      li.style.padding = "8px 10px";
      list.append(li);
    }
    for (const { e } of hits) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      const a = document.createElement("a");
      a.href = `${e.p}.html${e.a ? `#${e.a}` : ""}`;
      const title = document.createElement("span");
      title.className = "r-title";
      title.textContent = e.h && e.h !== e.t ? `${e.t} › ${e.h}` : e.t;
      a.append(title, excerpt(e.x || e.h, words));
      li.append(a);
      list.append(li);
    }
    list.hidden = false;
  };

  const move = (step) => {
    const items = [...list.querySelectorAll('[role="option"]')];
    if (!items.length) return;
    selected = (selected + step + items.length) % items.length;
    for (const [i, li] of items.entries()) li.setAttribute("aria-selected", String(i === selected));
    items[selected].scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("input", show);
  input.addEventListener("focus", () => {
    load();
    if (input.value) show();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") {
      const items = list.querySelectorAll('[role="option"] a');
      const target = items[Math.max(0, selected)];
      if (target) location.href = target.href;
    } else if (e.key === "Escape") {
      input.value = "";
      list.hidden = true;
      input.blur();
    } else return;
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".search")) list.hidden = true;
  });
})();
