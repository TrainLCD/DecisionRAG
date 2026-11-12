//! Display-only filtering for opaque bot payloads, including stored passage fragments.
//! Keep original evidence intact for ranking, citations and answer verification.

fn payload_line(line: &str, continuation: bool) -> Option<&str> {
    let text = line.trim();
    let text = text.strip_prefix("<!--").unwrap_or(text).trim();
    let text = text.strip_suffix("-->").unwrap_or(text).trim();
    if text.is_empty() && matches!(line.trim(), "<!--" | "-->") {
        return Some(text);
    }
    ((text.len() >= 32 || continuation && !text.is_empty())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=_-".contains(&b)))
    .then_some(text)
}

pub fn evidence_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut pending = String::new();
    let mut payload = String::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut tail_seen = false;
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
        let trimmed = line.trim_start_matches(' ');
        let marker = trimmed.as_bytes().first().copied().unwrap_or(0);
        let width = trimmed.bytes().take_while(|b| *b == marker).count();
        let fenced = fence.is_some();
        let delimiter =
            line.len() - trimmed.len() <= 3 && matches!(marker, b'`' | b'~') && width >= 3;
        if delimiter {
            if let Some((open, length)) = fence {
                if marker == open && width >= length && trimmed[width..].trim().is_empty() {
                    fence = None;
                }
            } else {
                fence = Some((marker, width));
            }
        }
        if fenced || delimiter || line.starts_with("    ") || line.starts_with('\t') {
            flush(&mut output, &mut pending, &mut payload);
            tail_seen = false;
            output.push_str(line);
        } else if let Some(part) = payload_line(line, payload.len() >= 256 && !tail_seen) {
            pending.push_str(line);
            payload.push_str(part);
            tail_seen |= !part.is_empty() && part.len() < 32;
            if line.trim_end().ends_with("-->") {
                flush(&mut output, &mut pending, &mut payload);
                tail_seen = false;
            }
        } else {
            flush(&mut output, &mut pending, &mut payload);
            tail_seen = false;
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
    #[test]
    fn removes_short_wrapped_tail_but_keeps_isolated_ids() {
        let data = "Ab1".repeat(90);
        let wrapped = data
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            evidence_text(&wrapped),
            "\n[エンコードされたデータを省略]\n"
        );
        assert_eq!(evidence_text("Ab1Ab1Ab1\n"), "Ab1Ab1Ab1\n");
        assert_eq!(
            evidence_text(&format!("{wrapped}\nSummary\n本文")),
            "\n[エンコードされたデータを省略]\nSummary\n本文"
        );
        assert_eq!(
            evidence_text(&format!("<!--\n{wrapped}\n-->\nSummary\n本文")),
            "\n[エンコードされたデータを省略]\nSummary\n本文"
        );
        let comment = format!("<!--\n{}\n-->\nSummary\n本文", encoded());
        assert_eq!(
            evidence_text(&comment),
            "\n[エンコードされたデータを省略]\nSummary\n本文"
        );
    }
    #[test]
    fn preserves_fenced_and_indented_long_code_expressions() {
        let expression = "Value1+Value2+".repeat(24) + "Value3";
        for body in [
            format!("```python\n{expression}\n```"),
            format!("~~~~\n{expression}\n~~~\n{expression}\n~~~~"),
            format!("    {expression}\n"),
            format!("\t{expression}\n"),
        ] {
            assert_eq!(evidence_text(&body), body);
        }
    }
}
