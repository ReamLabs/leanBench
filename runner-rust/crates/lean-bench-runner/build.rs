//! Bake the pinned leanSig / leanMultisig SHAs into the binary so each
//! result is provenance-complete. The Python orchestrator prints these as
//! part of the run metadata.

use std::{env, fs, path::PathBuf};

fn main() {
    let workspace_cargo = workspace_root().join("Cargo.toml");
    println!("cargo:rerun-if-changed={}", workspace_cargo.display());

    let Ok(text) = fs::read_to_string(&workspace_cargo) else { return };

    if let Some(rev) = find_rev(&text, "leansig") {
        println!("cargo:rustc-env=LEANSIG_SHA={rev}");
    }
    if let Some(rev) = find_rev(&text, "xmss") {
        println!("cargo:rustc-env=LEANMULTISIG_SHA={rev}");
    }
}

fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    p.pop();
    p.pop();
    p
}

fn find_rev(text: &str, dep_name: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if !t.starts_with(dep_name) {
            continue;
        }
        if let Some(start) = t.find("rev = \"") {
            let after = &t[start + 7..];
            if let Some(end) = after.find('"') {
                return Some(after[..end].to_string());
            }
        }
    }
    None
}
