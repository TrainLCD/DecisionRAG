//! Display-only filtering for opaque bot payloads, including stored passage fragments.
//! Keep original evidence intact for ranking, citations and answer verification.

fn payload_line(line: &str) -> Option<&str> {
    let text = line.trim();
    let text = text.strip_prefix("<!--").unwrap_or(text).trim();
    let text = text.strip_suffix("-->").unwrap_or(text).trim();
    if text.is_empty() && matches!(line.trim(), "<!--" | "-->") {
        return Some(text);
    }
    (text.len() >= 32
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=_-".contains(&b)))
    .then_some(text)
}

pub fn evidence_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut pending = String::new();
    let mut payload = String::new();
    fn flush(output: &mut String, pending: &mut String, payload: &mut String) {
        // Long mixed-case, numeric runs are opaque payloads. Short IDs, hashes,
        // ordinary prose, URLs and code lines are retained without modification.
        let opaque = payload.len() >= 256
            && payload.bytes().any(|b| b.is_ascii_uppercase())
            && payload.bytes().any(|b| b.is_ascii_lowercase())
            && payload.bytes().any(|b| b.is_ascii_digit());
        if opaque {
            output.push_str("\n[エンコードされたデータを省略]\n");
        } else {
            output.push_str(pending);
        }
        pending.clear();
        payload.clear();
    }
    for line in text.split_inclusive('\n') {
        if let Some(part) = payload_line(line) {
            pending.push_str(line);
            payload.push_str(part);
        } else {
            flush(&mut output, &mut pending, &mut payload);
            output.push_str(line);
        }
    }
    flush(&mut output, &mut pending, &mut payload);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded() -> String {
        "DwQgtGAEAqAWCWBnSTIEMB26CuAXA9mAOYCmGJATmriQCaQDG+".repeat(12)
    }
    #[test]
    fn hides_comment_payload_and_keeps_surrounding_markdown() {
        let body = format!(
            "## 修正\n本文\n<!--\n{}\n-->\n[詳細](https://example.com)",
            encoded()
        );
        let clean = evidence_text(&body);
        assert!(!clean.contains("DwQgt"));
        assert!(!clean.contains("<!--"));
        assert!(clean.starts_with("## 修正\n本文\n"));
        assert!(clean.ends_with("[詳細](https://example.com)"));
    }
    #[test]
    fn hides_middle_opening_and_closing_passage_fragments() {
        for body in [
            encoded(),
            format!("<!--\n{}", encoded()),
            format!("{}\n-->\n本文", encoded()),
        ] {
            assert!(!evidence_text(&body).contains("DwQgt"));
        }
    }
    #[test]
    fn hides_wrapped_payload_and_preserves_normal_text() {
        let wrapped = encoded()
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("\r\n");
        assert!(!evidence_text(&wrapped).contains("DwQgt"));
        let normal = "## 本文\n<!-- example -->\n```js\nconst value = 'YWJjMTIz';\n```\nhttps://example.com/path\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n";
        assert_eq!(evidence_text(normal), normal);
    }
    #[test]
    fn preserves_long_prose_and_short_base64() {
        let body = format!(
            "{}\nYWJjMTIz\n{}",
            "This is ordinary prose. ".repeat(100),
            "日本語の本文".repeat(100)
        );
        assert_eq!(evidence_text(&body), body);
    }
}
