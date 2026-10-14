// robots.txt as `crawl` obeys it (docs/spec.md §3.3.2, RFC 9309): the group for `pipo`, else `*`; `Allow` and
// `Disallow` with `*` and `$`, the longest matching rule wins and `Allow` wins a tie; `Crawl-delay` in seconds.

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Robots {
    /// (allow, pattern)
    rules: Vec<(bool, String)>,
    pub crawl_delay_ms: Option<u64>,
}

impl Robots {
    pub fn parse(text: &str, agent: &str) -> Robots {
        // Groups: one or more User-agent lines, then their rules.
        let mut groups: Vec<(Vec<String>, Robots)> = vec![];
        let mut in_agents = false;
        for raw in text.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            let Some((key, value)) = line.split_once(':') else { continue };
            let (key, value) = (key.trim().to_ascii_lowercase(), value.trim());
            match key.as_str() {
                "user-agent" => {
                    if !in_agents || groups.is_empty() {
                        groups.push((vec![], Robots::default()));
                    }
                    in_agents = true;
                    if let Some(g) = groups.last_mut() {
                        g.0.push(value.to_ascii_lowercase());
                    }
                }
                "allow" | "disallow" => {
                    in_agents = false;
                    if let Some(g) = groups.last_mut()
                        && !value.is_empty()
                    {
                        g.1.rules.push((key == "allow", value.to_string()));
                    }
                }
                "crawl-delay" => {
                    in_agents = false;
                    if let Some(g) = groups.last_mut() {
                        g.1.crawl_delay_ms =
                            value.parse::<f64>().ok().filter(|s| *s >= 0.0).map(|s| (s * 1000.0) as u64);
                    }
                }
                _ => {}
            }
        }
        let agent = agent.to_ascii_lowercase();
        let pick = |want: &dyn Fn(&str) -> bool| {
            let mut out: Option<Robots> = None;
            for (agents, rules) in &groups {
                if agents.iter().any(|a| want(a)) {
                    let o = out.get_or_insert_with(Robots::default);
                    o.rules.extend(rules.rules.iter().cloned());
                    o.crawl_delay_ms = o.crawl_delay_ms.or(rules.crawl_delay_ms);
                }
            }
            out
        };
        pick(&|a| a != "*" && agent.starts_with(a)).or_else(|| pick(&|a| a == "*")).unwrap_or_default()
    }

    /// Whether `path` (the URL's path and query) may be fetched.
    pub fn allowed(&self, path: &str) -> bool {
        let mut best: Option<(usize, bool)> = None;
        for (allow, pattern) in &self.rules {
            if matches(pattern, path) {
                let len = pattern.len();
                if best.is_none_or(|(l, a)| len > l || (len == l && *allow && !a)) {
                    best = Some((len, *allow));
                }
            }
        }
        best.is_none_or(|(_, allow)| allow)
    }
}

/// A robots.txt path pattern: a prefix, where `*` is any run of characters and a final `$` anchors the end.
fn matches(pattern: &str, path: &str) -> bool {
    let (pattern, anchored) = match pattern.strip_suffix('$') {
        Some(p) => (p, true),
        None => (pattern, false),
    };
    let parts: Vec<&str> = pattern.split('*').collect();
    let Some(first) = parts.first() else { return true };
    if !path.starts_with(first) {
        return false;
    }
    let mut at = first.len();
    for (i, part) in parts.iter().enumerate().skip(1) {
        let last = i == parts.len() - 1;
        if last && anchored {
            return path.len() >= at + part.len() && path.ends_with(part);
        }
        match path[at..].find(part) {
            Some(found) => at += found + part.len(),
            None => return false,
        }
    }
    !anchored || at == path.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TXT: &str = "# hi\nUser-agent: *\nDisallow: /private/\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 2\n\nUser-agent: badbot\nUser-agent: pipo\nDisallow: /nopipo\n";

    #[test]
    fn the_most_specific_group_and_the_longest_rule_win() {
        let any = Robots::parse(TXT, "otherbot");
        assert!(any.allowed("/"));
        assert!(!any.allowed("/private/x"));
        assert!(any.allowed("/private/open/page"));
        assert!(!any.allowed("/docs/a.pdf"));
        assert!(any.allowed("/docs/a.pdf?x=1"));
        assert_eq!(any.crawl_delay_ms, Some(2000));
        let pipo = Robots::parse(TXT, "pipo");
        assert!(pipo.allowed("/private/x"), "pipo's own group replaces *");
        assert!(!pipo.allowed("/nopipo/a"));
        assert_eq!(pipo.crawl_delay_ms, None);
    }

    #[test]
    fn empty_or_missing_rules_allow_everything() {
        assert!(Robots::parse("", "pipo").allowed("/anything"));
        assert!(Robots::parse("User-agent: *\nDisallow:\n", "pipo").allowed("/x"));
        assert!(!Robots::parse("User-agent: *\nDisallow: /\n", "pipo").allowed("/x"));
        assert!(matches("/a*b$", "/a-x-b"));
        assert!(!matches("/a*b$", "/a-x-bc"));
        assert!(matches("/$", "/"));
        assert!(!matches("/$", "/x"));
    }
}
