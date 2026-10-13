//! Line tool that holds one [`ChainTree`] for `node/src/fs1_tree.js`.
//!
//! Built only with `--features tree-cli`. The protocol is [`shear_fs1::tree_cli`].

use shear_fs1::{tree_cli, ChainTree, Fs1Params};

fn main() {
  let params = Fs1Params::fixed().expect("fixed generators");
  let mut tree = ChainTree::new(&params).expect("tree");
  let stdin = std::io::stdin();
  let stdout = std::io::stdout();
  if tree_cli::serve(&params, &mut tree, stdin.lock(), stdout.lock()).is_err() {
    std::process::exit(1);
  }
}
