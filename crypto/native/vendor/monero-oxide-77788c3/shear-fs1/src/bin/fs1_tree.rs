//! Line tool that holds one [`ChainTree`] for `node/src/fs1_tree.js`.
//!
//! Built only with `--features tree-cli`. Requests are one per line, fields
//! split by spaces or tabs. Every reply ends with a `root` or `error` line.
//!
//! - `connect <height> <id> <parent> <n>`, then `n` lines `<admitPub> <commit>`.
//!   Replies one `leaf <hex>` or `skip` line per note, then `root <root> <leaves>`.
//! - `disconnect <id>`. Replies `root <root> <leaves>`.
//! - `root`. Replies `root <root> <leaves>`.
//! - `generators`. Replies the pinned generator rows, then `root <root> <leaves>`.

use std::io::{BufRead, Write};

use ciphersuite::group::GroupEncoding;
use shear_fs1::{
  generators_digest,
  vectors::{hex, unhex_n},
  ChainNote, ChainTree, Fs1Error, Fs1Params,
};

fn reason(err: &Fs1Error) -> &'static str {
  match err {
    Fs1Error::Link => "link",
    Fs1Error::TreeSize => "full",
    _ => "tree",
  }
}

fn main() {
  let params = Fs1Params::fixed().expect("fixed generators");
  let mut tree = ChainTree::new(&params).expect("tree");
  let stdin = std::io::stdin();
  let mut lines = stdin.lock().lines();
  let stdout = std::io::stdout();
  let mut out = stdout.lock();
  while let Some(Ok(line)) = lines.next() {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let mut reply = Vec::new();
    let result: Result<(), &'static str> = (|| {
      match fields.as_slice() {
        ["connect", height, id, parent, n] => {
          let height: u64 = height.parse().map_err(|_| "height")?;
          let id = unhex_n::<32>(id).ok_or("id")?;
          let parent = unhex_n::<32>(parent).ok_or("parent")?;
          let n: usize = n.parse().map_err(|_| "count")?;
          let mut notes = Vec::with_capacity(n);
          for _ in 0 .. n {
            let line = lines.next().and_then(Result::ok).ok_or("note")?;
            let parts: Vec<&str> = line.split_whitespace().collect();
            let [admit_pub, commit] = parts.as_slice() else { return Err("note") };
            notes.push(ChainNote {
              admit_pub: unhex_n::<32>(admit_pub).ok_or("note")?,
              commit: unhex_n::<32>(commit).ok_or("note")?,
            });
          }
          let leaves = tree.connect(&params, height, id, parent, &notes).map_err(|e| reason(&e))?;
          for leaf in leaves {
            reply.push(leaf.map_or_else(|| "skip".to_string(), |l| format!("leaf {}", hex(&l))));
          }
          Ok(())
        }
        ["disconnect", id] => {
          tree.disconnect(&params, unhex_n::<32>(id).ok_or("id")?).map_err(|e| reason(&e))?;
          Ok(())
        }
        ["root"] => Ok(()),
        ["generators"] => {
          reply.push(format!("digest {}", hex(&generators_digest(&params))));
          for (name, point) in [("T", params.t_point()), ("U", params.u_point()), ("V", params.v_point())] {
            reply.push(format!("{name} {}", hex(&point.to_bytes())));
          }
          reply.push(format!("selene_init {}", hex(&params.c1_init_point().to_bytes())));
          reply.push(format!("helios_init {}", hex(&params.c2_init_point().to_bytes())));
          Ok(())
        }
        _ => Err("request"),
      }
    })();
    match result {
      Ok(()) => reply.push(format!("root {} {}", hex(&tree.root_bytes()), tree.len())),
      Err(why) => reply.push(format!("error {why}")),
    }
    for line in reply {
      let _ = writeln!(out, "{line}");
    }
    let _ = out.flush();
  }
}
