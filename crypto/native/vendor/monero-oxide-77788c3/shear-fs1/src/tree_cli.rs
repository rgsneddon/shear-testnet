//! The line protocol `bin/fs1_tree.rs` serves for `node/src/fs1_tree.js`.
//!
//! Requests are one per line, fields split by spaces or tabs. Every reply ends
//! with exactly one `root` or `error` line, and every request gets one reply.
//!
//! - `connect <height> <id> <parent> <n>`, then `n` lines `<admitPub> <commit>`.
//!   Replies one `leaf <hex>` or `skip` line per note, then `root <root> <leaves>`.
//! - `disconnect <id>`. Replies `root <root> <leaves>`.
//! - `root`. Replies `root <root> <leaves>`.
//! - `generators`. Replies the pinned generator rows, then `root <root> <leaves>`.
//!
//! Framing never depends on the content of a note line. The count is read first.
//! A count above [`MAX_BLOCK_NOTES`] is refused before any note line is read, and
//! the client sends none. Otherwise exactly `n` further lines are read as notes,
//! even when the header or a note is bad, so a bad request cannot shift the next
//! one. No line is held past [`MAX_LINE`] bytes; the rest of a longer line is
//! discarded and the line counts as bad. A failed request leaves the tree as it was.

use std::io::{self, BufRead, Write};

use ciphersuite::group::GroupEncoding;

use crate::{
  generators_digest,
  vectors::{hex, unhex_n},
  ChainNote, ChainTree, Fs1Error, Fs1Params,
};

/// Longest line read, newline excluded.
pub const MAX_LINE: usize = 512;

/// Most notes one `connect` may carry. A block holds far fewer.
pub const MAX_BLOCK_NOTES: usize = 65_536;

enum Line {
  Text(String),
  Bad,
  Eof,
}

/// One line of at most [`MAX_LINE`] bytes. A longer or non-UTF-8 line is consumed whole and is `Bad`.
fn read_line(reader: &mut impl BufRead) -> io::Result<Line> {
  let mut held = Vec::new();
  let mut over = false;
  let mut seen = false;
  loop {
    let buf = reader.fill_buf()?;
    if buf.is_empty() {
      if !seen {
        return Ok(Line::Eof);
      }
      break;
    }
    seen = true;
    let (take, done) = match buf.iter().position(|&b| b == b'\n') {
      Some(at) => (at, true),
      None => (buf.len(), false),
    };
    let room = MAX_LINE.saturating_sub(held.len());
    if take > room {
      over = true;
    }
    held.extend_from_slice(&buf[.. take.min(room)]);
    reader.consume(if done { take + 1 } else { take });
    if done {
      break;
    }
  }
  if held.last() == Some(&b'\r') {
    held.pop();
  }
  if over {
    return Ok(Line::Bad);
  }
  Ok(String::from_utf8(held).map_or(Line::Bad, Line::Text))
}

fn reason(err: &Fs1Error) -> &'static str {
  match err {
    Fs1Error::Link => "link",
    Fs1Error::TreeSize => "full",
    _ => "tree",
  }
}

fn note_of(line: &Line) -> Option<ChainNote> {
  let Line::Text(text) = line else { return None };
  let parts: Vec<&str> = text.split_whitespace().collect();
  let [admit_pub, commit] = parts.as_slice() else { return None };
  Some(ChainNote { admit_pub: unhex_n::<32>(admit_pub)?, commit: unhex_n::<32>(commit)? })
}

/// Serve requests from `reader` on `tree` until end of input.
pub fn serve(params: &Fs1Params, tree: &mut ChainTree, mut reader: impl BufRead, mut out: impl Write) -> io::Result<()> {
  loop {
    let line = match read_line(&mut reader)? {
      Line::Eof => return Ok(()),
      Line::Bad => None,
      Line::Text(text) => Some(text),
    };
    let fields: Vec<&str> = line.as_deref().map(|l| l.split_whitespace().collect()).unwrap_or_default();
    let mut reply = Vec::new();
    let result: Result<(), &'static str> = match fields.as_slice() {
      _ if line.is_none() => Err("line"),
      ["connect", height, id, parent, n] => {
        match n.parse::<usize>() {
          Ok(n) if n <= MAX_BLOCK_NOTES => {
            let mut notes = Vec::with_capacity(n);
            let mut bad_note = false;
            for _ in 0 .. n {
              let line = read_line(&mut reader)?;
              if matches!(line, Line::Eof) {
                return Ok(());
              }
              match note_of(&line) {
                Some(note) if !bad_note => notes.push(note),
                Some(_) => {}
                None => bad_note = true,
              }
            }
            let header = (|| {
              let height: u64 = height.parse().map_err(|_| "height")?;
              let id = unhex_n::<32>(id).ok_or("id")?;
              let parent = unhex_n::<32>(parent).ok_or("parent")?;
              Ok::<_, &'static str>((height, id, parent))
            })();
            match header {
              Err(why) => Err(why),
              Ok(_) if bad_note => Err("note"),
              Ok((height, id, parent)) => tree.connect(params, height, id, parent, &notes).map_err(|e| reason(&e)).map(
                |leaves| {
                  for leaf in leaves {
                    reply.push(leaf.map_or_else(|| "skip".to_string(), |l| format!("leaf {}", hex(&l))));
                  }
                },
              ),
            }
          }
          _ => Err("count"),
        }
      }
      ["disconnect", id] => match unhex_n::<32>(id) {
        Some(id) => tree.disconnect(params, id).map(|_| ()).map_err(|e| reason(&e)),
        None => Err("id"),
      },
      ["root"] => Ok(()),
      ["generators"] => {
        reply.push(format!("digest {}", hex(&generators_digest(params))));
        for (name, point) in [("T", params.t_point()), ("U", params.u_point()), ("V", params.v_point())] {
          reply.push(format!("{name} {}", hex(&point.to_bytes())));
        }
        reply.push(format!("selene_init {}", hex(&params.c1_init_point().to_bytes())));
        reply.push(format!("helios_init {}", hex(&params.c2_init_point().to_bytes())));
        Ok(())
      }
      _ => Err("request"),
    };
    match result {
      Ok(()) => reply.push(format!("root {} {}", hex(&tree.root_bytes()), tree.len())),
      Err(why) => {
        reply.clear();
        reply.push(format!("error {why}"));
      }
    }
    for line in reply {
      writeln!(out, "{line}")?;
    }
    out.flush()?;
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::chain_tree::tests::chain_note;
  use crate::membership::tests::params_8;

  fn run(input: &[u8]) -> (Vec<String>, ChainTree) {
    let params = params_8();
    let mut tree = ChainTree::new(params).expect("tree");
    let mut out = Vec::new();
    serve(params, &mut tree, input, &mut out).expect("serve");
    (String::from_utf8(out).unwrap().lines().map(str::to_string).collect(), tree)
  }

  fn note_line(seed: u64) -> String {
    let n = chain_note(seed);
    format!("{} {}\n", hex(&n.admit_pub), hex(&n.commit))
  }

  fn connect(height: u64, id: u8, parent: u8, notes: &[String]) -> String {
    format!("connect {height} {} {} {}\n{}", hex(&[id; 32]), hex(&[parent; 32]), notes.len(), notes.concat())
  }

  fn empty_root() -> String {
    format!("root {} 0", hex(&ChainTree::new(params_8()).unwrap().root_bytes()))
  }

  #[test]
  fn a_good_connect_replies_one_line_per_note_then_the_root() {
    let notes: Vec<String> = (0 .. 3).map(note_line).collect();
    let (lines, tree) = run(connect(1, 1, 0, &notes).as_bytes());
    assert_eq!(lines.len(), 4);
    assert!(lines[.. 3].iter().all(|l| l.starts_with("leaf ")));
    assert_eq!(lines[3], format!("root {} 3", hex(&tree.root_bytes())));
  }

  #[test]
  fn a_count_over_the_cap_is_refused_before_any_note_is_read() {
    let input = format!("connect 1 {} {} {}\nroot\nconnect 1 {} {} 99999999999999999999999\nroot\n",
      hex(&[1; 32]), hex(&[0; 32]), MAX_BLOCK_NOTES + 1, hex(&[1; 32]), hex(&[0; 32]));
    let (lines, tree) = run(input.as_bytes());
    assert_eq!(lines, vec!["error count".to_string(), empty_root(), "error count".to_string(), empty_root()]);
    assert!(tree.is_empty());
  }

  #[test]
  fn a_bad_note_line_consumes_the_whole_request_and_leaves_the_tree_unchanged() {
    let good: Vec<String> = (0 .. 2).map(note_line).collect();
    let long = format!("{}\n", "a".repeat(MAX_LINE * 3));
    let bad_lines: Vec<Vec<u8>> = vec![
      b"zz zz\n".to_vec(),
      b"connect 1 2 3 4\n".to_vec(),
      b"root\n".to_vec(),
      format!("{}\n", hex(&chain_note(9).admit_pub)).into_bytes(),
      long.into_bytes(),
      vec![0xff, 0xfe, b' ', b'x', b'\n'],
    ];
    for bad in bad_lines {
      let mut input = format!("connect 1 {} {} 3\n{}", hex(&[1; 32]), hex(&[0; 32]), good[0]).into_bytes();
      input.extend_from_slice(&bad);
      input.extend_from_slice(good[1].as_bytes());
      input.extend_from_slice(b"root\n");
      input.extend_from_slice(connect(1, 1, 0, &good).as_bytes());
      let (lines, tree) = run(&input);
      assert_eq!(lines[0], "error note", "{bad:?}");
      assert_eq!(lines[1], empty_root(), "{bad:?}");
      assert_eq!(lines.len(), 5, "{bad:?}");
      assert_eq!(lines[4], format!("root {} 2", hex(&tree.root_bytes())), "{bad:?}");
    }
  }

  #[test]
  fn a_bad_header_still_consumes_its_notes() {
    let good: Vec<String> = (0 .. 2).map(note_line).collect();
    for (header, why) in [("connect x {id} {p} 2", "height"), ("connect 1 zz {p} 2", "id"), ("connect 1 {id} 00 2", "parent")] {
      let header = header.replace("{id}", &hex(&[1; 32])).replace("{p}", &hex(&[0; 32]));
      let input = format!("{header}\n{}root\n", good.concat());
      let (lines, _) = run(input.as_bytes());
      assert_eq!(lines, vec![format!("error {why}"), empty_root()]);
    }
  }

  #[test]
  fn a_long_request_line_is_one_bad_line_and_the_next_request_is_served() {
    let mut input = vec![b'r'; MAX_LINE + 1];
    input.extend_from_slice(b"\nroot\nnonsense\r\nroot\r\n");
    let (lines, _) = run(&input);
    assert_eq!(lines, vec!["error line".to_string(), empty_root(), "error request".to_string(), empty_root()]);
    let mut exact = vec![b' '; MAX_LINE - 4];
    exact.extend_from_slice(b"root\n");
    assert_eq!(run(&exact).0, vec![empty_root()]);
  }

  #[test]
  fn a_link_error_is_a_clean_reply() {
    let good: Vec<String> = (0 .. 2).map(note_line).collect();
    let input = format!("{}{}disconnect {}\n", connect(1, 1, 0, &good), connect(3, 2, 1, &good), hex(&[7; 32]));
    let (lines, tree) = run(input.as_bytes());
    assert_eq!(lines[3], "error link");
    assert_eq!(lines[4], "error link");
    assert_eq!(tree.len(), 2);
  }

  #[test]
  fn end_of_input_inside_a_connect_ends_the_session() {
    let input = format!("connect 1 {} {} 3\n{}", hex(&[1; 32]), hex(&[0; 32]), note_line(1));
    let (lines, tree) = run(input.as_bytes());
    assert!(lines.is_empty());
    assert!(tree.is_empty());
  }
}
