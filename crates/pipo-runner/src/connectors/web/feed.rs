// Feeds as `poll`'s `parse: feed` reads them (docs/spec.md §3.3.2): RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed, each
// entry normalized to `{id, title, link, published, updated, summary, content, author, feed: {title, link}}`.

use serde_json::{Map, Value, json};

/// Whether a body looks like a feed: what `parse: auto` checks before choosing `feed`.
pub fn looks_like_feed(content_type: &str, body: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("rss") || ct.contains("atom") || ct.contains("feed+json") {
        return true;
    }
    let head: String = body.trim_start().chars().take(1024).collect();
    if ct.contains("xml") || head.starts_with("<?xml") || head.starts_with('<') {
        return head.contains("<rss") || head.contains("<feed") || head.contains("<rdf:RDF");
    }
    if ct.contains("json") || head.starts_with('{') {
        return head.contains("jsonfeed.org/version");
    }
    false
}

/// The entries of a feed, or why the body isn't one.
pub fn entries(body: &str) -> Result<Vec<Value>, String> {
    let trimmed = body.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with('{') {
        return json_feed(trimmed);
    }
    let doc = roxmltree::Document::parse_with_options(
        trimmed,
        roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() },
    )
    .map_err(|e| format!("not a feed: the XML doesn't parse ({e})"))?;
    let root = doc.root_element();
    match root.tag_name().name() {
        "rss" | "RDF" => Ok(rss(root)),
        "feed" => Ok(atom(root)),
        other => Err(format!("not a feed: the document is <{other}>, not <rss>, <feed> or <rdf:RDF>")),
    }
}

type El<'a, 'i> = roxmltree::Node<'a, 'i>;

fn child<'a, 'i>(n: El<'a, 'i>, name: &str) -> Option<El<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

fn text_of(n: Option<El>) -> Value {
    match n.map(|n| n.descendants().filter(|d| d.is_text()).filter_map(|d| d.text()).collect::<String>()) {
        Some(t) if !t.trim().is_empty() => json!(t.trim()),
        _ => Value::Null,
    }
}

/// A feed date as ISO 8601 (RFC 2822 for RSS, RFC 3339 for Atom), or the text as it was when neither parses.
fn date(v: Value) -> Value {
    let Some(s) = v.as_str() else { return v };
    let ts =
        s.parse::<jiff::Timestamp>().ok().or_else(|| jiff::fmt::rfc2822::parse(s).ok().map(|z| z.timestamp())).or_else(
            || {
                s.parse::<jiff::civil::DateTime>()
                    .ok()
                    .and_then(|d| d.to_zoned(jiff::tz::TimeZone::UTC).ok())
                    .map(|z| z.timestamp())
            },
        );
    match ts {
        Some(t) => json!(crate::time::iso(t.as_millisecond())),
        None => v,
    }
}

fn entry(mut e: Map<String, Value>, feed: &Value) -> Value {
    if e.get("id").is_none_or(Value::is_null) {
        let fallback = match e.get("link") {
            Some(Value::String(l)) => json!(l),
            _ => json!(super::content_hash(&Value::Object(e.clone()))),
        };
        e.insert("id".into(), fallback);
    }
    let mut out = Map::new();
    for k in ["id", "title", "link", "published", "updated", "summary", "content", "author"] {
        out.insert(k.into(), e.remove(k).unwrap_or(Value::Null));
    }
    out.insert("feed".into(), feed.clone());
    Value::Object(out)
}

fn rss(root: El) -> Vec<Value> {
    let channel = child(root, "channel");
    let feed = json!({
        "title": text_of(channel.and_then(|c| child(c, "title"))),
        "link": text_of(channel.and_then(|c| child(c, "link"))),
    });
    // RSS 2.0 has its items in <channel>; RSS 1.0 (RDF) beside it.
    let items = channel
        .into_iter()
        .chain([root])
        .flat_map(|p| p.children().filter(|c| c.is_element() && c.tag_name().name() == "item"));
    items
        .map(|i| {
            let get = |n: &str| text_of(child(i, n));
            let mut e = Map::new();
            e.insert("id".into(), get("guid"));
            e.insert("title".into(), get("title"));
            e.insert("link".into(), get("link"));
            e.insert(
                "published".into(),
                date(match get("pubDate") {
                    Value::Null => get("date"),
                    v => v,
                }),
            );
            e.insert("updated".into(), date(get("updated")));
            e.insert("summary".into(), get("description"));
            e.insert("content".into(), get("encoded"));
            e.insert(
                "author".into(),
                match get("author") {
                    Value::Null => get("creator"),
                    v => v,
                },
            );
            entry(e, &feed)
        })
        .collect()
}

fn atom_link(n: El) -> Value {
    let links: Vec<El> = n.children().filter(|c| c.is_element() && c.tag_name().name() == "link").collect();
    links
        .iter()
        .find(|l| l.attribute("rel").is_none_or(|r| r == "alternate"))
        .or(links.first())
        .and_then(|l| l.attribute("href"))
        .map(|h| json!(h))
        .unwrap_or(Value::Null)
}

fn atom(root: El) -> Vec<Value> {
    let feed = json!({ "title": text_of(child(root, "title")), "link": atom_link(root) });
    root.children()
        .filter(|c| c.is_element() && c.tag_name().name() == "entry")
        .map(|en| {
            let get = |n: &str| text_of(child(en, n));
            let mut e = Map::new();
            e.insert("id".into(), get("id"));
            e.insert("title".into(), get("title"));
            e.insert("link".into(), atom_link(en));
            e.insert("published".into(), date(get("published")));
            e.insert("updated".into(), date(get("updated")));
            e.insert("summary".into(), get("summary"));
            e.insert("content".into(), get("content"));
            e.insert("author".into(), text_of(child(en, "author").and_then(|a| child(a, "name"))));
            entry(e, &feed)
        })
        .collect()
}

fn json_feed(body: &str) -> Result<Vec<Value>, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("not a feed: the JSON doesn't parse ({e})"))?;
    let Some(items) = v.get("items").and_then(|i| i.as_array()) else {
        return Err("not a feed: a JSON Feed needs an `items` list".into());
    };
    let feed = json!({ "title": v.get("title").cloned().unwrap_or(Value::Null), "link": v.get("home_page_url").cloned().unwrap_or(Value::Null) });
    Ok(items
        .iter()
        .map(|i| {
            let get = |k: &str| i.get(k).cloned().unwrap_or(Value::Null);
            let author = i
                .get("authors")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .or(i.get("author"))
                .and_then(|a| a.get("name"))
                .cloned()
                .unwrap_or(Value::Null);
            let mut e = Map::new();
            e.insert(
                "id".into(),
                match get("id") {
                    Value::Number(n) => json!(n.to_string()),
                    v => v,
                },
            );
            e.insert("title".into(), get("title"));
            e.insert("link".into(), get("url"));
            e.insert("published".into(), date(get("date_published")));
            e.insert("updated".into(), date(get("date_modified")));
            e.insert("summary".into(), get("summary"));
            e.insert(
                "content".into(),
                match get("content_html") {
                    Value::Null => get("content_text"),
                    v => v,
                },
            );
            e.insert("author".into(), author);
            entry(e, &feed)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_items_are_normalized() {
        let rss = r#"<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Blog</title><link>https://blog.example/</link>
<item><title>Hello</title><link>https://blog.example/hello</link><guid isPermaLink="false">post-1</guid>
<pubDate>Thu, 01 Jan 2026 09:00:00 +0100</pubDate><description><![CDATA[<p>Hi</p>]]></description>
<content:encoded>Full text</content:encoded><dc:creator>Ada</dc:creator></item>
<item><title>No guid</title><link>https://blog.example/2</link></item>
</channel></rss>"#;
        assert!(looks_like_feed("application/rss+xml", rss));
        assert!(looks_like_feed("text/xml", rss));
        let e = entries(rss).unwrap();
        assert_eq!(
            e[0],
            json!({
                "id": "post-1", "title": "Hello", "link": "https://blog.example/hello",
                "published": "2026-01-01T08:00:00.000Z", "updated": null, "summary": "<p>Hi</p>",
                "content": "Full text", "author": "Ada", "feed": { "title": "Blog", "link": "https://blog.example/" }
            })
        );
        assert_eq!(e[1]["id"], json!("https://blog.example/2"));
    }

    #[test]
    fn atom_entries_and_json_feed_items_are_normalized() {
        let atom = r#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Rel</title><link href="https://x.example/"/>
<entry><id>tag:x,1</id><title>v1.0</title><link rel="alternate" href="https://x.example/v1"/><link rel="edit" href="/e"/>
<updated>2026-01-02T10:00:00Z</updated><author><name>Bob</name></author><summary>First</summary></entry></feed>"#;
        assert!(looks_like_feed("application/xml", atom));
        let e = entries(atom).unwrap();
        assert_eq!(e[0]["id"], json!("tag:x,1"));
        assert_eq!(e[0]["link"], json!("https://x.example/v1"));
        assert_eq!(e[0]["updated"], json!("2026-01-02T10:00:00.000Z"));
        assert_eq!(e[0]["author"], json!("Bob"));
        assert_eq!(e[0]["feed"], json!({ "title": "Rel", "link": "https://x.example/" }));

        let jf = r#"{"version":"https://jsonfeed.org/version/1.1","title":"J","home_page_url":"https://j.example/",
"items":[{"id":7,"url":"https://j.example/7","title":"Seven","content_text":"txt","date_published":"2026-01-03T00:00:00+00:00","authors":[{"name":"Cy"}]}]}"#;
        assert!(looks_like_feed("application/json", jf));
        assert!(!looks_like_feed("application/json", r#"{"items": []}"#));
        let e = entries(jf).unwrap();
        assert_eq!(e[0]["id"], json!("7"));
        assert_eq!(e[0]["content"], json!("txt"));
        assert_eq!(e[0]["published"], json!("2026-01-03T00:00:00.000Z"));
        assert_eq!(e[0]["author"], json!("Cy"));
    }

    #[test]
    fn what_is_not_a_feed_says_so() {
        assert!(!looks_like_feed("text/html", "<html><body>hi</body></html>"));
        assert_eq!(
            entries("<html></html>").unwrap_err(),
            "not a feed: the document is <html>, not <rss>, <feed> or <rdf:RDF>"
        );
        assert!(entries("<rss").unwrap_err().starts_with("not a feed: the XML doesn't parse"));
        assert_eq!(entries("{}").unwrap_err(), "not a feed: a JSON Feed needs an `items` list");
    }
}
