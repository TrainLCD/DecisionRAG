use std::io::{self, BufRead, Write};

fn main() {
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            std::process::exit(1)
        };
        let response = decision_rag_core::process(line.as_bytes());
        if out
            .write_all(&response)
            .and_then(|_| out.write_all(b"\n"))
            .and_then(|_| out.flush())
            .is_err()
        {
            std::process::exit(1);
        }
    }
}
