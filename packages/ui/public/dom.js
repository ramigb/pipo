// DOM helpers shared by the dashboard and the builder (docs/spec.md §8). Everything is built with createElement and
// text nodes: data from the API is untrusted, so nothing here ever parses HTML from a string.
export const SVG = "http://www.w3.org/2000/svg";

// Flattens nested child arrays and drops null/undefined/false, which DOM append/replaceChildren would stringify.
export const clean = (kids) =>
  kids.flat(Number.POSITIVE_INFINITY).filter((k) => k !== null && k !== undefined && k !== false);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el[k] = v;
    else if (k === "value") el.value = v ?? "";
    else if (k === "checked") el.checked = !!v;
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...clean(kids));
  return el;
}

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "class") el.setAttribute("class", v);
    else if (k.startsWith("on")) el[k] = v;
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  }
  for (const kid of clean(kids)) el.append(kid);
  return el;
}

// Transient effects (packet dots, sparkles) carry data-fx: a morph leaves them alone and they remove themselves.
const isFx = (n) => n.nodeType === 1 && n.hasAttribute("data-fx");

// A refresh of the same view morphs the new DOM into the old one, so scroll position, focus, text selection and
// untouched nodes survive a live update.
export function morph(old, next) {
  if (old === next) return;
  if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName) return old.replaceWith(next);
  if (old.nodeType !== 1) {
    if (old.data !== next.data) old.data = next.data;
    return;
  }
  if (old.hasAttribute("data-keep")) return;
  for (const a of [...old.attributes]) if (!next.hasAttribute(a.name)) old.removeAttribute(a.name);
  for (const a of next.attributes) {
    if (old.getAttribute(a.name) !== a.value && !(a.name === "value" && old === document.activeElement))
      old.setAttribute(a.name, a.value);
  }
  for (const k of ["onclick", "onscroll", "oninput", "onchange", "onsubmit", "onkeydown"])
    if (old[k] !== next[k]) old[k] = next[k];
  const have = [...old.childNodes].filter((n) => !isFx(n));
  const want = [...next.childNodes];
  want.forEach((w, i) => {
    if (have[i]) morph(have[i], w);
    else old.append(w);
  });
  for (const extra of have.slice(want.length)) extra.remove();
}

// Toasts: short-lived notes in the corner for the result of an action.
export function toast(text, kind = "ok", hint) {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(box);
  }
  const el = h(
    "div",
    { class: `toast ${kind}` },
    h("span", { class: "toast-emoji", "aria-hidden": "true" }, kind === "ok" ? "🎉" : kind === "warn" ? "🤔" : "😬"),
    h("div", null, h("div", null, text), hint ? h("div", { class: "toast-hint" }, hint) : null),
  );
  el.onclick = () => el.remove();
  box.append(el);
  setTimeout(() => el.classList.add("bye"), kind === "ok" ? 3200 : 7000);
  setTimeout(() => el.remove(), kind === "ok" ? 3600 : 7400);
}

/** An API error with the engine's hint and code kept apart, so views can show the hint on its own line. */
export class ApiError extends Error {
  constructor(message, hint, code, body) {
    super(message);
    this.hint = hint;
    this.code = code;
    this.body = body;
  }
}

/** The engine could not be reached at all (it is asleep, or gone). */
export class EngineDown extends Error {}

export async function api(path, post, method) {
  let res;
  try {
    res = await fetch(
      `/api${path}`,
      post !== undefined
        ? { method: method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(post) }
        : undefined,
    );
  } catch (e) {
    throw new EngineDown(e.message);
  }
  const body = await res.json().catch(() => ({}));
  // An engine started before Pipo was updated doesn't know the routes this (freshly served) page uses (D64).
  if (res.status === 404 && String(body.error).startsWith("no API route")) {
    throw new ApiError(
      `the engine doesn't know ${path.split("?")[0]} yet: it's older than this page`,
      "restart it: pipo engine stop, then pipo ui (and open the link it prints)",
      "engine_outdated",
      body,
    );
  }
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, body.hint, body.code, body);
  return body;
}
