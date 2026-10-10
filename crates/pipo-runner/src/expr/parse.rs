// Expression parsing (docs/spec.md §3.2). Ports packages/spec/src/expr/parse.ts together with the parts of
// jsep 1.4.0 (and its object and ternary plugins) that it relies on, so syntax, error messages and positions
// match. Positions are UTF-16 offsets, as in JavaScript.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, OnceLock};

use super::helpers::is_helper;

pub const BLOCKED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const BINARY_OPS: [&str; 17] = [
    "+", "-", "*", "/", "%", "==", "!=", "===", "!==", "<", "<=", ">", ">=", "&&", "||", "??", "in",
];
const UNARY_OPS: [&str; 3] = ["!", "-", "+"];

pub const LIMIT_SOURCE_LENGTH: usize = 2000;
pub const LIMIT_DEPTH: usize = 32;
pub const LIMIT_NODES: usize = 256;
const CACHE_SIZE: usize = 4096;

/// What went wrong in an expression. `Display` gives the same message as the TS `ExprError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExprError {
    pub message: String,
    /// Offset in the expression source (UTF-16 code units, as in JavaScript), when known.
    pub index: Option<usize>,
}

impl ExprError {
    pub fn new(message: impl Into<String>) -> Self {
        ExprError {
            message: message.into(),
            index: None,
        }
    }

    pub fn at(message: impl Into<String>, index: usize) -> Self {
        ExprError {
            message: message.into(),
            index: Some(index),
        }
    }
}

impl fmt::Display for ExprError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ExprError {}

/// jsep's syntax tree, restricted to the node types jsep can produce with Pipo's configuration.
#[derive(Clone, Debug, PartialEq)]
pub enum Ast {
    Literal(Lit),
    Identifier(String),
    /// `computed` is `a[b]`; otherwise `property` is an `Identifier` (`a.b`).
    Member {
        object: Box<Ast>,
        property: Box<Ast>,
        computed: bool,
        optional: bool,
    },
    Call {
        callee: Box<Ast>,
        arguments: Vec<Ast>,
        optional: bool,
    },
    Unary {
        operator: String,
        argument: Box<Ast>,
    },
    Binary {
        operator: String,
        left: Box<Ast>,
        right: Box<Ast>,
    },
    Conditional {
        test: Box<Ast>,
        consequent: Box<Ast>,
        alternate: Box<Ast>,
    },
    /// `None` is a hole (`[1,,2]`).
    Array(Vec<Option<Ast>>),
    Object(Vec<Prop>),
    This,
    Compound(Vec<Ast>),
    Sequence(Vec<Ast>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Lit {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Prop {
    /// `key: value` or the shorthand `{ name }` (where the value is the key). A computed key (`[k]: v`)
    /// keeps the first element of the brackets, if any.
    Property {
        key: Option<Box<Ast>>,
        value: Box<Ast>,
        computed: bool,
    },
    /// Anything else the object plugin accepts inside braces (`{ a b }`, `{ 1 }`); rejected by `parse`.
    Other(Box<Ast>),
}

impl Ast {
    fn type_name(&self) -> &'static str {
        match self {
            Ast::Literal(_) => "Literal",
            Ast::Identifier(_) => "Identifier",
            Ast::Member { .. } => "MemberExpression",
            Ast::Call { .. } => "CallExpression",
            Ast::Unary { .. } => "UnaryExpression",
            Ast::Binary { .. } => "BinaryExpression",
            Ast::Conditional { .. } => "ConditionalExpression",
            Ast::Array(_) => "ArrayExpression",
            Ast::Object(_) => "ObjectExpression",
            Ast::This => "ThisExpression",
            Ast::Compound(_) => "Compound",
            Ast::Sequence(_) => "SequenceExpression",
        }
    }
}

/// A parsed and vetted expression.
#[derive(Debug)]
pub struct Compiled {
    pub source: String,
    pub ast: Ast,
    /// Root identifiers the expression reads (`data`, `meta`, …), in first-use order.
    pub identifiers: Vec<String>,
    /// Helper functions the expression calls, in first-use order.
    pub helpers: Vec<String>,
}

fn cache() -> &'static Mutex<HashMap<String, Arc<Compiled>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Compiled>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parse and vet an expression (cached; the cache is bounded). Fails for syntax errors or anything outside
/// the allowed subset.
pub fn parse(source: &str) -> Result<Arc<Compiled>, ExprError> {
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(source).cloned()) {
        return Ok(hit);
    }
    let compiled = Arc::new(compile(source)?);
    if let Ok(mut c) = cache().lock() {
        if c.len() >= CACHE_SIZE {
            c.clear();
        }
        c.insert(source.to_string(), compiled.clone());
    }
    Ok(compiled)
}

fn compile(source: &str) -> Result<Compiled, ExprError> {
    let units: Vec<u16> = source.encode_utf16().collect();
    if units.len() > LIMIT_SOURCE_LENGTH {
        return Err(ExprError::new(format!(
            "expression is longer than {LIMIT_SOURCE_LENGTH} characters"
        )));
    }
    let ast = Parser {
        s: &units,
        i: 0,
        depth: 0,
    }
    .parse()?;
    let mut compiled = Compiled {
        source: source.to_string(),
        ast: Ast::This,
        identifiers: vec![],
        helpers: vec![],
    };
    let mut count = 0;
    vet(&ast, 0, &mut count, &mut compiled)?;
    compiled.ast = ast;
    Ok(compiled)
}

fn add(list: &mut Vec<String>, name: &str) {
    if !list.iter().any(|x| x == name) {
        list.push(name.to_string());
    }
}

fn vet(node: &Ast, depth: usize, count: &mut usize, c: &mut Compiled) -> Result<(), ExprError> {
    *count += 1;
    if *count > LIMIT_NODES {
        return Err(ExprError::new(format!("expression has more than {LIMIT_NODES} parts")));
    }
    if depth > LIMIT_DEPTH {
        return Err(ExprError::new(format!(
            "expression is nested deeper than {LIMIT_DEPTH}"
        )));
    }
    match node {
        Ast::Literal(_) => Ok(()),
        Ast::Identifier(name) => {
            add(&mut c.identifiers, name);
            Ok(())
        }
        Ast::Member {
            object,
            property,
            computed,
            ..
        } => {
            vet(object, depth + 1, count, c)?;
            if *computed {
                vet(property, depth + 1, count, c)
            } else {
                match property.as_ref() {
                    Ast::Identifier(name) if BLOCKED_KEYS.contains(&name.as_str()) => {
                        Err(ExprError::new(format!("access to '{name}' is not allowed")))
                    }
                    _ => Ok(()),
                }
            }
        }
        Ast::Call { callee, arguments, .. } => {
            let Ast::Identifier(name) = callee.as_ref() else {
                return Err(ExprError::new(
                    "only helper functions can be called, e.g. len(x) rather than x.length()",
                ));
            };
            if !is_helper(name) {
                return Err(ExprError::new(format!("unknown function '{name}'")));
            }
            add(&mut c.helpers, name);
            for a in arguments {
                vet(a, depth + 1, count, c)?;
            }
            Ok(())
        }
        Ast::Binary { operator, left, right } => {
            if !BINARY_OPS.contains(&operator.as_str()) {
                return Err(ExprError::new(format!("operator '{operator}' is not allowed")));
            }
            vet(left, depth + 1, count, c)?;
            vet(right, depth + 1, count, c)
        }
        Ast::Unary { operator, argument } => {
            if !UNARY_OPS.contains(&operator.as_str()) {
                return Err(ExprError::new(format!("operator '{operator}' is not allowed")));
            }
            vet(argument, depth + 1, count, c)
        }
        Ast::Conditional {
            test,
            consequent,
            alternate,
        } => {
            vet(test, depth + 1, count, c)?;
            vet(consequent, depth + 1, count, c)?;
            vet(alternate, depth + 1, count, c)
        }
        Ast::Array(elements) => {
            for el in elements.iter().flatten() {
                vet(el, depth + 1, count, c)?;
            }
            Ok(())
        }
        Ast::Object(props) => {
            for p in props {
                match p {
                    Prop::Other(_) => return Err(ExprError::new(OBJECT_ENTRY)),
                    Prop::Property { computed: true, .. } => {
                        return Err(ExprError::new("computed object keys are not allowed"));
                    }
                    Prop::Property { value, .. } => vet(value, depth + 1, count, c)?,
                }
            }
            Ok(())
        }
        Ast::Compound(_) => Err(ExprError::new("only a single expression is allowed (found ',' or ';')")),
        other => Err(ExprError::new(format!(
            "'{}' is not allowed in expressions",
            other.type_name()
        ))),
    }
}

pub(crate) const OBJECT_ENTRY: &str = "object entries must be 'key: value' pairs or names";

const TAB: u16 = 9;
const LF: u16 = 10;
const CR: u16 = 13;
const SPACE: u16 = 32;
const PERIOD: u16 = b'.' as u16;
const COMMA: u16 = b',' as u16;
const SQUOTE: u16 = b'\'' as u16;
const DQUOTE: u16 = b'"' as u16;
const OPAREN: u16 = b'(' as u16;
const CPAREN: u16 = b')' as u16;
const OBRACK: u16 = b'[' as u16;
const CBRACK: u16 = b']' as u16;
const QUMARK: u16 = b'?' as u16;
const SEMCOL: u16 = b';' as u16;
const COLON: u16 = b':' as u16;
const OCURLY: u16 = b'{' as u16;
const CCURLY: u16 = b'}' as u16;

/// jsep's binary operators and precedences, plus Pipo's `in` at 7. None is right-associative except `**`.
fn binary_precedence(op: &[u16]) -> Option<u8> {
    let s = String::from_utf16(op).ok()?;
    Some(match s.as_str() {
        "||" | "??" => 1,
        "&&" => 2,
        "|" => 3,
        "^" => 4,
        "&" => 5,
        "==" | "!=" | "===" | "!==" => 6,
        "<" | ">" | "<=" | ">=" | "in" => 7,
        "<<" | ">>" | ">>>" => 8,
        "+" | "-" => 9,
        "*" | "/" | "%" => 10,
        "**" => 11,
        _ => return None,
    })
}

const MAX_BINOP_LEN: usize = 3;

fn is_digit(c: Option<u16>) -> bool {
    matches!(c, Some(48..=57))
}

fn is_identifier_start(c: Option<u16>) -> bool {
    matches!(c, Some(c) if (65..=90).contains(&c) || (97..=122).contains(&c) || c >= 128 || c == b'$' as u16 || c == b'_' as u16)
}

fn is_identifier_part(c: Option<u16>) -> bool {
    is_identifier_start(c) || is_digit(c)
}

struct OpInfo {
    value: String,
    prec: u8,
    right_a: bool,
}

struct Parser<'s> {
    s: &'s [u16],
    i: usize,
    /// Recursion depth, capped at MAX_NESTING so pathological input can't overflow the stack.
    depth: usize,
}

/// jsep has no cap. Anything this deep fails the depth limit anyway, except redundant parentheses.
const MAX_NESTING: usize = 256;

type PResult<T> = Result<T, ExprError>;

impl Parser<'_> {
    fn code(&self) -> Option<u16> {
        self.s.get(self.i).copied()
    }

    fn code_at(&self, i: usize) -> Option<u16> {
        self.s.get(i).copied()
    }

    /// `this.char`: the current code unit as a string, or "" at the end.
    fn ch(&self) -> String {
        self.s
            .get(self.i)
            .map(|u| String::from_utf16_lossy(&[*u]))
            .unwrap_or_default()
    }

    fn len(&self) -> usize {
        self.s.len()
    }

    fn error<T>(&self, message: impl Into<String>) -> PResult<T> {
        Err(ExprError::at(message, self.i))
    }

    fn gobble_spaces(&mut self) {
        while matches!(self.code(), Some(SPACE | TAB | LF | CR)) {
            self.i += 1;
        }
    }

    fn parse(&mut self) -> PResult<Ast> {
        let mut nodes = self.gobble_expressions(None)?;
        Ok(if nodes.len() == 1 {
            nodes.remove(0)
        } else {
            Ast::Compound(nodes)
        })
    }

    fn gobble_expressions(&mut self, until: Option<u16>) -> PResult<Vec<Ast>> {
        let mut nodes = vec![];
        while self.i < self.len() {
            let ch_i = self.code();
            if ch_i == Some(SEMCOL) || ch_i == Some(COMMA) {
                self.i += 1;
            } else if let Some(node) = self.gobble_expression()? {
                nodes.push(node);
            } else if self.i < self.len() {
                if until.is_some() && ch_i == until {
                    break;
                }
                return self.error(format!("Unexpected \"{}\"", self.ch()));
            }
        }
        Ok(nodes)
    }

    fn nested<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
        if self.depth >= MAX_NESTING {
            return Err(ExprError::new(format!(
                "expression is nested deeper than {LIMIT_DEPTH}"
            )));
        }
        self.depth += 1;
        let out = f(self);
        self.depth -= 1;
        out
    }

    fn gobble_expression(&mut self) -> PResult<Option<Ast>> {
        self.nested(Self::gobble_expression_inner)
    }

    fn gobble_expression_inner(&mut self) -> PResult<Option<Ast>> {
        let node = self.gobble_binary_expression()?;
        self.gobble_spaces();
        // Ternary plugin (the `after-expression` hook).
        let Some(test) = node else { return Ok(None) };
        if self.code() != Some(QUMARK) {
            return Ok(Some(test));
        }
        self.i += 1;
        let Some(consequent) = self.gobble_expression()? else {
            return self.error("Expected expression");
        };
        self.gobble_spaces();
        if self.code() != Some(COLON) {
            return self.error("Expected :");
        }
        self.i += 1;
        let Some(alternate) = self.gobble_expression()? else {
            return self.error("Expected expression");
        };
        Ok(Some(Ast::Conditional {
            test: Box::new(test),
            consequent: Box::new(consequent),
            alternate: Box::new(alternate),
        }))
    }

    fn gobble_binary_op(&mut self) -> Option<(String, u8)> {
        self.gobble_spaces();
        let mut tc_len = MAX_BINOP_LEN.min(self.len().saturating_sub(self.i));
        while tc_len > 0 {
            let cand = &self.s[self.i..self.i + tc_len];
            if let Some(prec) = binary_precedence(cand)
                && (!is_identifier_start(self.code())
                    || (self.i + tc_len < self.len() && !is_identifier_part(self.code_at(self.i + tc_len))))
            {
                let op = String::from_utf16_lossy(cand);
                self.i += tc_len;
                return Some((op, prec));
            }
            tc_len -= 1;
        }
        None
    }

    fn gobble_binary_expression(&mut self) -> PResult<Option<Ast>> {
        let Some(left) = self.gobble_token()? else {
            return Ok(None);
        };
        let Some((biop, prec)) = self.gobble_binary_op() else {
            return Ok(Some(left));
        };
        let Some(right) = self.gobble_token()? else {
            return self.error(format!("Expected expression after {biop}"));
        };
        let mut nodes = vec![left, right];
        let mut ops = vec![OpInfo {
            right_a: biop == "**",
            value: biop,
            prec,
        }];
        while let Some((biop, prec)) = self.gobble_binary_op() {
            let info = OpInfo {
                right_a: biop == "**",
                value: biop.clone(),
                prec,
            };
            while let Some(prev) = ops.last() {
                let reduce = if info.right_a && prev.right_a {
                    prec > prev.prec
                } else {
                    prec <= prev.prec
                };
                if !reduce {
                    break;
                }
                let (Some(right), Some(op), Some(left)) = (nodes.pop(), ops.pop(), nodes.pop()) else {
                    break;
                };
                nodes.push(Ast::Binary {
                    operator: op.value,
                    left: Box::new(left),
                    right: Box::new(right),
                });
            }
            let Some(node) = self.gobble_token()? else {
                return self.error(format!("Expected expression after {biop}"));
            };
            ops.push(info);
            nodes.push(node);
        }
        let mut node = nodes.pop().unwrap_or(Ast::This);
        while let (Some(op), Some(left)) = (ops.pop(), nodes.pop()) {
            node = Ast::Binary {
                operator: op.value,
                left: Box::new(left),
                right: Box::new(node),
            };
        }
        Ok(Some(node))
    }

    fn gobble_token(&mut self) -> PResult<Option<Ast>> {
        self.nested(Self::gobble_token_inner)
    }

    fn gobble_token_inner(&mut self) -> PResult<Option<Ast>> {
        self.gobble_spaces();
        // Object plugin (the `gobble-token` hook).
        if self.code() == Some(OCURLY) {
            return self.gobble_object().map(Some);
        }
        let ch = self.code();
        if is_digit(ch) || ch == Some(PERIOD) {
            return self.gobble_numeric_literal().map(Some);
        }
        let node = if ch == Some(SQUOTE) || ch == Some(DQUOTE) {
            Some(self.gobble_string_literal()?)
        } else if ch == Some(OBRACK) {
            Some(self.gobble_array()?)
        } else {
            // Unary operators are all one character and none starts an identifier.
            if let Some(op) = ch.filter(|c| matches!(*c, 33 | 43 | 45 | 126)) {
                self.i += 1;
                let Some(argument) = self.gobble_token()? else {
                    return self.error("missing unaryOp argument");
                };
                let operator = String::from_utf16_lossy(&[op]);
                return Ok(Some(Ast::Unary {
                    operator,
                    argument: Box::new(argument),
                }));
            }
            if is_identifier_start(ch) {
                let name = self.gobble_identifier()?;
                Some(match name.as_str() {
                    "true" => Ast::Literal(Lit::Bool(true)),
                    "false" => Ast::Literal(Lit::Bool(false)),
                    "null" => Ast::Literal(Lit::Null),
                    "this" => Ast::This,
                    _ => Ast::Identifier(name),
                })
            } else if ch == Some(OPAREN) {
                self.gobble_group()?
            } else {
                None
            }
        };
        match node {
            Some(node) => self.gobble_token_property(node).map(Some),
            None => Ok(None),
        }
    }

    fn gobble_token_property(&mut self, mut node: Ast) -> PResult<Ast> {
        self.gobble_spaces();
        let mut ch = self.code();
        while matches!(ch, Some(PERIOD | OBRACK | OPAREN | QUMARK)) {
            let mut optional = false;
            if ch == Some(QUMARK) {
                if self.code_at(self.i + 1) != Some(PERIOD) {
                    break;
                }
                optional = true;
                self.i += 2;
                self.gobble_spaces();
                ch = self.code();
            }
            self.i += 1;
            if ch == Some(OBRACK) {
                let Some(property) = self.gobble_expression()? else {
                    return self.error(format!("Unexpected \"{}\"", self.ch()));
                };
                self.gobble_spaces();
                if self.code() != Some(CBRACK) {
                    return self.error("Unclosed [");
                }
                self.i += 1;
                node = Ast::Member {
                    object: Box::new(node),
                    property: Box::new(property),
                    computed: true,
                    optional,
                };
            } else if ch == Some(OPAREN) {
                let arguments = self.gobble_arguments(CPAREN)?.into_iter().flatten().collect();
                node = Ast::Call {
                    callee: Box::new(node),
                    arguments,
                    optional,
                };
            } else if ch == Some(PERIOD) || optional {
                if optional {
                    self.i -= 1;
                }
                self.gobble_spaces();
                let property = Ast::Identifier(self.gobble_identifier()?);
                node = Ast::Member {
                    object: Box::new(node),
                    property: Box::new(property),
                    computed: false,
                    optional,
                };
            }
            self.gobble_spaces();
            ch = self.code();
        }
        Ok(node)
    }

    fn take_digits(&mut self, number: &mut Vec<u16>) {
        while is_digit(self.code()) {
            number.push(self.s[self.i]);
            self.i += 1;
        }
    }

    fn gobble_numeric_literal(&mut self) -> PResult<Ast> {
        let mut number: Vec<u16> = vec![];
        self.take_digits(&mut number);
        if self.code() == Some(PERIOD) {
            number.push(PERIOD);
            self.i += 1;
            self.take_digits(&mut number);
        }
        if matches!(self.code(), Some(0x65 | 0x45)) {
            number.push(self.s[self.i]);
            self.i += 1;
            if matches!(self.code(), Some(0x2B | 0x2D)) {
                number.push(self.s[self.i]);
                self.i += 1;
            }
            self.take_digits(&mut number);
            if !is_digit(self.code_at(self.i - 1)) {
                return self.error(format!(
                    "Expected exponent ({}{})",
                    String::from_utf16_lossy(&number),
                    self.ch()
                ));
            }
        }
        let text = String::from_utf16_lossy(&number);
        let code = self.code();
        if is_identifier_start(code) {
            return self.error(format!(
                "Variable names cannot start with a number ({text}{})",
                self.ch()
            ));
        }
        if code == Some(PERIOD) || text == "." {
            return self.error("Unexpected period");
        }
        Ok(Ast::Literal(Lit::Num(parse_float(&text))))
    }

    fn gobble_string_literal(&mut self) -> PResult<Ast> {
        let mut out: Vec<u16> = vec![];
        let quote = self.s[self.i];
        self.i += 1;
        let mut closed = false;
        while self.i < self.len() {
            let ch = self.s[self.i];
            self.i += 1;
            if ch == quote {
                closed = true;
                break;
            }
            if ch != b'\\' as u16 {
                out.push(ch);
                continue;
            }
            let next = self.code();
            self.i += 1;
            match next {
                Some(0x6E) => out.push(LF),
                Some(0x72) => out.push(CR),
                Some(0x74) => out.push(TAB),
                Some(0x62) => out.push(8),
                Some(0x66) => out.push(12),
                Some(0x76) => out.push(11),
                Some(c) => out.push(c),
                None => {}
            }
        }
        if !closed {
            return self.error(format!("Unclosed quote after \"{}\"", String::from_utf16_lossy(&out)));
        }
        Ok(Ast::Literal(Lit::Str(String::from_utf16_lossy(&out))))
    }

    fn gobble_identifier(&mut self) -> PResult<String> {
        let start = self.i;
        if !is_identifier_start(self.code()) {
            return self.error(format!("Unexpected {}", self.ch()));
        }
        self.i += 1;
        while self.i < self.len() && is_identifier_part(self.code()) {
            self.i += 1;
        }
        Ok(String::from_utf16_lossy(&self.s[start..self.i]))
    }

    fn gobble_arguments(&mut self, termination: u16) -> PResult<Vec<Option<Ast>>> {
        let mut args: Vec<Option<Ast>> = vec![];
        let mut closed = false;
        let mut separators = 0;
        while self.i < self.len() {
            self.gobble_spaces();
            let ch_i = self.code();
            if ch_i == Some(termination) {
                closed = true;
                self.i += 1;
                if termination == CPAREN && separators > 0 && separators >= args.len() {
                    return self.error(format!("Unexpected token {}", termination as u8 as char));
                }
                break;
            } else if ch_i == Some(COMMA) {
                self.i += 1;
                separators += 1;
                if separators != args.len() {
                    if termination == CPAREN {
                        return self.error("Unexpected token ,");
                    }
                    while args.len() < separators {
                        args.push(None);
                    }
                }
            } else if args.len() != separators && separators != 0 {
                return self.error("Expected comma");
            } else {
                match self.gobble_expression()? {
                    Some(node) => args.push(Some(node)),
                    None => return self.error("Expected comma"),
                }
            }
        }
        if !closed {
            return self.error(format!("Expected {}", termination as u8 as char));
        }
        Ok(args)
    }

    fn gobble_group(&mut self) -> PResult<Option<Ast>> {
        self.i += 1;
        let mut nodes = self.gobble_expressions(Some(CPAREN))?;
        if self.code() != Some(CPAREN) {
            return self.error("Unclosed (");
        }
        self.i += 1;
        Ok(match nodes.len() {
            0 => None,
            1 => Some(nodes.remove(0)),
            _ => Some(Ast::Sequence(nodes)),
        })
    }

    fn gobble_array(&mut self) -> PResult<Ast> {
        self.i += 1;
        Ok(Ast::Array(self.gobble_arguments(CBRACK)?))
    }

    fn gobble_object(&mut self) -> PResult<Ast> {
        self.i += 1;
        let mut props = vec![];
        while self.code().is_some() {
            self.gobble_spaces();
            if self.code() == Some(CCURLY) {
                self.i += 1;
                return self.gobble_token_property(Ast::Object(props));
            }
            let Some(key) = self.gobble_expression()? else { break };
            self.gobble_spaces();
            let next = self.code();
            if matches!(key, Ast::Identifier(_)) && (next == Some(COMMA) || next == Some(CCURLY)) {
                props.push(Prop::Property {
                    key: Some(Box::new(key.clone())),
                    value: Box::new(key),
                    computed: false,
                });
            } else if next == Some(COLON) {
                self.i += 1;
                let Some(value) = self.gobble_expression()? else {
                    return self.error("unexpected object property");
                };
                let (key, computed) = match key {
                    Ast::Array(mut elements) => (if elements.is_empty() { None } else { elements.remove(0) }, true),
                    key => (Some(key), false),
                };
                props.push(Prop::Property {
                    key: key.map(Box::new),
                    value: Box::new(value),
                    computed,
                });
                self.gobble_spaces();
            } else {
                props.push(Prop::Other(Box::new(key)));
            }
            if self.code() == Some(COMMA) {
                self.i += 1;
            }
        }
        self.error("missing }")
    }
}

/// `parseFloat` of what gobble_numeric_literal collected: digits, an optional fraction and exponent. A literal
/// with no mantissa digits (".e5") is NaN, as in JavaScript.
fn parse_float(text: &str) -> f64 {
    let mantissa = text.split(['e', 'E']).next().unwrap_or("");
    if !mantissa.bytes().any(|b| b.is_ascii_digit()) {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_identifiers_and_helpers() {
        let c = parse("len(data.x) > 0 && meta.attempt < 3 && len(data.y) > 0").unwrap();
        assert_eq!(c.identifiers, ["data", "meta"]);
        assert_eq!(c.helpers, ["len"]);
    }

    #[test]
    fn deep_parentheses_do_not_overflow() {
        let src = format!("{}1{}", "(".repeat(100), ")".repeat(100));
        assert_eq!(parse(&src).unwrap().ast, Ast::Literal(Lit::Num(1.0)));
        for src in [
            format!("{}1{}", "(".repeat(999), ")".repeat(999)),
            format!("{}1{}", "[".repeat(999), "]".repeat(999)),
            format!("{}1", "!".repeat(1999)),
            "1?".repeat(400) + "1" + &":1".repeat(400),
            "{a:".repeat(400) + "1" + &"}".repeat(400),
        ] {
            assert!(parse(&src).unwrap_err().message.contains("nested deeper"));
        }
    }

    #[test]
    fn errors_carry_utf16_positions() {
        let e = parse("'😀' + ").unwrap_err();
        assert_eq!(e.message, "Expected expression after +");
        assert_eq!(e.index, Some(7));
    }
}
