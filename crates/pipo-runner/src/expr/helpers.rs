// Helper functions available in expressions (docs/spec.md §3.2). Ports packages/spec/src/expr/helpers.ts.
// `matches()` runs JavaScript patterns on the `regex` crate (linear time) after translating the classes and
// escapes whose meaning differs; lookaround and backreferences are not supported.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;

use super::eval::V;
use super::value::{JsValue, K, R, js_trim, stringify, type_of, utf16_len};
use crate::cron::civil_from_days;
use crate::duration::parse_duration_f64;

const HELPERS: [&str; 13] = [
    "exists", "len", "size", "type", "lower", "upper", "trim", "matches", "default", "json", "now", "iso", "duration",
];

pub(crate) fn is_helper(name: &str) -> bool {
    HELPERS.contains(&name)
}

/// Where `now()` and `iso()` read the time. It travels in [`EvalOptions`], an explicit argument rather than
/// global or task-local state, so a fixed clock (`pipo test` runs at a fixed instant, testing.ts) holds on any
/// thread or async task that evaluates with those options.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Clock {
    /// The system clock.
    #[default]
    System,
    /// A fixed instant, in epoch milliseconds.
    Fixed(f64),
}

impl Clock {
    pub fn now_ms(&self) -> f64 {
        match self {
            Clock::Fixed(ms) => *ms,
            Clock::System => match SystemTime::now().duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_millis() as f64,
                Err(e) => -(e.duration().as_millis() as f64),
            },
        }
    }
}

/// Options for `evaluate_with`, `render_with` and `render_string_with`. The default reads the system clock.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EvalOptions {
    pub clock: Clock,
}

fn text<'r>(x: R<'r>, f: &str) -> Result<&'r str, String> {
    match x.kind() {
        K::Str(s) => Ok(s),
        _ => Err(format!("{f}() expects a string, got {}", type_of(x))),
    }
}

fn own<'a>(v: JsValue) -> V<'a> {
    V::Own(v)
}

/// Call a helper. Missing arguments are `undefined`, extra ones are ignored, as in JavaScript.
pub(crate) fn call<'a>(name: &str, mut args: Vec<V<'a>>, opts: &EvalOptions) -> Result<V<'a>, String> {
    while args.len() < 2 {
        args.push(V::Own(JsValue::Undefined));
    }
    let x = args[0].r();
    Ok(match name {
        "exists" => own(JsValue::Bool(!x.is_nullish())),
        "len" => own(JsValue::Num(match x.kind() {
            K::Str(s) => utf16_len(s) as f64,
            K::Arr(a) => a.len() as f64,
            K::Obj(o) => o.len() as f64,
            K::Undef | K::Null => 0.0,
            _ => return Err(format!("len() expects a string, array or object, got {}", type_of(x))),
        })),
        "size" => own(JsValue::Num(match x.kind() {
            K::Undef => 0.0,
            K::Str(s) => s.len() as f64,
            _ => {
                let mut out = String::new();
                stringify(x, &mut out);
                out.len() as f64
            }
        })),
        "type" => own(JsValue::Str(type_of(x).into())),
        "lower" => own(JsValue::Str(text(x, "lower")?.to_lowercase())),
        "upper" => own(JsValue::Str(text(x, "upper")?.to_uppercase())),
        "trim" => own(JsValue::Str(js_trim(text(x, "trim")?).into())),
        "matches" => {
            let pattern = text(args[1].r(), "matches")?;
            if utf16_len(pattern) > 200 {
                return Err("matches() pattern is longer than 200 characters".into());
            }
            let re = regex(pattern)?;
            own(JsValue::Bool(re.is_match(text(x, "matches")?)))
        }
        "default" => {
            let y = args.swap_remove(1);
            let x = args.swap_remove(0);
            if x.r().is_nullish() { y } else { x }
        }
        "json" => {
            let mut out = String::new();
            own(if stringify(x, &mut out) {
                JsValue::Str(out)
            } else {
                JsValue::Undefined
            })
        }
        "now" => own(JsValue::Num(opts.clock.now_ms())),
        "iso" => {
            let ms = match x.kind() {
                K::Num(n) => n,
                _ => opts.clock.now_ms(),
            };
            own(JsValue::Str(iso_string(ms)?))
        }
        "duration" => own(JsValue::Num(parse_duration_f64(text(x, "duration")?)?)),
        _ => return Err(format!("unknown function '{name}'")),
    })
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_string(ms: f64) -> Result<String, String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return Err("Invalid Date".into());
    }
    let t = ms.trunc() as i64;
    let (days, rem) = (t.div_euclid(86_400_000), t.rem_euclid(86_400_000));
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    Ok(format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    ))
}

fn regex(pattern: &str) -> Result<Regex, String> {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(re) = cache.lock().ok().and_then(|c| c.get(pattern).cloned()) {
        return Ok(re);
    }
    let invalid = |why: &str| format!("Invalid regular expression: {why}");
    let translated = translate(pattern).map_err(|e| invalid(&e))?;
    let re = Regex::new(&translated).map_err(|e| {
        let msg = e.to_string();
        let last = msg.lines().last().unwrap_or("").trim();
        invalid(last.strip_prefix("error: ").unwrap_or(last))
    })?;
    if let Ok(mut c) = cache.lock() {
        if c.len() >= 256 {
            c.clear();
        }
        c.insert(pattern.to_string(), re.clone());
    }
    Ok(re)
}

const WORD: &str = "0-9A-Za-z_";
const SPACE: &str = r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn hex(c: &[char], from: usize, n: usize) -> Option<u32> {
    let digits: String = c.get(from..from + n)?.iter().collect();
    if digits.chars().all(|d| d.is_ascii_hexdigit()) {
        u32::from_str_radix(&digits, 16).ok()
    } else {
        None
    }
}

fn literal(out: &mut String, ch: char) {
    if ch.is_ascii_alphanumeric() {
        out.push(ch);
    } else {
        out.push_str(&format!(r"\x{{{:X}}}", ch as u32));
    }
}

/// Is `c[i..]` a JavaScript quantifier: `{n}`, `{n,}` or `{n,m}`? Returns its length.
fn quantifier(c: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    let start = j;
    while c.get(j).is_some_and(char::is_ascii_digit) {
        j += 1;
    }
    if j == start {
        return None;
    }
    if c.get(j) == Some(&',') {
        j += 1;
        while c.get(j).is_some_and(char::is_ascii_digit) {
            j += 1;
        }
    }
    (c.get(j) == Some(&'}')).then_some(j + 1 - i)
}

/// Rewrite a JavaScript pattern (no flags) for the `regex` crate: ASCII `\d \w \b`, JavaScript's `\s` and `.`,
/// Annex B identity escapes and literal braces, and character classes where `[`, `&&`, `--` and `~~` are
/// literal.
fn translate(p: &str) -> Result<String, String> {
    let c: Vec<char> = p.chars().collect();
    let mut out = String::with_capacity(p.len() * 2);
    let mut class = false;
    let mut last_dash = false;
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        i += 1;
        if ch == '\\' {
            let Some(&e) = c.get(i) else {
                return Err(r"\ at end of pattern".into());
            };
            i += 1;
            last_dash = false;
            match e {
                'd' => out.push_str(if class { "0-9" } else { "[0-9]" }),
                'D' => out.push_str("[^0-9]"),
                'w' if class => out.push_str(WORD),
                'w' => out.push_str(&format!("[{WORD}]")),
                'W' => out.push_str(&format!("[^{WORD}]")),
                's' if class => out.push_str(SPACE),
                's' => out.push_str(&format!("[{SPACE}]")),
                'S' => out.push_str(&format!("[^{SPACE}]")),
                'b' if class => out.push_str(r"\x08"),
                'b' => out.push_str(r"(?-u:\b)"),
                'B' if !class => out.push_str(r"(?-u:\B)"),
                'n' => out.push_str(r"\n"),
                'r' => out.push_str(r"\r"),
                't' => out.push_str(r"\t"),
                'f' => out.push_str(r"\x0C"),
                'v' => out.push_str(r"\x0B"),
                '0' if !c.get(i).is_some_and(char::is_ascii_digit) => out.push_str(r"\x00"),
                '1'..='9' => {
                    out.push('\\');
                    out.push(e);
                }
                'x' => match hex(&c, i, 2) {
                    Some(n) => {
                        i += 2;
                        out.push_str(&format!(r"\x{{{n:X}}}"));
                    }
                    None => out.push('x'),
                },
                'u' => match hex(&c, i, 4) {
                    Some(hi @ 0xD800..=0xDBFF) => {
                        let lo = (c.get(i + 4) == Some(&'\\') && c.get(i + 5) == Some(&'u'))
                            .then(|| hex(&c, i + 6, 4))
                            .flatten();
                        let Some(lo @ 0xDC00..=0xDFFF) = lo else {
                            return Err("lone surrogates are not supported".into());
                        };
                        i += 10;
                        out.push_str(&format!(r"\x{{{:X}}}", 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)));
                    }
                    Some(0xDC00..=0xDFFF) => return Err("lone surrogates are not supported".into()),
                    Some(n) => {
                        i += 4;
                        out.push_str(&format!(r"\x{{{n:X}}}"));
                    }
                    None => out.push('u'),
                },
                'c' => match c.get(i).filter(|l| l.is_ascii_alphabetic()) {
                    Some(l) => {
                        i += 1;
                        out.push_str(&format!(r"\x{{{:X}}}", *l as u32 % 32));
                    }
                    None => out.push_str(r"\\c"),
                },
                'k' if c.get(i) == Some(&'<') => out.push_str(r"\k"),
                e => literal(&mut out, e),
            }
            continue;
        }
        if class {
            match ch {
                ']' => {
                    class = false;
                    out.push(']');
                }
                '[' | '&' | '~' => literal(&mut out, ch),
                '-' if last_dash => literal(&mut out, ch),
                _ => out.push(ch),
            }
            last_dash = ch == '-';
            continue;
        }
        match ch {
            '.' => out.push_str(r"[^\n\r\x{2028}\x{2029}]"),
            '[' => {
                let negated = c.get(i) == Some(&'^');
                if negated {
                    i += 1;
                }
                if c.get(i) == Some(&']') {
                    i += 1;
                    out.push_str(if negated {
                        r"[\x{0}-\x{10FFFF}]"
                    } else {
                        r"[^\x{0}-\x{10FFFF}]"
                    });
                } else {
                    class = true;
                    last_dash = false;
                    out.push_str(if negated { "[^" } else { "[" });
                }
            }
            '{' => match quantifier(&c, i - 1) {
                Some(n) => {
                    out.extend(&c[i - 1..i - 1 + n]);
                    i += n - 1;
                }
                None => literal(&mut out, ch),
            },
            '}' | ']' => literal(&mut out, ch),
            _ => out.push(ch),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(s: &str, p: &str) -> bool {
        regex(p).unwrap().is_match(s)
    }

    #[test]
    fn patterns_follow_javascript() {
        assert!(m(" Ada", r"^\s*A"));
        assert!(!m("٣", r"\d"));
        assert!(!m("é", r"^\w$"));
        assert!(m("aé", r"a\b"));
        assert!(!m("a\rb", "a.b"));
        assert!(m("a/b", r"a\/b"));
        assert!(m("a{", "a{"));
        assert!(m("x<", r"\<"));
        assert!(m("p", r"\p"));
        assert!(m("aa", "a{2}"));
        assert!(m("a[b", r"[[]"));
        assert!(m("&", "[a&&b]"));
        assert!(!m("x", "[]"));
        assert!(m("\n", "[^]"));
        assert!(m("A", r"\u0041"));
        assert!(m("😀", r"\uD83D\uDE00"));
        assert!(m("\u{1}", r"\cA"));
        assert!(m("-", r"[\d-]"));
    }

    #[test]
    fn unsupported_patterns_are_errors() {
        for p in ["(", "(?=a)", r"(a)\1", r"\"] {
            assert!(regex(p).unwrap_err().starts_with("Invalid regular expression: "), "{p}");
        }
    }

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(-1.0).unwrap(), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_string(1.9).unwrap(), "1970-01-01T00:00:00.001Z");
        assert_eq!(iso_string(-1.9).unwrap(), "1969-12-31T23:59:59.999Z");
        assert_eq!(
            iso_string(253_402_300_800_000.0).unwrap(),
            "+010000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_string(-62_198_755_200_001.0).unwrap(),
            "-000002-12-31T23:59:59.999Z"
        );
        assert_eq!(iso_string(1e20).unwrap_err(), "Invalid Date");
    }
}
