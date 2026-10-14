// HTML pages as `poll` (`parse: html`) and `crawl` send them (docs/spec.md §3.3.2): the title, the visible text, the
// page's links, and with a `select` CSS selector the matching elements' text and HTML.

use reqwest::Url;
use scraper::node::Node;
use scraper::{ElementRef, Html, Selector};
use serde_json::{Value, json};

/// Elements whose content is never visible text.
const HIDDEN: &[&str] = &["script", "style", "noscript", "template", "head", "svg", "iframe", "object"];
/// Elements that start a new line of text.
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "td",
    "th",
    "tr",
    "ul",
];

pub struct Page {
    pub title: String,
    pub text: String,
    /// The selected elements' outer HTML (only with `select`).
    pub html: Option<String>,
    /// Absolute http(s) links, without fragments, in page order, each once.
    pub links: Vec<String>,
}

impl Page {
    /// `{url, status, title, text, links, html}`.
    pub fn to_json(&self, url: &str, status: u16) -> Value {
        json!({
            "url": url,
            "status": status,
            "title": self.title,
            "text": self.text,
            "links": self.links,
            "html": self.html,
        })
    }
}

/// A CSS selector, or why it doesn't parse.
pub fn selector(css: &str) -> Result<Selector, String> {
    Selector::parse(css).map_err(|e| format!("select '{css}' is not a CSS selector ({e})"))
}

pub fn page(body: &str, url: &Url, select: Option<&Selector>) -> Page {
    let doc = Html::parse_document(body);
    let title = doc
        .select(&Selector::parse("title").expect("valid selector"))
        .next()
        .map(|t| collapse(&t.text().collect::<String>()))
        .unwrap_or_default();
    let base = doc
        .select(&Selector::parse("base[href]").expect("valid selector"))
        .next()
        .and_then(|b| b.attr("href"))
        .and_then(|h| url.join(h).ok())
        .unwrap_or_else(|| url.clone());
    let mut links: Vec<String> = vec![];
    for a in doc.select(&Selector::parse("a[href], area[href]").expect("valid selector")) {
        if let Some(link) = a.attr("href").and_then(|h| absolute(&base, h))
            && !links.contains(&link)
        {
            links.push(link);
        }
    }
    let (text, html) = match select {
        Some(sel) => {
            let found: Vec<ElementRef> = doc.select(sel).collect();
            let text = found.iter().map(|e| visible_text(*e)).filter(|t| !t.is_empty()).collect::<Vec<_>>();
            (text.join("\n\n"), Some(found.iter().map(|e| e.html()).collect::<Vec<_>>().join("\n")))
        }
        None => {
            let body = doc.select(&Selector::parse("body").expect("valid selector")).next();
            (body.map(visible_text).unwrap_or_default(), None)
        }
    };
    Page { title, text, html, links }
}

/// A link as an absolute http(s) URL without its fragment, or None (mailto:, javascript:, unparseable).
pub fn absolute(base: &Url, href: &str) -> Option<String> {
    let mut u = base.join(href.trim()).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    u.set_fragment(None);
    Some(u.to_string())
}

/// The text a reader sees: hidden elements left out, whitespace collapsed, one line per block, no empty lines.
fn visible_text(root: ElementRef) -> String {
    let mut lines: Vec<String> = vec![];
    let mut line = String::new();
    walk(*root, &mut line, &mut lines);
    flush(&mut line, &mut lines);
    lines.join("\n")
}

fn walk(node: ego_tree::NodeRef<Node>, line: &mut String, lines: &mut Vec<String>) {
    match node.value() {
        Node::Text(t) => line.push_str(t),
        Node::Element(e) => {
            let name = e.name();
            if HIDDEN.contains(&name) {
                return;
            }
            let block = BLOCKS.contains(&name);
            if block {
                flush(line, lines);
            }
            for child in node.children() {
                walk(child, line, lines);
            }
            if block {
                flush(line, lines);
            }
        }
        _ => {
            for child in node.children() {
                walk(child, line, lines);
            }
        }
    }
}

fn flush(line: &mut String, lines: &mut Vec<String>) {
    let text = collapse(line);
    if !text.is_empty() {
        lines.push(text);
    }
    line.clear();
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!doctype html><html><head><title> The  Shop </title><base href="/shop/"><style>p{}</style></head>
<body><nav><a href="a.html#top">A</a> <a href="https://other.example/x">X</a> <a href="mailto:me@x">mail</a></nav>
<script>var hidden = 1;</script>
<main><h1>Prices</h1><p>Tea is <span id="price">4.50</span> today.</p><p class="note">Fresh   stock.</p>
<ul><li>one</li><li>two <a href="a.html">again</a></li></ul></main></body></html>"#;

    #[test]
    fn a_page_has_its_title_visible_text_and_absolute_links() {
        let url = Url::parse("https://shop.example/index.html").unwrap();
        let p = page(PAGE, &url, None);
        assert_eq!(p.title, "The Shop");
        assert_eq!(p.text, "A X mail\nPrices\nTea is 4.50 today.\nFresh stock.\none\ntwo again");
        assert_eq!(p.links, vec!["https://shop.example/shop/a.html", "https://other.example/x"]);
        assert_eq!(p.html, None);
        assert_eq!(p.to_json("u", 200)["html"], Value::Null);
    }

    #[test]
    fn select_narrows_text_and_html_to_the_matching_elements() {
        let url = Url::parse("https://shop.example/").unwrap();
        let sel = selector("#price, .note").unwrap();
        let p = page(PAGE, &url, Some(&sel));
        assert_eq!(p.text, "4.50\n\nFresh stock.");
        assert_eq!(p.html.as_deref(), Some("<span id=\"price\">4.50</span>\n<p class=\"note\">Fresh   stock.</p>"));
        assert_eq!(p.links.len(), 2, "links are always the whole page's");
        assert!(selector("p[").unwrap_err().starts_with("select 'p[' is not a CSS selector"));
    }
}
